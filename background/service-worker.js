// Background Service Worker (Manifest V3 Modular)
import { SpotifyProvider } from '../providers/spotify-provider.js';
import { scoreTrackMatch } from '../shared/confidence-engine.js';
import { logTelemetry } from '../shared/logger.js';

const spotify = new SpotifyProvider();
let isExecutingHandoff = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'NOW_PLAYING_DETECTED') {
        const track = message.payload;
        await logTelemetry('YOUTUBE_TRACK_DETECTED', {
          title: track.title,
          artist: track.artist,
          url: sender.tab?.url
        });

        await chrome.storage.local.set({
          currentTrack: track,
          lastDetectedAt: Date.now()
        });

        await chrome.action.setBadgeText({ text: '♫' });
        await chrome.action.setBadgeBackgroundColor({ color: '#1DB954' });

        // VERIFICA MODO AUTOMÁTICO
        const { autoModeEnabled, lastSyncedTrackTitle } = await chrome.storage.local.get([
          'autoModeEnabled',
          'lastSyncedTrackTitle'
        ]);

        await logTelemetry('AUTO_MODE_CHECK', {
          autoModeEnabled: !!autoModeEnabled,
          currentTitle: track.title,
          lastSyncedTitle: lastSyncedTrackTitle,
          isExecuting: isExecutingHandoff
        });

        const isDifferentTrack = track.title && (track.title !== lastSyncedTrackTitle);

        if (autoModeEnabled && isDifferentTrack && !isExecutingHandoff) {
          await logTelemetry('AUTO_MODE_TRIGGERED', { trackTitle: track.title });
          await chrome.storage.local.set({ lastSyncedTrackTitle: track.title });

          // Dispara o Handoff
          executeHandoff(true, sender.tab?.id, track).then(async (res) => {
            await logTelemetry('AUTO_HANDOFF_RESULT', res);
          }).catch(async (err) => {
            await logTelemetry('AUTO_HANDOFF_ERROR', { error: err.message });
          });
        }

        sendResponse({ success: true });

      } else if (message.type === 'TRIGGER_HANDOFF') {
        const { currentTrack } = await chrome.storage.local.get('currentTrack');
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const result = await executeHandoff(message.autoPause, activeTab?.id, currentTrack);
        if (result.success) {
          await chrome.storage.local.set({ lastSyncedTrackTitle: currentTrack?.title });
        }
        sendResponse(result);
      }
    } catch (err) {
      await logTelemetry('SERVICE_WORKER_ERROR', { error: err.message });
      sendResponse({ success: false, message: err.message });
    }
  })();
  return true;
});

// Executa o Handoff completo com telemetria passo a passo
async function executeHandoff(autoPause, tabId, trackData) {
  if (isExecutingHandoff) {
    return { success: false, message: 'Handoff já em processamento.' };
  }
  isExecutingHandoff = true;

  try {
    const { targetDeviceId, autoPauseSetting } = await chrome.storage.local.get([
      'targetDeviceId',
      'autoPauseSetting'
    ]);

    const track = trackData || (await chrome.storage.local.get('currentTrack')).currentTrack;
    if (!track || !track.title) {
      return { success: false, message: 'Nenhuma música detectada no YouTube.' };
    }

    await logTelemetry('RESOLVING_DEVICE', { preferred: 'Tudo', cachedId: targetDeviceId });

    // 1. Resolve dinamicamente o dispositivo alvo (Grupo Tudo)
    let deviceId = targetDeviceId;
    if (!deviceId) {
      const target = await spotify.resolveTargetDevice('Tudo');
      if (!target) {
        await logTelemetry('DEVICE_NOT_FOUND', { error: 'Nenhum dispositivo disponível' });
        return { success: false, message: 'Nenhum dispositivo Spotify Connect ativo encontrado.' };
      }
      deviceId = target.id;
    }

    await logTelemetry('TARGET_DEVICE_RESOLVED', { deviceId });

    // 2. Busca no catálogo do Spotify
    const searchTitle = track.normalizedTitle || track.title;
    const searchArtist = track.normalizedArtist || track.artist;
    await logTelemetry('SPOTIFY_SEARCHING', { title: searchTitle, artist: searchArtist });

    const candidates = await spotify.searchTrack(searchTitle, searchArtist);
    if (!candidates || candidates.length === 0) {
      await logTelemetry('SPOTIFY_NO_MATCH', { title: searchTitle });
      return { success: false, message: `Música "${searchTitle}" não encontrada no catálogo.` };
    }

    // 3. Avalia o grau de confiança
    let bestCandidate = candidates[0];
    let highestConfidence = 0;
    for (const cand of candidates) {
      const conf = scoreTrackMatch(track, cand);
      if (conf > highestConfidence) {
        highestConfidence = conf;
        bestCandidate = cand;
      }
    }

    await logTelemetry('BEST_MATCH_CHOSEN', {
      trackName: bestCandidate.name,
      artist: bestCandidate.artists.map(a => a.name).join(', '),
      uri: bestCandidate.uri,
      confidence: highestConfidence
    });

    // 4. Pausa imediata da aba do YouTube
    if (autoPause || autoPauseSetting !== false) {
      try {
        if (tabId) {
          chrome.tabs.sendMessage(tabId, { type: 'PAUSE_AND_MUTE_YOUTUBE' });
        } else {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_AND_MUTE_YOUTUBE' });
        }
        await logTelemetry('YOUTUBE_PAUSED', { tabId });
      } catch (e) {}
    }

    // 5. Transfere sessão e inicia reprodução no grupo Tudo
    const token = await spotify.getAccessToken();
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_ids: [deviceId],
        play: true
      })
    });

    await new Promise(r => setTimeout(r, 600));
    await spotify.playTrackOnDevice(deviceId, bestCandidate.uri);

    await logTelemetry('SPOTIFY_PLAY_COMMAND_SENT', {
      device: deviceId,
      uri: bestCandidate.uri
    });

    return {
      success: true,
      trackName: bestCandidate.name,
      artist: bestCandidate.artists.map(a => a.name).join(', '),
      confidence: highestConfidence
    };
  } finally {
    isExecutingHandoff = false;
  }
}
