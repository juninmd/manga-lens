import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 220 } });
await page.goto('http://127.0.0.1:7789/');
await page.waitForSelector('.ml-toolbar');
await page.locator('.ml-toolbar').screenshot({ path: '.workflow/5-competitive-quality/shot-toolbar.png' });
await browser.close();
console.log('ok');
