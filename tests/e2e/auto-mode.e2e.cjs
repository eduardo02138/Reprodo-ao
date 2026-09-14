// E2E audit of the auto mode: loads THIS repository as an unpacked extension in Chromium,
// drives the real YouTube site and mocks the Spotify Web API (no request reaches Spotify).
// Run: npm run test:e2e   (set CHROMIUM_PATH if Playwright's browser is not installed)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-chromium');

const EXT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '.output');
fs.mkdirSync(OUT, { recursive: true });

// Branded Google Chrome ignores --load-extension; use Chromium / Chrome for Testing
function findBrowser() {
  let bundled = null;
  try { bundled = chromium.executablePath(); } catch (e) {}
  return [process.env.CHROMIUM_PATH, bundled].filter(Boolean).find(p => fs.existsSync(p)) || null;
}

const V = {
  rick: { id: 'dQw4w9WgXcQ', re: /never.?gonna/i },
  aha: { id: 'djV11Xbc914', re: /take.?on.?me/i },
  queen: { id: 'fJ9rUzIMcZQ', re: /bohemian/i },
  despacito: { id: 'kJQP7kiw5Fk', re: /despacito/i },
  gangnam: { id: '9bZkp7q19f0', re: /gangnam/i },
  uptown: { id: 'OPf0YbXqDm0', re: /uptown/i },
  seeyou: { id: 'RgKAFK5djSk', re: /see.?you/i },
  shape: { id: 'JGwWNGJdvx8', re: /shape.?of.?you/i }
};
const TUDO = { id: 'dev-tudo', name: 'Tudo', type: 'Speaker', is_active: false, volume_percent: 40, supports_volume: true };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const results = [];
const record = (id, name, status, evidence = {}) => {
  results.push({ id, name, status, evidence });
  console.log(`[${status}] ${id} ${name} ${JSON.stringify(evidence)}`);
};

const spot = { requests: [], plays: [], transfers: [], player: null, failPlay: [], devices: [TUDO] };
const okPlays = () => spot.plays.filter(p => p.uri && !p.failed);

async function waitFor(fn, timeout, interval = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  return null;
}
// Real YouTube ads can run for minutes. The extension correctly waits for them to end,
// so while waiting the test clicks "Skip ad" like a user would.
let activePage = null;
let skipClicks = 0;
async function skipAdIfPossible() {
  if (!activePage) return;
  // YouTube ignores a synthetic element.click() on "Skip": use a real (trusted) mouse click
  const skip = activePage.locator('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern').first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click({ timeout: 1000 }).then(() => { skipClicks++; }).catch(() => {});
  }
}
const waitPlay = (re, since, timeout = 120000) => waitFor(async () => {
  await skipAdIfPossible();
  return okPlays().find(p => p.t >= since && re.test(p.uri));
}, timeout);

async function videoState(page) {
  return page.evaluate(() => {
    const v = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
    return {
      paused: v ? v.paused : null,
      muted: v ? v.muted : null,
      mediaTitle: navigator.mediaSession?.metadata?.title || null,
      url: location.href,
      ad: !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting')
    };
  }).catch(e => ({ error: e.message }));
}

const loadInPlace = (page, id) => page.evaluate((vid) => {
  const p = document.getElementById('movie_player');
  if (!p?.loadVideoById) return false;
  p.loadVideoById(vid);
  return true;
}, id);

