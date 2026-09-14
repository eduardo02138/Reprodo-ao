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

  // Lista dispositivos disponíveis
  async getDevices() {
    const { res } = await this.client.request('/me/player/devices');
    if (!res.ok) {
      throw new Error(`Erro ao obter dispositivos: ${res.status}`);
    }
    const data = await res.json();
    return data.devices || [];
  }

  // RC-5 FIX: Accepts object {preferredId, preferredName, fallbackName}
  // RC-13 FIX: No devices[0] fallback — returns null if preferred not found
  async resolveTargetDevice({ preferredId, preferredName, fallbackName } = {}) {
    const devices = await this.getDevices();
    if (devices.length === 0) return null;

    // Filter out restricted devices
    const available = devices.filter(d => !d.is_restricted);
    if (available.length === 0) return null;

    // 1. Match by saved ID (validate it still exists and is accessible)
    if (preferredId) {
      const byId = available.find(d => d.id === preferredId);
      if (byId) {
        return { device: byId, matchedBy: 'id' };
      }
    }

    // 2. Match by preferred name
    const nameToFind = preferredName || fallbackName || 'Tudo';
    const byName = available.find(d =>
      d.name.toLowerCase() === nameToFind.toLowerCase()
    );
    if (byName) {
      return { device: byName, matchedBy: 'name' };
    }

    // 3. Looser name match (contains)
    const byPartialName = available.find(d =>
      d.name.toLowerCase().includes(nameToFind.toLowerCase())
    );
    if (byPartialName) {
      return { device: byPartialName, matchedBy: 'partial-name' };
    }

    // 4. Try fallback name if different from preferred
    if (fallbackName && fallbackName !== nameToFind) {
      const byFallback = available.find(d =>
        d.name.toLowerCase().includes(fallbackName.toLowerCase())
      );
      if (byFallback) {
        return { device: byFallback, matchedBy: 'fallback-name' };
      }
    }

    // 5. NO automatic fallback to devices[0] — return null
    // The caller must handle DEVICE_UNAVAILABLE
    return null;
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

    // Fallback: broader search without field qualifiers
    const fallbackQuery = artist ? `${title} ${artist}` : title;
    const fallbackRes = await this.client.request(`/search?q=${encodeURIComponent(fallbackQuery)}&type=track&limit=5`);
    data = await fallbackRes.res.json();
    return data.tracks?.items || [];
  }

  // RC-6 FIX: Returns {ok, status, error} instead of boolean
  async playTrackOnDevice(deviceId, trackUri) {
    const endpoint = deviceId
      ? `/me/player/play?device_id=${encodeURIComponent(deviceId)}`
      : '/me/player/play';

    try {
      const { res } = await this.client.request(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ uris: [trackUri] })
      });

      if (res.status === 204 || res.ok) {
        return { ok: true, status: res.status };
      }

      let error = '';
      try { error = await res.text(); } catch (e) {}
      return { ok: false, status: res.status, error };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  // Transfer playback to a device (needed when device is inactive)
  async transferPlayback(deviceId, autoPlay = false) {
    try {
      const { res } = await this.client.request('/me/player', {
        method: 'PUT',
        body: JSON.stringify({
          device_ids: [deviceId],
          play: autoPlay
        })
      });

      if (res.status === 204 || res.ok) {
        return { ok: true, status: res.status };
      }

      let error = '';
      try { error = await res.text(); } catch (e) {}
      return { ok: false, status: res.status, error };
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  // Volume control with abort tag for race condition prevention
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
