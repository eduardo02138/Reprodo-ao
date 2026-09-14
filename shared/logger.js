// logger.js: Sistema de Telemetria e Logs em tempo real persistente no chrome.storage
export async function logTelemetry(stage, data = {}) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
  const logEntry = {
    time: timestamp,
    stage,
    data,
    id: Math.random().toString(36).substring(2, 7)
  };

  console.log(`[TELEMETRIA ${timestamp}] [${stage}]`, data);

  try {
    const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
    telemetryLogs.unshift(logEntry);
    // Mantém os últimos 40 registros
    if (telemetryLogs.length > 40) telemetryLogs.pop();
    await chrome.storage.local.set({ telemetryLogs });
  } catch (e) {}
}
