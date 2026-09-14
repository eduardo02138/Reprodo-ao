// Teste do fluxo do modo automático no service worker real, com chrome.* e Spotify simulados.
// Rodar: node --test tests/auto-mode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// Os sleeps do handoff (transferência/verificação) viram 0 ms
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, 0, ...args);
console.log = () => {};

const storage = {
  spotify_access_token: 'tok-0',
  spotify_refresh_token: 'ref-0',
  spotify_token_expires_at: Date.now() + 3600000
};
const tabMessages = [];
let messageListener;

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = typeof keys === 'string' ? [keys] : keys;
        return Object.fromEntries(list.filter(k => k in storage).map(k => [k, structuredClone(storage[k])]));
      },
      set: async (obj) => { Object.assign(storage, structuredClone(obj)); }
    }
  },
  runtime: {
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    getURL: (p) => `chrome-extension://test/${p}`
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    sendMessage: async (tabId, msg) => {
      tabMessages.push(msg.type);
      return msg.type === 'PAUSE_AND_MUTE_YOUTUBE' ? { paused: true } : { restored: true };
    }
  }
};

const spotify = {
  devices: [{ id: 'dev-tudo', name: 'Tudo', type: 'Speaker', is_active: false }],
  catalog: [
    ['Never Gonna Give You Up', 'Rick Astley', 'rick'],
    ['Take On Me', 'a-ha', 'aha'],
    ['POWER', 'Kanye West', 'power'],
    ['Bohemian Rhapsody', 'Queen', 'queen'],
    ['Admirável Chip Novo', 'Pitty', 'pitty'],
    ['Die With A Smile', 'Lady Gaga', 'gaga']
  ].map(([name, artist, id]) => ({ name, artists: [{ name: artist }], album: { name }, uri: `spotify:track:${id}` })),
  player: null,
  calls: [],
  plays: [],
  playFailures: [],
  refreshes: 0,
  revokedToken: null
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  spotify.calls.push(`${method} ${u.pathname}`);

  if (u.hostname === 'accounts.spotify.com') {
    spotify.refreshes++;
    return json({ access_token: `tok-${spotify.refreshes}`, refresh_token: `ref-${spotify.refreshes}`, expires_in: 3600 });
  }
  if (opts.headers?.Authorization === `Bearer ${spotify.revokedToken}`) {
    return json({ error: { status: 401, message: 'The access token expired' } }, 401);
  }
  if (u.pathname === '/v1/me/player/devices') return json({ devices: spotify.devices });
  if (u.pathname === '/v1/search') {
    const q = u.searchParams.get('q').toLowerCase();
    return json({ tracks: { items: spotify.catalog.filter(t => q.includes(t.name.toLowerCase())) } });
  }
  if (u.pathname === '/v1/me/player/play' && method === 'PUT') {
    const status = spotify.playFailures.shift();
    if (status) return json({ error: { status, message: `mock ${status}` } }, status);
    const uri = JSON.parse(opts.body).uris[0];
    const device = spotify.devices.find(d => d.id === u.searchParams.get('device_id'));
    spotify.plays.push(uri);
    spotify.player = { is_playing: true, device, item: spotify.catalog.find(t => t.uri === uri) };
    return new Response(null, { status: 204 });
  }
  if (u.pathname === '/v1/me/player' && method === 'PUT') return new Response(null, { status: 204 });
  if (u.pathname === '/v1/me/player') return spotify.player ? json(spotify.player) : new Response(null, { status: 204 });
  return json({ error: 'not mocked' }, 500);
};

await import('../background/service-worker.js');
const { SpotifyClient } = await import('../shared/spotify-client.js');

const TAB = { tab: { id: 7, url: 'https://www.youtube.com/watch?v=x' } };

function send(message, sender = TAB) {
  return new Promise((resolve) => {
    if (messageListener(message, sender, resolve) !== true) resolve(undefined);
  });
}

const detected = (title, artist, pageInstanceId = 'page-1') => send({
  type: 'NOW_PLAYING_DETECTED',
  payload: { title, artist, source: 'youtube', metadataSource: 'media-session', pageInstanceId, signature: `${title}|${artist}`.toLowerCase() }
});

test.beforeEach(() => {
  tabMessages.length = 0;
  spotify.calls = [];
  spotify.plays = [];
  spotify.playFailures = [];
});

test('modo automático OFF: detecta, mas não toca', async () => {
  storage.autoModeEnabled = false;
  const res = await detected('Never Gonna Give You Up', 'Rick Astley');
  assert.equal(res.decision, 'SKIP_AUTO_MODE_OFF');
  assert.deepEqual(spotify.plays, []);
  assert.equal(storage.currentTrack.title, 'Never Gonna Give You Up');
});

test('modo automático ON: nova faixa pausa o YouTube e toca no Tudo', async () => {
  storage.autoModeEnabled = true;
  const res = await detected('Never Gonna Give You Up', 'Rick Astley');
  assert.equal(res.decision, 'TRIGGER');
  assert.equal(res.handoff.success, true, res.handoff.message);
  assert.equal(res.handoff.device, 'Tudo');
  assert.deepEqual(spotify.plays, ['spotify:track:rick']);
  assert.deepEqual(tabMessages, ['PAUSE_AND_MUTE_YOUTUBE']);
  assert.equal(res.handoff.verification.verified, true);
});

