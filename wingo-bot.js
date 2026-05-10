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

async function login() {
  console.log('Giris yapiliyor...');
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Prijava butonuna tikla
  const btns = await page.$$('button');
  for (const btn of btns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt === 'Prijava') {
      await btn.click();
      console.log('Login butonu tiklandi');
      await sleep(2000);
      break;
    }
  }

  await page.screenshot({ path: '/root/wingo-oracle/login-screen.png' });

  // Username ve password inputlarini bul
  const inputs = await page.$$('input');
  let userInput = null, passInput = null;
  for (const inp of inputs) {
    const type = await inp.evaluate(el => el.type);
    if (type === 'password') passInput = inp;
    else if (type === 'text' || type === 'email') {
      if (!userInput) userInput = inp;
    }
  }

  if (userInput) {
    await userInput.click({ clickCount: 3 });
    await userInput.type(USERNAME);
    console.log('Username girildi');
  }
  if (passInput) {
    await passInput.click({ clickCount: 3 });
    await passInput.type(PASSWORD);
    console.log('Password girildi');
  }

  // Submit
  const submitBtns = await page.$$('button');
  for (const btn of submitBtns) {
    const txt = await btn.evaluate(el => el.textContent.trim());
    if (txt === 'Prijava') {
      await btn.click();
      console.log('Submit tiklandi');
      break;
    }
  }

  await sleep(4000);
  await page.screenshot({ path: '/root/wingo-oracle/after-login.png' });

  const url = page.url();
  console.log('Login sonrasi URL:', url);

  // Wingo sayfasina git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);
  console.log('Wingo sayfasi acildi');
  await page.screenshot({ path: '/root/wingo-oracle/wingo-page.png' });
}

async function selectNumbers(numbers) {
  try {
    // Sayilari sec - her sayi icin button ara
    for (const num of numbers) {
      const btns = await page.$$('button');
      let found = false;
      for (const btn of btns) {
        const txt = await btn.evaluate(el => el.textContent.trim());
        if (txt === String(num)) {
          await btn.click();
          await sleep(200);
          found = true;
          break;
        }
      }
      if (!found) {
        // data-number ile dene
        const el = await page.$(`[data-number="${num}"]`);
        if (el) { await el.click(); await sleep(200); }
      }
    }
    console.log(`Sayilar secildi: ${numbers}`);
    return true;
  } catch(e) {
    console.log('Sayi secme hatasi:', e.message);
    return false;
  }
}

async function placeBet(numbers) {
  try {
    console.log(`Bahis aciliyor: ${numbers}`);

    // Clear ticket
    const allBtns = await page.$$('button');
    for (const btn of allBtns) {
      const txt = await btn.evaluate(el => el.textContent.trim());
      if (txt.includes('Clear') || txt.includes('Obrisi') || txt.includes('clear')) {
        await btn.click();
        await sleep(500);
        break;
      }
    }

    // Sayilari sec
    await selectNumbers(numbers);
    await sleep(500);

    // Miktar gir
    const inputs = await page.$$('input');
    for (const inp of inputs) {
      const type = await inp.evaluate(el => el.type);
      if (type === 'number' || type === 'text') {
        const placeholder = await inp.evaluate(el => el.placeholder);
        if (placeholder.includes('0') || placeholder === '') {
          try {
            await inp.click({ clickCount: 3 });
            await inp.type(BET_AMOUNT);
            console.log('Miktar girildi:', BET_AMOUNT);
            break;
          } catch(e) {}
        }
      }
    }
    await sleep(300);

    // Bahis koy butonu
    for (const btn of await page.$$('button')) {
      const txt = await btn.evaluate(el => el.textContent.trim().toLowerCase());
      if (txt.includes('bet') || txt.includes('ulog') || txt.includes('uplati')) {
        await btn.click();
        console.log('Bahis konuldu!');
        await sleep(1000);
        return true;
      }
    }

    await page.screenshot({ path: '/root/wingo-oracle/bet-screen.png' });
    console.log('Bahis butonu bulunamadi');
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

  console.log('Bot calisiyor...');

  setInterval(async () => {
    try {
      const pred = await getLatestPrediction();
      if (!pred || !pred.pred_certain6) return;

      const numbers = pred.pred_certain6.split(',').map(Number);
      const round = parseInt(pred.global_round || pred.round);

      if (round !== currentRound) {
        console.log(`\nYeni tahmin - Round ${round}: [${numbers}]`);
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
