// Implementação padrão de OAuth 2.0 com PKCE para extensões Chrome sem segredo do cliente

export async function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

export async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function getRedirectUri() {
  return chrome.identity.getRedirectURL('spotify');
}

export async function initiateSpotifyAuth(clientId) {
  const verifier = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = await getRedirectUri();

  // Salva o verifier para a troca de código posterior
  await chrome.storage.local.set({ pkce_code_verifier: verifier });

  const scopes = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing'
  ].join(' ');

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('scope', scopes);

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl.toString(),
        interactive: true
      },
      async (redirectUrl) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        if (!redirectUrl) {
          return reject(new Error('Fluxo de autenticação cancelado pelo usuário.'));
        }

        try {
          const url = new URL(redirectUrl);
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            return reject(new Error(`Spotify error: ${error}`));
          }

          if (!code) {
            return reject(new Error('Nenhum código de autorização retornado.'));
          }

          // Troca o código pelo access_token usando PKCE
          const tokenData = await exchangeCodeForToken(clientId, code, redirectUri);
          resolve(tokenData);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function exchangeCodeForToken(clientId, code, redirectUri) {
  const { pkce_code_verifier } = await chrome.storage.local.get('pkce_code_verifier');

  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', redirectUri);
  params.append('code_verifier', pkce_code_verifier);

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Falha ao obter token (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in * 1000);

  await chrome.storage.local.set({
    spotify_access_token: data.access_token,
    spotify_refresh_token: data.refresh_token,
    spotify_token_expires_at: expiresAt
  });

  return data;
}
