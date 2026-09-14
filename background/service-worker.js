// Background Service Worker (Manifest V3 Modular)
// Unified handoff executor: both manual and auto use the same pipeline
import { SpotifyProvider } from '../providers/spotify-provider.js';
import { scoreTrackMatch } from '../shared/confidence-engine.js';
import { logTelemetry } from '../shared/logger.js';
import { loginWithSpotify, logoutSpotify } from '../shared/auth.js';

const spotify = new SpotifyProvider();

// Below this the match is uncertain: a title that merely contains the query with a wrong artist scores 40
const MIN_CONFIDENCE = 50;
const VERIFY_ATTEMPTS = 4;
const VERIFY_INTERVAL_MS = 1000;
const TRANSFER_SETTLE_MS = 800;

// Latest-wins handoff queue: only the most recent auto track matters
let handoffChain = Promise.resolve();
let handoffSeq = 0;
let latestAutoSeq = 0;
let correlationCounter = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function generateCorrelationId() {
  return `handoff_${String(++correlationCounter).padStart(4, '0')}_${Date.now().toString(36)}`;
}

// Handoff state machine states
const HandoffState = {
  IDLE: 'IDLE',
  DETECTED: 'DETECTED',
  MATCHING: 'MATCHING',
  DEVICE_RESOLVING: 'DEVICE_RESOLVING',
  READY_TO_TRANSFER: 'READY_TO_TRANSFER',
  PLAY_COMMAND_SENT: 'PLAY_COMMAND_SENT',
  VERIFYING: 'VERIFYING',
  PLAYING: 'PLAYING',
  // Spotify accepted the play, but GET /me/player did not show it yet (Alexa groups can lag)
  PLAY_UNCONFIRMED: 'PLAY_UNCONFIRMED',
  // Error states
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  MATCH_UNCERTAIN: 'MATCH_UNCERTAIN',
  DEVICE_UNAVAILABLE: 'DEVICE_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  TEMPORARY_FAILURE: 'TEMPORARY_FAILURE',
  FAILED: 'FAILED'
};

async function setHandoffState(state, correlationId) {
  await chrome.storage.local.set({
    handoffState: state,
    lastCorrelationId: correlationId
  });
}

// Spotify client errors start with a code (see shared/spotify-client.js)
function classifyError(message = '') {
  if (message.startsWith('AUTH_REQUIRED') || message.startsWith('CLIENT_ID_REQUIRED')) {
    return { state: HandoffState.AUTH_REQUIRED, retryable: false };
  }
  if (message.startsWith('QUOTA_EXCEEDED')) return { state: HandoffState.RATE_LIMITED, retryable: false };
  if (message.startsWith('RATE_LIMITED')) return { state: HandoffState.RATE_LIMITED, retryable: true };
  return { state: HandoffState.TEMPORARY_FAILURE, retryable: true };
}

// Normalize incoming payload to a canonical track object
function toTrack(payload) {
  if (!payload) return null;
  const title = payload.title || payload.normalizedTitle || payload.rawTitle || '';
  const artist = payload.artist || payload.normalizedArtist || payload.rawArtist || '';
  if (!title) return null;
  return {
    ...payload,
    title,
    artist,
    signature: payload.signature || `${title}|${artist}`.toLowerCase()
  };
}

// ───── Message Router ─────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = {
    NOW_PLAYING_DETECTED: () => onTrackDetected(message.payload, sender),
    TRIGGER_HANDOFF: () => onManualHandoff(message, sender),
    SPOTIFY_LOGIN: () => onLogin(message),
    SPOTIFY_LOGOUT: () => onLogout()
  }[message.type];
  if (!handler) return false;

  const reply = (response) => {
    try {
      sendResponse(response);
    } catch (e) {
      // Sender is gone (e.g. popup closed while the Spotify login window was open)
    }
  };

  handler()
    .then(reply)
    .catch(async (err) => {
      await logTelemetry('SERVICE_WORKER_ERROR', { error: err.message });
      reply({ success: false, message: err.message });
    });
  return true; // keep sendResponse channel open for async
});

