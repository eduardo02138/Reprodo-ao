// logger.js: Telemetry system with correlationId tracking and log rotation
const MAX_LOG_ENTRIES = 1000;

export async function logTelemetry(stage, data = {}, correlationId = null) {
  const now = new Date();
  const timestamp = now.toISOString();
  const timeShort = timestamp.split('T')[1].slice(0, 12); // HH:MM:SS.mmm

  const logEntry = {
    timestamp,
    time: timeShort,
    stage,
    correlationId,
    data,
    id: Math.random().toString(36).substring(2, 8)
  };

  console.log(`[SYNC ${timeShort}] [${correlationId || '-'}] ${stage}`, data);

  try {
    const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
    telemetryLogs.unshift(logEntry);

    // Log rotation: keep only the most recent entries
    while (telemetryLogs.length > MAX_LOG_ENTRIES) {
      telemetryLogs.pop();
    }

    await chrome.storage.local.set({ telemetryLogs });
  } catch (e) {
    // Storage may be unavailable during SW shutdown
  }
}
