const { chromium } = require('playwright-chromium');
const path = require('path');

async function run() {
  const extensionPath = path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension');
  console.log('Iniciando Chromium com extensão em:', extensionPath);
  
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  console.log('Contexto aberto. serviceWorkers():', context.serviceWorkers().length);
  
  context.on('serviceworker', sw => {
    console.log('Evento serviceworker disparado:', sw.url());
  });

  // Abre uma aba para disparar a extensão
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8085/test-player.html');
  console.log('Página aberta.');

  await new Promise(r => setTimeout(r, 2000));
  console.log('ServiceWorkers após 2s:', context.serviceWorkers().map(s => s.url()));

  await context.close();
}
run().catch(console.error);
