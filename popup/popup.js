import { SpotifyProvider } from '../providers/spotify-provider.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Elementos do Card e Artwork
  const trackTitleEl = document.getElementById('track-title');
  const trackArtistEl = document.getElementById('track-artist');
  const trackArtwork = document.getElementById('track-artwork');
  const artworkPlaceholder = document.getElementById('artwork-placeholder');
  const playingWave = document.getElementById('playing-wave');
  const stateDot = document.getElementById('playback-state-dot');
  const stateText = document.getElementById('playback-state-text');

  // Controles de Playback
  const ctrlPlayPauseBtn = document.getElementById('ctrl-play-pause');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnSpinner = document.getElementById('btn-spinner');
  const ctrlPrevBtn = document.getElementById('ctrl-prev');
  const ctrlNextBtn = document.getElementById('ctrl-next');

  // Dispositivos e Volume
  const deviceListEl = document.getElementById('device-list');
  const refreshDevicesBtn = document.getElementById('refresh-devices-btn');
  const volumeSlider = document.getElementById('volume-slider');
  const volValText = document.getElementById('vol-val-text');
  const targetDeviceLabel = document.getElementById('target-device-label');
  const volIcon = document.getElementById('vol-icon');

  // Handoff e Status
  const handoffBtn = document.getElementById('handoff-btn');
  const handoffBtnText = document.getElementById('handoff-btn-text');
  const handoffSpinner = document.getElementById('handoff-spinner');
  const statusBox = document.getElementById('status-message');
  const closeBtn = document.getElementById('close-btn');

  const provider = new SpotifyProvider();
  let currentTrack = null;
  let selectedDeviceId = null;
  let selectedDeviceName = 'Tudo';
  let isCurrentlyPlaying = false;
  let volumeDebounceTimer = null;
  let pollTimer = null;

  // 1. Carrega dados prévios do storage
  const storage = await chrome.storage.local.get([
    'currentTrack',
    'targetDeviceId',
    'targetDeviceName',
    'lastVolume'
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

  // 2. Consulta aba ativa
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && (activeTab.url?.includes('youtube.com') || activeTab.url?.includes('music.youtube.com'))) {
    try {
      chrome.tabs.sendMessage(activeTab.id, { type: 'GET_ACTIVE_TRACK' }, (res) => {
        if (res?.payload) {
          updateTrackDisplay(res.payload);
        }
      });
    } catch (e) {}
  }

  function updateTrackDisplay(track) {
    currentTrack = track;
    trackTitleEl.textContent = track.normalizedTitle || track.rawTitle;
    trackArtistEl.textContent = track.normalizedArtist || track.rawArtist || 'Artista do canal';

    // Exibe Capa se disponível
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

  // 3. Consulta em tempo real o estado de reprodução (Polling leve a cada 3s)
  async function checkPlaybackStatus() {
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
          selectedDeviceId = state.device.id;
          selectedDeviceName = state.device.name;
          targetDeviceLabel.textContent = state.device.name;
          if (state.device.volume_percent !== null) {
            volumeSlider.value = state.device.volume_percent;
            volValText.textContent = `${state.device.volume_percent}%`;
          }
        }
      }
    } catch (e) {
      // Falha silenciosa se offline
    }
  }

  // 4. Botão Play / Pause Interativo com animação
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
      showStatus(`Erro: ${err.message}`, '#ff5555');
    } finally {
      btnSpinner.classList.add('hidden');
      if (isCurrentlyPlaying) iconPause.classList.remove('hidden');
      else iconPlay.classList.remove('hidden');
    }
  });

  // Botões Próxima e Anterior
  ctrlNextBtn.addEventListener('click', async () => {
    try {
      await provider.nextTrack();
      showStatus('⏭ Próxima faixa', '#1db954');
      setTimeout(checkPlaybackStatus, 800);
    } catch (e) {}
  });

  ctrlPrevBtn.addEventListener('click', async () => {
    try {
      await provider.previousTrack();
      showStatus('⏮ Faixa anterior', '#1db954');
      setTimeout(checkPlaybackStatus, 800);
    } catch (e) {}
  });

  // 5. Slider de Volume Mestre com Feedback em tempo real
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
        console.warn('Erro ao ajustar volume:', err);
      }
    }, 200);
  });

  // 6. Lista os dispositivos disponíveis
  async function loadDevices() {
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
            <span class="device-name">${dev.name}</span>
            <span class="device-status">${dev.type} • ${dev.is_active ? 'Em reprodução' : 'Disponível'}</span>
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
      deviceListEl.innerHTML = `<div class="empty-state" style="color:#ff5555">Erro: ${err.message}</div>`;
    }
  }

  // 7. Ação de Handoff com Spinner e Feedback de Animação
  handoffBtn.addEventListener('click', () => {
    if (!currentTrack) return;

    handoffBtn.disabled = true;
    handoffBtnText.textContent = `Enviando para ${selectedDeviceName}...`;
    handoffSpinner.classList.remove('hidden');

    chrome.runtime.sendMessage({
      type: 'TRIGGER_HANDOFF',
      autoPause: true
    }, (res) => {
      handoffBtn.disabled = false;
      handoffSpinner.classList.add('hidden');
      handoffBtnText.textContent = `▶ Pausar YouTube & Tocar em ${selectedDeviceName}`;

      if (res && res.success) {
        showStatus(`✓ Tocando "${res.trackName}" em ${selectedDeviceName}!`, '#1db954');
        setPlayingVisuals(true);
        setTimeout(checkPlaybackStatus, 1200);
      } else {
        showStatus(`Falha: ${res?.message || 'Erro ao conectar'}`, '#ff5555');
      }
    });
  });

  function showStatus(text, color) {
    statusBox.textContent = text;
    statusBox.style.color = color;
    statusBox.classList.remove('hidden');
    setTimeout(() => {
      statusBox.classList.add('hidden');
    }, 4500);
  }

  refreshDevicesBtn.addEventListener('click', loadDevices);
  if (closeBtn) closeBtn.addEventListener('click', () => window.close());

  // Inicialização
  await loadDevices();
  await checkPlaybackStatus();
  pollTimer = setInterval(checkPlaybackStatus, 3000);
});

  // Controle do Modo Automático
  const autoModeToggle = document.getElementById('auto-mode-toggle');
  const autoModeBadge = document.getElementById('auto-mode-badge');

  chrome.storage.local.get('autoModeEnabled', (res) => {
    const isAuto = !!res.autoModeEnabled;
    autoModeToggle.checked = isAuto;
    updateAutoBadge(isAuto);
  });

  autoModeToggle.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.local.set({ autoModeEnabled: enabled });
    updateAutoBadge(enabled);
    showStatus(enabled ? '⚡ Modo Automático ATIVADO' : 'Modo Automático DESATIVADO', enabled ? '#1db954' : '#888');
  });

  function updateAutoBadge(enabled) {
    if (enabled) {
      autoModeBadge.textContent = 'ON';
      autoModeBadge.className = 'badge-auto-on';
    } else {
      autoModeBadge.textContent = 'OFF';
      autoModeBadge.className = 'badge-auto-off';
    }
  }

  // Renderiza logs de telemetria no painel do popup
  const telemetryListEl = document.getElementById('telemetry-log-list');
  const clearLogsBtn = document.getElementById('clear-logs-btn');

  async function updateTelemetryUI() {
    if (!telemetryListEl) return;
    const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
    if (telemetryLogs.length === 0) {
      telemetryListEl.innerHTML = '<div class="log-empty">Aguardando eventos do YouTube...</div>';
      return;
    }

    telemetryListEl.innerHTML = telemetryLogs.slice(0, 10).map(l => {
      const detail = l.data?.trackTitle || l.data?.title || l.data?.trackName || l.data?.error || '';
      return `
        <div class="telemetry-item">
          <div><span class="log-time">${l.time}</span><span class="log-stage">${l.stage}</span></div>
          <span class="log-msg">${detail}</span>
        </div>
      `;
    }).join('');
  }

  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      await chrome.storage.local.set({ telemetryLogs: [] });
      updateTelemetryUI();
    });
  }

  // Atualiza telemetria a cada ciclo de polling
  updateTelemetryUI();
  setInterval(updateTelemetryUI, 2000);
