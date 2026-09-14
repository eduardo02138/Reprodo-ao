// Content Script: Detecção contínua por MediaSession + DOM Fallback e Controle de Playback
(function() {
  let lastReportedTitle = '';

  function getMediaElement() {
    return document.querySelector('video');
  }

  function pauseAndMuteCurrentVideo() {
    const video = getMediaElement();
    if (video) {
      video.muted = true;
      video.pause();
      return true;
    }
    return false;
  }

  function extractMetadata() {
    const isYTM = window.location.hostname === 'music.youtube.com';
    let title = null;
    let artist = null;
    let album = null;
    let artworkUrl = null;
    let metadataSource = 'fallback';

    // 1. Prioridade 1: MediaSession API (Alta Fidelidade)
    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      const meta = navigator.mediaSession.metadata;
      if (meta.title && meta.title.trim()) {
        title = meta.title.trim();
        artist = meta.artist ? meta.artist.trim() : null;
        album = meta.album ? meta.album.trim() : null;

        if (meta.artwork && meta.artwork.length > 0) {
          artworkUrl = meta.artwork[meta.artwork.length - 1].src || null;
        }
        metadataSource = 'media-session';
      }
    }

    // 2. Prioridade 2: Adaptador DOM
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
        const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string');
        const channelEl = document.querySelector('#owner #channel-name a, ytd-channel-name a');
        if (titleEl && titleEl.textContent.trim()) {
          title = titleEl.textContent.trim();
          artist = channelEl?.textContent.trim() || null;
          metadataSource = 'dom-youtube';
        }
      }
    }

    // 3. Prioridade 3: Fallback de título
    if (!title) {
      title = document.title.replace(/ - YouTube( Music)?$/i, '').trim();
      metadataSource = 'document-title';
    }

    const video = getMediaElement();
    return {
      title,
      artist,
      album,
      artworkUrl,
      metadataSource,
      source: isYTM ? 'youtube-music' : 'youtube',
      playback: {
        playing: video ? !video.paused : false,
        currentTime: video ? video.currentTime : 0,
        duration: video ? video.duration : 0
      }
    };
  }

  function monitorTrack() {
    const raw = extractMetadata();
    if (!raw.title) return;

    // Normaliza
    const normalized = typeof normalizeTrackInfo === 'function' 
      ? normalizeTrackInfo(raw.title, raw.artist)
      : { title: raw.title, artist: raw.artist };

    const cleanTitle = normalized.title || raw.title;
    if (cleanTitle === lastReportedTitle) return;
    lastReportedTitle = cleanTitle;

    chrome.runtime.sendMessage({
      type: 'NOW_PLAYING_DETECTED',
      payload: {
        rawTitle: raw.title,
        rawArtist: raw.artist,
        album: raw.album,
        artworkUrl: raw.artworkUrl,
        normalizedTitle: cleanTitle,
        normalizedArtist: normalized.artist || raw.artist,
        metadataSource: raw.metadataSource,
        source: raw.source
      }
    });
  }

  // Injeta botão nativo de Handoff
  function injectHandoffButton() {
    if (document.getElementById('sync-handoff-btn')) return;

    const controls = document.querySelector('.ytp-right-controls, ytmusic-player-bar .right-controls-buttons');
    if (!controls) return;

    const btn = document.createElement('button');
    btn.id = 'sync-handoff-btn';
    btn.className = 'sync-handoff-btn';
    btn.title = 'Handoff: Tocar nas Alexas / TV';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
    `;

    btn.addEventListener('click', () => {
      btn.classList.add('loading');
      chrome.runtime.sendMessage({
        type: 'TRIGGER_HANDOFF',
        autoPause: true
      }, (res) => {
        btn.classList.remove('loading');
        if (res && res.success) {
          pauseAndMuteCurrentVideo();
          btn.classList.add('success');
          setTimeout(() => btn.classList.remove('success'), 2500);
        } else {
          alert(res?.message || 'Selecione um dispositivo nas opções.');
        }
      });
    });

    controls.prepend(btn);
  }

  // Escuta comandos remotos
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PAUSE_AND_MUTE_YOUTUBE' || msg.type === 'PAUSE_YOUTUBE') {
      const paused = pauseAndMuteCurrentVideo();
      sendResponse({ paused });
    } else if (msg.type === 'GET_ACTIVE_TRACK') {
      const raw = extractMetadata();
      const normalized = typeof normalizeTrackInfo === 'function' 
        ? normalizeTrackInfo(raw.title, raw.artist)
        : { title: raw.title, artist: raw.artist };

      sendResponse({
        payload: {
          rawTitle: raw.title,
          rawArtist: raw.artist,
          album: raw.album,
          artworkUrl: raw.artworkUrl,
          normalizedTitle: normalized.title || raw.title,
          normalizedArtist: normalized.artist || raw.artist,
          metadataSource: raw.metadataSource,
          source: raw.source
        }
      });
    }
  });

  const observer = new MutationObserver(() => {
    monitorTrack();
    injectHandoffButton();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(monitorTrack, 1500);
})();
