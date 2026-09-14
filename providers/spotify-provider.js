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

  // Resolve o dispositivo alvo contra a lista atual: o device_id do Spotify só é persistente "até certo ponto"
  async resolveTargetDevice({ preferredId = null, preferredName = null, fallbackName = 'Tudo' } = {}) {
    const devices = await this.getDevices();
    if (devices.length === 0) return null;

    const lower = (s) => (s || '').toLowerCase();
    const exactName = (name) => name && devices.find(d => lower(d.name) === lower(name));
    const partialName = (name) => name && devices.find(d => lower(d.name).includes(lower(name)));
    const pick = (device, matchedBy) => (device ? { device, matchedBy } : null);

    return pick(preferredId && devices.find(d => d.id === preferredId), 'id')
      || pick(exactName(preferredName), 'name')
      || pick(exactName(fallbackName) || partialName(fallbackName), 'fallback-name')
      || pick(devices.find(d => d.is_active), 'active')
      || pick(devices[0], 'first-available');
  }

  // Busca faixa no catálogo: qualificada → ampla → só título
  async searchTrack(title, artist) {
    const queries = [
      artist ? `track:"${title}" artist:"${artist}"` : `track:"${title}"`,
      artist ? `${title} ${artist}` : title,
      title
    ];

    for (const query of [...new Set(queries)]) {
      const { res } = await this.client.request(`/search?q=${encodeURIComponent(query)}&type=track&limit=5`);
      if (res.status === 400) continue;
      if (!res.ok) throw new Error(`Erro na busca do Spotify: ${res.status}`);
      const data = await res.json();
      if (data.tracks?.items?.length > 0) return data.tracks.items;
    }
    return [];
  }

  async describeResult(res) {
    if (res.ok) return { ok: true, status: res.status };
    let error = '';
    try {
      const body = await res.json();
      error = body.error?.message || body.error?.reason || JSON.stringify(body);
    } catch (e) {}
    return { ok: false, status: res.status, error };
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
    return this.describeResult(res);
  }

  async transferPlayback(deviceId, play = false) {
    const { res } = await this.client.request('/me/player', {
      method: 'PUT',
      body: JSON.stringify({ device_ids: [deviceId], play })
    });
    return this.describeResult(res);
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
