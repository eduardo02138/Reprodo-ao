// auth.js: Spotify OAuth 2.0 with PKCE for Chrome extensions (no client secret)
import { SPOTIFY_CLIENT_ID, SPOTIFY_SCOPES, TOKEN_KEYS } from './spotify-config.js';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function generateCodeChallenge(codeVerifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

// Must be registered as a Redirect URI of the app in the Spotify Developer Dashboard
export function getRedirectUri() {
  if (typeof chrome.identity?.getRedirectURL !== 'function') {
    throw new Error('Login indisponível: este navegador não oferece a API chrome.identity (use Google Chrome ou Microsoft Edge e recarregue a extensão).');
  }
  return chrome.identity.getRedirectURL('spotify');
}

// Interactive login runs in the service worker: the popup closes when the Spotify window takes focus.
// interactive=false is the automatic login: no window, it only succeeds when the user already
// authorized the app and is still signed in to Spotify in this browser.
export async function loginWithSpotify({ interactive = true } = {}) {
  const verifier = randomToken(64);
  const state = randomToken(16);
  const redirectUri = getRedirectUri();

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', await generateCodeChallenge(verifier));
  authUrl.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive,
      // Silent attempt: let Spotify redirect on its own, then give up instead of waiting for a click
      ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 })
    });
  } catch (err) {
    throw new Error(interactive
      ? `Login cancelado ou bloqueado: ${err.message}`
      : `Login automático não foi possível: ${err.message}`);
  }
  if (!redirectUrl) throw new Error('Login cancelado.');

  const params = new URL(redirectUrl).searchParams;
  if (params.get('error')) throw new Error(`Spotify recusou o login: ${params.get('error')}`);
  if (params.get('state') !== state) throw new Error('Resposta de login inválida (state não confere).');
  const code = params.get('code');
  if (!code) throw new Error('Spotify não retornou o código de autorização.');

  return exchangeCodeForToken(code, redirectUri, verifier);
}

async function exchangeCodeForToken(code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Falha ao obter token (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  await chrome.storage.local.set({
    spotify_access_token: data.access_token,
    spotify_refresh_token: data.refresh_token,
    spotify_token_expires_at: Date.now() + data.expires_in * 1000,
    engineState: 'READY',
    // Enables the automatic (silent) login when this session is lost later
    spotifyAuthorizedOnce: true,
    autoReauthDisabled: false
  });

  // Tokens stay in storage only; never return them to callers that might log them
  return { scope: data.scope, expiresIn: data.expires_in };
}

export async function logoutSpotify() {
  await chrome.storage.local.remove([...TOKEN_KEYS, 'spotifyDisplayName']);
  // An explicit logout must not be undone by the automatic login
  await chrome.storage.local.set({
    engineState: 'AUTH_REQUIRED',
    spotifyAuthorizedOnce: false,
    autoReauthDisabled: true
  });
}

