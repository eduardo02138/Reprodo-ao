// spotify-client.js: Centralized Spotify API client with serialized token refresh,
// one retry on 401, rate limit handling, abort controllers and error categorization.
// Error messages start with a code (AUTH_REQUIRED, RATE_LIMITED, QUOTA_EXCEEDED, TEMPORARY_FAILURE).
import { SPOTIFY_CLIENT_ID, TOKEN_KEYS } from './spotify-config.js';
import { loginWithSpotify } from './auth.js';

const REFRESH_MARGIN_MS = 60000;
const SILENT_LOGIN_COOLDOWN_MS = 2 * 60 * 1000;

const isExpiring = (tokens) =>
  !tokens.spotify_token_expires_at || Date.now() > tokens.spotify_token_expires_at - REFRESH_MARGIN_MS;

let localRefreshChain = Promise.resolve();

// Popup and service worker each have their own client. Spotify rotates refresh tokens
// (the old one stops working), so two simultaneous refreshes would log the user out.
// A Web Lock serializes the refresh across every extension context.
function withRefreshLock(fn) {
  if (globalThis.navigator?.locks) {
    return navigator.locks.request('spotify-token-refresh', fn);
  }
  const run = localRefreshChain.then(fn);
  localRefreshChain = run.catch(() => {});
  return run;
}

async function markAuthRequired() {
  await chrome.storage.local.set({ engineState: 'AUTH_REQUIRED' });
}

// Automatic login: after the user authorized the app once, a lost session is recovered without
// a window. Call it while holding the refresh lock so two contexts never run the flow together.
export async function trySilentLogin() {
  const { spotifyAuthorizedOnce, lastSilentLoginAt = 0 } =
    await chrome.storage.local.get(['spotifyAuthorizedOnce', 'lastSilentLoginAt']);
  if (!spotifyAuthorizedOnce || typeof chrome.identity?.launchWebAuthFlow !== 'function') return null;
  if (Date.now() - lastSilentLoginAt < SILENT_LOGIN_COOLDOWN_MS) return null;

  await chrome.storage.local.set({ lastSilentLoginAt: Date.now() });
  try {
    await loginWithSpotify({ interactive: false });
    const { spotify_access_token } = await chrome.storage.local.get('spotify_access_token');
    return spotify_access_token || null;
  } catch (e) {
    return null;
  }
}

export class SpotifyClient {
  constructor() {
    this.rateLimitResetTime = 0;
    this.quotaExceeded = false;
    this.requestSequence = 0;
    this.activeAbortControllers = new Map();
  }

  // staleToken: a token Spotify just rejected with 401 and must be replaced even if not "expired"
  async getAccessToken({ staleToken = null } = {}) {
    const tokens = await chrome.storage.local.get(TOKEN_KEYS);

    if (!tokens.spotify_access_token && !tokens.spotify_refresh_token) {
      const silentToken = await withRefreshLock(async () => {
        const current = await chrome.storage.local.get(TOKEN_KEYS);
        return current.spotify_access_token || trySilentLogin();
      });
      if (silentToken) return silentToken;
      await markAuthRequired();
      throw new Error('AUTH_REQUIRED: Conecte sua conta Spotify no popup da extensão.');
    }

    const needsRefresh = (t) => isExpiring(t) || (!!staleToken && t.spotify_access_token === staleToken);
    if (!needsRefresh(tokens)) return tokens.spotify_access_token;

    if (!tokens.spotify_refresh_token) {
      await markAuthRequired();
      throw new Error('AUTH_REQUIRED: Sessão do Spotify expirada. Conecte novamente.');
    }

    return withRefreshLock(async () => {
      // Another context may have refreshed while we waited for the lock
      const current = await chrome.storage.local.get(TOKEN_KEYS);
      if (current.spotify_access_token && !needsRefresh(current)) return current.spotify_access_token;

      try {
        const refreshed = await this.refreshToken(current.spotify_refresh_token);
        return refreshed.access_token;
      } catch (err) {
        if (err.message === 'invalid_grant') {
          // Refresh token revoked or older than 6 months: only a new login fixes it
          await chrome.storage.local.remove(TOKEN_KEYS);
          const silentToken = await trySilentLogin();
          if (silentToken) return silentToken;
          await markAuthRequired();
          throw new Error('AUTH_REQUIRED: Sessão do Spotify revogada ou expirada. Conecte novamente.');
        }
        // Network/5xx during refresh: keep using the current token only while it is really valid
        const stillValid = current.spotify_access_token
          && current.spotify_token_expires_at > Date.now()
          && current.spotify_access_token !== staleToken;
        if (stillValid) return current.spotify_access_token;
        throw new Error(`TEMPORARY_FAILURE: Falha ao renovar token (${err.message})`);
      }
    });
  }

  async refreshToken(refreshToken) {
    const params = new URLSearchParams();
    params.append('client_id', SPOTIFY_CLIENT_ID);
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
    await chrome.storage.local.set({
      spotify_access_token: data.access_token,
      spotify_refresh_token: data.refresh_token || refreshToken,
      spotify_token_expires_at: Date.now() + (data.expires_in * 1000),
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
      throw new Error(`TEMPORARY_FAILURE: Rede indisponível (${err.message})`);
    }
  }

  // Centralized request method with rate limit, abort, and auth handling
  async request(endpoint, options = {}, cancelTag = null) {
    if (this.quotaExceeded) {
      throw new Error('QUOTA_EXCEEDED: Cota de API do Spotify excedida no modo desenvolvedor.');
    }

    if (Date.now() < this.rateLimitResetTime) {
      const waitSec = Math.ceil((this.rateLimitResetTime - Date.now()) / 1000);
      throw new Error(`RATE_LIMITED: Aguarde ${waitSec}s antes de enviar novos comandos.`);
    }

    // Cancel previous request with same tag (e.g., rapid volume changes)
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
      const token = await this.getAccessToken();
      res = await this.send(url, options, token);

      // Token rejected before its expected expiry (revoked, rotated elsewhere): refresh once and retry
      if (res.status === 401) {
        const renewed = await this.getAccessToken({ staleToken: token });
        if (renewed && renewed !== token) {
          res = await this.send(url, options, renewed);
        }
      }
    } finally {
      if (cancelTag && this.activeAbortControllers.get(cancelTag)?.signal === options.signal) {
        this.activeAbortControllers.delete(cancelTag);
      }
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      this.rateLimitResetTime = Date.now() + (retryAfter * 1000);
      const body = await res.text();
      if (body.includes('QUOTA_EXCEEDED')) {
        this.quotaExceeded = true;
        await chrome.storage.local.set({ engineState: 'QUOTA_EXCEEDED' });
        throw new Error('QUOTA_EXCEEDED: Cota de API do Spotify excedida no modo desenvolvedor.');
      }
      await chrome.storage.local.set({ engineState: 'RATE_LIMITED' });
      throw new Error(`RATE_LIMITED: Retry-After ${retryAfter}s`);
    }

    if (res.status === 401) {
      await markAuthRequired();
      throw new Error('AUTH_REQUIRED: Spotify recusou o token. Conecte novamente.');
    }

    return { res, seq: currentSeq };
  }
}
