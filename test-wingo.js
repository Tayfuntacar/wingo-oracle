const puppeteer = require('puppeteer');
require('dotenv').config();

const X_AUTH = JSON.stringify({
  accessToken: process.env.VOLCANO_TOKEN,
  refreshToken: process.env.VOLCANO_REFRESH,
  username: '',
  fingerprint: '019d4ee1-3afb-72cc-9618-001a24459b7e'
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Token inject
  await page.goto('https://www.volcanobet.me', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate((xAuth) => {
    localStorage.setItem('x-auth', xAuth);
    localStorage.setItem('x-active-lang', 'en');
  }, X_AUTH);

  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  // iframe var mi?
  const frames = page.frames();
  console.log(`Frame sayisi: ${frames.length}`);
  for (const frame of frames) {
    console.log('Frame URL:', frame.url());
    const numBtns = await frame.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>/^\d+$/.test(t))
    ).catch(() => []);
    if (numBtns.length > 0) {
      console.log('FRAME ILE SAYI BUTONLARI BULUNDU:', numBtns.slice(0,10));
    }
  }

  // Network isteklerini dinle - bahis isteğini yakala
  page.on('request', req => {
    if (req.url().includes('bet') || req.url().includes('ticket') || req.url().includes('stake')) {
      console.log('BET REQUEST:', req.method(), req.url());
      console.log('POST DATA:', req.postData());
    }
  });

  // Place bet butonuna tikla
  const placed = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Place bet'));
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log('Place bet tiklandi:', placed);
  await sleep(3000);

  await page.screenshot({ path: '/root/wingo-oracle/wingo-test.png' });
  await browser.close();
})().catch(console.error);
