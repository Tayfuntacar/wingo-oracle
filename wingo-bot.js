const puppeteer = require('puppeteer');
const { Client } = require('pg');

const DB_URL = 'postgresql://wingo:wingo2026@localhost:5432/wingodb';
const USERNAME = 'Adem1414';
const PASSWORD = 'Adem0402';
const BET_AMOUNT = 0.10;
const BET_ROUNDS = 3;

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
    SELECT round, pred_certain6, global_round, created_at
    FROM predictions 
    WHERE pred_certain6 IS NOT NULL AND pred_certain6 != ''
    ORDER BY created_at DESC 
    LIMIT 1
  `);
  return res.rows[0] || null;
}

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
  console.log('Browser hazir');
}

async function login() {
  console.log('Giris yapiliyor...');
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Screenshot al - ne gorunuyor?
  await page.screenshot({ path: '/root/wingo-oracle/screen1.png' });
  console.log('Ekran goruntusu alindi: screen1.png');

  // Login butonunu bul
  const content = await page.content();
  if (content.includes('Log In') || content.includes('Login') || content.includes('Prijavi')) {
    const loginBtn = await page.$('button[class*="login"], a[class*="login"], [class*="Login"]');
    if (loginBtn) {
      await loginBtn.click();
      await sleep(2000);
    }
  }

  await page.screenshot({ path: '/root/wingo-oracle/screen2.png' });
  console.log('Ekran 2 alindi');

  // Input alanlari
  const inputs = await page.$$('input');
  console.log(`Input sayisi: ${inputs.length}`);

  for (let i = 0; i < inputs.length; i++) {
    const type = await inputs[i].evaluate(el => el.type);
    const name = await inputs[i].evaluate(el => el.name || el.placeholder || '');
    console.log(`Input ${i}: type=${type} name=${name}`);
  }
}

async function run() {
  await connectDB();
  await initBrowser();
  await login();
  console.log('Test tamamlandi - sayfayi inceliyorum');
}

run().catch(e => { console.error('HATA:', e.message); process.exit(1); });
