// Title normalization and Spotify match scoring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scoreTrackMatch } from '../../shared/confidence-engine.js';

const require = createRequire(import.meta.url);
const { normalizeTrackInfo } = require('../../content/track-normalizer.js');

const spotifyTrack = (name, artist) => ({ name, artists: [{ name: artist }], album: { name: '' } });

test('"Artist - Song (Official Video) (4K Remaster)" is split and cleaned', () => {
  const r = normalizeTrackInfo('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley', 'youtube');
  assert.equal(r.title, 'Never Gonna Give You Up');
  assert.equal(r.artist, 'Rick Astley');
});

test('VEVO channel: artist comes from the title', () => {
  const r = normalizeTrackInfo('Kanye West - POWER', 'KanyeWestVEVO', 'youtube');
  assert.deepEqual([r.title, r.artist], ['POWER', 'Kanye West']);
});

test('brackets and parentheses with noise are removed', () => {
  const r = normalizeTrackInfo('a-ha - Take On Me (Official Video) [Remastered in 4K]', 'a-ha', 'youtube');
  assert.deepEqual([r.title, r.artist], ['Take On Me', 'a-ha']);
});

test('"Song - Artist" order keeps the song as title', () => {
  const r = normalizeTrackInfo('Die With A Smile - Lady Gaga', 'Lady Gaga', 'youtube');
  assert.deepEqual([r.title, r.artist], ['Die With A Smile', 'Lady Gaga']);
});

test('YouTube Music titles are not split on " - "', () => {
  const r = normalizeTrackInfo('Admirável Chip Novo - Remasterizado', 'Pitty', 'youtube-music');
  assert.deepEqual([r.title, r.artist], ['Admirável Chip Novo - Remasterizado', 'Pitty']);
});

test('Portuguese "(Vídeo Oficial)" is removed', () => {
  assert.equal(normalizeTrackInfo('Admirável Chip Novo (Vídeo Oficial)', 'Pitty', 'youtube').title, 'Admirável Chip Novo');
});

test('empty title returns empty strings', () => {
  assert.equal(normalizeTrackInfo('', null, 'youtube').title, '');
  assert.equal(normalizeTrackInfo(null, null, 'youtube').title, '');
});

test('exact title and artist score at least 80', () => {
  assert.ok(scoreTrackMatch({ title: 'POWER', artist: 'Kanye West' }, spotifyTrack('POWER', 'Kanye West')) >= 80);
});

test('title that only contains the query, with a wrong artist, stays below the 50 threshold', () => {
  const score = scoreTrackMatch({ title: 'Power Rangers Theme', artist: 'Kids TV' }, spotifyTrack('POWER', 'Kanye West'));
  assert.ok(score < 50, `score ${score}`);
});

test('unrelated track scores below 30; missing data scores 0', () => {
  assert.ok(scoreTrackMatch({ title: 'Hello', artist: 'Adele' }, spotifyTrack('Bohemian Rhapsody', 'Queen')) < 30);
  assert.equal(scoreTrackMatch({ title: 'Something', artist: 'X' }, null), 0);
  assert.equal(scoreTrackMatch({ title: '', artist: '' }, spotifyTrack('Anything', 'Anyone')), 0);
});