test('mesma faixa na mesma página não repete o play', async () => {
  const res = await detected('Never Gonna Give You Up', 'Rick Astley');
  assert.equal(res.decision, 'SKIP_ALREADY_SYNCED');
  assert.deepEqual(spotify.plays, []);
});

test('F5 na página (novo pageInstanceId) reenvia a mesma faixa', async () => {
  const res = await detected('Never Gonna Give You Up', 'Rick Astley', 'page-2');
  assert.equal(res.decision, 'TRIGGER');
  assert.equal(res.handoff.success, true);
  assert.deepEqual(spotify.plays, ['spotify:track:rick']);
});

test('troca de música no YouTube troca no Spotify', async () => {
  const res = await detected('Take On Me', 'a-ha', 'page-2');
  assert.equal(res.handoff.success, true);
  assert.deepEqual(spotify.plays, ['spotify:track:aha']);
  assert.equal(spotify.player.item.uri, 'spotify:track:aha');
});

test('trocas rápidas: faixa intermediária é descartada, a última toca', async () => {
  const results = await Promise.all([
    detected('Bohemian Rhapsody', 'Queen', 'page-2'),
    detected('Admirável Chip Novo', 'Pitty', 'page-2'),
    detected('Die With A Smile', 'Lady Gaga', 'page-2')
  ]);
  assert.equal(results[1].handoff.superseded, true);
  assert.ok(!spotify.plays.includes('spotify:track:pitty'));
  assert.equal(spotify.plays.at(-1), 'spotify:track:gaga');
  assert.equal(spotify.player.item.uri, 'spotify:track:gaga');
});

test('dispositivo inativo (404): transfere a sessão e repete o play', async () => {
  spotify.playFailures = [404];
  const res = await detected('POWER', 'Kanye West', 'page-2');
  assert.equal(res.handoff.success, true, res.handoff.message);
  const playIdx = spotify.calls.indexOf('PUT /v1/me/player/play');
  const transferIdx = spotify.calls.indexOf('PUT /v1/me/player');
  assert.ok(playIdx >= 0 && transferIdx > playIdx, spotify.calls.join('\n'));
  assert.deepEqual(spotify.plays, ['spotify:track:power']);
});

test('ID salvo do grupo mudou: re-resolve "Tudo" pelo nome e atualiza o cache', async () => {
  storage.targetDeviceId = 'dev-antigo';
  storage.targetDeviceName = 'Tudo';
  spotify.devices = [{ id: 'dev-celular', name: 'Celular', type: 'Smartphone', is_active: true }, { id: 'dev-tudo-2', name: 'Tudo', type: 'Speaker', is_active: false }];
  const res = await detected('Bohemian Rhapsody', 'Queen', 'page-2');
  assert.equal(res.handoff.success, true);
  assert.equal(res.handoff.device, 'Tudo');
  assert.equal(storage.targetDeviceId, 'dev-tudo-2');
});

test('música fora do catálogo: não pausa o YouTube e não toca nada', async () => {
  const res = await detected('Faixa Inexistente XYZ', 'Ninguém', 'page-2');
  assert.equal(res.handoff.success, false);
  assert.deepEqual(spotify.plays, []);
  assert.deepEqual(tabMessages, []);
});

test('match fraco (título só parecido, artista errado) não toca', async () => {
  const res = await detected('Power Rangers Theme', 'Kids TV', 'page-2');
  assert.equal(res.handoff.success, false);
  assert.match(res.handoff.message, /Match fraco/);
  assert.deepEqual(spotify.plays, []);
});

test('Spotify recusa o play depois da pausa: devolve o som ao YouTube', async () => {
  spotify.playFailures = [403];
  const res = await detected('Take On Me', 'a-ha', 'page-3');
  assert.equal(res.handoff.success, false);
  assert.deepEqual(tabMessages, ['PAUSE_AND_MUTE_YOUTUBE', 'RESTORE_YOUTUBE']);
});

test('botão manual com currentTrack antigo (só normalizedTitle) funciona', async () => {
  storage.currentTrack = { normalizedTitle: 'Admirável Chip Novo', normalizedArtist: 'Pitty' };
  storage.currentTrackTabId = 7;
  const res = await send({ type: 'TRIGGER_HANDOFF', autoPause: true }, {});
  assert.equal(res.success, true, res.message);
  assert.deepEqual(spotify.plays, ['spotify:track:pitty']);
});

test('token recusado (401): renova uma vez e repete a chamada', async () => {
  spotify.revokedToken = storage.spotify_access_token;
  const before = spotify.refreshes;
  const res = await detected('POWER', 'Kanye West', 'page-4');
  assert.equal(res.handoff.success, true, res.handoff.message);
  assert.equal(spotify.refreshes, before + 1);
  spotify.revokedToken = null;
});

test('refresh concorrente acontece uma vez só (refresh token rotativo)', async () => {
  storage.spotify_token_expires_at = 0;
  const before = spotify.refreshes;
  const a = new SpotifyClient();
  const b = new SpotifyClient();
  const tokens = await Promise.all([a.getAccessToken(), b.getAccessToken(), a.getAccessToken()]);
  assert.equal(spotify.refreshes, before + 1);
  assert.equal(new Set(tokens).size, 1);
});
