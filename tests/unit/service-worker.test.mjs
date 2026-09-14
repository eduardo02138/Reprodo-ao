// Tests the REAL background/service-worker.js with chrome.* and the Spotify Web API mocked.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Handoff sleeps (transfer settle, playback verification) run with 0 ms
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, 0, ...args);
console.log = () => {};

// ── chrome.* mock (async jitter exposes races between storage reads and writes) ──
const storage = {};
const tabMessages = [];
let messageListener;
let identityHandler = null;
const jitter = () => new Promise(resolve => realSetTimeout(resolve, Math.random() * 2));

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        await jitter();
        const list = keys == null ? Object.keys(storage) : (typeof keys === 'string' ? [keys] : keys);
        return Object.fromEntries(list.filter(k => k in storage).map(k => [k, structuredClone(storage[k])]));
      },
      set: async (obj) => {
        await jitter();
        for (const [k, v] of Object.entries(obj)) storage[k] = structuredClone(v);
      },
      remove: async (keys) => {
        await jitter();
        for (const k of [].concat(keys)) delete storage[k];
      }
    }
  },
  runtime: { onMessage: { addListener: (fn) => { messageListener = fn; } } },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    sendMessage: async (tabId, msg) => {
      tabMessages.push(msg.type);
      return msg.type === 'PAUSE_AND_MUTE_YOUTUBE' ? { paused: true } : { restored: true };
    }
  },
  identity: {
    getRedirectURL: (path) => `https://testextid.chromiumapp.org/${path}`,
    launchWebAuthFlow: async (details) => identityHandler(details.url, details)
  }
};

// ── Spotify Web API mock (refresh tokens rotate: the previous one stops working) ──
const TUDO = { id: 'dev-tudo', name: 'Tudo', type: 'Speaker', is_active: false };
const ECHO = { id: 'dev-echo', name: 'Echo Pop', type: 'Speaker', is_active: false };
const S = {
  devices: [TUDO],
  catalog: [
    ['Never Gonna Give You Up', 'Rick Astley', 'rick'],
    ['Take On Me', 'a-ha', 'aha'],
    ['POWER', 'Kanye West', 'power'],
    ['Bohemian Rhapsody', 'Queen', 'queen'],
    ['Admirável Chip Novo', 'Pitty', 'pitty'],
    ['Die With A Smile', 'Lady Gaga', 'gaga']
  ].map(([name, artist, id]) => ({ name, artists: [{ name: artist }], album: { name }, uri: `spotify:track:${id}` })),
  player: null,
  playerUpdates: true,
  failPlay: [],
  calls: [],
  plays: [],
  validAccess: 'acc-0',
  validRefresh: 'ref-0',
  tokenSeq: 0,
  refreshCalls: 0,
  codeExchanges: []
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  S.calls.push(`${method} ${u.hostname}${u.pathname}`);

  if (u.hostname === 'accounts.spotify.com') {
    const body = new URLSearchParams(opts.body);
    await new Promise(resolve => realSetTimeout(resolve, 3));
    if (body.get('grant_type') === 'authorization_code') {
      S.codeExchanges.push(Object.fromEntries(body));
      if (body.get('code') !== 'good-code' || !body.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
    } else {
      S.refreshCalls++;
      S.lastRefreshClientId = body.get('client_id');
      if (body.get('refresh_token') !== S.validRefresh) return json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400);
    }
    S.tokenSeq++;
    S.validAccess = `acc-${S.tokenSeq}`;
    S.validRefresh = `ref-${S.tokenSeq}`;
    return json({ access_token: S.validAccess, refresh_token: S.validRefresh, expires_in: 3600, scope: 'user-modify-playback-state' });
  }

  if (opts.headers?.Authorization !== `Bearer ${S.validAccess}`) {
    return json({ error: { status: 401, message: 'The access token expired' } }, 401);
  }
  if (u.pathname === '/v1/me') return json({ display_name: 'Conta Teste', product: 'premium' });
  if (u.pathname === '/v1/me/player/devices') return json({ devices: S.devices });
  if (u.pathname === '/v1/search') {
    const q = u.searchParams.get('q').toLowerCase();
    return json({ tracks: { items: S.catalog.filter(t => q.includes(t.name.toLowerCase())) } });
  }
  if (u.pathname === '/v1/me/player/play' && method === 'PUT') {
    const status = S.failPlay.shift();
    if (status) return json({ error: { status, message: `mock ${status}` } }, status);
    const uri = JSON.parse(opts.body).uris[0];
    S.plays.push(uri);
    if (S.playerUpdates) {
      const device = S.devices.find(d => d.id === u.searchParams.get('device_id'));
      S.player = { is_playing: true, device, item: S.catalog.find(t => t.uri === uri) };
    }
    return new Response(null, { status: 204 });
  }
  if (u.pathname === '/v1/me/player' && method === 'PUT') return new Response(null, { status: 204 });
  if (u.pathname === '/v1/me/player') return S.player ? json(S.player) : new Response(null, { status: 204 });
  return json({ error: 'not mocked' }, 500);
};

