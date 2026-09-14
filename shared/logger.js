// logger.js: Telemetry system with correlationId tracking and log rotation
const MAX_LOG_ENTRIES = 300;

// Writes are serialized: concurrent get → unshift → set calls used to overwrite each other
let writeQueue = Promise.resolve();

export function logTelemetry(stage, data = {}, correlationId = null) {
  const now = new Date();
  const time = `${now.toLocaleTimeString('pt-BR', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;

  const logEntry = {
    timestamp: now.toISOString(),
    time,
    stage,
    correlationId,
    data,
    id: Math.random().toString(36).substring(2, 8)
  };

  console.log(`[SYNC ${time}] [${correlationId || '-'}] ${stage}`, data);

  writeQueue = writeQueue
    .then(async () => {
      const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
      telemetryLogs.unshift(logEntry);
      await chrome.storage.local.set({ telemetryLogs: telemetryLogs.slice(0, MAX_LOG_ENTRIES) });
    })
    .catch(() => {
      // Storage may be unavailable during SW shutdown
    });
  return writeQueue;
}
