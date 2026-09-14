const { chromium } = require('playwright-chromium');
const path = require('path');

async function run() {
  const extensionPath = path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension');
  
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  console.log('Contexto iniciado com headless: false.');
  
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  }

  console.log('✓ Service worker capturado com sucesso:', sw.url());
  await context.close();
}
run().catch(console.error);