const CLIENT_ID = 'abcdef0123456789abcdef0123456789';
const freshTokens = () => ({
  spotify_access_token: S.validAccess,
  spotify_refresh_token: S.validRefresh,
  spotify_token_expires_at: Date.now() + 3600 * 1000,
  spotifyTokenClientId: CLIENT_ID
});
Object.assign(storage, freshTokens(), { spotifyClientId: CLIENT_ID });

await import('../../background/service-worker.js');
const { SpotifyClient } = await import('../../shared/spotify-client.js');
const { logTelemetry } = await import('../../shared/logger.js');

const TAB = { tab: { id: 7 } };
const send = (message, sender = TAB) => new Promise((resolve) => {
  if (messageListener(message, sender, resolve) !== true) resolve(undefined);
});
const detect = (title, artist, pageInstanceId = 'page-1', extra = {}) => send({
  type: 'NOW_PLAYING_DETECTED',
  payload: { title, artist, pageInstanceId, videoId: 'vid', source: 'youtube', metadataSource: 'media-session', ...extra }
});

test.beforeEach(() => {
  tabMessages.length = 0;
  S.calls = [];
  S.plays = [];
  S.failPlay = [];
  S.playerUpdates = true;
  S.devices = [TUDO];
});

test('auto mode OFF: track is detected but nothing plays', async () => {
  storage.autoModeEnabled = false;
  const res = await detect('Never Gonna Give You Up', 'Rick Astley');
  assert.equal(res.decision, 'SKIP_AUTO_MODE_OFF');
  assert.deepEqual(S.plays, []);
  assert.equal(storage.currentTrack.title, 'Never Gonna Give You Up');
});

test('auto mode ON: new track pauses YouTube and plays on Tudo, confirmed by GET /me/player', async () => {
  storage.autoModeEnabled = true;
  const res = await detect('Never Gonna Give You Up', 'Rick Astley');
  assert.equal(res.decision, 'TRIGGER');
  assert.equal(res.handoff.success, true, res.handoff.message);
  assert.equal(res.handoff.confirmed, true);
  assert.equal(res.handoff.device, 'Tudo');
  assert.deepEqual(S.plays, ['spotify:track:rick']);
  assert.deepEqual(tabMessages, ['PAUSE_AND_MUTE_YOUTUBE']);
  assert.equal(storage.handoffState, 'PLAYING');
  assert.equal(storage.lastHandoffResult.status, 'confirmed');
});

test('same track on the same page is not sent again', async () => {
  const res = await detect('Never Gonna Give You Up', 'Rick Astley');
  assert.equal(res.decision, 'SKIP_ALREADY_SYNCED');
  assert.deepEqual(S.plays, []);
});

test('F5 (new pageInstanceId) sends the same track again', async () => {
  const res = await detect('Never Gonna Give You Up', 'Rick Astley', 'page-2');
  assert.equal(res.decision, 'TRIGGER');
  assert.equal(res.handoff.success, true);
});

test('changing the track on YouTube changes it on Spotify', async () => {
  const res = await detect('Take On Me', 'a-ha', 'page-2');
  assert.equal(res.handoff.success, true);
  assert.equal(S.player.item.uri, 'spotify:track:aha');
});

test('rapid changes: the middle track is dropped and the last one plays', async () => {
  const results = await Promise.all([
    detect('Bohemian Rhapsody', 'Queen', 'page-2'),
    detect('Admirável Chip Novo', 'Pitty', 'page-2'),
    detect('Die With A Smile', 'Lady Gaga', 'page-2')
  ]);
  assert.equal(results[1].handoff.superseded, true);
  assert.ok(!S.plays.includes('spotify:track:pitty'));
  assert.equal(S.plays.at(-1), 'spotify:track:gaga');
});

