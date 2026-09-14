// spotify-client.js: Cliente centralizado com resiliência, auto-refresh (G6),
// tratamento estrito de 429/Retry-After/Quota (G7), abort controllers e sequence tracking (G10)

const CLIENT_ID = '24cb626331b849ecafb746f6b4487f80';
const TOKEN_KEYS = ['spotify_access_token', 'spotify_refresh_token', 'spotify_token_expires_at'];
const REFRESH_MARGIN_MS = 60000;

const isExpiring = (tokens) =>
  !tokens.spotify_token_expires_at || Date.now() > tokens.spotify_token_expires_at - REFRESH_MARGIN_MS;

let localRefreshChain = Promise.resolve();

// Popup e service worker têm clientes separados. O Spotify pode rotacionar o refresh token
// (o antigo deixa de valer), então dois refresh simultâneos derrubariam a sessão.
// O Web Lock serializa o refresh entre todos os contextos da extensão.
function withRefreshLock(fn) {
  if (globalThis.navigator?.locks) {
    return navigator.locks.request('spotify-token-refresh', fn);
  }
  const run = localRefreshChain.then(fn);
  localRefreshChain = run.catch(() => {});
  return run;
}

export class SpotifyClient {
  constructor() {
    this.rateLimitResetTime = 0;
    this.quotaExceeded = false;
    this.requestSequence = 0;
    this.activeAbortControllers = new Map();
  }

  async loadTokens() {
    const tokens = await chrome.storage.local.get(TOKEN_KEYS);
    if (tokens.spotify_access_token) return tokens;

    // Sem token salvo: usa o seed empacotado. Ele pode estar vencido, então força refresh (expires_at = 0).
    try {
      const res = await fetch(chrome.runtime.getURL('shared/default-token.json'));
      if (res.ok) {
        const seed = await res.json();
        const seeded = {
          spotify_access_token: seed.access_token,
          spotify_refresh_token: seed.refresh_token,
          spotify_token_expires_at: 0
        };
        await chrome.storage.local.set(seeded);
        return seeded;
      }
    } catch (e) {}
    return tokens;
  }

  // staleToken: token que acabou de receber 401 e precisa ser trocado mesmo sem ter "expirado"
  async getAccessToken({ staleToken = null } = {}) {
    const tokens = await this.loadTokens();
    const needsRefresh = (t) => isExpiring(t) || (!!staleToken && t.spotify_access_token === staleToken);

    if (!tokens.spotify_refresh_token || !needsRefresh(tokens)) {
      return tokens.spotify_access_token;
    }

    return withRefreshLock(async () => {
      // Outro contexto pode ter renovado enquanto esperávamos o lock
      const current = await chrome.storage.local.get(TOKEN_KEYS);
      if (!needsRefresh(current)) return current.spotify_access_token;

      try {
        const refreshed = await this.refreshToken(current.spotify_refresh_token || tokens.spotify_refresh_token);
        return refreshed.access_token;
      } catch (err) {
        if (err.message.includes('invalid_grant')) {
          await chrome.storage.local.set({ engineState: 'AUTH_REQUIRED' });
          throw new Error('AUTH_REQUIRED: Sessão do Spotify expirada (6 meses). Faça login novamente.');
        }
        return current.spotify_access_token || tokens.spotify_access_token;
      }
    });
  }

  async refreshToken(refreshToken) {
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('invalid_grant')) {
        throw new Error('invalid_grant');
      }
      throw new Error(`Falha no refresh: ${res.status}`);
    }

    const data = await res.json();
    const expiresAt = Date.now() + (data.expires_in * 1000);

    await chrome.storage.local.set({
      spotify_access_token: data.access_token,
      spotify_refresh_token: data.refresh_token || refreshToken,
      spotify_token_expires_at: expiresAt,
      engineState: 'READY'
    });

    return data;
  }

  async send(url, options, token) {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    try {
      return await fetch(url, { ...options, headers });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('REQUEST_SUPERSEDED: Operação mais recente enviada.');
      }
      throw err;
    }
  }

  // G7 & G10: Método centralizado de requisições
  async request(endpoint, options = {}, cancelTag = null) {
    // 1. Verifica estado de Quota / Rate Limit
    if (this.quotaExceeded) {
      throw new Error('QUOTA_EXCEEDED: Cota de API do Spotify excedida no modo desenvolvedor.');
    }

    if (Date.now() < this.rateLimitResetTime) {
      const waitSec = Math.ceil((this.rateLimitResetTime - Date.now()) / 1000);
      throw new Error(`RATE_LIMITED: Aguarde ${waitSec}s antes de enviar novos comandos.`);
    }

    // 2. G10: Cancelamento de requisições anteriores com a mesma tag (ex: volume rápido)
    if (cancelTag) {
      if (this.activeAbortControllers.has(cancelTag)) {
        this.activeAbortControllers.get(cancelTag).abort();
      }
      const controller = new AbortController();
      this.activeAbortControllers.set(cancelTag, controller);
      options.signal = controller.signal;
    }

    const currentSeq = ++this.requestSequence;
    const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`;

    let res;
    try {
      let token = await this.getAccessToken();
      if (!token) throw new Error('AUTH_REQUIRED');

      res = await this.send(url, options, token);

      // Token recusado antes do vencimento previsto: renova uma vez e repete
      if (res.status === 401) {
        const renewed = await this.getAccessToken({ staleToken: token });
        if (renewed && renewed !== token) {
          token = renewed;
          res = await this.send(url, options, token);
        }
      }
    } finally {
      if (cancelTag && this.activeAbortControllers.get(cancelTag)?.signal === options.signal) {
        this.activeAbortControllers.delete(cancelTag);
      }
    }

    // 3. G7: Tratamento dos códigos de status
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      this.rateLimitResetTime = Date.now() + (retryAfter * 1000);
      const body = await res.text();
      if (body.includes('QUOTA_EXCEEDED')) {
        this.quotaExceeded = true;
        await chrome.storage.local.set({ engineState: 'QUOTA_EXCEEDED' });
      } else {
        await chrome.storage.local.set({ engineState: 'RATE_LIMITED' });
      }
      throw new Error(`RATE_LIMITED: Retry-After ${retryAfter}s`);
    }

    if (res.status === 401) {
      await chrome.storage.local.set({ engineState: 'AUTH_REQUIRED' });
      throw new Error('AUTH_REQUIRED');
    }

    return { res, seq: currentSeq };
  }
}
