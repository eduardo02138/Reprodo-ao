// Content Script: YouTube/YouTube Music track detection with SPA navigation support
// Runs in the page context (not a module — no import/export)
(function() {
  // ───── State ─────
  let lastReportedSignature = '';
  let lastReportedVideoId = '';
  let metadataStabilizeTimer = null;
  let correlationCounter = 0;

  // Unique per page load — enables F5 re-detection (RC-2 FIX)
  const pageInstanceId = `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ───── Helpers ─────
  function getMediaElement() {
    return document.querySelector('video');
  }

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v') || '';
  }

  function generateCorrelationId() {
    return `cs_${String(++correlationCounter).padStart(4, '0')}_${Date.now().toString(36)}`;
  }

  // ───── Video Controls ─────
  function pauseAndMuteCurrentVideo() {
    const video = getMediaElement();
    if (video) {
      video.muted = true;
      video.pause();
      return true;
    }
    return false;
  }

  function restoreVideo() {
    const video = getMediaElement();
    if (video) {
      video.muted = false;
      video.play().catch(() => {}); // may fail if user hasn't interacted
      return true;
    }
    return false;
  }

  // ───── Metadata Extraction ─────
  function extractMetadata() {
    const isYTM = window.location.hostname === 'music.youtube.com';
    let title = null;
    let artist = null;
    let album = null;
    let artworkUrl = null;
    let metadataSource = 'fallback';

    // Priority 1: MediaSession API (highest fidelity)
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

    // Priority 2: DOM selectors
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

    // Priority 3: document.title fallback
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
      videoId: getVideoId(),
      playback: {
        playing: video ? !video.paused : false,
        currentTime: video ? video.currentTime : 0,
        duration: video ? video.duration : 0
      }
    };
  }

  // ───── Track Detection with Stabilization ─────
  // Waits for metadata to stabilize after navigation before reporting
  function scheduleMetadataCheck(reason) {
    // Cancel any pending check — we want the latest state
    clearTimeout(metadataStabilizeTimer);

    // Short debounce: wait for MediaSession to catch up with the URL change
    metadataStabilizeTimer = setTimeout(() => {
      checkAndReportTrack(reason);
    }, 400);
  }

  function checkAndReportTrack(reason) {
    const raw = extractMetadata();
    if (!raw.title) return;

    // Normalize
    const normalized = typeof normalizeTrackInfo === 'function'
      ? normalizeTrackInfo(raw.title, raw.artist)
      : { title: raw.title, artist: raw.artist };

    const cleanTitle = normalized.title || raw.title;
    const cleanArtist = normalized.artist || raw.artist || '';
    const signature = `${cleanTitle}|${cleanArtist}`.toLowerCase();
    const videoId = raw.videoId;

    // Skip if same track AND same video (prevents duplicate reports)
    // But allow if videoId changed (new video) or if this is a new page instance
    if (signature === lastReportedSignature && videoId === lastReportedVideoId) {
      return;
    }

    // Hypothesis B guard: if URL changed but MediaSession still shows old track,
    // the metadata hasn't stabilized yet. Check videoId consistency.
    if (videoId && videoId !== lastReportedVideoId && raw.metadataSource === 'media-session') {
      // Video changed — verify MediaSession isn't stale by comparing with DOM
      const domTitle = getDOMTitle();
      if (domTitle && !titleMatchesLoosely(cleanTitle, domTitle)) {
        // MediaSession is stale — retry after a bit
        console.log('[SyncMusic] MediaSession stale after navigation, retrying...', {
          mediaSessionTitle: cleanTitle, domTitle, videoId
        });
        setTimeout(() => checkAndReportTrack(reason + '-retry'), 800);
        return;
      }
    }

    lastReportedSignature = signature;
    lastReportedVideoId = videoId;
    const correlationId = generateCorrelationId();

    // Send to service worker with canonical field names (RC-3 FIX)
    chrome.runtime.sendMessage({
      type: 'NOW_PLAYING_DETECTED',
      payload: {
        // Primary fields (what the SW expects)
        title: cleanTitle,
        artist: cleanArtist,
        signature,
        // Additional metadata
        rawTitle: raw.title,
        rawArtist: raw.artist,
        album: raw.album,
        artworkUrl: raw.artworkUrl,
        metadataSource: raw.metadataSource,
        source: raw.source,
        videoId,
        pageInstanceId,
        correlationId,
        reason
      }
    }).catch(() => {
      // Extension context may be invalidated after reload
    });
  }

  // Helper: get title from DOM (bypassing MediaSession)
  function getDOMTitle() {
    const isYTM = window.location.hostname === 'music.youtube.com';
    if (isYTM) {
      const el = document.querySelector('ytmusic-player-bar .title');
      return el?.textContent?.trim() || null;
    }
    const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string');
    return el?.textContent?.trim() || null;
  }

  // Helper: loose title comparison to detect stale MediaSession
  function titleMatchesLoosely(a, b) {
    if (!a || !b) return false;
    const na = a.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    return na.includes(nb) || nb.includes(na);
  }

  // ───── YouTube SPA Navigation Detection (RC-1 FIX) ─────

  // 1. YouTube's custom navigation events
  document.addEventListener('yt-navigate-finish', () => {
    scheduleMetadataCheck('yt-navigate-finish');
  });

  // YouTube Music uses similar but different event
  document.addEventListener('yt-page-data-updated', () => {
    scheduleMetadataCheck('yt-page-data-updated');
  });

  // 2. History API interception (SPA pushState/replaceState)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    scheduleMetadataCheck('pushState');
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    scheduleMetadataCheck('replaceState');
  };

  window.addEventListener('popstate', () => {
    scheduleMetadataCheck('popstate');
  });

  // 3. Video element events (most reliable for actual track change)
  function attachVideoListeners() {
    const video = getMediaElement();
    if (!video || video.__syncMusicListenersAttached) return;
    video.__syncMusicListenersAttached = true;

    video.addEventListener('loadedmetadata', () => {
      scheduleMetadataCheck('video-loadedmetadata');
    });

    video.addEventListener('playing', () => {
      // Only check if this looks like a new track (not a resume)
      if (video.currentTime < 2) {
        scheduleMetadataCheck('video-playing-start');
      }
    });
  }

  // 4. MutationObserver (catches DOM changes not covered above)
  const observer = new MutationObserver(() => {
    attachVideoListeners();
    injectHandoffButton();
    // Don't call scheduleMetadataCheck on every mutation — too noisy
    // The specific event listeners above handle track changes
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 5. Periodic fallback (safety net, longer interval since we have event-driven detection)
  setInterval(() => {
    attachVideoListeners();
    checkAndReportTrack('interval');
  }, 3000);

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

  // ───── Remote Command Handler ─────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PAUSE_AND_MUTE_YOUTUBE' || msg.type === 'PAUSE_YOUTUBE') {
      const paused = pauseAndMuteCurrentVideo();
      sendResponse({ paused });
    } else if (msg.type === 'RESTORE_YOUTUBE') {
      const restored = restoreVideo();
      sendResponse({ restored });
    } else if (msg.type === 'GET_ACTIVE_TRACK') {
      const raw = extractMetadata();
      const normalized = typeof normalizeTrackInfo === 'function'
        ? normalizeTrackInfo(raw.title, raw.artist)
        : { title: raw.title, artist: raw.artist };

      sendResponse({
        payload: {
          title: normalized.title || raw.title,
          artist: normalized.artist || raw.artist,
          rawTitle: raw.title,
          rawArtist: raw.artist,
          album: raw.album,
          artworkUrl: raw.artworkUrl,
          metadataSource: raw.metadataSource,
          source: raw.source,
          videoId: raw.videoId,
          pageInstanceId,
          signature: `${normalized.title || raw.title}|${normalized.artist || raw.artist || ''}`.toLowerCase()
        }
      });
    }
    return false; // synchronous response
  });

  // ───── Initial Detection ─────
  attachVideoListeners();
  scheduleMetadataCheck('initial-load');
})();