// ───── Spotify Account ─────
async function onLogin({ interactive = true } = {}) {
  const mode = interactive ? 'interactive' : 'automatic';
  await logTelemetry('AUTH_LOGIN_START', { mode });
  try {
    if (interactive) {
      await loginWithSpotify({ interactive: true });
    } else {
      // No tokens: the client runs the silent login itself (lock + cooldown)
      await spotify.getAccessToken();
    }
    await chrome.storage.local.remove('authError');
    await logTelemetry('AUTH_LOGIN_OK', { mode });
    await cacheProfileName();
    return { success: true };
  } catch (err) {
    // A failed automatic attempt is expected (never authorized, signed out of Spotify): no error banner
    if (interactive) await chrome.storage.local.set({ authError: err.message });
    await logTelemetry('AUTH_LOGIN_FAILED', { mode, error: err.message });
    return { success: false, message: err.message };
  }
}

async function cacheProfileName() {
  const profile = await spotify.getProfile().catch(() => null);
  if (profile?.display_name) {
    await chrome.storage.local.set({ spotifyDisplayName: profile.display_name });
  }
}

async function onLogout() {
  await logoutSpotify();
  await logTelemetry('AUTH_LOGOUT', {});
  return { success: true };
}

// lastAutoSync dedupes detections. It is written when the attempt starts (so A → B → A still
// sends A again) and rolled back if that same attempt fails (so a retry is not skipped).
async function markSyncAttempt(track, attemptId) {
  await chrome.storage.local.set({
    lastAutoSync: {
      signature: track.signature,
      pageInstanceId: track.pageInstanceId,
      attemptId,
      at: Date.now()
    }
  });
}

async function rollbackSyncAttempt(attemptId) {
  const { lastAutoSync } = await chrome.storage.local.get('lastAutoSync');
  if (lastAutoSync?.attemptId === attemptId) {
    await chrome.storage.local.remove('lastAutoSync');
  }
}

// ───── Auto Mode: Track Detected ─────
async function onTrackDetected(payload, sender) {
  const track = toTrack(payload);
  if (!track) return { success: false, decision: 'IGNORED_NO_TITLE' };

  // Always generated here: content script counters restart on every page load
  const correlationId = generateCorrelationId();
  const tabId = sender.tab?.id;

  await logTelemetry('TRACK_DETECTED', {
    title: track.title,
    artist: track.artist,
    source: track.source,
    metadataSource: track.metadataSource,
    videoId: track.videoId,
    reason: track.reason,
    tabId,
    signature: track.signature,
    pageInstanceId: track.pageInstanceId,
    sourceCorrelationId: payload.correlationId
  }, correlationId);

  await setHandoffState(HandoffState.DETECTED, correlationId);

  // Save current track for popup display
  await chrome.storage.local.set({
    currentTrack: track,
    currentTrackTabId: tabId,
    lastDetectedAt: Date.now()
  });
  await chrome.action.setBadgeText({ text: '♫' });
  await chrome.action.setBadgeBackgroundColor({ color: '#1DB954' });

  // ── Auto Mode Decision ──
  const { autoModeEnabled, lastAutoSync } = await chrome.storage.local.get([
    'autoModeEnabled', 'lastAutoSync'
  ]);

  const isNewTrack = track.signature !== lastAutoSync?.signature;
  const isNewPage = !!track.pageInstanceId && track.pageInstanceId !== lastAutoSync?.pageInstanceId;

  let decision = 'TRIGGER';
  if (!autoModeEnabled) decision = 'SKIP_AUTO_MODE_OFF';
  else if (!isNewTrack && !isNewPage) decision = 'SKIP_ALREADY_SYNCED';

  await logTelemetry('AUTO_MODE_DECISION', {
    title: track.title,
    autoModeEnabled: !!autoModeEnabled,
    isNewTrack,
    isNewPage,
    previousSignature: lastAutoSync?.signature || null,
    reason: track.reason,
    decision
  }, correlationId);

  if (decision !== 'TRIGGER') {
    await setHandoffState(HandoffState.IDLE, correlationId);
    return { success: true, decision };
  }

  await markSyncAttempt(track, correlationId);

  await logTelemetry('HANDOFF_INTENT_CREATED', {
    title: track.title,
    origin: 'auto'
  }, correlationId);

  const handoff = await enqueueHandoff({
    track, tabId, origin: 'auto', correlationId
  });

  if (!handoff.superseded) {
    await logTelemetry(
      handoff.success ? 'HANDOFF_COMPLETED' : 'HANDOFF_FAILED',
      {
        title: track.title,
        trackName: handoff.trackName,
        confirmed: handoff.confirmed,
        error: handoff.success ? undefined : handoff.message,
        retryable: handoff.retryable,
        elapsedMs: handoff.elapsedMs,
        device: handoff.device
      },
      correlationId
    );
  }

  if (!handoff.success && !handoff.superseded) {
    await rollbackSyncAttempt(correlationId);
  }

  return { success: true, decision, handoff };
}

