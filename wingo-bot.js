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

  // Prijava butonuna tikla - JS ile
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.trim() === 'Prijava');
    if (btn) btn.click();
  });
  console.log('Prijava tiklandi');
  await sleep(2000);

  // Simdi password input gelmeli
  const passExists = await page.evaluate(() => !!document.querySelector('input[type="password"]'));
  console.log('Password input var mi:', passExists);

  if (!passExists) {
    // Modal acilmamis olabilir, tekrar dene
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => b.textContent.trim() === 'Prijava');
      if (btn) btn.click();
    });
    await sleep(2000);
  }

  await page.screenshot({ path: '/root/wingo-oracle/s1-modal.png' });

  // Inputlari doldur
  await page.evaluate((user, pass) => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const passInput = inputs.find(i => i.type === 'password');
    const userInput = inputs.find(i => i.type !== 'password' && i.offsetParent !== null);
    
    if (userInput) {
      userInput.focus();
      userInput.value = user;
      userInput.dispatchEvent(new Event('input', {bubbles:true}));
      userInput.dispatchEvent(new Event('change', {bubbles:true}));
    }
    if (passInput) {
      passInput.focus();
      passInput.value = pass;
      passInput.dispatchEvent(new Event('input', {bubbles:true}));
      passInput.dispatchEvent(new Event('change', {bubbles:true}));
    }
    return {user: !!userInput, pass: !!passInput};
  }, USERNAME, PASSWORD);

  await sleep(500);
  console.log('Bilgiler girildi');
  await page.screenshot({ path: '/root/wingo-oracle/s2-filled.png' });

  // Submit
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    // Modal icerisindeki Prijava butonu
    const modalBtn = btns.filter(b => b.textContent.trim() === 'Prijava').pop();
    if (modalBtn) modalBtn.click();
  });
  await sleep(5000);

  await page.screenshot({ path: '/root/wingo-oracle/s3-after.png' });
  console.log('Login sonrasi URL:', page.url());

  // Wingo'ya git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  await page.screenshot({ path: '/root/wingo-oracle/s4-wingo.png' });

  // Sayfadaki tum butonlar
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t)
  );
  console.log('Wingo butonlari (ilk 50):', btns.slice(0, 50));
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
      const btns = Array.from(document.querySelectorAll('button'));
      const c = btns.find(b => /clear|obrisi|ponisti/i.test(b.textContent));
      if (c) c.click();
    });
    await sleep(300);

    // Sayilari sec
    for (const num of numbers) {
      const ok = await page.evaluate((n) => {
        const all = Array.from(document.querySelectorAll('button, [role="button"], td, li'));
        const el = all.find(e => e.textContent.trim() === String(n) && e.offsetParent !== null);
        if (el) { el.click(); return true; }
        return false;
      }, num);
      if (ok) await sleep(200);
      else console.log(`${num} bulunamadi`);
    }

    await sleep(500);

    // Miktar
    await page.evaluate((amt) => {
      const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null);
      if (inputs.length) {
        inputs[0].value = amt;
        inputs[0].dispatchEvent(new Event('input', {bubbles:true}));
      }
    }, BET_AMOUNT);

    await sleep(300);

    // Bahis koy
    const ok = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(b => /uplati|bet|place|potvrdi/i.test(b.textContent) && b.offsetParent !== null);
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });

    if (ok) { console.log('Bahis konuldu:', ok); await sleep(2000); return true; }

    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>t).slice(0,20)
    );
    console.log('Butonlar:', btns);
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
        console.log(`\nYeni tahmin Round ${round}: [${numbers}]`);
        currentRound = round;
        currentNumbers = numbers;
        betsRemaining = BET_ROUNDS;
      }
      if (betsRemaining > 0) {
        const ok = await placeBet(currentNumbers);
        if (ok) { betsRemaining--; console.log(`Kalan bahis: ${betsRemaining}`); }
      }
    } catch(e) { console.log('Loop:', e.message); }
  }, 20000);
}

run().catch(e => { console.error('KRITIK:', e.message); process.exit(1); });