test('inactive device (404): transfers the session and plays', async () => {
  S.failPlay = [404];
  const res = await detect('POWER', 'Kanye West', 'page-2');
  assert.equal(res.handoff.success, true, res.handoff.message);
  assert.ok(S.calls.includes('PUT api.spotify.com/v1/me/player'));
  assert.deepEqual(S.plays, ['spotify:track:power']);
});

test('failed attempt is not marked as synced, so the retry goes through', async () => {
  S.devices = [];
  const first = await detect('Take On Me', 'a-ha', 'page-3');
  assert.equal(first.handoff.success, false);
  assert.equal(first.handoff.retryable, true);
  assert.equal(first.handoff.errorCode, 'DEVICE_UNAVAILABLE');
  assert.equal(storage.lastAutoSync, undefined);
  assert.deepEqual(tabMessages, [], 'YouTube must not be paused when no device is available');

  S.devices = [TUDO];
  const retry = await detect('Take On Me', 'a-ha', 'page-3', { reason: 'retry-1' });
  assert.equal(retry.decision, 'TRIGGER');
  assert.equal(retry.handoff.success, true);
});

test('weak match (similar title, wrong artist) is not played and not retried', async () => {
  const res = await detect('Power Rangers Theme', 'Kids TV', 'page-3');
  assert.equal(res.handoff.success, false);
  assert.equal(res.handoff.errorCode, 'MATCH_UNCERTAIN');
  assert.equal(res.handoff.retryable, false);
  assert.deepEqual(S.plays, []);
});

test('play accepted but not visible in GET /me/player is reported as unconfirmed', async () => {
  S.playerUpdates = false;
  S.player = null;
  const res = await detect('Bohemian Rhapsody', 'Queen', 'page-3');
  assert.equal(res.handoff.success, true);
  assert.equal(res.handoff.confirmed, false);
  assert.equal(storage.handoffState, 'PLAY_UNCONFIRMED');
  assert.equal(storage.lastHandoffResult.status, 'unconfirmed');
});

test('fallback to Tudo does not overwrite the preferred device', async () => {
  storage.targetDeviceName = 'Echo Pop';
  storage.targetDeviceId = 'dev-echo';

  const offline = await detect('Take On Me', 'a-ha', 'page-4');
  assert.equal(offline.handoff.device, 'Tudo');
  assert.equal(storage.targetDeviceId, 'dev-echo');

  S.devices = [TUDO, ECHO];
  const back = await detect('POWER', 'Kanye West', 'page-4');
  assert.equal(back.handoff.device, 'Echo Pop');

  delete storage.targetDeviceName;
  delete storage.targetDeviceId;
});

test('Spotify refuses the play after YouTube was paused: sound goes back to YouTube', async () => {
  S.failPlay = [403];
  const res = await detect('Admirável Chip Novo', 'Pitty', 'page-5');
  assert.equal(res.handoff.success, false);
  assert.equal(res.handoff.retryable, false);
  assert.deepEqual(tabMessages, ['PAUSE_AND_MUTE_YOUTUBE', 'RESTORE_YOUTUBE']);
});

test('manual handoff with an old stored currentTrack (only normalizedTitle) works', async () => {
  storage.currentTrack = { normalizedTitle: 'Die With A Smile', normalizedArtist: 'Lady Gaga' };
  storage.currentTrackTabId = 7;
  const res = await send({ type: 'TRIGGER_HANDOFF' }, {});
  assert.equal(res.success, true, res.message);
  assert.deepEqual(S.plays, ['spotify:track:gaga']);
});

test('401 before the token expires: refreshes once and repeats the call', async () => {
  S.validAccess = 'rotated-elsewhere';
  const before = S.refreshCalls;
  const res = await detect('Take On Me', 'a-ha', 'page-6');
  assert.equal(res.handoff.success, true, res.handoff.message);
  assert.equal(S.refreshCalls, before + 1);
  assert.equal(S.lastRefreshClientId, CLIENT_ID, 'refresh must use the app that issued the tokens');
});

