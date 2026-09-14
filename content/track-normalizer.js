// track-normalizer.js: Remove ruídos de títulos do YouTube para precisão máxima no catálogo
function normalizeTrackInfo(rawTitle, rawArtist) {
  if (!rawTitle) return { title: '', artist: '' };

  let title = rawTitle;

  // 1. Trata casos onde o título do vídeo já traz "Artista - Música"
  if (title.includes(' - ')) {
    const parts = title.split(' - ');
    if (!rawArtist || rawArtist.toLowerCase().includes('topic') || rawArtist.toLowerCase().includes('vevo')) {
      rawArtist = parts[0].trim();
    }
    title = parts.slice(1).join(' - ').trim();
  }

  // 2. Remove termos de ruído comuns em clipes de vídeo
  const noisePatterns = [
    /\b(official\s*(music\s*)?video)\b/gi,
    /\b(clipe\s*oficial)\b/gi,
    /\b(vídeo\s*oficial)\b/gi,
    /\b(official\s*audio)\b/gi,
    /\b(audio\s*oficial)\b/gi,
    /\b(lyric\s*video)\b/gi,
    /\b(letra)\b/gi,
    /\b(visualizer)\b/gi,
    /\b(4k|hd|1080p)\b/gi,
    /\b(vevo)\b/gi,
    /\b(video\s*clip)\b/gi,
    /\[.*?\]/g, // Remove colchetes [ex: Clipe Oficial]
    /\(.*?(official|video|clipe|audio|4k|visualizer).*?\)/gi // Remove parênteses contendo ruídos
  ];

  for (const pattern of noisePatterns) {
    title = title.replace(pattern, '');
  }

  // 3. Limpeza de parênteses ou colchetes vazios residuais () ou []
  title = title.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');

  // 4. Limpeza de espaços duplos e pontuações finais
  title = title.replace(/\s+/g, ' ').replace(/[\|\-–—]+$/, '').trim();
  const artist = (rawArtist || '').replace(/- Topic$/i, '').trim();

  return {
    title,
    artist,
    query: artist ? `${title} ${artist}` : title
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeTrackInfo };
}
