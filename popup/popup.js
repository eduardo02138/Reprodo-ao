// popup.js — Popup controller with all logic inside DOMContentLoaded
import { SpotifyProvider } from '../providers/spotify-provider.js';
import { TOKEN_KEYS } from '../shared/spotify-config.js';

// Track titles come from YouTube uploaders: never inject them as HTML
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const isAuthError = (message = '') => message.startsWith('AUTH_REQUIRED');

document.addEventListener('DOMContentLoaded', async () => {
  // ───── Element References ─────
  const trackTitleEl = document.getElementById('track-title');
  const trackArtistEl = document.getElementById('track-artist');
  const trackArtwork = document.getElementById('track-artwork');
  const artworkPlaceholder = document.getElementById('artwork-placeholder');
  const playingWave = document.getElementById('playing-wave');
  const stateDot = document.getElementById('playback-state-dot');
  const stateText = document.getElementById('playback-state-text');

  const ctrlPlayPauseBtn = document.getElementById('ctrl-play-pause');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnSpinner = document.getElementById('btn-spinner');
  const ctrlPrevBtn = document.getElementById('ctrl-prev');
  const ctrlNextBtn = document.getElementById('ctrl-next');

  const deviceListEl = document.getElementById('device-list');
  const refreshDevicesBtn = document.getElementById('refresh-devices-btn');
  const volumeSlider = document.getElementById('volume-slider');
  const volValText = document.getElementById('vol-val-text');
  const targetDeviceLabel = document.getElementById('target-device-label');
  const volIcon = document.getElementById('vol-icon');

  const handoffBtn = document.getElementById('handoff-btn');
  const handoffBtnText = document.getElementById('handoff-btn-text');
  const handoffSpinner = document.getElementById('handoff-spinner');
  const statusBox = document.getElementById('status-message');
  const closeBtn = document.getElementById('close-btn');

  // Auto mode elements
  const autoModeToggle = document.getElementById('auto-mode-toggle');
  const autoModeBadge = document.getElementById('auto-mode-badge');
  const lastHandoffEl = document.getElementById('last-handoff');

  // Debug mode elements
  const debugToggle = document.getElementById('debug-mode-toggle');
  const debugPanel = document.getElementById('debug-panel');

  // Telemetry elements
  const telemetryListEl = document.getElementById('telemetry-log-list');
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  const copyLogsBtn = document.getElementById('copy-logs-btn');
  const exportLogsBtn = document.getElementById('export-logs-btn');

  // Spotify account elements
  const authIndicator = document.getElementById('auth-indicator');
  const authBtn = document.getElementById('auth-btn');
  const authSetup = document.getElementById('auth-setup');
  const authErrorEl = document.getElementById('auth-error');
  const redirectUriEl = document.getElementById('redirect-uri');
  const copyRedirectBtn = document.getElementById('copy-redirect-btn');

  const provider = new SpotifyProvider();
  let currentTrack = null;
  let activeTab = null;
  let selectedDeviceId = null;
  let selectedDeviceName = 'Tudo';
  let isCurrentlyPlaying = false;
  let volumeDebounceTimer = null;
  let isConnected = false;

  // ───── 1. Load saved state ─────
  const storage = await chrome.storage.local.get([
    'currentTrack',
    'targetDeviceId',
    'targetDeviceName',
    'lastVolume',
    'autoModeEnabled',
    'debugModeEnabled',
    'lastHandoffResult'
  ]);

  if (storage.currentTrack) {
    updateTrackDisplay(storage.currentTrack);
  }

  if (storage.targetDeviceId) {
    selectedDeviceId = storage.targetDeviceId;
    selectedDeviceName = storage.targetDeviceName || 'Tudo';
    targetDeviceLabel.textContent = selectedDeviceName;
  }

  if (storage.lastVolume !== undefined) {
    volumeSlider.value = storage.lastVolume;
    volValText.textContent = `${storage.lastVolume}%`;
  }

  // ───── 2. Auto Mode Toggle ─────
  if (autoModeToggle) {
    autoModeToggle.checked = !!storage.autoModeEnabled;
    updateAutoBadge(!!storage.autoModeEnabled);

    autoModeToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      // Clearing lastAutoSync lets the track already playing on YouTube go to Spotify right away
      await chrome.storage.local.set({ autoModeEnabled: enabled, lastAutoSync: null });
      updateAutoBadge(enabled);
      showStatus(
        enabled ? '⚡ Modo Automático ATIVADO' : 'Modo Automático DESATIVADO',
        enabled ? '#1db954' : '#888'
      );
    });
  }

  function updateAutoBadge(enabled) {
    if (!autoModeBadge) return;
    autoModeBadge.textContent = enabled ? 'ON' : 'OFF';
    autoModeBadge.className = enabled ? 'badge-auto-on' : 'badge-auto-off';
  }

  function renderLastHandoff(result) {
    if (!lastHandoffEl) return;
    if (!result) {
      lastHandoffEl.classList.add('hidden');
      return;
    }
    const when = new Date(result.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const text = {
      confirmed: `✓ ${when} tocando: ${result.trackName} → ${result.device}`,
      unconfirmed: `… ${when} enviado, sem confirmação: ${result.trackName} → ${result.device}`,
      failed: `✗ ${when} falhou: ${result.message}`
    }[result.status] || '';
    lastHandoffEl.textContent = text;
    lastHandoffEl.title = text;
    lastHandoffEl.className = `last-handoff ${result.status}`;
  }

  // ───── 3. Debug Mode Toggle ─────
  if (debugToggle) {
    debugToggle.checked = !!storage.debugModeEnabled;
    toggleDebugPanel(!!storage.debugModeEnabled);

    debugToggle.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      await chrome.storage.local.set({ debugModeEnabled: enabled });
      toggleDebugPanel(enabled);
    });
  }

  function toggleDebugPanel(show) {
    if (debugPanel) {
      debugPanel.classList.toggle('hidden', !show);
    }
  }

  // ───── 4. Spotify Account ─────
  // chrome.identity is missing in some Chromium-based browsers: the popup must keep working,
  // only the Spotify login becomes unavailable
  const identityAvailable = typeof chrome.identity?.getRedirectURL === 'function';
  if (redirectUriEl) {
    redirectUriEl.textContent = identityAvailable
      ? chrome.identity.getRedirectURL('spotify')
      : 'Indisponível: este navegador não oferece chrome.identity';
  }

  async function renderAuthState() {
    const data = await chrome.storage.local.get([...TOKEN_KEYS, 'engineState', 'authError', 'spotifyDisplayName']);
    isConnected = !!(data.spotify_access_token || data.spotify_refresh_token) && data.engineState !== 'AUTH_REQUIRED';

    authIndicator.textContent = isConnected
      ? `Conectado como ${data.spotifyDisplayName || 'sua conta'} ✓`
      : 'Spotify: desconectado';
    authIndicator.className = `auth-text ${isConnected ? 'connected' : 'disconnected'}`;
    authBtn.textContent = isConnected ? 'Desconectar' : 'Conectar Spotify';
    authBtn.className = isConnected ? 'btn-account secondary' : 'btn-account';
    authSetup?.classList.toggle('hidden', isConnected);
    if (authErrorEl) authErrorEl.textContent = !isConnected && data.authError ? data.authError : '';

    if (isConnected && !data.spotifyDisplayName) cacheProfileName();
    return isConnected;
  }

  async function cacheProfileName() {
    const profile = await provider.getProfile().catch(() => null);
    if (profile?.display_name) {
      await chrome.storage.local.set({ spotifyDisplayName: profile.display_name });
    }
  }

  // Automatic login: if the app was authorized before, recover a lost session without a window
  async function tryAutomaticLogin() {
    const { spotifyAuthorizedOnce, autoReauthDisabled } =
      await chrome.storage.local.get(['spotifyAuthorizedOnce', 'autoReauthDisabled']);
    if (isConnected || !identityAvailable || !spotifyAuthorizedOnce || autoReauthDisabled) return false;

    authIndicator.textContent = 'Spotify: entrando automaticamente…';
    authBtn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'SPOTIFY_LOGIN', interactive: false }).catch(() => null);
    authBtn.disabled = false;
    await renderAuthState();
    return !!res?.success;
  }


  authBtn.addEventListener('click', () => {
    if (isConnected) {
      chrome.runtime.sendMessage({ type: 'SPOTIFY_LOGOUT' }, async () => {
        await renderAuthState();
        await loadDevices();
        showStatus('Spotify desconectado', '#888');
      });
      return;
    }

    if (!identityAvailable) {
      showStatus('Login indisponível neste navegador (sem chrome.identity). Use Google Chrome ou Microsoft Edge.', '#ff5555');
      return;
    }

    authBtn.disabled = true;
    authBtn.textContent = 'Abrindo login…';
    // The popup usually closes when the Spotify window opens; the service worker finishes the flow
    chrome.runtime.sendMessage({ type: 'SPOTIFY_LOGIN' }, async (res) => {
      if (chrome.runtime.lastError) return;
      authBtn.disabled = false;
      await renderAuthState();
      if (res?.success) {
        showStatus('✓ Spotify conectado', '#1db954');
        await loadDevices();
        await checkPlaybackStatus();
      } else {
        showStatus(`Login falhou: ${res?.message || 'erro desconhecido'}`, '#ff5555');
      }
    });
  });

  if (copyRedirectBtn) {
    copyRedirectBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(redirectUriEl.textContent);
      showStatus('📋 Redirect URI copiada', '#1db954');
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.spotify_access_token || changes.engineState || changes.authError || changes.spotifyDisplayName) renderAuthState();
    if (changes.lastHandoffResult) renderLastHandoff(changes.lastHandoffResult.newValue);
  });

  // ───── 5. Query active tab ─────
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && /^https:\/\/(www|music)\.youtube\.com\//.test(activeTab.url || '')) {
      chrome.tabs.sendMessage(activeTab.id, { type: 'GET_ACTIVE_TRACK' }, (res) => {
        if (chrome.runtime.lastError) return; // tab may not have content script
        if (res?.payload) {
          updateTrackDisplay(res.payload);
        }
      });
    }
  } catch (e) { /* tabs API may fail if no permission */ }

  // ───── Display Helpers ─────
  function updateTrackDisplay(track) {
    currentTrack = track;
    trackTitleEl.textContent = track.title || track.normalizedTitle || track.rawTitle || '';
    trackArtistEl.textContent = track.artist || track.normalizedArtist || track.rawArtist || 'Artista do canal';

    if (track.artworkUrl) {
      trackArtwork.src = track.artworkUrl;
      trackArtwork.style.display = 'block';
      artworkPlaceholder.style.display = 'none';
    } else {
      trackArtwork.style.display = 'none';
      artworkPlaceholder.style.display = 'block';
    }

    updateHandoffButtonState();
  }

  function updateHandoffButtonState() {
    if (currentTrack) {
      handoffBtn.disabled = false;
      handoffBtnText.textContent = `▶ Pausar YouTube & Tocar em ${selectedDeviceName}`;
    } else {
      handoffBtn.disabled = true;
      handoffBtnText.textContent = `▶ Selecione uma música no YouTube`;
    }
  }

  function setPlayingVisuals(isPlaying) {
    isCurrentlyPlaying = isPlaying;
    if (isPlaying) {
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
      ctrlPlayPauseBtn.classList.add('active-playing');
      stateDot.className = 'status-dot playing';
      stateText.textContent = 'Tocando';
      playingWave.classList.remove('hidden');
    } else {
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
      ctrlPlayPauseBtn.classList.remove('active-playing');
      stateDot.className = 'status-dot paused';
      stateText.textContent = 'Pausado';
      playingWave.classList.add('hidden');
    }
  }

  function showStatus(text, color) {
    statusBox.textContent = text;
    statusBox.style.color = color;
    statusBox.classList.remove('hidden');
    setTimeout(() => {
      statusBox.classList.add('hidden');
    }, 4500);
  }

  function errorText(err) {
    return isAuthError(err.message) ? 'Conecte o Spotify (rodapé do popup)' : err.message;
  }

  // ───── 6. Playback polling ─────
  async function checkPlaybackStatus() {
    if (!isConnected) return;
    try {
      const state = await provider.getPlaybackState();
      if (state) {
        setPlayingVisuals(state.is_playing);
        if (state.item) {
          trackTitleEl.textContent = state.item.name;
          trackArtistEl.textContent = state.item.artists.map(a => a.name).join(', ');
          if (state.item.album?.images?.[0]?.url) {
            trackArtwork.src = state.item.album.images[0].url;
            trackArtwork.style.display = 'block';
            artworkPlaceholder.style.display = 'none';
          }
        }
        if (state.device) {
          // Update display only — don't overwrite user's saved preference
          targetDeviceLabel.textContent = state.device.name;
          if (state.device.volume_percent !== null) {
            volumeSlider.value = state.device.volume_percent;
            volValText.textContent = `${state.device.volume_percent}%`;
          }
        }
      }
    } catch (e) { /* silent on network failures */ }
  }

  // ───── 7. Debug panel updates ─────
  async function updateDebugPanel() {
    if (!debugPanel || debugPanel.classList.contains('hidden')) return;

    const data = await chrome.storage.local.get([
      'autoModeEnabled', 'currentTrack', 'lastAutoSync',
      'targetDeviceId', 'targetDeviceName', 'handoffState',
      'lastCorrelationId', 'lastHandoffError', 'engineState'
    ]);

    const debugContent = debugPanel.querySelector('.debug-content');
    if (!debugContent) return;

    const row = (label, value, cls = '') =>
      `<div class="debug-row ${cls}"><span>${label}</span> <span>${escapeHtml(value)}</span></div>`;
    const track = data.currentTrack;

    debugContent.innerHTML = [
      `<div class="debug-row"><span>AUTO:</span> <span class="${data.autoModeEnabled ? 'debug-on' : 'debug-off'}">${data.autoModeEnabled ? 'ON' : 'OFF'}</span></div>`,
      row('Track:', track?.title || '—'),
      row('Artist:', track?.artist || '—'),
      row('Signature:', track?.signature || '—'),
      row('Previous:', data.lastAutoSync?.signature || '—'),
      row('Target:', data.targetDeviceName || 'Tudo'),
      row('State:', data.handoffState || 'IDLE'),
      row('Engine:', data.engineState || '—'),
      row('Correlation:', data.lastCorrelationId || '—'),
      data.lastHandoffError ? row('Error:', data.lastHandoffError, 'debug-error') : ''
    ].join('');
  }

  // ───── 8. Telemetry UI ─────
  function describeLog(data = {}) {
    const main = data.title || data.trackName || data.device || '';
    const extras = [
      data.decision,
      data.confidence !== undefined ? `${data.confidence}%` : null,
      data.status !== undefined ? `HTTP ${data.status}` : null,
      data.error
    ].filter(Boolean);
    return [main, ...extras].filter(Boolean).join(' · ');
  }

  async function updateTelemetryUI() {
    if (!telemetryListEl) return;
    const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
    if (telemetryLogs.length === 0) {
      telemetryListEl.innerHTML = '<div class="log-empty">Aguardando eventos do YouTube...</div>';
      return;
    }

    telemetryListEl.innerHTML = telemetryLogs.slice(0, 15).map(l => {
      const detail = escapeHtml(describeLog(l.data));
      const cid = l.correlationId ? `<span class="log-cid">${escapeHtml(l.correlationId)}</span>` : '';
      return `
        <div class="telemetry-item">
          <div><span class="log-time">${escapeHtml(l.time)}</span>${cid}<span class="log-stage">${escapeHtml(l.stage)}</span></div>
          <span class="log-msg" title="${detail}">${detail}</span>
        </div>
      `;
    }).join('');
  }

  // ───── 9. Playback Controls ─────
  ctrlPlayPauseBtn.addEventListener('click', async () => {
    iconPlay.classList.add('hidden');
    iconPause.classList.add('hidden');
    btnSpinner.classList.remove('hidden');

    try {
      const newState = !isCurrentlyPlaying;
      await provider.togglePlayback(isCurrentlyPlaying);
      setPlayingVisuals(newState);
      showStatus(newState ? '▶ Reproduzindo' : '⏸ Pausado', newState ? '#1db954' : '#f39c12');
    } catch (err) {
      showStatus(`Erro: ${errorText(err)}`, '#ff5555');
    } finally {
      btnSpinner.classList.add('hidden');
      if (isCurrentlyPlaying) iconPause.classList.remove('hidden');
      else iconPlay.classList.remove('hidden');
    }
  });

  ctrlNextBtn.addEventListener('click', async () => {
    try {
      await provider.nextTrack();
      showStatus('⏭ Próxima faixa', '#1db954');
      setTimeout(checkPlaybackStatus, 800);
    } catch (err) {
      showStatus(`Erro: ${errorText(err)}`, '#ff5555');
    }
  });

  ctrlPrevBtn.addEventListener('click', async () => {
    try {
      await provider.previousTrack();
      showStatus('⏮ Faixa anterior', '#1db954');
      setTimeout(checkPlaybackStatus, 800);
    } catch (err) {
      showStatus(`Erro: ${errorText(err)}`, '#ff5555');
    }
  });

  // ───── 10. Volume ─────
  volumeSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    volValText.textContent = `${val}%`;

    if (val === 0) volIcon.textContent = '🔇';
    else if (val < 50) volIcon.textContent = '🔉';
    else volIcon.textContent = '🔊';

    clearTimeout(volumeDebounceTimer);
    volumeDebounceTimer = setTimeout(async () => {
      try {
        await provider.setVolume(val, selectedDeviceId);
        await chrome.storage.local.set({ lastVolume: val });
      } catch (err) {
        console.warn('Volume error:', err);
      }
    }, 200);
  });

  // ───── 11. Device list ─────
  async function loadDevices() {
    if (!isConnected) {
      deviceListEl.innerHTML = '<div class="empty-state">Conecte sua conta Spotify (rodapé) para listar os dispositivos.</div>';
      return;
    }

    deviceListEl.innerHTML = '<div class="loading-state">Buscando dispositivos...</div>';

    try {
      const devices = await provider.getDevices();

      if (!devices || devices.length === 0) {
        deviceListEl.innerHTML = `
          <div class="empty-state">
            Nenhum dispositivo ativo encontrado.<br>
            Diga "Alexa, tocar Spotify" para acordar os dispositivos.
          </div>
        `;
        return;
      }

      deviceListEl.innerHTML = '';

      devices.forEach(dev => {
        const item = document.createElement('div');
        item.className = 'device-item';

        const isCurrent = (selectedDeviceId && dev.id === selectedDeviceId) ||
                          (!selectedDeviceId && dev.name.toLowerCase().includes('tudo'));

        if (isCurrent) {
          item.classList.add('active');
          selectedDeviceId = dev.id;
          selectedDeviceName = dev.name;
          targetDeviceLabel.textContent = dev.name;
          if (dev.volume_percent !== null && dev.volume_percent !== undefined) {
            volumeSlider.value = dev.volume_percent;
            volValText.textContent = `${dev.volume_percent}%`;
          }
        }

        let icon = '🔊';
        if (dev.type === 'TV') icon = '📺';
        if (dev.type === 'Smartphone') icon = '📱';
        if (dev.type === 'Computer') icon = '💻';

        item.innerHTML = `
          <div class="device-icon">${icon}</div>
          <div class="device-info">
            <span class="device-name">${escapeHtml(dev.name)}</span>
            <span class="device-status">${escapeHtml(dev.type)} • ${dev.is_active ? 'Em reprodução' : 'Disponível'}</span>
          </div>
          <span class="radio-indicator"></span>
        `;

        item.addEventListener('click', async () => {
          document.querySelectorAll('.device-item').forEach(d => d.classList.remove('active'));
          item.classList.add('active');
          selectedDeviceId = dev.id;
          selectedDeviceName = dev.name;
          targetDeviceLabel.textContent = dev.name;

          if (dev.volume_percent !== null && dev.volume_percent !== undefined) {
            volumeSlider.value = dev.volume_percent;
            volValText.textContent = `${dev.volume_percent}%`;
          }

          await chrome.storage.local.set({
            targetDeviceId: dev.id,
            targetDeviceName: dev.name
          });
          updateHandoffButtonState();
        });

        deviceListEl.appendChild(item);
      });

      updateHandoffButtonState();

    } catch (err) {
      deviceListEl.innerHTML = `<div class="empty-state" style="color:#ff5555">Erro: ${escapeHtml(errorText(err))}</div>`;
    }
  }

  // ───── 12. Manual Handoff ─────
  handoffBtn.addEventListener('click', () => {
    if (!currentTrack) return;

    handoffBtn.disabled = true;
    handoffBtnText.textContent = `Enviando para ${selectedDeviceName}...`;
    handoffSpinner.classList.remove('hidden');

    const isYouTubeTab = /^https:\/\/(www|music)\.youtube\.com\//.test(activeTab?.url || '');
    chrome.runtime.sendMessage({
      type: 'TRIGGER_HANDOFF',
      payload: currentTrack,
      tabId: isYouTubeTab ? activeTab.id : undefined
    }, (res) => {
      if (chrome.runtime.lastError) {
        showStatus('Erro: Extensão desconectada', '#ff5555');
      }
      handoffBtn.disabled = false;
      handoffSpinner.classList.add('hidden');
      handoffBtnText.textContent = `▶ Pausar YouTube & Tocar em ${selectedDeviceName}`;

      if (res && res.success) {
        showStatus(
          res.confirmed ? `✓ Tocando "${res.trackName}" em ${res.device}!` : `Enviado "${res.trackName}" para ${res.device} (aguardando confirmação)`,
          res.confirmed ? '#1db954' : '#f39c12'
        );
        setPlayingVisuals(true);
        setTimeout(checkPlaybackStatus, 1200);
      } else {
        showStatus(`Falha: ${res?.message || 'Erro ao conectar'}`, '#ff5555');
      }
    });
  });

  // ───── 13. Log buttons ─────
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      await chrome.storage.local.set({ telemetryLogs: [] });
      updateTelemetryUI();
    });
  }

  if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', async () => {
      const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
      const text = telemetryLogs.map(l =>
        `[${l.time}] [${l.correlationId || '-'}] ${l.stage} ${JSON.stringify(l.data)}`
      ).join('\n');
      await navigator.clipboard.writeText(text);
      showStatus('📋 Logs copiados!', '#1db954');
    });
  }

  if (exportLogsBtn) {
    exportLogsBtn.addEventListener('click', async () => {
      const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
      const blob = new Blob([JSON.stringify(telemetryLogs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sync-music-logs-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ───── 14. Event listeners ─────
  refreshDevicesBtn.addEventListener('click', loadDevices);
  if (closeBtn) closeBtn.addEventListener('click', () => window.close());

  // ───── 15. Initialize ─────
  await renderAuthState();
  tryAutomaticLogin().then(async (loggedIn) => {
    if (!loggedIn) return;
    await loadDevices();
    await checkPlaybackStatus();
  });
  renderLastHandoff(storage.lastHandoffResult);
  updateTelemetryUI();
  setInterval(() => {
    updateTelemetryUI();
    updateDebugPanel();
  }, 2000);

  await loadDevices();
  await checkPlaybackStatus();
  setInterval(checkPlaybackStatus, 3000);
});