test('concurrent refresh with a rotating refresh token happens once and keeps the session', async () => {
  storage.spotify_token_expires_at = 0;
  const before = S.refreshCalls;
  const a = new SpotifyClient();
  const b = new SpotifyClient();
  const tokens = await Promise.all([a.getAccessToken(), b.getAccessToken(), a.getAccessToken()]);
  assert.equal(S.refreshCalls, before + 1);
  assert.equal(new Set(tokens).size, 1);
  assert.notEqual(storage.engineState, 'AUTH_REQUIRED');
});

test('revoked refresh token: AUTH_REQUIRED, tokens removed, no retry', async () => {
  Object.assign(storage, { spotify_refresh_token: 'revoked', spotify_token_expires_at: 0 });
  const res = await detect('POWER', 'Kanye West', 'page-7');
  assert.equal(res.handoff.success, false);
  assert.equal(res.handoff.errorCode, 'AUTH_REQUIRED');
  assert.equal(res.handoff.retryable, false);
  assert.equal(storage.spotify_access_token, undefined);
  assert.equal(storage.engineState, 'AUTH_REQUIRED');
});

test('without a Spotify account no request reaches the Web API', async () => {
  const res = await detect('Bohemian Rhapsody', 'Queen', 'page-8');
  assert.equal(res.handoff.errorCode, 'AUTH_REQUIRED');
  assert.deepEqual(S.calls.filter(c => c.includes('api.spotify.com')), []);
});

test('login without a saved Client ID explains what to do and opens no window', async () => {
  let opened = false;
  identityHandler = () => { opened = true; };
  delete storage.spotifyClientId;
  const res = await send({ type: 'SPOTIFY_LOGIN' }, {});
  assert.equal(res.success, false);
  assert.match(res.message, /Client ID/);
  assert.equal(opened, false);
  storage.spotifyClientId = CLIENT_ID;
});

test('login: PKCE authorize URL, state check, code exchange and tokens stored', async () => {
  let authorize;
  identityHandler = (url) => {
    authorize = new URL(url).searchParams;
    return `https://testextid.chromiumapp.org/spotify?code=good-code&state=${authorize.get('state')}`;
  };
  const res = await send({ type: 'SPOTIFY_LOGIN' }, {});
  assert.equal(res.success, true, res.message);

  assert.equal(authorize.get('client_id'), CLIENT_ID);
  assert.equal(authorize.get('response_type'), 'code');
  assert.equal(authorize.get('code_challenge_method'), 'S256');
  assert.equal(authorize.get('redirect_uri'), 'https://testextid.chromiumapp.org/spotify');
  assert.match(authorize.get('scope'), /user-modify-playback-state/);

  const exchange = S.codeExchanges.at(-1);
  const expectedChallenge = createHash('sha256').update(exchange.code_verifier).digest('base64url');
  assert.equal(authorize.get('code_challenge'), expectedChallenge);
  assert.ok(exchange.code_verifier.length >= 43);
  assert.equal(exchange.client_id, CLIENT_ID);
  assert.equal(storage.spotifyTokenClientId, CLIENT_ID);

  assert.equal(storage.spotify_access_token, S.validAccess);
  assert.equal(storage.engineState, 'READY');
  assert.equal(storage.spotifyAuthorizedOnce, true);
  assert.equal(storage.spotifyDisplayName, 'Conta Teste');

  const handoff = await detect('POWER', 'Kanye West', 'page-9');
  assert.equal(handoff.handoff.success, true, handoff.handoff.message);
});

test('Spotify refusing the authorization page explains which Client ID and Redirect URI to check', async () => {
  identityHandler = () => { throw new Error('Authorization page could not be loaded.'); };
  const res = await send({ type: 'SPOTIFY_LOGIN' }, {});
  assert.equal(res.success, false);
  assert.ok(res.message.includes('Redirect URI cadastrada é exatamente https://testextid.chromiumapp.org/spotify'), res.message);
  assert.ok(res.message.includes(CLIENT_ID.slice(-4)), res.message);
  assert.match(storage.authError, /AUTH_PAGE_REJECTED/);
});

