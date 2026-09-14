const { chromium } = require('playwright-chromium');
const path = require('path');

async function run() {
  const extensionPath = path.resolve('/home/edu/.gemini/antigravity/scratch/sync-music-extension');
  const context = await chromium.launchPersistentContext('/tmp/pw-profile-123', {
    headless: false,
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--ozone-platform=x11',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  console.log('Navegador iniciado com --ozone-platform=x11');
  const page = await context.newPage();
  await page.goto('chrome://version');
  console.log('Abriu chrome://version');

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
      console.log('✓ Service worker:', sw.url());
    } catch (e) {
      console.log('SW não disparou no evento. Total ativos:', context.serviceWorkers().length);
    }
  } else {
    console.log('✓ Service worker imediato:', sw.url());
  }

  await context.close();
}
run().catch(console.error);
