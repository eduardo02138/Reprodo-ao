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

  const page = await context.newPage();
  await page.goto('chrome://extensions');
  await page.waitForTimeout(2000);
  const text = await page.innerText('body');
  console.log('Conteúdo de chrome://extensions:\n', text);
  await context.close();
}
run().catch(console.error);
