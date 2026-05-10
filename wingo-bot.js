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
  await page.setViewport({ width: 390, height: 844 });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15');
  console.log('Browser hazir');
}

async function clickButtonByText(text) {
  return await page.evaluate((txt) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent.trim() === txt);
    if (btn) { btn.click(); return true; }
    return false;
  }, text);
}

async function login() {
  console.log('Giris yapiliyor...');
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Prijava butonuna js ile tikla
  const clicked = await clickButtonByText('Prijava');
  console.log('Login btn tiklandi:', clicked);
  await sleep(2000);

  // Password inputunu bul
  const passInput = await page.$('input[type="password"]');
  if (!passInput) {
    console.log('Password input bulunamadi - belki zaten giris yapilmis?');
    return;
  }

  // Username - password'den onceki input
  const allInputs = await page.$$('input');
  let userInput = null;
  for (const inp of allInputs) {
    const type = await inp.evaluate(el => el.type);
    if (type !== 'password' && !userInput) {
      userInput = inp;
    }
  }

  if (userInput) {
    await page.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('input', {bubbles:true})); }, 
      await userInput.asElement ? userInput : userInput, USERNAME);
  }

  // Password doldur
  await page.evaluate((el, val) => { 
    el.value = val; 
    el.dispatchEvent(new Event('input', {bubbles:true})); 
  }, passInput, PASSWORD);

  await sleep(500);

  // Submit
  await clickButtonByText('Prijava');
  console.log('Submit tiklandi');
  await sleep(4000);

  const url = page.url();
  console.log('Giris sonrasi URL:', url);

  // Wingo sayfasina git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Giris kontrol - kullanici adi gorunuyor mu?
  const pageText = await page.evaluate(() => document.body.innerText);
  if (pageText.includes('Adem') || pageText.includes('37.66') || pageText.includes('€')) {
    console.log('GIRIS BASARILI!');
  } else {
    console.log('Giris durumu belirsiz, devam edilecek...');
  }

  await page.screenshot({ path: '/root/wingo-oracle/wingo-page.png' });

  // Sayfa butonlarini goster
  const btns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t).slice(0, 20);
  });
  console.log('Sayfadaki butonlar:', btns);
}

async function placeBet(numbers) {
  try {
    console.log(`Bahis: [${numbers}]`);

    // Clear ticket
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const clear = btns.find(b => b.textContent.toLowerCase().includes('clear') || b.textContent.toLowerCase().includes('obrisi'));
      if (clear) clear.click();
    });
    await sleep(500);

    // Sayilari sec
    for (const num of numbers) {
      const found = await page.evaluate((n) => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.trim() === String(n));
        if (btn) { btn.click(); return true; }
        // data-number veya data-value dene
        const el = document.querySelector(`[data-number="${n}"], [data-value="${n}"]`);
        if (el) { el.click(); return true; }
        return false;
      }, num);
      if (found) await sleep(150);
      else console.log(`Sayi bulunamadi: ${num}`);
    }

    await sleep(300);

    // Miktar gir
    await page.evaluate((amount) => {
      const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]'));
      for (const inp of inputs) {
        if (inp.offsetParent !== null) { // visible
          inp.value = amount;
          inp.dispatchEvent(new Event('input', {bubbles:true}));
          inp.dispatchEvent(new Event('change', {bubbles:true}));
          break;
        }
      }
    }, BET_AMOUNT);

    await sleep(300);

    // Bahis koy
    const betPlaced = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const betBtn = btns.find(b => {
        const t = b.textContent.toLowerCase();
        return t.includes('bet') || t.includes('ulog') || t.includes('uplati') || t.includes('stavi');
      });
      if (betBtn) { betBtn.click(); return true; }
      return false;
    });

    if (betPlaced) {
      console.log('Bahis konuldu!');
      await sleep(1000);
      return true;
    }

    // Screenshot al
    await page.screenshot({ path: '/root/wingo-oracle/bet-screen.png' });
    
    // Tum butonlari listele
    const btns = await page.evaluate(() => 
      Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t=>t).slice(0,15)
    );
    console.log('Mevcut butonlar:', btns);
    return false;
  } catch(e) {
    console.log('Bahis hatasi:', e.message);
    return false;
  }
}

async function run() {
  await connectDB();
  await initBrowser();
  await login();

  console.log('\nBot calisiyor - 20sn aralikla kontrol...');

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
        const success = await placeBet(currentNumbers);
        if (success) {
          betsRemaining--;
          console.log(`Kalan bahis: ${betsRemaining}`);
        }
      }
    } catch(e) {
      console.log('Loop hatasi:', e.message);
    }
  }, 20000);
}

run().catch(e => { console.error('KRITIK HATA:', e.message); process.exit(1); });
