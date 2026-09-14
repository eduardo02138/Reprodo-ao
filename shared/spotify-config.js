// spotify-config.js: Spotify app settings.
// Each user brings their own Spotify app: the Client ID is typed in the popup and kept in chrome.storage.
// PKCE flow: only the Client ID is needed, never the Client Secret.

export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing'
];

export const CLIENT_ID_KEY = 'spotifyClientId';
// Client ID of the app that issued the current tokens: refresh must use the same app
export const TOKEN_CLIENT_ID_KEY = 'spotifyTokenClientId';

export const TOKEN_KEYS = ['spotify_access_token', 'spotify_refresh_token', 'spotify_token_expires_at', TOKEN_CLIENT_ID_KEY];

export const CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/i;

export async function getClientId() {
  const { [CLIENT_ID_KEY]: clientId } = await chrome.storage.local.get(CLIENT_ID_KEY);
  return CLIENT_ID_PATTERN.test(clientId || '') ? clientId : null;
}
