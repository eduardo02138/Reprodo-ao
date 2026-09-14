// track-normalizer.js: Remove ruídos de títulos do YouTube para precisão máxima no catálogo
function normalizeTrackInfo(rawTitle, rawArtist, source) {
  if (!rawTitle) return { title: '', artist: '' };

  let title = rawTitle;
  let artist = rawArtist || '';
  const channelIsGeneric = !artist || /topic|vevo/i.test(artist);
  const contains = (text, part) => !!text && !!part && text.toLowerCase().includes(part.toLowerCase());

  // 1. "Artista - Música" é comum no YouTube; no YouTube Music o título já é só a música
  if (source !== 'youtube-music' && title.includes(' - ')) {
    const [head, ...rest] = title.split(' - ');
    const tail = rest.join(' - ').trim();
    if (!channelIsGeneric && contains(tail, artist) && !contains(head, artist)) {
      title = head.trim(); // "Música - Artista"
    } else {
      artist = head.trim();
      title = tail;
    }
  }

  // 2. Remove termos de ruído comuns em clipes de vídeo (parênteses/colchetes primeiro)
  const noisePatterns = [
    /\[[^\]]*\]/g,
    /\([^)]*(official|oficial|video|vídeo|clipe|clip|audio|áudio|lyric|letra|legendado|4k|hd|hq|remaster|visualizer)[^)]*\)/gi,
    /\b(official\s*(music\s*)?video)\b/gi,
    /\b(clipe\s*oficial)\b/gi,
    /(vídeo\s*oficial)/gi,
    /\b(official\s*audio)\b/gi,
    /\b(audio\s*oficial)\b/gi,
    /\b(lyric\s*video)\b/gi,
    /\b(visualizer)\b/gi,
    /\b(4k|1080p)\b/gi,
    /\b(video\s*clip)\b/gi
  ];

  for (const pattern of noisePatterns) {
    title = title.replace(pattern, '');
  }

  // 3. Limpeza de parênteses ou colchetes vazios residuais () ou []
  title = title.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');

  // 4. Limpeza de espaços duplos e pontuações finais
  title = title.replace(/\s+/g, ' ').replace(/[\|\-–—]+$/, '').trim();
  artist = artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();

  return {
    title,
    artist,
    query: artist ? `${title} ${artist}` : title
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeTrackInfo };
}
