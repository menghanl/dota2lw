// livetest.mjs — e2e against the real Liquipedia API (no fixtures)
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) console.log('CONSOLE ERR:', m.text().slice(0, 200)); });
await page.goto('http://localhost:8013/#matches', { waitUntil: 'networkidle2', timeout: 45000 });
await page.waitForFunction(() => document.querySelectorAll('.match-card').length > 5, { timeout: 30000 });
console.log('partial paint OK');
await page.waitForFunction(() => document.querySelectorAll('.match-card').length > 40, { timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: '/tmp/lpshots/LIVE.png' });
const n = await page.$$eval('.match-card', els => els.length);
console.log('LIVE OK — match cards rendered:', n);
await browser.close();