// ───── Manual Handoff ─────
async function onManualHandoff(message, sender) {
  let track = toTrack(message.payload);
  let tabId = sender.tab?.id ?? message.tabId;
  const correlationId = generateCorrelationId();

  if (!track) {
    const stored = await chrome.storage.local.get(['currentTrack', 'currentTrackTabId']);
    track = toTrack(stored.currentTrack);
    tabId = tabId ?? stored.currentTrackTabId;
  }

  await logTelemetry('HANDOFF_INTENT_CREATED', {
    title: track?.title,
    origin: 'manual',
    tabId
  }, correlationId);

  const result = await enqueueHandoff({
    track, tabId, origin: 'manual', correlationId
  });

  if (result.success && track) {
    // Prevent auto mode from re-sending the same track after manual handoff
    await markSyncAttempt(track, correlationId);
  }

  return result;
}

// ───── Latest-Wins Queue ─────
function enqueueHandoff(job) {
  const seq = ++handoffSeq;
  if (job.origin === 'auto') latestAutoSeq = seq;

  const run = handoffChain.then(async () => {
    // Latest-wins: if a newer auto job arrived while we waited, skip this one
    if (job.origin === 'auto' && seq !== latestAutoSeq) {
      await logTelemetry('HANDOFF_SUPERSEDED', {
        title: job.track?.title,
        seq,
        latestSeq: latestAutoSeq
      }, job.correlationId);
      return { success: false, superseded: true, retryable: false, message: 'Substituído por faixa mais recente.' };
    }

    await logTelemetry('HANDOFF_STARTED', {
      title: job.track?.title,
      origin: job.origin
    }, job.correlationId);

    return executeHandoff(job);
  });

  handoffChain = run.catch(() => {});
  return run;
}

// ───── Tab Communication ─────
async function sendToTab(tabId, message) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Tab closed or content script orphaned after extension reload
    return null;
  }
}

// ───── Confidence-Based Track Matching ─────
function pickBestCandidate(track, candidates) {
  let best = null;
  let confidence = -1;
  for (const candidate of candidates) {
    const score = scoreTrackMatch(track, candidate);
    if (score > confidence) {
      confidence = score;
      best = candidate;
    }
  }
  return { candidate: best, confidence };
}

