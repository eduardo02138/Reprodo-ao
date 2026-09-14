// logger.js: Sistema de Telemetria e Logs em tempo real persistente no chrome.storage
const MAX_LOGS = 80;

// Gravações em série: get→unshift→set concorrentes perdiam eventos
let writeQueue = Promise.resolve();

export function logTelemetry(stage, data = {}) {
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const logEntry = {
    time,
    at: Date.now(),
    stage,
    data,
    id: Math.random().toString(36).substring(2, 7)
  };

  console.log(`[TELEMETRIA ${time}] [${stage}]`, data);

  writeQueue = writeQueue
    .then(async () => {
      const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
      telemetryLogs.unshift(logEntry);
      await chrome.storage.local.set({ telemetryLogs: telemetryLogs.slice(0, MAX_LOGS) });
    })
    .catch(() => {});
  return writeQueue;
}
