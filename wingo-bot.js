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
  console.log('Browser hazir');
}

async function login() {
  console.log('Sayfa aciliyor...');
  await page.goto('https://www.volcanobet.me', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Prijava butonuna tikla
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Prijava');
    if (btn) btn.click();
  });
  await sleep(2000);

  // Tum inputlari JS ile doldur ve submit et
  const result = await page.evaluate((user, pass) => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const passInput = inputs.find(i => i.type === 'password');
    if (!passInput) return 'no-password-input';
    
    // Username - password'den onceki input
    const userInput = inputs.slice(0, inputs.indexOf(passInput)).pop();
    
    const setVal = (el, val) => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    
    if (userInput) setVal(userInput, user);
    setVal(passInput, pass);
    
    return 'ok';
  }, USERNAME, PASSWORD);
  
  console.log('Input result:', result);
  await sleep(500);
  await page.screenshot({ path: '/root/wingo-oracle/s1.png' });

  // Submit - form submit veya Enter
  await page.evaluate(() => {
    const form = document.querySelector('form');
    if (form) { form.submit(); return; }
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Prijava');
    if (btn) btn.click();
  });
  
  await sleep(5000);
  await page.screenshot({ path: '/root/wingo-oracle/s2.png' });
  console.log('URL:', page.url());

  // Wingo'ya git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);
  await page.screenshot({ path: '/root/wingo-oracle/s3.png' });

  const numBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>/^\d+$/.test(t))
  );
  console.log(`Sayi butonlari: ${numBtns.length} adet`, numBtns.slice(0,10));

  if (numBtns.length === 0) {
    const all = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>t).slice(0,20)
    );
    console.log('Tum butonlar:', all);
  }
}

async function placeBet(numbers) {
  try {
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
        const el = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === String(n) && b.offsetParent !== null);
        if (el) { el.click(); return true; }
        return false;
      }, num);
      if (ok) { found++; await sleep(150); }
    }
    if (found === 0) { console.log('Hic sayi secilemedi'); return false; }
    console.log(`${found}/${numbers.length} sayi secildi`);

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

    // Bahis koy
    const ok = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(b => /uplati|bet|potvrdi/i.test(b.textContent) && b.offsetParent !== null);
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });

    if (ok) { console.log('Bahis:', ok); await sleep(2000); return true; }
    return false;
  } catch(e) { console.log('Hata:', e.message); return false; }
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