async function routeSpotify(ctx) {
  await ctx.route(/https:\/\/(api|accounts)\.spotify\.com\/.*/, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const method = req.method();
    const t = Date.now();
    const p = u.pathname;
    spot.requests.push({ t, method, path: p });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const empty = () => route.fulfill({ status: 204, body: '' });
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (e) {}

    if (u.hostname === 'accounts.spotify.com') {
      return json({ access_token: `mock-${t}`, refresh_token: 'mock-refresh', expires_in: 3600, token_type: 'Bearer' });
    }
    if (p === '/v1/me') return json({ display_name: 'Conta Teste', product: 'premium' });
    if (p === '/v1/me/player/devices') {
      return json({ devices: spot.devices.map(d => ({ ...d, is_active: !!spot.player && d.id === spot.player.device.id })) });
    }
    if (p === '/v1/search') {
      const q = u.searchParams.get('q') || '';
      const tm = q.match(/track:"([^"]+)"/);
      const am = q.match(/artist:"([^"]+)"/);
      const name = tm ? tm[1] : q;
      const artist = am ? am[1] : (tm ? 'Unknown' : q);
      spot.lastSearch = q;
      return json({ tracks: { items: [{ id: slug(name), name, artists: [{ name: artist }], album: { name, images: [] }, uri: `spotify:track:${slug(name)}` }] } });
    }
    if (p === '/v1/me/player/play' && method === 'PUT') {
      const fail = spot.failPlay.shift();
      if (fail) {
        spot.plays.push({ t, failed: fail });
        return json({ error: { status: fail, message: `mock failure ${fail}` } }, fail);
      }
      const uri = body.uris?.[0] || spot.player?.item?.uri || null;
      spot.plays.push({ t, uri, explicit: !!body.uris, deviceId: u.searchParams.get('device_id') });
      if (uri) spot.player = { is_playing: true, device: TUDO, item: { uri, name: uri, artists: [{ name: 'mock' }], album: { images: [] } } };
      return empty();
    }
    if (p === '/v1/me/player' && method === 'PUT') {
      spot.transfers.push({ t, body });
      return empty();
    }
    if ((p === '/v1/me/player' || p === '/v1/me/player/currently-playing') && method === 'GET') {
      return spot.player ? json(spot.player) : empty();
    }
    if (p === '/v1/me/player/pause' && spot.player) spot.player.is_playing = false;
    return empty();
  });
}

