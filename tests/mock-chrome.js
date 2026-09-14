// Mock das APIs do Chrome para testes autônomos em Node.js
// NO hardcoded tokens — tests must set tokens explicitly if needed

let memoryStorage = {};

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
        return { ...memoryStorage };
      },
      set: async (obj) => {
        Object.assign(memoryStorage, obj);
      },
      remove: async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        keyArr.forEach(k => delete memoryStorage[k]);
      }
    }
  },
  runtime: {
    getURL: (file) => `chrome-extension://fake-id/${file}`,
    lastError: null
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {}
  },
  tabs: {
    query: async () => [],
    sendMessage: async () => null
  }
};

// Helper to reset storage between tests
globalThis.resetMockStorage = (initial = {}) => {
  memoryStorage = { ...initial };
};
