const puppeteer = require('puppeteer');
const { Client } = require('pg');

const DB_URL = 'postgresql://wingo:wingo2026@localhost:5432/wingodb';
const BET_AMOUNT = '0.10';
const BET_ROUNDS = 3;

const ACCESS_TOKEN = process.env.VOLCANO_TOKEN;
const X_AUTH = JSON.stringify({
  accessToken: process.env.VOLCANO_TOKEN,
  refreshToken: process.env.VOLCANO_REFRESH,
  username: '',
  fingerprint: '019d4ee1-3afb-72cc-9618-001a24459b7e'
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let db = new Client({ connectionString: DB_URL });
let browser, page;
let currentRound = -1;
let betsRemaining = 0;
let currentNumbers = [];

async function connectDB() {
  await db.connect();
  console.log('DB baglandi');
}

async function getLatestPrediction() {
  const res = await db.query(`
    SELECT round, pred_certain6, global_round
    FROM predictions 
    WHERE pred_certain6 IS NOT NULL AND pred_certain6 != ''
    ORDER BY created_at DESC LIMIT 1
  `);
  return res.rows[0] || null;
}

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  console.log('Browser hazir');
}

async function setupWithToken() {
  console.log('Token ile oturum aciliyor...');
  
  // Once ana sayfaya git
  await page.goto('https://www.volcanobet.me', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  
  // LocalStorage'a token'i inject et
  await page.evaluate((xAuth) => {
    localStorage.setItem('x-auth', xAuth);
    localStorage.setItem('visited-site', 'true');
    localStorage.setItem('x-active-lang', 'en');
  }, X_AUTH);
  
  console.log('Token localStorage\'a eklendi');
  
  // Wingo sayfasina git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);
  
  await page.screenshot({ path: '/root/wingo-oracle/wingo-auth.png' });
  
  // Giris basarili mi?
  const loggedIn = await page.evaluate(() => {
    const text = document.body.innerText;
    // Bakiye varsa veya Registracija yoksa giris yapilmis
    return text.includes('€') || !text.includes('Registracija') || text.includes('Adem');
  });
  console.log('Giris durumu:', loggedIn ? 'BASARILI' : 'BASARISIZ');

  // Sayfadaki sayisal butonlari goster
  const numBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>/^\d+$/.test(t) && parseInt(t)>=1 && parseInt(t)<=48)
  );
  console.log(`Sayi butonlari: ${numBtns.length} adet`);
  
  if (numBtns.length === 0) {
    const allBtns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>t).slice(0,20)
    );
    console.log('Tum butonlar:', allBtns);
  }
  
  return numBtns.length > 0;
}

async function placeBet(numbers) {
  try {
    console.log(`Bahis: [${numbers}]`);

    if (!page.url().includes('wingo')) {
      await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(3000);
    }

    // Clear
    await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('button')).find(b => /clear|obrisi/i.test(b.textContent));
      if (c) c.click();
    });
    await sleep(300);

    // Sayilari sec
    let found = 0;
    for (const num of numbers) {
      const ok = await page.evaluate((n) => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.trim() === String(n) && b.offsetParent !== null);
        if (btn) { btn.click(); return true; }
        return false;
      }, num);
      if (ok) { found++; await sleep(200); }
    }
    console.log(`${found}/${numbers.length} sayi secildi`);

    if (found === 0) return false;

    // Miktar
    await page.evaluate((amt) => {
      const inp = Array.from(document.querySelectorAll('input')).find(i => i.offsetParent !== null);
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, amt);
        inp.dispatchEvent(new Event('input', {bubbles:true}));
      }
    }, BET_AMOUNT);
    await sleep(300);

    // Uplati
    const ok = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(b => 
        /uplati|bet|potvrdi/i.test(b.textContent) && b.offsetParent !== null
      );
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });

    if (ok) { console.log('Bahis konuldu:', ok); await sleep(2000); return true; }
    return false;
  } catch(e) { console.log('Hata:', e.message); return false; }
}

async function run() {
  await connectDB();
  await initBrowser();
  const ok = await setupWithToken();
  
  if (!ok) {
    console.log('UYARI: Sayi butonlari gorunmuyor, bahis calismayabilir');
  }

  console.log('\nBot calisiyor...');

  setInterval(async () => {
    try {
      const pred = await getLatestPrediction();
      if (!pred || !pred.pred_certain6) return;
      const numbers = pred.pred_certain6.split(',').map(Number);
      const round = parseInt(pred.global_round || pred.round);
      if (round !== currentRound) {
        console.log(`\nRound ${round}: [${numbers}]`);
        currentRound = round; currentNumbers = numbers; betsRemaining = BET_ROUNDS;
      }
      if (betsRemaining > 0) {
        const ok = await placeBet(currentNumbers);
        if (ok) { betsRemaining--; console.log(`Kalan: ${betsRemaining}`); }
      }
    } catch(e) { console.log('Loop:', e.message); }
  }, 20000);
}

run().catch(e => { console.error('KRITIK:', e.message); process.exit(1); });
