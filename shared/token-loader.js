// token-loader.js: Garante a persistência e autorrenovação automática do token na extensão
const CLIENT_ID = '24cb626331b849ecafb746f6b4487f80';

export async function ensureValidToken() {
  let { spotify_access_token, spotify_refresh_token, spotify_token_expires_at } = 
    await chrome.storage.local.get(['spotify_access_token', 'spotify_refresh_token', 'spotify_token_expires_at']);

  // Se não estiver no chrome.storage, inicializa com o token emitido
  if (!spotify_access_token) {
    try {
      const response = await fetch(chrome.runtime.getURL('shared/default-token.json'));
      if (response.ok) {
        const seed = await response.json();
        spotify_access_token = seed.access_token;
        spotify_refresh_token = seed.refresh_token;
        spotify_token_expires_at = Date.now() + (seed.expires_in * 1000);
        await chrome.storage.local.set({
          spotify_access_token,
          spotify_refresh_token,
          spotify_token_expires_at
        });
      }
    } catch (e) {
      console.warn('Seed token nao encontrado');
    }
  }

  // Se expirou e temos refresh_token, renova automaticamente
  if (spotify_refresh_token && spotify_token_expires_at && Date.now() > (spotify_token_expires_at - 60000)) {
    try {
      const params = new URLSearchParams();
      params.append('client_id', CLIENT_ID);
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', spotify_refresh_token);

      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      if (res.ok) {
        const data = await res.json();
        spotify_access_token = data.access_token;
        if (data.refresh_token) spotify_refresh_token = data.refresh_token;
        spotify_token_expires_at = Date.now() + (data.expires_in * 1000);

        await chrome.storage.local.set({
          spotify_access_token,
          spotify_refresh_token,
          spotify_token_expires_at
        });
      }
    } catch (err) {
      console.error('Falha ao auto-renovar token:', err);
    }
  }

  return spotify_access_token;
}
