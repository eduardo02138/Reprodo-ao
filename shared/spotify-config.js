// spotify-config.js: Spotify app settings. PKCE flow: the client ID is public and there is no client secret.
export const SPOTIFY_CLIENT_ID = '24cb626331b849ecafb746f6b4487f80';

export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing'
];

export const TOKEN_KEYS = ['spotify_access_token', 'spotify_refresh_token', 'spotify_token_expires_at'];
