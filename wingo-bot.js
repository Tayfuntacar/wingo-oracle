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
let isLoggedIn = false;

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

async function login() {
  console.log('Login sayfasi aciliyor...');
  
  // Direkt login sayfasina git
  await page.goto('https://www.volcanobet.me/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);
  
  await page.screenshot({ path: '/root/wingo-oracle/s1-login.png' });
  
  // Buton ve input listesi
  const pageInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t=>t);
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({type:i.type, placeholder:i.placeholder, name:i.name}));
    return { btns, inputs, url: window.location.href };
  });
  console.log('URL:', pageInfo.url);
  console.log('Butonlar:', pageInfo.btns.slice(0,10));
  console.log('Inputlar:', pageInfo.inputs.slice(0,5));

  // Username inputunu doldur
  const userInput = await page.$('input[type="text"], input[type="email"], input:not([type="password"])');
  if (userInput) {
    await userInput.click({ clickCount: 3 });
    await userInput.type(USERNAME, { delay: 50 });
    console.log('Username girildi');
  }

  // Password inputunu doldur  
  const passInput = await page.$('input[type="password"]');
  if (passInput) {
    await passInput.click({ clickCount: 3 });
    await passInput.type(PASSWORD, { delay: 50 });
    console.log('Password girildi');
  }

  await sleep(500);
  await page.screenshot({ path: '/root/wingo-oracle/s2-filled.png' });

  // Enter bas
  await page.keyboard.press('Enter');
  await sleep(5000);

  await page.screenshot({ path: '/root/wingo-oracle/s3-after-login.png' });
  console.log('Login sonrasi URL:', page.url());

  // Wingo sayfasina git
  await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(5000);

  await page.screenshot({ path: '/root/wingo-oracle/s4-wingo.png' });

  // Wingo sayfasindaki butonlar
  const wingoBtns = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent.trim(),
      class: b.className.substring(0,50)
    })).filter(b=>b.text);
    return btns.slice(0,40);
  });
  console.log('Wingo butonlari:', JSON.stringify(wingoBtns, null, 2));

  isLoggedIn = true;
}

async function placeBet(numbers) {
  try {
    console.log(`Bahis: [${numbers}]`);

    // Wingo sayfasinda miyiz?
    if (!page.url().includes('wingo')) {
      await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(3000);
    }

    // Sayfalaki tum butonlari al
    const allBtns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, [role="button"]')).map(b => ({
        text: b.textContent.trim(),
        class: b.className
      })).filter(b => b.text && /^\d+$/.test(b.text));
    });
    
    if (allBtns.length === 0) {
      console.log('Sayi butonlari bulunamadi - screenshot aliniyor');
      await page.screenshot({ path: '/root/wingo-oracle/no-btns.png' });
      return false;
    }

    console.log(`${allBtns.length} sayi butonu bulundu`);

    // Sayilari sec
    for (const num of numbers) {
      const found = await page.evaluate((n) => {
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = all.find(b => b.textContent.trim() === String(n));
        if (btn) { btn.click(); return true; }
        return false;
      }, num);
      if (found) { await sleep(200); console.log(`${num} secildi`); }
      else console.log(`${num} bulunamadi`);
    }

    await sleep(500);

    // Miktar gir
    await page.evaluate((amt) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const visible = inputs.filter(i => i.offsetParent !== null && (i.type === 'number' || i.type === 'text'));
      if (visible.length > 0) {
        visible[0].value = amt;
        visible[0].dispatchEvent(new Event('input', {bubbles:true}));
        visible[0].dispatchEvent(new Event('change', {bubbles:true}));
      }
    }, BET_AMOUNT);

    await sleep(300);

    // Bahis koy butonu
    const betOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const keywords = ['bet', 'ulog', 'uplati', 'stavi', 'place', 'potvrdi', 'confirm'];
      const btn = btns.find(b => keywords.some(k => b.textContent.toLowerCase().includes(k)));
      if (btn) { btn.click(); return btn.textContent.trim(); }
      return null;
    });

    if (betOk) {
      console.log(`Bahis konuldu! (${betOk})`);
      await sleep(2000);
      return true;
    }

    await page.screenshot({ path: '/root/wingo-oracle/bet-fail.png' });
    const btns = await page.evaluate(() => 
      Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim()).filter(t=>t).slice(0,20)
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