(async () => {
  const browser = findBrowser();
  if (!browser) {
    console.error('Chromium não encontrado: rode `npx playwright install chromium` ou defina CHROMIUM_PATH.');
    process.exit(2);
  }

  const profile = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: browser,
    headless: true,
    // pt-BR on purpose: YouTube shows uploader-translated titles there ("Shape of You" → "A Sua Forma")
    locale: 'pt-BR',
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--autoplay-policy=no-user-gesture-required',
      // Safety net: anything that escapes the mocked route cannot reach the real Spotify
      '--host-resolver-rules=MAP api.spotify.com ~NOTFOUND, MAP accounts.spotify.com ~NOTFOUND'
    ]
  });
  await routeSpotify(ctx);

  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const pageErrors = [];
  const syncLogs = [];

  async function withPopup(fn) {
    const popup = await ctx.newPage();
    popup.on('pageerror', e => pageErrors.push(`popup: ${e.message}`));
    await popup.setViewportSize({ width: 380, height: 1200 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await sleep(1500);
    try { return await fn(popup); } finally { await popup.close(); }
  }

  const setAutoMode = (on) => withPopup(async (popup) => {
    const checked = await popup.$eval('#auto-mode-toggle', el => el.checked);
    if (checked !== on) await popup.locator('label.switch', { has: popup.locator('#auto-mode-toggle') }).click();
    await sleep(800);
    const stored = await sw.evaluate(() => chrome.storage.local.get('autoModeEnabled'));
    const badge = (await popup.textContent('#auto-mode-badge')).trim();
    return { stored: stored.autoModeEnabled, badge };
  });

  // A0 — no Spotify account: popup offers login instead of claiming to be connected
  try {
    const r = await withPopup(async (popup) => ({
      indicator: (await popup.textContent('#auth-indicator')).trim(),
      button: (await popup.textContent('#auth-btn')).trim(),
      setupVisible: await popup.isVisible('#auth-setup'),
      redirectUri: (await popup.textContent('#redirect-uri')).trim(),
      devices: (await popup.textContent('#device-list')).trim(),
      // The account card must be the first thing under the header, above the auto mode card
      cardOnTop: await popup.evaluate(() =>
        document.getElementById('account-card').getBoundingClientRect().top
        < document.querySelector('.auto-mode-card').getBoundingClientRect().top)
    }));
    const ok = /Conectar/.test(r.button) && /desconectado/.test(r.indicator) && r.setupVisible && r.cardOnTop
      && /^https:\/\/[a-z]+\.chromiumapp\.org\/spotify$/.test(r.redirectUri) && /Conecte/.test(r.devices);
    record('A0', 'Sem conta: popup oferece login e mostra a Redirect URI', ok ? 'PASS' : 'FAIL', r);
  } catch (e) { record('A0', 'Sem conta: popup oferece login e mostra a Redirect URI', 'FAIL', { error: e.message }); }

  // A0b — Client ID is saved from the panel (no code change) and unlocks the login button
  try {
    const r = await withPopup(async (popup) => {
      const btnDisabledBefore = await popup.$eval('#auth-btn', b => b.disabled);
      await popup.fill('#client-id-input', '123');
      await popup.click('#save-client-id-btn');
      const invalidMsg = (await popup.textContent('#client-id-status')).trim();
      await popup.fill('#client-id-input', 'abcdef0123456789abcdef0123456789');
      await popup.click('#save-client-id-btn');
      await sleep(500);
      return {
        btnDisabledBefore,
        invalidMsg,
        validMsg: (await popup.textContent('#client-id-status')).trim(),
        btnDisabledAfter: await popup.$eval('#auth-btn', b => b.disabled),
        stored: (await sw.evaluate(() => chrome.storage.local.get('spotifyClientId'))).spotifyClientId
      };
    });
    const ok = r.btnDisabledBefore && /inválido/.test(r.invalidMsg) && /salvo/.test(r.validMsg)
      && !r.btnDisabledAfter && r.stored === 'abcdef0123456789abcdef0123456789';
    record('A0b', 'Client ID salvo pelo painel libera o login', ok ? 'PASS' : 'FAIL', r);
  } catch (e) { record('A0b', 'Client ID salvo pelo painel libera o login', 'FAIL', { error: e.message }); }

  // Simulates a finished login (the OAuth window itself cannot run headless)
  await sw.evaluate(async () => chrome.storage.local.set({
    spotify_access_token: 'mock-access',
    spotify_refresh_token: 'mock-refresh',
    spotify_token_expires_at: Date.now() + 3600 * 1000,
    spotifyTokenClientId: 'abcdef0123456789abcdef0123456789',
    engineState: 'READY'
  }));

  // A1 — connected: popup shows the real state and lists devices
  try {
    const r = await withPopup(async (popup) => {
      await popup.waitForSelector('.device-item', { timeout: 8000 }).catch(() => {});
      return {
        indicator: (await popup.textContent('#auth-indicator')).trim(),
        button: (await popup.textContent('#auth-btn')).trim(),
        setupVisible: await popup.isVisible('#auth-setup'),
        devices: await popup.$$eval('.device-name', els => els.map(e => e.textContent))
      };
    });
    const ok = /Conectado como Conta Teste/.test(r.indicator) && /Desconectar/.test(r.button) && !r.setupVisible && r.devices.includes('Tudo');
    record('A1', 'Conectado: popup mostra estado real e lista dispositivos', ok ? 'PASS' : 'FAIL', r);
  } catch (e) { record('A1', 'Conectado: popup mostra estado real e lista dispositivos', 'FAIL', { error: e.message }); }

  // S0 — auto mode via the real popup toggle
  try {
    const r = await setAutoMode(true);
    record('S0', 'Popup liga o modo automático', r.stored === true && r.badge === 'ON' ? 'PASS' : 'FAIL', r);
  } catch (e) { record('S0', 'Popup liga o modo automático', 'FAIL', { error: e.message }); }

  const page = await ctx.newPage();
  activePage = page;
  page.on('pageerror', e => pageErrors.push(`youtube: ${e.message}`));
  page.on('console', m => {
    const text = m.text();
    if (text.includes('[SyncMusic]')) syncLogs.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  });

  let t0 = Date.now();
  try {
    await page.goto(`https://www.youtube.com/watch?v=${V.rick.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const play = await waitPlay(V.rick.re, t0);
    await sleep(2500);
    const vs = await videoState(page);
    record('S1', 'Abrir vídeo toca no Spotify (Tudo)', play ? 'PASS' : 'FAIL', { latencyMs: play ? play.t - t0 : null, uri: play?.uri });
    record('S1b', 'YouTube pausado após o handoff', play && vs.paused ? 'PASS' : 'FAIL', vs);
  } catch (e) { record('S1', 'Abrir vídeo toca no Spotify (Tudo)', 'FAIL', { error: e.message }); }

  t0 = Date.now();
  await sleep(15000);
  const repeats = okPlays().filter(p => p.t >= t0);
  record('S2', 'Sem play repetido em 15s na mesma faixa', repeats.length === 0 ? 'PASS' : 'FAIL', { playsIn15s: repeats.length });

  // S3 — ads must be ignored and the song goes out when they end.
  // A simulated ad covers the track change; loadVideoById often also brings a real ad on top of it.
  t0 = Date.now();
  try {
    await page.evaluate(() => {
      const player = document.getElementById('movie_player');
      player.classList.add('ad-showing');
      window.__fakeAd = setInterval(() => player.classList.add('ad-showing'), 200);
    });
    await loadInPlace(page, V.aha.id);
    await sleep(8000);
    await page.evaluate(() => {
      clearInterval(window.__fakeAd);
      const player = document.getElementById('movie_player');
      // A real ad also sets ad-interrupting; stripping its ad-showing would hide the "Skip" button
      if (!player.classList.contains('ad-interrupting')) player.classList.remove('ad-showing');
    });
    const adEnd = Date.now();
    // Real ads can be long: wait up to 3 min, skipping them like a user would
    const play = await waitPlay(V.aha.re, t0, 180000);
    const vs = await videoState(page);
    const wrongPlays = okPlays().filter(p => p.t >= t0 && !V.aha.re.test(p.uri)).map(p => p.uri);
    record('S3a', 'Anúncio (simulado e real) nunca é enviado ao Spotify', wrongPlays.length === 0 ? 'PASS' : 'FAIL',
      { playsOtherThanSong: wrongPlays, adStillShowing: vs.ad, mediaTitleNow: vs.mediaTitle });
    if (play) {
      record('S3b', 'Música vai ao Spotify quando o anúncio termina', 'PASS', { afterSimulatedAdMs: play.t - adEnd, uri: play.uri, skipClicks });
    } else {
      record('S3b', 'Música vai ao Spotify quando o anúncio termina', vs.ad ? 'SKIP' : 'FAIL',
        { note: vs.ad ? 'anúncio real do YouTube ainda em exibição após 3 min' : 'sem anúncio e sem handoff', youtube: vs, skipClicks });
    }
  } catch (e) { record('S3a', 'Anúncio (simulado e real) nunca é enviado ao Spotify', 'FAIL', { error: e.message }); }

  // S4 — SPA navigation to another video
  t0 = Date.now();
  try {
    await page.evaluate((id) => {
      document.querySelector('ytd-app').dispatchEvent(new CustomEvent('yt-navigate', {
        bubbles: true, composed: true,
        detail: { endpoint: { commandMetadata: { webCommandMetadata: { url: `/watch?v=${id}`, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } }, watchEndpoint: { videoId: id } } }
      }));
    }, V.queen.id);
    const navigated = await waitFor(async () => page.url().includes(V.queen.id), 10000);
    if (!navigated) {
      record('S4', 'Navegação SPA troca no Spotify', 'SKIP', { note: 'yt-navigate não navegou nesta versão do YouTube' });
    } else {
      const play = await waitPlay(V.queen.re, t0, 180000);
      const vs = await videoState(page);
      const wrongPlays = okPlays().filter(p => p.t >= t0 && !V.queen.re.test(p.uri)).map(p => p.uri);
      const status = wrongPlays.length ? 'FAIL' : (play ? 'PASS' : (vs.ad ? 'SKIP' : 'FAIL'));
      record('S4', 'Navegação SPA troca no Spotify', status, {
        latencyMs: play ? play.t - t0 : null,
        uri: play?.uri,
        playsOtherThanSong: wrongPlays,
        note: !play && vs.ad ? 'anúncio real do YouTube ainda em exibição após 3 min' : undefined,
        youtube: play ? undefined : vs,
        skipClicks
      });
    }
  } catch (e) { record('S4', 'Navegação SPA troca no Spotify', 'FAIL', { error: e.message }); }

  // S5 — F5 on the same track
  t0 = Date.now();
  try {
    const current = await videoState(page);
    const target = Object.values(V).find(v => current.url.includes(v.id)) || V.rick;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    const play = await waitPlay(target.re, t0);
    record('S5', 'F5 na mesma música dispara de novo', play ? 'PASS' : 'FAIL', { video: target.id, latencyMs: play ? play.t - t0 : null });
  } catch (e) { record('S5', 'F5 na mesma música dispara de novo', 'FAIL', { error: e.message }); }

  // S6 — rapid switching: only the last track may end up playing
  t0 = Date.now();
  try {
    await loadInPlace(page, V.despacito.id);
    await sleep(400);
    await loadInPlace(page, V.gangnam.id);
    await waitPlay(V.gangnam.re, t0);
    await sleep(6000);
    const order = okPlays().filter(p => p.t >= t0).map(p => p.uri);
    record('S6', 'Troca rápida: última música vence', V.gangnam.re.test(order.at(-1) || '') ? 'PASS' : 'FAIL', { playsInOrder: order });
  } catch (e) { record('S6', 'Troca rápida: última música vence', 'FAIL', { error: e.message }); }

  // S7 — Spotify refuses the play: YouTube must play again with sound
  t0 = Date.now();
  try {
    spot.failPlay = [403, 403, 403];
    await loadInPlace(page, V.uptown.id);
    const attempted = await waitFor(() => spot.plays.find(p => p.t >= t0 && p.failed), 60000);
    await sleep(5000);
    const vs = await videoState(page);
    spot.failPlay = [];
    record('S7', 'Play recusado (403): YouTube volta a tocar com som', attempted && vs.paused === false && vs.muted === false ? 'PASS' : 'FAIL', { playAttempted: !!attempted, youtube: vs });
  } catch (e) { record('S7', 'Play recusado (403): YouTube volta a tocar com som', 'FAIL', { error: e.message }); }

  // S8 — inactive device (404): transfer and play
  t0 = Date.now();
  try {
    spot.failPlay = [404];
    await loadInPlace(page, V.seeyou.id);
    const play = await waitPlay(V.seeyou.re, t0);
    spot.failPlay = [];
    record('S8', 'Dispositivo inativo (404): transfere e toca', play ? 'PASS' : 'FAIL', { transfers: spot.transfers.filter(x => x.t >= t0).length, uri: play?.uri });
  } catch (e) { record('S8', 'Dispositivo inativo (404): transfere e toca', 'FAIL', { error: e.message }); }

  // S14 — transient failure (device offline) is retried on its own
  t0 = Date.now();
  try {
    spot.devices = [];
    await loadInPlace(page, V.shape.id);
    const attempt = await waitFor(() => spot.requests.find(r => r.t >= t0 && r.path === '/v1/me/player/devices'), 60000);
    await sleep(3000);
    const early = okPlays().filter(p => p.t >= t0).length;
    const duringFailure = await videoState(page);
    spot.devices = [TUDO];
    const play = await waitPlay(/shape.?of.?you|a.?sua.?forma/i, t0);
    record('S14', 'Falha transitória (sem dispositivo) é re-tentada sozinha', attempt && early === 0 && play ? 'PASS' : 'FAIL',
      { firstAttemptMs: attempt ? attempt.t - t0 : null, playMs: play ? play.t - t0 : null, uri: play?.uri, youtubeDuringFailure: duringFailure });
    await sleep(8000);
    const shapePlays = okPlays().filter(p => p.t >= t0).map(p => p.uri);
    record('S16', 'Título traduzido pelo YouTube não vira segunda música', shapePlays.length === 1 ? 'PASS' : 'FAIL',
      { playsInOrder: shapePlays, mediaTitleNow: (await videoState(page)).mediaTitle });
  } catch (e) { record('S14', 'Falha transitória (sem dispositivo) é re-tentada sozinha', 'FAIL', { error: e.message }); }

  // S9 — auto mode OFF: nothing goes to Spotify and YouTube keeps its sound
  try {
    const toggle = await setAutoMode(false);
    await sleep(1500);
    t0 = Date.now();
    await loadInPlace(page, V.rick.id);
    await sleep(14000);
    const plays = okPlays().filter(p => p.t >= t0);
    const vs = await videoState(page);
    record('S9', 'Modo automático OFF: troca não vai ao Spotify', plays.length === 0 && toggle.stored === false ? 'PASS' : 'FAIL', { toggle, playsAfterOff: plays.length });
    record('S9b', 'Modo OFF: YouTube com som', vs.muted === false ? 'PASS' : 'FAIL', vs);
  } catch (e) { record('S9', 'Modo automático OFF: troca não vai ao Spotify', 'FAIL', { error: e.message }); }

  // S10 — turning auto mode on while music plays sends the current track
  try {
    await page.evaluate(() => { const v = document.querySelector('video'); v.muted = false; return v.play(); }).catch(() => {});
    t0 = Date.now();
    const toggle = await setAutoMode(true);
    const play = await waitPlay(V.rick.re, t0, 20000);
    record('S10', 'Ligar o modo com música tocando envia a faixa atual', play ? 'PASS' : 'FAIL', { toggle, latencyMs: play ? play.t - t0 : null });
  } catch (e) { record('S10', 'Ligar o modo com música tocando envia a faixa atual', 'FAIL', { error: e.message }); }

  // S11 — YouTube home must not become a "song" (first let the S10 handoff finish verifying playback)
  await sleep(6000);
  t0 = Date.now();
  try {
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(12000);
    const plays = okPlays().filter(p => p.t >= t0).map(p => p.uri);
    const requests = spot.requests.filter(r => r.t >= t0);
    record('S11', 'Home do YouTube não dispara handoff', plays.length === 0 ? 'PASS' : 'FAIL', { plays, lastSearch: spot.lastSearch });
    record('S12', 'Sem tráfego Spotify com popup fechado e sem troca (12s)', requests.length === 0 ? 'PASS' : 'FAIL', { requests: requests.length, paths: [...new Set(requests.map(r => r.path))] });
  } catch (e) { record('S11', 'Home do YouTube não dispara handoff', 'FAIL', { error: e.message }); }

  const telemetry = await sw.evaluate(() => chrome.storage.local.get(['telemetryLogs', 'lastHandoffResult'])).catch(() => ({}));
  await withPopup(async (popup) => {
    await sleep(2000);
    record('S15', 'Popup mostra o resultado do último handoff', (await popup.isVisible('#last-handoff')) ? 'PASS' : 'FAIL',
      { text: (await popup.textContent('#last-handoff')).trim(), stored: telemetry.lastHandoffResult?.status });
    await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
  }).catch((e) => record('S15', 'Popup mostra o resultado do último handoff', 'FAIL', { error: e.message }));

  record('S13', 'Sem exceções JS não tratadas (popup/YouTube)', pageErrors.length === 0 ? 'PASS' : 'FAIL', { pageErrors: pageErrors.slice(0, 10) });

  const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    extension: EXT,
    chromium: ctx.browser()?.version(),
    summary,
    results,
    spotifyMock: { totalRequests: spot.requests.length, plays: spot.plays, transfers: spot.transfers.length },
    skipClicks,
    telemetryLast: (telemetry.telemetryLogs || []).slice(0, 300),
    contentScriptLogs: syncLogs
  }, null, 2));
  console.log('SUMMARY', JSON.stringify(summary));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exitCode = summary.FAIL ? 1 : 0;
})().catch(e => { console.error('E2E_HARNESS_FAIL', e.stack); process.exit(1); });
