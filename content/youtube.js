// Content Script: YouTube/YouTube Music track detection with SPA navigation support
// Runs in the extension's isolated world (not a module — no import/export)
(function() {
  // ───── Config ─────
  const STABILIZE_MS = 400;
  const STALE_RETRY_MS = 800;
  const MAX_STALE_RETRIES = 5;
  const FALLBACK_INTERVAL_MS = 3000;
  // Extra attempts when a handoff fails for a transient reason (device offline, 5xx, network)
  const RETRY_DELAYS_MS = [10000, 30000];

  // ───── State ─────
  // Unique per page load — enables F5 re-detection
  const pageInstanceId = `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let lastReportedSignature = '';
  let lastReportedVideoId = '';
  let lastReportedTrack = null;
  let lastReportedMediaId = '';
  // Other titles YouTube showed for the video already reported (uploader translations)
  const titleAliases = new Set();
  let stabilizeTimer = null;
  let staleTimer = null;
  let staleRetries = 0;
  let pendingForce = false;
  let retryTimer = null;
  let retrySignature = '';
  let retryCount = 0;
  let correlationCounter = 0;
  let autoModeEnabled = false;
  let pausedByExtension = false;
  let mutedByExtension = false;
  let domWorkScheduled = false;
  let observer = null;
  let fallbackTimer = null;

  const log = (...args) => console.info('[SyncMusic]', ...args);

  // ───── Helpers ─────
  const isYouTubeMusic = () => window.location.hostname === 'music.youtube.com';
  const extensionAlive = () => !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  function getMediaElement() {
    return document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('video.html5-main-video')
      || document.querySelector('video');
  }

  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v') || '';
  }

  function generateCorrelationId() {
    return `cs_${String(++correlationCounter).padStart(4, '0')}_${Date.now().toString(36)}`;
  }

  // During an ad MediaSession shows the ad, and pausing it would block the song that follows
  function isAdPlaying() {
    return !!document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting, .html5-video-player.ad-showing');
  }

  // On youtube.com only /watch has a track; the home/search pages must never become a "song"
  function isTrackPage() {
    if (isYouTubeMusic()) return true;
    return window.location.pathname === '/watch' && !!getVideoId();
  }

  // Extension context dies when the extension is reloaded; this script stays orphaned until F5
  function stopIfOrphaned() {
    if (extensionAlive()) return false;
    clearInterval(fallbackTimer);
    clearTimeout(stabilizeTimer);
    clearTimeout(staleTimer);
    clearTimeout(retryTimer);
    observer?.disconnect();
    return true;
  }

  // ───── Video Controls ─────
  function pauseForHandoff({ muteOnly = false } = {}) {
    const video = getMediaElement();
    if (!video) return false;
    if (!muteOnly && !video.paused) {
      video.pause();
      pausedByExtension = true;
    }
    if (!video.muted) {
      video.muted = true;
      mutedByExtension = true;
    }
    return true;
  }

  // Handoff failed: give sound (and playback, if we paused it) back to YouTube
  function restoreYouTube() {
    const video = getMediaElement();
    if (video && mutedByExtension) video.muted = false;
    if (video && pausedByExtension) video.play().catch(() => {});
    mutedByExtension = false;
    pausedByExtension = false;
  }


  function unmuteIfMutedByExtension() {
    const video = getMediaElement();
    if (video && mutedByExtension) video.muted = false;
    mutedByExtension = false;
  }

  // ───── Metadata Extraction ─────
  // allowFallback: only for explicit requests (popup/button); auto detection never uses document.title
  function extractMetadata(allowFallback) {
    if (!allowFallback && !isTrackPage()) return null;

    const isYTM = isYouTubeMusic();
    let title = null;
    let artist = null;
    let album = null;
    let artworkUrl = null;
    let metadataSource = null;

    // Priority 1: MediaSession API (highest fidelity)
    const meta = navigator.mediaSession?.metadata;
    if (meta?.title?.trim()) {
      title = meta.title.trim();
      artist = meta.artist?.trim() || null;
      album = meta.album?.trim() || null;
      if (meta.artwork?.length) {
        artworkUrl = meta.artwork[meta.artwork.length - 1].src || null;
      }
      metadataSource = 'media-session';
    }

    // Priority 2: DOM selectors
    if (!title) {
      if (isYTM) {
        const titleEl = document.querySelector('ytmusic-player-bar .title');
        const bylineEl = document.querySelector('ytmusic-player-bar .byline');
        if (titleEl?.textContent.trim()) {
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
        if (titleEl?.textContent.trim()) {
          title = titleEl.textContent.trim();
          artist = channelEl?.textContent.trim() || null;
          metadataSource = 'dom-youtube';
        }
      }
    }

    // Priority 3: document.title fallback
    if (!title && allowFallback) {
      title = document.title.replace(/ - YouTube( Music)?$/i, '').trim() || null;
      metadataSource = 'document-title';
    }

    if (!title) return null;

    const video = getMediaElement();
    return {
      title,
      artist,
      album,
      artworkUrl,
      metadataSource,
      source: isYTM ? 'youtube-music' : 'youtube',
      videoId: getVideoId(),
      playing: video ? !video.paused : false
    };
  }

  function buildTrackPayload(allowFallback = false) {
    const raw = extractMetadata(allowFallback);
    if (!raw) return null;

    const normalized = typeof normalizeTrackInfo === 'function'
      ? normalizeTrackInfo(raw.title, raw.artist, raw.source)
      : { title: raw.title, artist: raw.artist || '' };

    const title = normalized.title || raw.title;
    const artist = normalized.artist || raw.artist || '';

    return {
      title,
      artist,
      signature: `${title}|${artist}`.toLowerCase(),
      rawTitle: raw.title,
      rawArtist: raw.artist,
      album: raw.album,
      artworkUrl: raw.artworkUrl,
      metadataSource: raw.metadataSource,
      source: raw.source,
      videoId: raw.videoId,
      playing: raw.playing,
      pageInstanceId
    };
  }

  // Helper: get title from DOM (bypassing MediaSession)
  function getDOMTitle() {
    const selector = isYouTubeMusic()
      ? 'ytmusic-player-bar .title'
      : 'h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string';
    return document.querySelector(selector)?.textContent?.trim() || null;
  }

  // Loose comparison that also works for accented and non-Latin titles
  function titlesMatchLoosely(a, b) {
    const clean = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const na = clean(a);
    const nb = clean(b);
    if (!na || !nb) return true; // nothing comparable: trust MediaSession
    return na.includes(nb) || nb.includes(na);
  }

  // YouTube swaps a video's title for the uploader's translation a few seconds after it starts
  // ("Shape of You" → "A Sua Forma"). Same media source + same artist = same song with a new label.
  function isTitleRelabel(track, mediaId) {
    if (!lastReportedTrack || track.source !== 'youtube') return false;
    if (!mediaId || mediaId !== lastReportedMediaId) return false;
    if (track.signature === lastReportedTrack.signature) return false;
    return titleAliases.has(track.signature)
      || track.artist.toLowerCase() === lastReportedTrack.artist.toLowerCase();
  }

  // ───── Track Detection with Stabilization ─────
  function scheduleMetadataCheck(reason, { force = false } = {}) {
    pendingForce = pendingForce || force;
    clearTimeout(stabilizeTimer);
    // Short debounce: wait for MediaSession to catch up with the URL change
    stabilizeTimer = setTimeout(() => {
      const forced = pendingForce;
      pendingForce = false;
      checkAndReportTrack(reason, { force: forced });
    }, STABILIZE_MS);
  }

  function checkAndReportTrack(reason, { force = false } = {}) {
    if (stopIfOrphaned()) return;

    if (isAdPlaying()) {
      pendingForce = pendingForce || force;
      return; // the 'playing' event or the fallback interval checks again after the ad
    }

    const track = buildTrackPayload(false);
    if (!track) {
      pendingForce = pendingForce || force;
      return;
    }

    const mediaId = getMediaElement()?.src || '';
    if (isTitleRelabel(track, mediaId)) {
      if (!titleAliases.has(track.signature)) {
        titleAliases.add(track.signature);
        log(`título trocado no mesmo vídeo (tradução do YouTube): "${track.title}" — mantendo "${lastReportedTrack.title}"`);
      }
      // Forced reports (auto mode turned on) keep the title first seen for this video
      if (force) reportTrack(lastReportedTrack, reason);
      return;
    }

    if (!force && track.signature === lastReportedSignature && track.videoId === lastReportedVideoId) {
      return;
    }

    // URL changed but one of the metadata sources is still from the previous video: wait for them to agree
    if (track.videoId && track.videoId !== lastReportedVideoId
        && track.metadataSource === 'media-session' && staleRetries < MAX_STALE_RETRIES) {
      const domTitle = getDOMTitle();
      if (domTitle && !titlesMatchLoosely(track.rawTitle, domTitle)) {
        staleRetries++;
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => checkAndReportTrack(`${reason}-stale-retry`, { force }), STALE_RETRY_MS);
        return;
      }
    }

    staleRetries = 0;
    lastReportedSignature = track.signature;
    lastReportedVideoId = track.videoId;
    lastReportedTrack = track;
    lastReportedMediaId = mediaId;
    titleAliases.clear();

    if (track.signature !== retrySignature) {
      retrySignature = track.signature;
      retryCount = 0;
      clearTimeout(retryTimer);
    }

    reportTrack(track, reason);
  }

  async function reportTrack(track, reason) {
    log(`faixa detectada (${reason}): ${track.title} — ${track.artist || '?'} [${track.metadataSource}]`);

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'NOW_PLAYING_DETECTED',
        payload: { ...track, reason, correlationId: generateCorrelationId() }
      });
    } catch (err) {
      log('extensão indisponível:', err.message);
      return;
    }

    const handoff = res?.handoff;
    if (!handoff) {
      log('modo automático:', res?.decision || 'sem resposta');
      return;
    }
    if (handoff.superseded) return;
    if (handoff.success) {
      log(handoff.confirmed ? 'tocando no Spotify:' : 'play enviado ao Spotify (sem confirmação):',
        `${handoff.trackName} → ${handoff.device}`);
      return;
    }

    log('handoff falhou:', handoff.message);
    scheduleRetry(track, handoff);
  }

  function scheduleRetry(track, handoff) {
    if (!handoff.retryable || retryCount >= RETRY_DELAYS_MS.length) return;
    if (track.signature !== lastReportedSignature) return;

    const delay = RETRY_DELAYS_MS[retryCount++];
    const attempt = retryCount;
    log(`nova tentativa em ${delay / 1000}s (${attempt}/${RETRY_DELAYS_MS.length})`);

    const attemptRetry = () => {
      if (!autoModeEnabled || stopIfOrphaned()) return;
      if (isAdPlaying()) {
        retryTimer = setTimeout(attemptRetry, 3000);
        return;
      }
      const current = buildTrackPayload(false);
      // Track changed meanwhile: normal detection already handles the new one
      if (!current || (current.signature !== track.signature && !titleAliases.has(current.signature))) return;
      // Resend the original payload: YouTube may have translated the title in the meantime
      reportTrack(track, `retry-${attempt}`);
    };

    clearTimeout(retryTimer);
    retryTimer = setTimeout(attemptRetry, delay);
  }

  // ───── YouTube SPA Navigation Detection ─────
  // DOM events are shared with the page, so these work from the isolated world.
  // (Overriding history.pushState here would NOT intercept the page's own calls.)
  document.addEventListener('yt-navigate-finish', () => scheduleMetadataCheck('yt-navigate-finish'));
  document.addEventListener('yt-page-data-updated', () => scheduleMetadataCheck('yt-page-data-updated'));
  window.addEventListener('popstate', () => scheduleMetadataCheck('popstate'));

  // Video element events (most reliable for actual track change, including the end of an ad)
  function attachVideoListeners() {
    const video = getMediaElement();
    if (!video || video.__syncMusicListenersAttached) return;
    video.__syncMusicListenersAttached = true;

    video.addEventListener('loadedmetadata', () => scheduleMetadataCheck('video-loadedmetadata'));
    video.addEventListener('playing', () => {
      // Only check if this looks like a new track (not a resume)
      if (video.currentTime < 2) scheduleMetadataCheck('video-playing-start');
    });
  }

  // ───── Handoff Button Injection ─────
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

    btn.addEventListener('click', async () => {
      btn.classList.remove('success', 'error');
      btn.classList.add('loading');
      try {
        // The service worker pauses YouTube itself when the handoff goes through
        const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_HANDOFF', payload: buildTrackPayload(true) });
        btn.classList.add(res?.success ? 'success' : 'error');
        btn.title = res?.success ? `Tocando em ${res.device}` : (res?.message || 'Falha no handoff');
        if (!res?.success) alert(res?.message || 'Falha no handoff.');
      } catch (err) {
        btn.classList.add('error');
        alert(`Extensão indisponível (${err.message}). Recarregue a página.`);
      } finally {
        btn.classList.remove('loading');
        setTimeout(() => btn.classList.remove('success', 'error'), 2500);
      }
    });

    controls.prepend(btn);
  }

  // ───── Remote Command Handler ─────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PAUSE_AND_MUTE_YOUTUBE' || msg.type === 'PAUSE_YOUTUBE') {
      sendResponse({ paused: pauseForHandoff({ muteOnly: !!msg.muteOnly }) });
    } else if (msg.type === 'RESTORE_YOUTUBE') {
      restoreYouTube();
      sendResponse({ restored: true });
    } else if (msg.type === 'GET_ACTIVE_TRACK') {
      sendResponse({ payload: buildTrackPayload(true) });
    }
    return false; // synchronous response
  });

  // ───── Auto Mode State ─────
  chrome.storage.local.get('autoModeEnabled')
    .then(({ autoModeEnabled: enabled }) => { autoModeEnabled = !!enabled; })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.autoModeEnabled) return;
    autoModeEnabled = !!changes.autoModeEnabled.newValue;

    if (autoModeEnabled) {
      // Turned on while music plays: send the current track right away
      const video = getMediaElement();
      if (video && !video.paused) {
        retryCount = 0;
        scheduleMetadataCheck('auto-mode-enabled', { force: true });
      }
    } else {
      clearTimeout(retryTimer);
      unmuteIfMutedByExtension();
    }
  });

  // ───── Wiring ─────
  // YouTube mutates the DOM constantly: batch the DOM work instead of running it per mutation
  observer = new MutationObserver(() => {
    if (domWorkScheduled) return;
    domWorkScheduled = true;
    setTimeout(() => {
      domWorkScheduled = false;
      attachVideoListeners();
      injectHandoffButton();
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Periodic fallback (safety net for events we miss)
  fallbackTimer = setInterval(() => {
    attachVideoListeners();
    scheduleMetadataCheck('interval');
  }, FALLBACK_INTERVAL_MS);

  attachVideoListeners();
  injectHandoffButton();
  scheduleMetadataCheck('initial-load');
})();
