const puppeteer = require('puppeteer');
const { Client } = require('pg');

const DB_URL = 'postgresql://wingo:wingo2026@localhost:5432/wingodb';
const USERNAME = 'Adem1414';
const PASSWORD = 'Adem0402';
const BET_AMOUNT = '0.10';
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
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  console.log('Browser hazir');
}

async function login() {
  console.log('Sayfa aciliyor...');
  await page.goto('https://www.volcanobet.me', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Prijava butonuna tikla
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.trim() === 'Prijava');
    if (btn) btn.click();
  });
  await sleep(2000);

  // Password var mi?
  const passInput = await page.$('input[type="password"]');
  if (!passInput) { console.log('Modal acilmadi!'); return; }

  // Username inputuna tikla ve yaz
  const inputs = await page.$$('input');
  for (const inp of inputs) {
    const type = await inp.evaluate(el => el.type);
    const visible = await inp.evaluate(el => el.offsetParent !== null);
    if (type !== 'password' && visible) {
      await inp.click();
      await inp.type(USERNAME, { delay: 80 });
      console.log('Username yazildi');
      break;
    }
  }

  // Password inputuna tikla ve yaz
  await passInput.click();
  await passInput.type(PASSWORD, { delay: 80 });
  console.log('Password yazildi');

  await sleep(500);
  await page.screenshot({ path: '/root/wingo-oracle/s1-filled.png' });

  // Enter bas
  await passInput.press('Enter');
  await sleep(5000);

  await page.screenshot({ path: '/root/wingo-oracle/s2-after.png' });
  console.log('Login sonrasi URL:', page.url());

  // Giris basarili mi kontrol et
  const loggedIn = await page.evaluate(() => {
    const text = document.body.innerText;
    return !text.includes('Registracija') || text.includes('€') || text.includes('Adem');
  });
  console.log('Giris basarili:', loggedIn);

  // Wingo'ya git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);
  await page.screenshot({ path: '/root/wingo-oracle/s3-wingo.png' });

  // Sayfadaki butonlar - 1-48 arasi sayilar var mi?
  const numBtns = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.map(b => b.textContent.trim()).filter(t => /^\d+$/.test(t) && parseInt(t) >= 1 && parseInt(t) <= 48);
  });
  console.log('Sayi butonlari:', numBtns.length > 0 ? numBtns.slice(0,10) : 'YOK');

  if (numBtns.length === 0) {
    // Tum butonlari goster
    const allBtns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>t).slice(0,30)
    );
    console.log('Tum butonlar:', allBtns);
  }
}

async function placeBet(numbers) {
  try {
    // Clear
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const c = btns.find(b => /clear|obrisi|ponisti/i.test(b.textContent));
      if (c) c.click();
    });
    await sleep(300);

    // Sayilari sec
    let found = 0;
    for (const num of numbers) {
      const ok = await page.evaluate((n) => {
        const all = Array.from(document.querySelectorAll('button'));
        const el = all.find(e => e.textContent.trim() === String(n) && e.offsetParent !== null);
        if (el) { el.click(); return true; }
        return false;
      }, num);
      if (ok) { found++; await sleep(150); }
    }
    console.log(`${found}/${numbers.length} sayi secildi`);

    // Miktar
    const amtInputs = await page.$$('input');
    for (const inp of amtInputs) {
      const visible = await inp.evaluate(el => el.offsetParent !== null);
      if (visible) {
        await inp.click({ clickCount: 3 });
        await inp.type(BET_AMOUNT);
        break;
      }
    }
    await sleep(300);

    // Bahis koy
    const ok = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(b => /uplati|bet|place|potvrdi/i.test(b.textContent) && b.offsetParent !== null);
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });

    if (ok) { console.log('Bahis:', ok); await sleep(2000); return true; }
    return false;
  } catch(e) {
    console.log('Hata:', e.message);
    return false;
  }
}

async function run() {
  await connectDB();
  await initBrowser();
  await login();
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
