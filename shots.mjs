// shots.mjs — mobile-emulated screenshots of the app via puppeteer-core.
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8013';
const OUT = '/tmp/lpshots';

const targets = [
  { name: 'matches', url: '/?src=local#matches' },
  { name: 'groups', url: '/?src=local#groups' },
  { name: 'survival', url: '/?src=local#b-survival' },
  { name: 'playoffs', url: '/?src=local#b-playoffs' },
  { name: 'info', url: '/?src=local#info', tapFirst: '.team-card' },
];

const filter = process.argv[2];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

for (const t of targets) {
  if (filter && !t.name.includes(filter)) continue;
  try {
    await page.goto(BASE + t.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('.spinner'), { timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    if (t.tapFirst) {
      await page.$eval(t.tapFirst, el => el.click()).catch(e => console.log('  tap failed:', e.message));
      await new Promise(r => setTimeout(r, 500));
    }
    await page.screenshot({ path: `${OUT}/${t.name}.png`, fullPage: !!t.full });
    console.log('OK', t.name);
  } catch (e) {
    console.log('FAIL', t.name, e.message);
  }
}
await browser.close();