test('login with a mismatching state is rejected and stores nothing', async () => {
  const tokenBefore = storage.spotify_access_token;
  identityHandler = () => 'https://testextid.chromiumapp.org/spotify?code=good-code&state=forged';
  const res = await send({ type: 'SPOTIFY_LOGIN' }, {});
  assert.equal(res.success, false);
  assert.match(res.message, /state/);
  assert.equal(storage.spotify_access_token, tokenBefore);
  assert.match(storage.authError, /state/);
});

test('automatic login: a revoked session comes back without a window and the handoff goes through', async () => {
  let details;
  identityHandler = (url, d) => {
    details = d;
    return `https://testextid.chromiumapp.org/spotify?code=good-code&state=${new URL(url).searchParams.get('state')}`;
  };
  storage.lastSilentLoginAt = 0;
  Object.assign(storage, { spotify_refresh_token: 'revoked', spotify_token_expires_at: 0 });

  const res = await detect('Take On Me', 'a-ha', 'page-10');
  assert.equal(res.handoff.success, true, res.handoff.message);
  assert.equal(details.interactive, false, 'automatic login must not open a window');
  assert.equal(storage.spotify_access_token, S.validAccess);
});

test('automatic login is throttled after an attempt', async () => {
  let calls = 0;
  identityHandler = () => { calls++; throw new Error('User interaction required.'); };
  storage.lastSilentLoginAt = Date.now();
  Object.assign(storage, { spotify_refresh_token: 'revoked', spotify_token_expires_at: 0 });

  const res = await detect('POWER', 'Kanye West', 'page-11');
  assert.equal(res.handoff.errorCode, 'AUTH_REQUIRED');
  assert.equal(calls, 0);
});

test('popup automatic login message: no window, failure does not show an error banner', async () => {
  let details;
  identityHandler = (url, d) => { details = d; throw new Error('User interaction required.'); };
  storage.lastSilentLoginAt = 0;
  delete storage.authError;

  const res = await send({ type: 'SPOTIFY_LOGIN', interactive: false }, {});
  assert.equal(res.success, false);
  assert.equal(details.interactive, false);
  assert.equal(storage.authError, undefined);
});

test('login in a browser without chrome.identity fails with a clear message', async () => {
  const identity = chrome.identity;
  delete chrome.identity;
  try {
    const res = await send({ type: 'SPOTIFY_LOGIN' }, {});
    assert.equal(res.success, false);
    assert.match(res.message, /chrome\.identity/);
  } finally {
    chrome.identity = identity;
  }
});

test('logout removes the tokens', async () => {
  const res = await send({ type: 'SPOTIFY_LOGOUT' }, {});
  assert.equal(res.success, true);
  assert.equal(storage.spotify_access_token, undefined);
  assert.equal(storage.spotify_refresh_token, undefined);
  assert.equal(storage.engineState, 'AUTH_REQUIRED');
  assert.equal(storage.autoReauthDisabled, true);
});

test('after logout the automatic login stays off', async () => {
  let calls = 0;
  identityHandler = () => { calls++; return 'https://testextid.chromiumapp.org/spotify?code=good-code&state=x'; };
  storage.lastSilentLoginAt = 0;
  const res = await detect('Bohemian Rhapsody', 'Queen', 'page-12');
  assert.equal(res.handoff.errorCode, 'AUTH_REQUIRED');
  assert.equal(calls, 0);
  assert.equal(storage.spotifyAuthorizedOnce, false);
  assert.equal(storage.autoReauthDisabled, true);
});

// ── Strict AUTH Test Suite (AUTH-01 through AUTH-04) ──
test('AUTH-01: refresh normal recupera access token sem executar launchWebAuthFlow', async () => {
  let webAuthFlowCalls = 0;
  identityHandler = () => {
    webAuthFlowCalls++;
    return 'https://testextid.chromiumapp.org/spotify?code=good-code&state=x';
  };
  // Token expirado mas refresh token válido
  storage.spotify_token_expires_at = Date.now() - 1000;
  storage.spotify_refresh_token = S.validRefresh;
  delete storage.autoReauthDisabled;

  const client = new SpotifyClient();
  const token = await client.getAccessToken();

  assert.ok(token);
  assert.equal(token, S.validAccess);
  assert.equal(webAuthFlowCalls, 0, 'Refresh normal não deve chamar launchWebAuthFlow');
});

