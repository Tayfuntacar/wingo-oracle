const puppeteer = require('puppeteer');
const { Client } = require('pg');

const DB_URL = 'postgresql://wingo:wingo2026@localhost:5432/wingodb';
const USERNAME = 'Adem1414';
const PASSWORD = 'Adem0402';
const BET_AMOUNT = 0.10; // 0.10 euro per bet
const BET_ROUNDS = 3; // her tahmin için 3 tur oyna

let db = new Client({ connectionString: DB_URL });
let browser, page;
let lastPlayedRound = -1;

async function connectDB() {
  await db.connect();
  console.log('DB baglandi');
}

async function getLatestPrediction() {
  const res = await db.query(`
    SELECT round, pred_certain6, global_round
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
  await page.waitForTimeout(2000);

  // Login butonu
  const loginBtn = await page.$('[class*="login"], [class*="Login"], button[class*="auth"]');
  if (loginBtn) {
    await loginBtn.click();
    await page.waitForTimeout(1000);
  }

  // Username ve password
  await page.type('input[name="username"], input[type="text"]', USERNAME);
  await page.type('input[name="password"], input[type="password"]', PASSWORD);
  
  // Submit
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  console.log('Giris tamamlandi');
}

async function placeBet(numbers) {
  try {
    console.log(`Bahis aciliyor: ${numbers}`);
    
    // Wingo sayfasina git
    await page.goto('https://www.volcanobet.me/wingo', { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Sayilari sec
    for (const num of numbers) {
      const selector = `[data-number="${num}"], button:has-text("${num}")`;
      try {
        await page.click(selector);
        await page.waitForTimeout(200);
      } catch(e) {
        // XPath ile dene
        const elements = await page.$x(`//button[text()="${num}"] | //*[@data-value="${num}"]`);
        if (elements.length > 0) {
          await elements[0].click();
          await page.waitForTimeout(200);
        }
      }
    }

    // Miktar gir
    const amountInput = await page.$('input[class*="amount"], input[placeholder*="amount"], input[type="number"]');
    if (amountInput) {
      await amountInput.click({ clickCount: 3 });
      await amountInput.type(BET_AMOUNT.toString());
    }

    // Bahis koy
    const betBtn = await page.$('button[class*="bet"], button[class*="Bet"], button[class*="place"]');
    if (betBtn) {
      await betBtn.click();
      await page.waitForTimeout(1000);
      console.log(`Bahis konuldu: ${numbers} - ${BET_AMOUNT}€`);
      return true;
    }
    
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

  let betsRemaining = 0;
  let currentNumbers = [];
  let currentRound = -1;

  console.log('Bot calisiyor - her tahmin icin 3 tur oynayacak...');

  setInterval(async () => {
    try {
      const pred = await getLatestPrediction();
      if (!pred || !pred.pred_certain6) return;

      const numbers = pred.pred_certain6.split(',').map(Number);
      const round = pred.global_round || pred.round;

      // Yeni tahmin mi?
      if (round !== currentRound) {
        console.log(`Yeni tahmin - Round ${round}: ${numbers}`);
        currentRound = round;
        currentNumbers = numbers;
        betsRemaining = BET_ROUNDS;
      }

      // Bahis koy
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
  }, 15000); // 15 saniyede bir kontrol et
}

run().catch(console.error);
