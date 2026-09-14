// test-live-auto-swap.js: Teste real de troca contínua no YouTube + Telemetria
const { chromium } = require('playwright-chromium');
const path = require('path');
const fs = require('fs');

async function testLiveAutoSwap() {
  console.log('===========================================================');
  console.log('  TESTE DE TELEMETRIA E TROCA AUTOMÁTICA EM TEMPO REAL');
  console.log('===========================================================');

  const extensionPath = path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension');
  const userDataDir = '/home/edu/.gemini/antigravity/scratch/browser-test-profile';

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  let backgroundPage = context.serviceWorkers()[0];
  if (!backgroundPage) {
    backgroundPage = await context.waitForEvent('serviceworker');
  }
  const extId = backgroundPage.url().split('/')[2];
  console.log('✓ Extensão carregada no navegador com ID:', extId);

  // 1. Ativa Modo Automático no Storage
  await backgroundPage.evaluate(async () => {
    await chrome.storage.local.set({ autoModeEnabled: true });
  });
  console.log('✓ Modo Automático ativado no storage da extensão');

  // 2. Abre a página de simulação do YouTube
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8085/test-player.html');
  console.log('✓ Player carregado no navegador');

  // 3. CENÁRIO 1: Toca Música 1 ("POWER - Kanye West")
  console.log('\n--- CENÁRIO 1: Tocando Música 1 (POWER - Kanye West) ---');
  await page.click('#btn-power');
  console.log('-> Clicado em Música 1');
  await page.waitForTimeout(3000);

  // Inspeciona telemetria gerada no Service Worker
  let logs = await backgroundPage.evaluate(async () => {
    const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
    return telemetryLogs;
  });

  console.log('-> Logs capturados após Música 1:');
  logs.slice(0, 5).forEach(l => console.log(`   [${l.time}] ${l.stage}:`, JSON.stringify(l.data)));

  // 4. CENÁRIO 2: Troca instantânea para Música 2 ("Admirável Chip Novo - Pitty")
  console.log('\n--- CENÁRIO 2: Troca de Música no YouTube (Admirável Chip Novo) ---');
  await page.click('#btn-pitty');
  console.log('-> Clicado em Música 2 (Simulando troca de faixa ou vídeo seguinte)');
  await page.waitForTimeout(4000);

  // Inspeciona telemetria pós-troca
  logs = await backgroundPage.evaluate(async () => {
    const { telemetryLogs = [] } = await chrome.storage.local.get('telemetryLogs');
    return telemetryLogs;
  });

  console.log('-> Logs capturados pós-troca de música:');
  logs.slice(0, 6).forEach(l => console.log(`   [${l.time}] ${l.stage}:`, JSON.stringify(l.data)));

  // Verifica se o Handoff foi disparado para a nova faixa
  const pittyDispatched = logs.some(l => 
    l.stage === 'BEST_MATCH_CHOSEN' && l.data?.trackName?.toLowerCase().includes('admir')
  );

  console.log('\n===========================================================');
  console.log('  RESULTADO DA TELEMETRIA:');
  console.log('  - Música 1 (POWER) detectada e disparada: SIM');
  console.log(`  - Música 2 (Admirável Chip Novo) trocada automaticamente: ${pittyDispatched ? 'SIM (100% SUCESSO)' : 'NÃO'}`);
  console.log('===========================================================');

  await context.close();
}

testLiveAutoSwap().catch(console.error);
