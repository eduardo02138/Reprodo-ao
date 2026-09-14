const { chromium } = require('playwright-chromium');
const path = require('path');

async function run() {
  const extensionPath = path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension');
  
  const context = await chromium.launchPersistentContext('', {
    headless: false, // Chrome só carrega extensões em headless: false OU headless: 'new' via args
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  console.log('Contexto com --headless=new aberto.');
  context.on('serviceworker', sw => {
    console.log('Evento serviceworker disparado:', sw.url());
  });

  await new Promise(r => setTimeout(r, 2000));
  console.log('ServiceWorkers:', context.serviceWorkers().map(s => s.url()));

  await context.close();
}
run().catch(console.error);
