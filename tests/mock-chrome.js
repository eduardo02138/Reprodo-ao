// Mock das APIs do Chrome para testes autônomos em Node.js
const fs = require('fs');
const path = require('path');

const storageFile = path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension/shared/default-token.json');
let memoryStorage = {};

if (fs.existsSync(storageFile)) {
  const seed = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  memoryStorage = {
    spotify_access_token: seed.access_token,
    spotify_refresh_token: seed.refresh_token,
    spotify_token_expires_at: Date.now() + 3600000
  };
}

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: memoryStorage[keys] };
        if (Array.isArray(keys)) {
          const res = {};
          keys.forEach(k => res[k] = memoryStorage[k]);
          return res;
        }
        return memoryStorage;
      },
      set: async (obj) => {
        Object.assign(memoryStorage, obj);
      }
    }
  },
  runtime: {
    getURL: (file) => path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension', file)
  }
};