test('AUTH-02: invalid_grant -> silent auth funciona se Spotify puder redirecionar sem interacao', async () => {
  let detailsCaptured;
  identityHandler = (url, details) => {
    detailsCaptured = details;
    const state = new URL(url).searchParams.get('state');
    return `https://testextid.chromiumapp.org/spotify?code=good-code&state=${state}`;
  };
  storage.lastSilentLoginAt = 0;
  storage.spotifyAuthorizedOnce = true;
  delete storage.autoReauthDisabled;
  Object.assign(storage, { spotify_refresh_token: 'revoked', spotify_token_expires_at: 0 });

  const client = new SpotifyClient();
  const token = await client.getAccessToken();

  assert.ok(token);
  assert.equal(detailsCaptured.interactive, false, 'Silent re-auth deve ser não-interativo');
  assert.equal(storage.spotify_access_token, S.validAccess);
  assert.equal(storage.engineState, 'READY');
});

test('AUTH-03: silent auth exige UI -> fica AUTH_REQUIRED, sem abrir janela escondida nem loopar', async () => {
  let calls = 0;
  identityHandler = (url, details) => {
    calls++;
    assert.equal(details.interactive, false, 'Tentativa automática não pode ser interativa');
    throw new Error('User interaction required');
  };
  storage.lastSilentLoginAt = 0;
  storage.spotifyAuthorizedOnce = true;
  delete storage.autoReauthDisabled;
  Object.assign(storage, { spotify_refresh_token: 'revoked', spotify_token_expires_at: 0 });

  const client = new SpotifyClient();
  await assert.rejects(
    () => client.getAccessToken(),
    (err) => err.message.startsWith('AUTH_REQUIRED')
  );

  assert.equal(calls, 1, 'Deve tentar exatamente uma vez');
  assert.equal(storage.engineState, 'AUTH_REQUIRED');
  assert.equal(storage.spotify_access_token, undefined);
  assert.ok(Date.now() - storage.lastSilentLoginAt < 5000, 'Cooldown de 2 minutos deve ser persistido em storage');
});

test('AUTH-04: usuario clica Desconectar -> nenhuma tentativa automatica ocorre depois, mesmo apos 401/reload', async () => {
  let webAuthFlowCalls = 0;
  identityHandler = () => {
    webAuthFlowCalls++;
    return 'https://testextid.chromiumapp.org/spotify?code=good-code&state=x';
  };
  storage.lastSilentLoginAt = 0;

  // Usuário desconecta explicitamente
  const logoutRes = await send({ type: 'SPOTIFY_LOGOUT' }, {});
  assert.equal(logoutRes.success, true);
  assert.equal(storage.autoReauthDisabled, true);
  assert.equal(storage.spotifyAuthorizedOnce, false);

  // Simula detecção de música no YouTube após 401 ou reload de página
  const detectRes = await detect('Never Gonna Give You Up', 'Rick Astley', 'page-after-logout');
  assert.equal(detectRes.handoff.errorCode, 'AUTH_REQUIRED');
  assert.equal(webAuthFlowCalls, 0, 'Nenhuma tentativa automática deve ocorrer após logout explícito');

  // Simula cliente tentando getAccessToken diretamente
  const client = new SpotifyClient();
  await assert.rejects(
    () => client.getAccessToken(),
    (err) => err.message.startsWith('AUTH_REQUIRED')
  );
  assert.equal(webAuthFlowCalls, 0, 'Cliente não deve disparar silent login após logout explícito');
});

test('old tokens without a known Client ID ask for a new login instead of failing silently', async () => {
  const savedClientId = storage.spotifyClientId;
  delete storage.spotifyClientId;
  delete storage.spotifyTokenClientId;
  Object.assign(storage, { spotify_access_token: 'legacy', spotify_refresh_token: 'legacy', spotify_token_expires_at: 0, engineState: 'READY' });

  const res = await detect('POWER', 'Kanye West', 'page-13');
  assert.equal(res.handoff.errorCode, 'AUTH_REQUIRED');
  assert.equal(storage.spotify_refresh_token, undefined);
  storage.spotifyClientId = savedClientId;
});

test('telemetry keeps every event written concurrently', async () => {
  storage.telemetryLogs = [];
  await Promise.all(Array.from({ length: 30 }, (_, i) => logTelemetry(`EVT_${i}`)));
  assert.equal(storage.telemetryLogs.length, 30);
});