// ───── Playback Verification (204 ≠ confirmed playback) ─────
async function verifyPlayback(deviceId, uri, correlationId) {
  let last = {};
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    await sleep(VERIFY_INTERVAL_MS);

    await logTelemetry('PLAYBACK_VERIFY_REQUEST', { attempt }, correlationId);

    const state = await spotify.getPlaybackState();
    const item = state?.item;
    last = {
      attempt,
      activeDevice: state?.device?.name || null,
      deviceMatches: state?.device?.id === deviceId,
      isPlaying: !!state?.is_playing,
      trackMatches: !!item && (item.uri === uri || item.linked_from?.uri === uri)
    };

    await logTelemetry('PLAYBACK_VERIFY_RESPONSE', last, correlationId);

    if (last.trackMatches && last.isPlaying) return { verified: true, ...last };
  }
  return { verified: false, ...last };
}

// ───── Single Handoff Executor (used by BOTH auto and manual) ─────
async function executeHandoff({ track, tabId, origin, correlationId }) {
  const startedAt = Date.now();
  let pausedTab = false;

  // Shown in the popup so the user can tell whether the last handoff really worked
  const recordResult = (fields) => chrome.storage.local.set({
    lastHandoffResult: { origin, correlationId, title: track?.title || null, at: Date.now(), ...fields }
  });

  const fail = async (stage, state, message, { retryable = false, ...data } = {}) => {
    await logTelemetry(stage, { error: message, retryable, ...data }, correlationId);
    await setHandoffState(state, correlationId);
    await chrome.storage.local.set({ lastHandoffError: message });
    // If we paused YouTube but Spotify didn't take over, restore audio
    if (pausedTab) {
      await sendToTab(tabId, { type: 'RESTORE_YOUTUBE' });
    }
    await recordResult({ status: 'failed', message });
    return { success: false, retryable, errorCode: state, message, elapsedMs: Date.now() - startedAt };
  };

  if (!track?.title) {
    return fail('HANDOFF_NO_TRACK', HandoffState.FAILED,
      'Nenhuma música detectada no YouTube.');
  }

  try {
    await setHandoffState(HandoffState.MATCHING, correlationId);

    const { targetDeviceId, targetDeviceName } = await chrome.storage.local.get([
      'targetDeviceId', 'targetDeviceName'
    ]);

    // ── Step 1: Search Spotify + Resolve Device in parallel ──
    // (Do NOT pause YouTube yet — we need to ensure Spotify is ready first)
    await logTelemetry('SPOTIFY_SEARCH_START', {
      title: track.title, artist: track.artist
    }, correlationId);

    const [target, candidates] = await Promise.all([
      spotify.resolveTargetDevice({
        preferredId: targetDeviceId,
        preferredName: targetDeviceName,
        fallbackName: 'Tudo'
      }),
      spotify.searchTrack(track.title, track.artist)
    ]);

    // ── Step 2: Validate device ──
    await setHandoffState(HandoffState.DEVICE_RESOLVING, correlationId);

    if (!target) {
      return fail('DEVICE_UNAVAILABLE', HandoffState.DEVICE_UNAVAILABLE,
        'Dispositivo preferido não encontrado. Verifique se está ativo no Spotify.',
        { retryable: true, preferredName: targetDeviceName || 'Tudo' });
    }

    const device = target.device;
    await logTelemetry('DEVICE_SELECTED', {
      device: device.name,
      deviceId: device.id,
      type: device.type,
      matchedBy: target.matchedBy
    }, correlationId);

    // Refresh the cached ID only when the preferred device itself was found under a new ID.
    // A fallback match must not overwrite the user's choice.
    if (['name', 'partial-name'].includes(target.matchedBy) && device.id !== targetDeviceId) {
      await chrome.storage.local.set({ targetDeviceId: device.id });
    }

    // ── Step 3: Validate search results ──
    await logTelemetry('SPOTIFY_SEARCH_RESULT', {
      count: candidates.length,
      firstMatch: candidates[0]?.name
    }, correlationId);

    if (!candidates.length) {
      return fail('SPOTIFY_NO_MATCH', HandoffState.FAILED,
        `Música "${track.title}" não encontrada no catálogo.`,
        { title: track.title });
    }

    // ── Step 4: Confidence scoring ──
    const { candidate, confidence } = pickBestCandidate(track, candidates);
    const matchInfo = {
      trackName: candidate.name,
      artist: candidate.artists.map(a => a.name).join(', '),
      uri: candidate.uri,
      confidence
    };

    await logTelemetry('SPOTIFY_MATCH_SELECTED', matchInfo, correlationId);

    if (confidence < MIN_CONFIDENCE) {
      return fail('MATCH_UNCERTAIN', HandoffState.MATCH_UNCERTAIN,
        `Match fraco (${confidence}%) para "${track.title}".`,
        matchInfo);
    }

    // ── Step 5: Spotify is ready — NOW pause YouTube ──
    await setHandoffState(HandoffState.READY_TO_TRANSFER, correlationId);

    await logTelemetry('YOUTUBE_PAUSE_REQUEST', { tabId }, correlationId);
    const pauseResult = await sendToTab(tabId, { type: 'PAUSE_AND_MUTE_YOUTUBE' });
    pausedTab = !!pauseResult?.paused;
    await logTelemetry('YOUTUBE_PAUSE_RESULT', { tabId, paused: pausedTab }, correlationId);

    // ── Step 6: Send play command ──
    await setHandoffState(HandoffState.PLAY_COMMAND_SENT, correlationId);

    await logTelemetry('SPOTIFY_PLAY_REQUEST', {
      device: device.name, uri: candidate.uri
    }, correlationId);

    let play = await spotify.playTrackOnDevice(device.id, candidate.uri);

    // If device is inactive (404/5xx), transfer session and retry
    if (!play.ok && (play.status === 404 || play.status >= 500)) {
      await logTelemetry('SPOTIFY_TRANSFER_RETRY', {
        status: play.status, error: play.error, device: device.name
      }, correlationId);

      const transfer = await spotify.transferPlayback(device.id, false);
      await logTelemetry('SPOTIFY_TRANSFER_RESPONSE', {
        status: transfer.status, error: transfer.error
      }, correlationId);

      await sleep(TRANSFER_SETTLE_MS);
      play = await spotify.playTrackOnDevice(device.id, candidate.uri);
    }

    await logTelemetry('SPOTIFY_PLAY_RESPONSE', {
      ok: play.ok, status: play.status, error: play.error
    }, correlationId);

    if (!play.ok) {
      const { state, retryable } = play.status === 0
        ? classifyError(play.error)
        : { state: HandoffState.FAILED, retryable: play.status === 404 || play.status === 429 || play.status >= 500 };
      return fail('SPOTIFY_PLAY_FAILED', state,
        `Spotify recusou o play (${play.status}): ${play.error || 'sem detalhes'}`,
        { retryable, status: play.status, device: device.name });
    }

    // ── Step 7: Verify actual playback (204 ≠ confirmed) ──
    await setHandoffState(HandoffState.VERIFYING, correlationId);

    const verification = await verifyPlayback(device.id, candidate.uri, correlationId);
    const confirmed = verification.verified;

    await setHandoffState(confirmed ? HandoffState.PLAYING : HandoffState.PLAY_UNCONFIRMED, correlationId);
    await logTelemetry(confirmed ? 'PLAYBACK_CONFIRMED' : 'PLAYBACK_UNCONFIRMED', verification, correlationId);
    await chrome.storage.local.remove('lastHandoffError');
    await recordResult({
      status: confirmed ? 'confirmed' : 'unconfirmed',
      trackName: matchInfo.trackName,
      device: device.name
    });

    return {
      success: true,
      confirmed,
      ...matchInfo,
      device: device.name,
      playStatus: play.status,
      verification,
      elapsedMs: Date.now() - startedAt
    };
  } catch (err) {
    const { state, retryable } = classifyError(err.message);
    return fail('HANDOFF_ERROR', state, err.message, { retryable });
  }
}
