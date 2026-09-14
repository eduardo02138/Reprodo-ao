// Provedor Spotify Connect resiliente usando SpotifyClient centralizado
import { SpotifyClient } from '../shared/spotify-client.js';

export class SpotifyProvider {
  constructor() {
    this.name = 'Spotify Connect';
    this.client = new SpotifyClient();
  }

  async getAccessToken() {
    return await this.client.getAccessToken();
  }

  // G8: Descoberta resiliente respeitando preferredDeviceName ("Tudo")
  async getDevices() {
    const { res } = await this.client.request('/me/player/devices');
    if (!res.ok) {
      throw new Error(`Erro ao obter dispositivos: ${res.status}`);
    }
    const data = await res.json();
    return data.devices || [];
  }

  // Resolve dispositivo alvo dinamicamente verificando se o ID em cache ainda existe
  async resolveTargetDevice(preferredName = 'Tudo') {
    const devices = await this.getDevices();
    if (devices.length === 0) return null;

    const { cachedDeviceId } = await chrome.storage.local.get('cachedDeviceId');

    // 1. Verifica se o ID cacheado ainda é válido na lista atual
    if (cachedDeviceId) {
      const existing = devices.find(d => d.id === cachedDeviceId);
      if (existing) return existing;
    }

    // 2. Procura pelo nome preferido ("Tudo" ou "Casa")
    const matchByName = devices.find(d => d.name.toLowerCase().includes(preferredName.toLowerCase()));
    if (matchByName) {
      await chrome.storage.local.set({ cachedDeviceId: matchByName.id });
      return matchByName;
    }

    // 3. Fallback: Primeiro dispositivo de áudio disponível
    const fallback = devices[0];
    await chrome.storage.local.set({ cachedDeviceId: fallback.id });
    return fallback;
  }

  // Busca faixa no catálogo com busca qualificada e fallback amplo
  async searchTrack(title, artist) {
    let query = `track:"${title}"`;
    if (artist) query += ` artist:"${artist}"`;

    let { res } = await this.client.request(`/search?q=${encodeURIComponent(query)}&type=track&limit=5`);
    let data = await res.json();

    if (data.tracks?.items?.length > 0) {
      return data.tracks.items;
    }

    // Fallback de busca ampla
    const fallbackQuery = artist ? `${title} ${artist}` : title;
    const fallbackRes = await this.client.request(`/search?q=${encodeURIComponent(fallbackQuery)}&type=track&limit=5`);
    data = await fallbackRes.res.json();
    return data.tracks?.items || [];
  }

  // Dispara reprodução em dispositivo
  async playTrackOnDevice(deviceId, trackUri) {
    const endpoint = deviceId 
      ? `/me/player/play?device_id=${encodeURIComponent(deviceId)}`
      : '/me/player/play';

    const { res } = await this.client.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify({ uris: [trackUri] })
    });

    return res.status === 204 || res.ok;
  }

  // G10: Ajuste de volume com abort tag para evitar race condition
  async setVolume(percent, deviceId) {
    let endpoint = `/me/player/volume?volume_percent=${encodeURIComponent(percent)}`;
    if (deviceId) endpoint += `&device_id=${encodeURIComponent(deviceId)}`;

    const { res } = await this.client.request(endpoint, { method: 'PUT' }, 'volume-change');
    return res.status === 204 || res.ok;
  }

  async getPlaybackState() {
    try {
      const { res } = await this.client.request('/me/player');
      if (res.status === 204 || !res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async togglePlayback(isPlaying) {
    const endpoint = isPlaying ? '/me/player/pause' : '/me/player/play';
    const { res } = await this.client.request(endpoint, { method: 'PUT' });
    return res.status === 204 || res.ok;
  }

  async nextTrack() {
    const { res } = await this.client.request('/me/player/next', { method: 'POST' });
    return res.status === 204 || res.ok;
  }

  async previousTrack() {
    const { res } = await this.client.request('/me/player/previous', { method: 'POST' });
    return res.status === 204 || res.ok;
  }
}
