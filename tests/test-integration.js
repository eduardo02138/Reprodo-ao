// test-integration.js — Integration tests for handoff pipeline logic
// Run with: node tests/test-integration.js
'use strict';

// ── Test harness ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    results.push(`  ✓ ${msg}`);
  } else {
    failed++;
    results.push(`  ✗ ${msg}`);
    process.exitCode = 1;
  }
}

function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  if (!ok) {
    msg += ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`;
  }
  assert(ok, msg);
}

function section(name) {
  results.push(`\n─── ${name} ───`);
}

// ── Mock chrome.storage.local ─────────────────────────────────
let memoryStorage = {};

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: memoryStorage[keys] };
        if (Array.isArray(keys)) {
          const res = {};
          keys.forEach(k => res[k] = memoryStorage[k]);
          return res;
        }
        return { ...memoryStorage };
      },
      set: async (obj) => {
        Object.assign(memoryStorage, obj);
      }
    }
  }
};

function resetStorage(initial = {}) {
  memoryStorage = { ...initial };
}

// ── Simplified enqueueHandoff (mirrors real service-worker) ──
let handoffChain = Promise.resolve();
let handoffSeq = 0;
let latestAutoSeq = 0;

function resetQueue() {
  handoffChain = Promise.resolve();
  handoffSeq = 0;
  latestAutoSeq = 0;
}

function enqueueHandoff(job, executor) {
  const seq = ++handoffSeq;
  if (job.origin === 'auto') latestAutoSeq = seq;
  const run = handoffChain.then(async () => {
    if (job.origin === 'auto' && seq !== latestAutoSeq) {
      return { superseded: true };
    }
    return executor(job);
  });
  handoffChain = run.catch(() => {});
  return run;
}

// ── Helper: toTrack (same as production logic) ──
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

// ── Delay helper ──
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── Test 1: Latest-wins queue ─────────────────────────────────
async function testLatestWinsQueue() {
  section('Latest-wins queue');
  resetQueue();

  const executed = [];

  // Executor that takes 50ms to simulate async work
  const executor = async (job) => {
    await delay(50);
    executed.push(job.trackTitle);
    return { executed: true, track: job.trackTitle };
  };

  // Enqueue 3 auto jobs rapidly (no await between enqueues)
  const p1 = enqueueHandoff({ origin: 'auto', trackTitle: 'Track A' }, executor);
  const p2 = enqueueHandoff({ origin: 'auto', trackTitle: 'Track B' }, executor);
  const p3 = enqueueHandoff({ origin: 'auto', trackTitle: 'Track C' }, executor);

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  // All 3 enqueues happen synchronously, so latestAutoSeq=3 before any
  // executor runs. This means A (seq=1) and B (seq=2) are both superseded.
  // Only C (seq=3) actually executes — this IS correct latest-wins behavior.
  assertEqual(r1.superseded, true, 'Track A is superseded (seq=1 vs latest=3)');
  assertEqual(r2.superseded, true, 'Track B is superseded (seq=2 vs latest=3)');
  assert(r3.superseded !== true, 'Track C executes (seq=3 = latest)');

  // Only C should have actually executed
  assert(!executed.includes('Track A'), 'Track A was NOT executed');
  assert(!executed.includes('Track B'), 'Track B was NOT executed');
  assert(executed.includes('Track C'), 'Track C was executed');
  assertEqual(executed.length, 1, 'Exactly 1 track executed (true latest-wins)');
}

// ── Test 2: Auto mode decision ───────────────────────────────
async function testAutoModeDecision() {
  section('Auto mode decision');

  // Scenario 1: autoModeEnabled = false → skip
  resetStorage({ autoModeEnabled: false, lastSyncedTrackTitle: '' });
  const { autoModeEnabled } = await chrome.storage.local.get(['autoModeEnabled']);
  const track1 = toTrack({ title: 'POWER', artist: 'Kanye West' });
  const shouldSkip = !autoModeEnabled;
  assert(shouldSkip, 'autoModeEnabled=false → should skip');

  // Scenario 2: autoModeEnabled = true + new track → trigger
  resetStorage({ autoModeEnabled: true, lastSyncedTrackTitle: 'Old Track' });
  const storage2 = await chrome.storage.local.get(['autoModeEnabled', 'lastSyncedTrackTitle']);
  const track2 = toTrack({ title: 'POWER', artist: 'Kanye West' });
  const isDifferent = track2.title !== storage2.lastSyncedTrackTitle;
  const shouldTrigger = storage2.autoModeEnabled && track2.title && isDifferent;
  assert(shouldTrigger, 'autoModeEnabled=true + new track → should trigger');

  // Scenario 3: autoModeEnabled = true + same track → skip
  resetStorage({ autoModeEnabled: true, lastSyncedTrackTitle: 'POWER' });
  const storage3 = await chrome.storage.local.get(['autoModeEnabled', 'lastSyncedTrackTitle']);
  const track3 = toTrack({ title: 'POWER', artist: 'Kanye West' });
  const isSame = track3.title === storage3.lastSyncedTrackTitle;
  const shouldNotTrigger = !(storage3.autoModeEnabled && track3.title && !isSame);
  assert(shouldNotTrigger, 'autoModeEnabled=true + same track (no reload) → should skip');

  // Scenario 4: autoModeEnabled = true + same track + isNavigationReload → trigger
  resetStorage({ autoModeEnabled: true, lastSyncedTrackTitle: 'POWER' });
  const storage4 = await chrome.storage.local.get(['autoModeEnabled', 'lastSyncedTrackTitle']);
  const track4 = toTrack({ title: 'POWER', artist: 'Kanye West', isNavigationReload: true });
  const isDiff4 = track4.title !== storage4.lastSyncedTrackTitle;
  const shouldTriggerReload = storage4.autoModeEnabled && track4.title && (isDiff4 || track4.isNavigationReload);
  assert(shouldTriggerReload, 'autoModeEnabled=true + same track + isNavigationReload → should trigger');
}

// ── Test 3: Duplicate detection ──────────────────────────────
async function testDuplicateDetection() {
  section('Duplicate detection (signature-based)');

  const seenSignatures = new Map(); // signature → pageInstanceId
  const executed = [];

  function shouldProcess(track) {
    if (!track || !track.signature) return false;
    const prevPageId = seenSignatures.get(track.signature);
    if (prevPageId && prevPageId === track.pageInstanceId) {
      return false; // duplicate: same signature + same page instance
    }
    seenSignatures.set(track.signature, track.pageInstanceId);
    return true;
  }

  const trackA = toTrack({ title: 'POWER', artist: 'Kanye West', pageInstanceId: 'page-1' });
  const trackA2 = toTrack({ title: 'POWER', artist: 'Kanye West', pageInstanceId: 'page-1' });
  const trackA3 = toTrack({ title: 'POWER', artist: 'Kanye West', pageInstanceId: 'page-2' });
  const trackB = toTrack({ title: 'Hello', artist: 'Adele', pageInstanceId: 'page-1' });

  // First time seeing this track → process
  assert(shouldProcess(trackA), 'First occurrence → process');

  // Same signature, same pageInstanceId → skip
  assert(!shouldProcess(trackA2), 'Same signature + same pageInstanceId → skip (duplicate)');

  // Same signature, different pageInstanceId → process (tab reloaded)
  assert(shouldProcess(trackA3), 'Same signature + different pageInstanceId → process');

  // Different track entirely → process
  assert(shouldProcess(trackB), 'Different track → process');

  // null → skip
  assert(!shouldProcess(null), 'null track → skip');
}

// ── Test 4: pageInstanceId change ────────────────────────────
async function testPageInstanceIdChange() {
  section('pageInstanceId change triggers re-process');

  const processedLog = [];
  let lastSignature = null;
  let lastPageInstanceId = null;

  function handleTrack(track) {
    if (!track) return 'skip';
    const sig = track.signature;
    const pid = track.pageInstanceId;

    if (sig === lastSignature && pid === lastPageInstanceId) {
      return 'skip'; // true duplicate
    }

    // Different pageInstanceId with same signature = tab reload, should re-trigger
    lastSignature = sig;
    lastPageInstanceId = pid;
    processedLog.push({ sig, pid });
    return 'trigger';
  }

  const t1 = toTrack({ title: 'Song', artist: 'Band', pageInstanceId: 'abc-123' });
  assertEqual(handleTrack(t1), 'trigger', 'First encounter → trigger');

  const t2 = toTrack({ title: 'Song', artist: 'Band', pageInstanceId: 'abc-123' });
  assertEqual(handleTrack(t2), 'skip', 'Same sig + same pageInstanceId → skip');

  const t3 = toTrack({ title: 'Song', artist: 'Band', pageInstanceId: 'def-456' });
  assertEqual(handleTrack(t3), 'trigger', 'Same sig + different pageInstanceId → trigger');

  assertEqual(processedLog.length, 2, 'Only 2 triggers total');
}

// ── Run all tests ─────────────────────────────────────────────
async function main() {
  await testLatestWinsQueue();
  await testAutoModeDecision();
  await testDuplicateDetection();
  await testPageInstanceIdChange();

  // Summary
  results.push('');
  console.log(results.join('\n'));
  const total = passed + failed;
  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAIL');
  } else {
    console.log('OK');
  }
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exitCode = 1;
});
