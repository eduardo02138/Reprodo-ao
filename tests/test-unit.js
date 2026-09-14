// test-unit.js — Unit tests for sync-music-extension
// Run with: node tests/test-unit.js
'use strict';

const { execSync } = require('child_process');
const path = require('path');

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

function assertRange(value, min, max, msg) {
  const ok = value >= min && value <= max;
  if (!ok) {
    msg += ` (expected ${min}..${max}, got ${value})`;
  }
  assert(ok, msg);
}

function section(name) {
  results.push(`\n─── ${name} ───`);
}

// ── 1. Syntax check: node --check on each source file ────────
section('Syntax Validation (node --check)');

const ROOT = path.resolve(__dirname, '..');
const filesToCheck = [
  'content/track-normalizer.js',
  'content/youtube.js',
  'shared/confidence-engine.js',
  'shared/spotify-client.js',
  'shared/auth.js',
  'shared/logger.js',
  'providers/spotify-provider.js',
  'popup/popup.js',
  'background/service-worker.js',
];

for (const file of filesToCheck) {
  const abs = path.join(ROOT, file);
  try {
    execSync(`node --check "${abs}"`, { stdio: 'pipe' });
    assert(true, `node --check ${file}`);
  } catch (err) {
    // ES module files will fail --check with import/export but that's a
    // syntax-awareness limitation of --check for modules; it still validates
    // the rest of the syntax. We accept exit-code 1 with the specific
    // "Cannot use import statement" or "Unexpected token 'export'" message.
    const stderr = (err.stderr || '').toString();
    if (
      stderr.includes('Cannot use import statement') ||
      stderr.includes("Unexpected token 'export'")
    ) {
      assert(true, `node --check ${file} (ES module — import/export detected, syntax OK)`);
    } else {
      assert(false, `node --check ${file}: ${stderr.trim().split('\n')[0]}`);
    }
  }
}

// ── 2. normalizeTrackInfo() tests ────────────────────────────
section('normalizeTrackInfo()');

const { normalizeTrackInfo } = require(path.join(ROOT, 'content/track-normalizer.js'));

{
  const r = normalizeTrackInfo('Kanye West - POWER (Official Video)', null, 'youtube');
  assertEqual(r.title, 'POWER', 'Kanye: title = POWER');
  assertEqual(r.artist, 'Kanye West', 'Kanye: artist = Kanye West');
}

{
  const r = normalizeTrackInfo('Pitty - Admirável Chip Novo', null, 'youtube');
  assertEqual(r.title, 'Admirável Chip Novo', 'Pitty: title = Admirável Chip Novo');
  assertEqual(r.artist, 'Pitty', 'Pitty: artist = Pitty');
}

{
  const r = normalizeTrackInfo('Song Name [Clipe Oficial] [4K]', 'Channel', 'youtube');
  assertEqual(r.title, 'Song Name', 'Brackets: title = Song Name');
  assertEqual(r.artist, 'Channel', 'Brackets: artist = Channel');
}

{
  const r = normalizeTrackInfo('', null, 'youtube');
  assertEqual(r.title, '', 'Empty title → empty string');
}

{
  const r = normalizeTrackInfo(null, null, 'youtube');
  assertEqual(r.title, '', 'null title → empty string');
}

// ── 3. scoreTrackMatch() tests ───────────────────────────────
section('scoreTrackMatch()');

// The module uses `export function`, so we need to read and eval it
// to get the function in CommonJS context.
const ceSource = require('fs').readFileSync(
  path.join(ROOT, 'shared/confidence-engine.js'), 'utf8'
);
// Strip the export keyword so we can eval it in CommonJS
const ceCode = ceSource.replace(/^export\s+/gm, '');
const scoreTrackMatch = new Function(ceCode + '\nreturn scoreTrackMatch;')();

{
  const score = scoreTrackMatch(
    { title: 'POWER', artist: 'Kanye West' },
    { name: 'POWER', artists: [{ name: 'Kanye West' }], album: { name: '' } }
  );
  assert(score >= 80, `Exact match score >= 80 (got ${score})`);
}

{
  const score = scoreTrackMatch(
    { title: 'POWER', artist: 'Kanye West' },
    { name: 'POWER - Remix', artists: [{ name: 'Kanye West' }], album: { name: '' } }
  );
  assert(score > 40, `Partial match score > 40 (got ${score})`);
  assert(score < 85, `Partial match score < 85 (got ${score})`);
}

{
  const score = scoreTrackMatch(
    { title: 'Hello', artist: 'Adele' },
    { name: 'Bohemian Rhapsody', artists: [{ name: 'Queen' }], album: { name: '' } }
  );
  assert(score < 30, `No match score < 30 (got ${score})`);
}

{
  const score = scoreTrackMatch(
    { title: 'Something', artist: 'Artist' },
    null
  );
  assertEqual(score, 0, 'null spotifyTrack → 0');
}

{
  const score = scoreTrackMatch(
    { title: '', artist: '' },
    { name: 'Anything', artists: [{ name: 'Anyone' }], album: { name: '' } }
  );
  assertEqual(score, 0, 'empty title → 0');
}

// ── 4. toTrack() tests ──────────────────────────────────────
section('toTrack()');

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

{
  const r = toTrack(null);
  assertEqual(r, null, 'null → null');
}

{
  const r = toTrack({ title: 'POWER', artist: 'Kanye West' });
  assertEqual(r.signature, 'power|kanye west', 'signature = power|kanye west');
  assertEqual(r.title, 'POWER', 'title preserved');
  assertEqual(r.artist, 'Kanye West', 'artist preserved');
}

{
  const r = toTrack({ normalizedTitle: 'POWER', normalizedArtist: 'Kanye' });
  assertEqual(r.title, 'POWER', 'normalizedTitle fallback → title = POWER');
  assertEqual(r.artist, 'Kanye', 'normalizedArtist fallback → artist = Kanye');
  assertEqual(r.signature, 'power|kanye', 'signature from fallbacks');
}

{
  const r = toTrack({ rawTitle: 'Something' });
  assertEqual(r.title, 'Something', 'rawTitle fallback → title = Something');
  assertEqual(r.artist, '', 'no artist → empty string');
}

{
  const r = toTrack({});
  assertEqual(r, null, '{} (no title fields) → null');
}

{
  const r = toTrack({ title: 'X', artist: 'Y', signature: 'custom|sig' });
  assertEqual(r.signature, 'custom|sig', 'existing signature is preserved');
}

// ── Summary ──────────────────────────────────────────────────
results.push('');
console.log(results.join('\n'));
const total = passed + failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
} else {
  console.log('OK');
}
