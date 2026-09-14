// spotify-client.js: Centralized Spotify API client with auto-refresh,
// rate limit handling, abort controllers, and proper error categorization

const CLIENT_ID = '24cb626331b849ecafb746f6b4487f80';

export class SpotifyClient {
  constructor() {
    this.rateLimitResetTime = 0;
    this.quotaExceeded = false;
    this.requestSequence = 0;
    this.activeAbortControllers = new Map();
  }

  async getAccessToken() {
    let { spotify_access_token, spotify_refresh_token, spotify_token_expires_at } =
      await chrome.storage.local.get([
        'spotify_access_token', 'spotify_refresh_token', 'spotify_token_expires_at'
      ]);

    // No token at all → user must authenticate
    if (!spotify_access_token && !spotify_refresh_token) {
      await chrome.storage.local.set({ engineState: 'AUTH_REQUIRED' });
      throw new Error('AUTH_REQUIRED: Nenhum token encontrado. Faça login no Spotify.');
    }

    // Auto-refresh if token expires within 60 seconds
    const isExpiring = !spotify_token_expires_at || Date.now() > (spotify_token_expires_at - 60000);
    if (isExpiring && spotify_refresh_token) {
      try {
        const refreshed = await this.refreshToken(spotify_refresh_token);
        if (refreshed) {
          spotify_access_token = refreshed.access_token;
        }
      } catch (err) {
        if (err.message.includes('invalid_grant')) {
          // Refresh token revoked or expired (6 months) — need full re-auth
          await chrome.storage.local.set({ engineState: 'AUTH_REQUIRED' });
          throw new Error('AUTH_REQUIRED: Sessão do Spotify expirada. Faça login novamente.');
        }

        // Network error or server error during refresh — temporary failure
        // Do NOT return the expired token
        if (!spotify_access_token || (spotify_token_expires_at && Date.now() > spotify_token_expires_at)) {
          throw new Error(`TEMPORARY_AUTH_FAILURE: ${err.message}`);
        }
        // Token not yet expired, use it despite refresh failure
      }
    }

    if (!spotify_access_token) {
      await chrome.storage.local.set({ engineState: 'AUTH_REQUIRED' });
      throw new Error('AUTH_REQUIRED');
    }

    return spotify_access_token;
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
      engineState: 'ACTIVE'
    });

    return data;
  }

  // Centralized request method with rate limit, abort, and auth handling
  async request(endpoint, options = {}, cancelTag = null) {
    // 1. Check quota/rate limit state
    if (this.quotaExceeded) {
      throw new Error('QUOTA_EXCEEDED: Cota de API do Spotify excedida no modo desenvolvedor.');
    }

    if (Date.now() < this.rateLimitResetTime) {
      const waitSec = Math.ceil((this.rateLimitResetTime - Date.now()) / 1000);
      throw new Error(`RATE_LIMITED: Aguarde ${waitSec}s antes de enviar novos comandos.`);
    }

    // 2. Cancel previous request with same tag (e.g., rapid volume changes)
    if (cancelTag) {
      if (this.activeAbortControllers.has(cancelTag)) {
        this.activeAbortControllers.get(cancelTag).abort();
      }
      const controller = new AbortController();
      this.activeAbortControllers.set(cancelTag, controller);
      options.signal = controller.signal;
    }

    const token = await this.getAccessToken();
    if (!token) throw new Error('AUTH_REQUIRED');

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const currentSeq = ++this.requestSequence;
    const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`;

    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('REQUEST_SUPERSEDED: Operação mais recente enviada.');
      }
      throw err;
    } finally {
      if (cancelTag && this.activeAbortControllers.get(cancelTag)?.signal === options.signal) {
        this.activeAbortControllers.delete(cancelTag);
      }
    }

    // 3. Handle response status codes
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
