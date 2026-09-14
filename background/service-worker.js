// Background Service Worker (Manifest V3 Modular)
// Implementa Fila Single-Flight + Latest-Wins, Contrato Canônico e Telemetria Completa
import { SpotifyProvider } from '../providers/spotify-provider.js';
import { scoreTrackMatch } from '../shared/confidence-engine.js';
import { logTelemetry } from '../shared/logger.js';

const spotify = new SpotifyProvider();

// Gerenciamento de Fila Single-Flight + Latest-Wins
let isHandoffActive = false;
let pendingHandoff = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'NOW_PLAYING_DETECTED') {
        const track = message.payload;
        await logTelemetry('YOUTUBE_TRACK_DETECTED', {
          title: track.title,
          artist: track.artist,
          rawTitle: track.rawTitle,
          isReload: !!track.isNavigationReload,
          url: sender.tab?.url
        });

        // Atualiza track atual no storage
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
          isHandoffActive,
          isNavigationReload: !!track.isNavigationReload
        });

        // Condição: Nova música OU recarregamento de página (F5) com título ativo
        const isDifferentTrack = track.title && (track.title !== lastSyncedTrackTitle);
        const shouldTrigger = autoModeEnabled && track.title && (isDifferentTrack || track.isNavigationReload);

        if (shouldTrigger) {
          await logTelemetry('AUTO_MODE_TRIGGERED', { 
            trackTitle: track.title, 
            reason: isDifferentTrack ? 'NEW_TRACK' : 'PAGE_RELOAD' 
          });

          await chrome.storage.local.set({ lastSyncedTrackTitle: track.title });

          // Despacha para a Fila Single-Flight + Latest-Wins
          scheduleHandoff(true, sender.tab?.id, track);
        }

        sendResponse({ success: true });

      } else if (message.type === 'TRIGGER_HANDOFF') {
        const { currentTrack } = await chrome.storage.local.get('currentTrack');
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (currentTrack?.title) {
          await chrome.storage.local.set({ lastSyncedTrackTitle: currentTrack.title });
        }
        
        const result = await scheduleHandoff(message.autoPause, activeTab?.id, currentTrack);
        sendResponse(result);
      }
    } catch (err) {
      await logTelemetry('SERVICE_WORKER_ERROR', { error: err.message });
      sendResponse({ success: false, message: err.message });
    }
  })();
  return true;
});

// Agendador com Política Single-Flight + Latest-Wins
async function scheduleHandoff(autoPause, tabId, trackData) {
  if (isHandoffActive) {
    await logTelemetry('HANDOFF_QUEUED_LATEST_WINS', { 
      displacedTrack: pendingHandoff?.track?.title || 'in-flight', 
      newTrack: trackData?.title 
    });
    // Guarda a mais recente para rodar imediatamente ao término do atual
    pendingHandoff = { autoPause, tabId, track: trackData };
    return { success: true, queued: true, message: 'Operação enfileirada (Latest-Wins).' };
  }

  isHandoffActive = true;
  let finalResult = null;

  try {
    finalResult = await executeHandoff(autoPause, tabId, trackData);
  } finally {
    isHandoffActive = false;
    // Se houve uma música mais recente agendada durante a execução, roda a pendente
    if (pendingHandoff) {
      const next = pendingHandoff;
      pendingHandoff = null;
      await logTelemetry('EXECUTING_PENDING_HANDOFF', { track: next.track?.title });
      scheduleHandoff(next.autoPause, next.tabId, next.track);
    }
  }

  return finalResult;
}

// Executa o Handoff completo com telemetria e resolução dinâmica de dispositivos
async function executeHandoff(autoPause, tabId, trackData) {
  try {
    const { targetDeviceId, autoPauseSetting } = await chrome.storage.local.get([
      'targetDeviceId',
      'autoPauseSetting'
    ]);

    const track = trackData || (await chrome.storage.local.get('currentTrack')).currentTrack;
    const trackTitle = track?.title || track?.normalizedTitle || track?.rawTitle;
    const trackArtist = track?.artist || track?.normalizedArtist || track?.rawArtist;

    if (!track || !trackTitle) {
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
    await logTelemetry('SPOTIFY_SEARCHING', { title: trackTitle, artist: trackArtist });

    const candidates = await spotify.searchTrack(trackTitle, trackArtist);
    if (!candidates || candidates.length === 0) {
      await logTelemetry('SPOTIFY_NO_MATCH', { title: trackTitle });
      return { success: false, message: `Música "${trackTitle}" não encontrada no catálogo.` };
    }

    // 3. Avalia o grau de confiança da melhor correspondência
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

    // 4. Pausa imediata da aba do YouTube para liberar o áudio
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

    // 5. Transfere sessão e inicia reprodução no dispositivo Spotify Connect
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
  } catch (error) {
    await logTelemetry('EXECUTE_HANDOFF_ERROR', { error: error.message });
    return { success: false, message: error.message };
  }
}
