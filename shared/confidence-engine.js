// confidence-engine.js: Calcula score de similaridade e correspondência entre YouTube e Spotify
export function scoreTrackMatch(sourceMeta, spotifyTrack) {
  if (!spotifyTrack || !sourceMeta.title) return 0;

  const clean = (str) => (str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^\w\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const srcTitle = clean(sourceMeta.title);
  const spTitle = clean(spotifyTrack.name);
  const srcArtist = clean(sourceMeta.artist);
  const spArtists = spotifyTrack.artists.map(a => clean(a.name)).join(' ');
  const srcAlbum = clean(sourceMeta.album);
  const spAlbum = clean(spotifyTrack.album?.name);

  let score = 0;

  // 1. Match de Título (Peso: até 50 pontos)
  if (srcTitle === spTitle) {
    score += 50;
  } else if (spTitle.includes(srcTitle) || srcTitle.includes(spTitle)) {
    score += 40;
  } else {
    // Similaridade básica por palavras compartilhadas
    const srcWords = srcTitle.split(' ');
    const matchedWords = srcWords.filter(w => w.length > 2 && spTitle.includes(w));
    if (srcWords.length > 0) {
      score += Math.round((matchedWords.length / srcWords.length) * 35);
    }
  }

  // 2. Match de Artista (Peso: até 35 pontos)
  if (srcArtist && spArtists) {
    if (spArtists.includes(srcArtist) || srcArtist.includes(spArtists)) {
      score += 35;
    } else {
      const artWords = srcArtist.split(' ');
      const matchedArt = artWords.filter(w => w.length > 2 && spArtists.includes(w));
      if (artWords.length > 0) {
        score += Math.round((matchedArt.length / artWords.length) * 25);
      }
    }
  } else {
    // Se não há artista no metadado, concede ponto neutro moderado se o título foi muito forte
    if (score >= 45) score += 20;
  }

  // 3. Match de Álbum (Bônus de alta fidelidade: até 15 pontos)
  if (srcAlbum && spAlbum) {
    if (srcAlbum === spAlbum || spAlbum.includes(srcAlbum) || srcAlbum.includes(spAlbum)) {
      score += 15;
    }
  }

  return Math.min(score, 100);
}
