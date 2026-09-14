// media-session-reader.js: Extrai metadados estruturados de alta fidelidade
// Prioridade: navigator.mediaSession.metadata -> DOM Adapter -> Document Title Fallback

export function readMediaMetadata() {
  const isYTM = window.location.hostname === 'music.youtube.com';
  let title = null;
  let artist = null;
  let album = null;
  let artworkUrl = null;
  let metadataSource = 'fallback';

  // 1. Prioridade 1: MediaSession API (Fonte preferencial de alta fidelidade)
  if (navigator.mediaSession && navigator.mediaSession.metadata) {
    const meta = navigator.mediaSession.metadata;
    if (meta.title && meta.title.trim()) {
      title = meta.title.trim();
      artist = meta.artist ? meta.artist.trim() : null;
      album = meta.album ? meta.album.trim() : null;

      if (meta.artwork && meta.artwork.length > 0) {
        // Pega a artwork de maior resolução
        const bestArtwork = meta.artwork[meta.artwork.length - 1];
        artworkUrl = bestArtwork.src || null;
      }
      metadataSource = 'media-session';
    }
  }

  // 2. Prioridade 2: Adaptador DOM específico
  if (!title) {
    if (isYTM) {
      const titleEl = document.querySelector('ytmusic-player-bar .title');
      const bylineEl = document.querySelector('ytmusic-player-bar .byline');
      if (titleEl && titleEl.textContent.trim()) {
        title = titleEl.textContent.trim();
        if (bylineEl) {
          const parts = bylineEl.textContent.split('•');
          artist = parts[0]?.trim() || null;
          album = parts[1]?.trim() || null;
        }
        metadataSource = 'dom-ytm';
      }
    } else {
      // YouTube Padrão
      const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string');
      const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a');
      if (titleEl && titleEl.textContent.trim()) {
        title = titleEl.textContent.trim();
        artist = channelEl?.textContent.trim() || null;
        metadataSource = 'dom-youtube';
      }
    }
  }

  // 3. Prioridade 3: Fallback por document.title
  if (!title) {
    title = document.title.replace(/ - YouTube( Music)?$/i, '').trim();
    metadataSource = 'document-title';
  }

  // Coleta dados do elemento de vídeo subjacente
  const video = document.querySelector('video');
  const playback = {
    playing: video ? !video.paused : false,
    currentTime: video ? video.currentTime : 0,
    duration: video ? video.duration : 0
  };

  return {
    source: isYTM ? 'youtube-music' : 'youtube',
    metadataSource,
    title,
    artist,
    album,
    artworkUrl,
    playback
  };
}
