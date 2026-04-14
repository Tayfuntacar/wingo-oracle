var WebSocket = require('ws');
var https = require('https');
var express = require('express');
var cors = require('cors');
var { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────
// VERİTABANI BAĞLANTISI
// Düzeltme: Client → Pool (tek bağlantı havuzu, çift bağlantı sorunu giderildi)
// ─────────────────────────────────────────────────────────────
var DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:LqxXVFqCIrOqDMmNmsSSOvCGLUkvEtsL@junction.proxy.rlwy.net:43663/railway';

var pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }
});

var db = {
  query: function(text, params) { return pool.query(text, params); }
};

// ─────────────────────────────────────────────────────────────
// RENK VE SAYI HARİTALARI
// Düzeltme: Yeni koddaki COLOR_NUMS (çakışmalı) kaldırıldı.
// Mevcut colors (1→1 eşleme) ve CNU (6'lı gruplar) korundu.
// ─────────────────────────────────────────────────────────────
var colors = {
  1:'Sari',9:'Sari',17:'Sari',25:'Sari',33:'Sari',41:'Sari',
  2:'Yesil',10:'Yesil',18:'Yesil',26:'Yesil',34:'Yesil',42:'Yesil',
  3:'Mavi',11:'Mavi',19:'Mavi',27:'Mavi',35:'Mavi',43:'Mavi',
  4:'Kirmizi',12:'Kirmizi',20:'Kirmizi',28:'Kirmizi',36:'Kirmizi',44:'Kirmizi',
  5:'Kahve',13:'Kahve',21:'Kahve',29:'Kahve',37:'Kahve',45:'Kahve',
  6:'Turuncu',14:'Turuncu',22:'Turuncu',30:'Turuncu',38:'Turuncu',46:'Turuncu',
  7:'Siyah',15:'Siyah',23:'Siyah',31:'Siyah',39:'Siyah',47:'Siyah',
  8:'Mor',16:'Mor',24:'Mor',32:'Mor',40:'Mor',48:'Mor'
};

var ALL_COLORS = ['Sari','Yesil','Mavi','Kirmizi','Kahve','Turuncu','Siyah','Mor'];

var COLOR_HEX = {
  'Sari':'#facc15','Yesil':'#22c55e','Mavi':'#3b82f6','Kirmizi':'#ef4444',
  'Kahve':'#d97706','Turuncu':'#f97316','Siyah':'#9ca3af','Mor':'#a855f7'
};

// MS Çekirdek ve Sıcak Havuzlar (yeni koddan eklendi)
var MS_CORE_POOL = [7, 17, 24, 25, 30, 33, 38];
var MS_HOT_POOL  = [2, 11, 19, 28, 36, 39, 47];

// ─────────────────────────────────────────────────────────────
// GENEL DEĞİŞKENLER
// ─────────────────────────────────────────────────────────────
var lastProcessedWsRound = -1;
var globalPredCache = {};

process.on('uncaughtException',  function(e) { console.log('KRITIK HATA:',  e.message, e.stack); });
process.on('unhandledRejection', function(e) { console.log('PROMISE HATASI:', e && e.message ? e.message : e); });

// ─────────────────────────────────────────────────────────────
// BAŞLATMA
// ─────────────────────────────────────────────────────────────
db.query('CREATE TABLE IF NOT EXISTS draws (id SERIAL PRIMARY KEY, round INT UNIQUE, first INT, over_under VARCHAR(5), color VARCHAR(20), all_numbers TEXT, created_at TIMESTAMP DEFAULT NOW())')
.then(function() {
  return db.query(`CREATE TABLE IF NOT EXISTS predictions (
    id SERIAL PRIMARY KEY,
    round INT UNIQUE,
    pred_ou VARCHAR(10),
    pred_color VARCHAR(20),
    pred_first VARCHAR(50),
    pred_first5 VARCHAR(100),
    pred_certain6 VARCHAR(100),
    pred_certain7 VARCHAR(100),
    pred_certain8 VARCHAR(100),
    actual_first INT,
    actual_first5 VARCHAR(100),
    actual_color VARCHAR(20),
    actual_ou VARCHAR(10),
    ou_hit INT DEFAULT -1,
    color_hit INT DEFAULT -1,
    first_hit INT DEFAULT -1,
    first5_hit INT DEFAULT -1,
    first5_match INT DEFAULT -1,
    certain8_hit INT DEFAULT -1,
    certain8_match INT DEFAULT -1,
    certain8_full_match INT DEFAULT -1,
    certain6_match INT DEFAULT -1,
    certain7_match INT DEFAULT -1,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
})
// Düzeltme: ALTER TABLE ile eksik kolonlar güvenli şekilde eklendi
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_first5 TEXT'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS first5_match INT DEFAULT -1'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_match INT DEFAULT -1'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_full_match INT DEFAULT -1'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_certain6 TEXT'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain6_match INT DEFAULT -1'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_certain7 TEXT'); })
.then(function() { return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain7_match INT DEFAULT -1'); })
.then(function() {
  console.log('Tablolar hazir!');
  return loadCacheFromDB();
})
.then(function() { return backfillCertain6(); })
.then(function() {
  connect();
  startDashboard();
})
.catch(function(e) { console.log('DB hatasi:', e.message); });

// ─────────────────────────────────────────────────────────────
// WEBSOCKET BAĞLANTISI
// ─────────────────────────────────────────────────────────────
var opt = {
  hostname: 'virtualbingodataprovider-volcano.xtreme.bet',
  path: '/hubs/messagehub/negotiate?negotiateVersion=1',
  method: 'POST',
  headers: { 'Origin': 'https://www.volcanobet.me' },
  rejectUnauthorized: false
};

function connect() {
  https.request(opt, function(r) {
    var b = '';
    r.on('data', function(d) { b += d; });
    r.on('end', function() {
      try {
        var parsed = JSON.parse(b);
        var t = encodeURIComponent(parsed.connectionToken);
        var w = new WebSocket('wss://virtualbingodataprovider-volcano.xtreme.bet/hubs/messagehub?id=' + t, {
          headers: { 'Origin': 'https://www.volcanobet.me' },
          rejectUnauthorized: false
        });
        w.on('open', function() {
          console.log('WebSocket baglandi!');
          w.send('{"protocol":"json","version":1}\x1e');
          setTimeout(function() {
            w.send('{"arguments":["00000000-0000-0000-0000-000000000000"],"invocationId":"0","target":"SubscribeClient","type":1}\x1e');
          }, 1000);
        });
        w.on('message', function(d) {
          try {
            var msgs = d.toString().split('\x1e').filter(function(s) { return s.trim(); });
            msgs.forEach(function(msg) {
              try {
                var j = JSON.parse(msg);
                if (j.target === 'ReceivePartialResult' && j.arguments && j.arguments[0] && j.arguments[0].ballNumbers && j.arguments[0].ballNumbers.length === 35) {
                  var a = j.arguments[0];
                  var wsRound = parseInt(a.number);
                  if (wsRound === lastProcessedWsRound) return;
                  lastProcessedWsRound = wsRound;
                  var first  = parseInt(a.ballNumbers[0]);
                  var first5 = a.ballNumbers.slice(0, 5).map(Number);
                  var allNums = a.ballNumbers.map(Number);
                  var ou   = first > 24 ? 'OVER' : 'UNDER';
                  var renk = colors[first] || 'Bilinmiyor';
                  console.log('------------------------------------');
                  console.log('YENI CEKILIS | Round: ' + wsRound);
                  console.log('FIRST: ' + first + ' | ' + ou + ' | ' + renk);
                  saveDraw(wsRound, first, first5, allNums, ou, renk, a.ballNumbers.join(','));
                }
              } catch(e2) {}
            });
          } catch(e) { console.log('Mesaj hatasi:', e.message); }
        });
        w.on('close', function() { console.log('WS kapandi, 3sn sonra baglaniliyor...'); setTimeout(connect, 3000); });
        w.on('error', function(e) { console.log('WS hatasi:', e.message); });
      } catch(e) { console.log('Negotiate hatasi:', e.message); setTimeout(connect, 5000); }
    });
  }).on('error', function(e) { console.log('HTTPS hatasi:', e.message); setTimeout(connect, 5000); }).end();
}

// ─────────────────────────────────────────────────────────────
// VERİTABANI İŞLEMLERİ
// ─────────────────────────────────────────────────────────────
function saveDraw(round, first, first5, allNums, ou, renk, allNumsStr) {
  db.query(
    'INSERT INTO draws (round, first, over_under, color, all_numbers, created_at) VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (round) DO UPDATE SET first=EXCLUDED.first, over_under=EXCLUDED.over_under, color=EXCLUDED.color, all_numbers=EXCLUDED.all_numbers, created_at=NOW() RETURNING id',
    [round, first, ou, renk, allNumsStr]
  ).then(function(ins) {
    if (ins.rows.length === 0) {
      console.log('Round ' + round + ' zaten var - tahmin guncelleniyor...');
    } else {
      console.log('Draw kaydedildi: Round ' + round);
    }
    saveNextPrediction(round, function() {
      updatePredictions(round, first, first5, allNums, ou, renk);
    });
  }).catch(function(e) { console.log('Draw hatasi:', e.message); });
}

// Düzeltme: certain7_match kolonu UPDATE sorgusuna eklendi (yeni koddan).
// Mevcut kodun first5_hit / certain8_hit sütunları da korundu.
function updatePredictions(round, first, first5, allNums, ou, renk) {
  db.query('SELECT id, pred_ou, pred_color, pred_first, pred_first5, pred_certain8, pred_certain6, pred_certain7 FROM predictions WHERE round = $1', [round])
  .then(function(res) {
    if (res.rows.length === 0) { console.log('Round ' + round + ' icin bekleyen tahmin yok.'); return; }
    res.rows.forEach(function(row) {
      var ouHit       = row.pred_ou    === ou   ? 1 : 0;
      var colorHit    = row.pred_color === renk  ? 1 : 0;
      var pf          = row.pred_first    ? row.pred_first.split(',').map(Number)    : [];
      var pf5         = row.pred_first5   ? row.pred_first5.split(',').map(Number)   : [];
      var pc8         = row.pred_certain8 ? row.pred_certain8.split(',').map(Number) : [];
      var pc6         = row.pred_certain6 ? row.pred_certain6.split(',').map(Number) : [];
      var pc7         = row.pred_certain7 ? row.pred_certain7.split(',').map(Number) : [];
      var firstHit    = pf.indexOf(first) !== -1 ? 1 : 0;
      var f5Hit       = pf5.indexOf(first) !== -1 ? 1 : 0;
      var c8Hit       = pc8.indexOf(first) !== -1 ? 1 : 0;
      var f5Match     = first5.filter(function(n) { return pf5.indexOf(n) !== -1; }).length;
      var c8Match     = first5.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      var c8FullMatch = allNums.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      var c6Match     = pc6.length > 0 ? allNums.filter(function(n) { return pc6.indexOf(n) !== -1; }).length : -1;
      var c7Match     = pc7.length > 0 ? allNums.filter(function(n) { return pc7.indexOf(n) !== -1; }).length : -1;
      db.query(
        'UPDATE predictions SET actual_first=$1,actual_first5=$2,actual_color=$3,actual_ou=$4,ou_hit=$5,color_hit=$6,first_hit=$7,first5_hit=$8,certain8_hit=$9,first5_match=$10,certain8_match=$11,certain8_full_match=$12,certain6_match=$13,certain7_match=$14 WHERE id=$15',
        [first, first5.join(','), renk, ou, ouHit, colorHit, firstHit, f5Hit, c8Hit, f5Match, c8Match, c8FullMatch, c6Match, c7Match, row.id]
      ).then(function() {
        console.log('>>> Round ' + round + ' | OU:' + (ouHit?'TUTTU':'KACTI') + ' | Renk:' + (colorHit?'TUTTU':'KACTI') + ' | C6:' + c6Match + '/6 | C8:' + c8FullMatch + '/8');
      }).catch(function(e) { console.log('Update hatasi:', e.message); });
    });
  }).catch(function(e) { console.log('UpdatePred hatasi:', e.message); });
}

function saveNextPrediction(round, callback) {
  db.query("SELECT round, first, over_under, color, all_numbers, created_at FROM draws WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 200")
  .then(function(res) {
    var draws = res.rows;
    if (draws.length < 10) { console.log('Yeterli veri yok (' + draws.length + '/10)'); if (callback) callback(); return; }
    var pred;
    try { pred = predict(draws); } catch(e) { console.log('Predict hatasi:', e.message); if (callback) callback(); return; }
    if (!pred || !pred.over_under) { console.log('Tahmin uretilmedi'); if (callback) callback(); return; }
    globalPredCache = pred;
    var nextRound = round + 1;
    console.log('--- TAHMIN: Round ' + nextRound + ' -> ' + pred.over_under.pred + ' / ' + (pred.color ? pred.color.pred : '?') + ' ---');
    db.query(
      'INSERT INTO predictions (round,pred_ou,pred_color,pred_first,pred_first5,pred_certain8,pred_certain6,pred_certain7) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (round) DO UPDATE SET pred_ou=$2,pred_color=$3,pred_first=$4,pred_first5=$5,pred_certain8=$6,pred_certain6=$7,pred_certain7=$8 WHERE predictions.ou_hit=-1',
      [nextRound,
       pred.over_under.pred,
       pred.color ? pred.color.pred : '',
       pred.first_candidates  ? pred.first_candidates.join(',')  : '',
       pred.first5_candidates ? pred.first5_candidates.join(',') : '',
       pred.certain8          ? pred.certain8.join(',')          : '',
       pred.certain6          ? pred.certain6.join(',')          : '',
       pred.certain7          ? pred.certain7.join(',')          : '']
    ).then(function() { console.log('Tahmin kaydedildi: Round ' + nextRound); if (callback) callback(); })
     .catch(function(e) { console.log('SavePred hatasi:', e.message); if (callback) callback(); });
  }).catch(function(e) { console.log('SaveNextPred hatasi:', e.message); });
}

function backfillCertain6() {
  return db.query(
    "SELECT p.id, p.pred_certain6, d.all_numbers FROM predictions p LEFT JOIN draws d ON p.round = d.round WHERE p.ou_hit != -1 AND p.pred_certain6 IS NOT NULL AND p.pred_certain6 != '' AND d.all_numbers IS NOT NULL"
  ).then(function(res) {
    if (res.rows.length === 0) { console.log('Backfill: guncellenecek kayit yok.'); return; }
    console.log('Backfill: ' + res.rows.length + ' kayit certain6_match guncelleniyor...');
    var promises = res.rows.map(function(row) {
      var pc6   = row.pred_certain6.split(',').map(Number);
      var aAll  = row.all_numbers.split(',').map(Number);
      var c6Match = aAll.filter(function(n) { return pc6.indexOf(n) !== -1; }).length;
      return db.query('UPDATE predictions SET certain6_match=$1 WHERE id=$2', [c6Match, row.id]);
    });
    return Promise.all(promises).then(function() { console.log('Backfill tamamlandi.'); });
  }).catch(function(e) { console.log('Backfill hatasi:', e.message); });
}

function loadCacheFromDB() {
  return db.query("SELECT round, first, over_under, color, all_numbers, created_at FROM draws WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 200")
  .then(function(drawRes) {
    if (drawRes.rows.length >= 10) {
      try {
        var pred = predict(drawRes.rows);
        if (pred && pred.over_under) {
          globalPredCache = pred;
          console.log('Cache yuklendi - OU: ' + pred.over_under.pred + ' Renk: ' + (pred.color ? pred.color.pred : '?'));
        }
      } catch(e) { console.log('Cache predict hatasi:', e.message); }
    } else {
      console.log('Yeterli draw yok, cache bos kalacak.');
    }
  }).catch(function(e) { console.log('loadCacheFromDB hatasi:', e.message); });
}

// ════════════════════════════════════════════════════════════
// TAHMİN MOTORU
// Düzeltme: generatePredictions() mevcut predict() fonksiyonuyla birleştirildi.
// certain6 ve first tahminleri yeni kodun MS_CORE_POOL mantığıyla güncellendi.
// certain8List, certain7List ve msBonus artık predict() scope'unda doğru tanımlanıyor.
// ════════════════════════════════════════════════════════════

function calcStreakOU(ouList) {
  if (!ouList || ouList.length === 0) return { type: 'OVER', count: 1 };
  var last = ouList[0]; var count = 1;
  for (var i = 1; i < ouList.length; i++) {
    if (ouList[i] === last) count++; else break;
  }
  return { type: last, count: count };
}

function predict(draws) {
  var result = {};
  if (!draws || draws.length < 10) return result;
  var n = draws.length;
  var firstNums  = draws.map(function(d) { return parseInt(d.first); });
  var colorList  = draws.map(function(d) { return d.color; });
  var ouList     = draws.map(function(d) { return d.over_under; });
  var allNumsArr = draws.map(function(d) { return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });

  // ── MS HAVUZU: DİNAMİK (son 15 çekilişten otomatik hesaplanır) ──
  var msFP = {};
  var msOU = {};
  draws.slice(0, Math.min(15, n)).forEach(function(d) {
    if (!d.created_at) return;
    try {
      var ms2 = parseInt(d.created_at.toString().split('.')[1].replace('Z','').substring(0,3));
      if (isNaN(ms2)) return;
      if (!msFP[ms2]) msFP[ms2] = {};
      var f2 = parseInt(d.first);
      msFP[ms2][f2] = (msFP[ms2][f2] || 0) + 1;
      if (!msOU[ms2]) msOU[ms2] = {OVER:0, UNDER:0};
      msOU[ms2][d.over_under] = (msOU[ms2][d.over_under] || 0) + 1;
    } catch(e2) {}
  });

  var MS_FIRST_POOL = {};
  Object.keys(msFP).forEach(function(ms2) {
    var freq   = msFP[ms2];
    var sorted2 = Object.keys(freq).map(Number).sort(function(a,b){ return freq[b]-freq[a]; });
    MS_FIRST_POOL[parseInt(ms2)] = sorted2.slice(0,5);
  });

  var MS_OU_SIGNAL = {};
  Object.keys(msOU).forEach(function(ms2) {
    var d2   = msOU[ms2];
    var tot2 = d2.OVER + d2.UNDER;
    if (tot2 < 8) return;
    var overPct = d2.OVER / tot2 * 100;
    if (overPct >= 60) MS_OU_SIGNAL[parseInt(ms2)] = 'OVER';
    else if (overPct <= 40) MS_OU_SIGNAL[parseInt(ms2)] = 'UNDER';
  });

  var lastMs = -1, predMs = -1;
  if (draws[0] && draws[0].created_at) {
    try {
      var tsStr  = draws[0].created_at.toString();
      var msPart = tsStr.split('.')[1];
      if (msPart) lastMs = parseInt(msPart.replace('Z','').substring(0,3));
    } catch(e) {}
  }

  var msTrans = {};
  for (var msi = 0; msi < Math.min(draws.length - 1, 15); msi++) {
    if (!draws[msi].created_at || !draws[msi+1].created_at) continue;
    try {
      var msA = parseInt(draws[msi+1].created_at.toString().split('.')[1].replace('Z','').substring(0,3));
      var msB = parseInt(draws[msi].created_at.toString().split('.')[1].replace('Z','').substring(0,3));
      if (!msTrans[msA]) msTrans[msA] = {};
      msTrans[msA][msB] = (msTrans[msA][msB] || 0) + 1;
    } catch(e) {}
  }
  if (lastMs >= 0 && msTrans[lastMs]) {
    var bestCnt = 0;
    Object.keys(msTrans[lastMs]).forEach(function(ms) {
      if (msTrans[lastMs][ms] > bestCnt) { bestCnt = msTrans[lastMs][ms]; predMs = parseInt(ms); }
    });
  }

  // ── SIFIR RENK SİNYALİ ──
  var last10Colors = colorList.slice(0, Math.min(10, n));
  var colorCnt10 = {};
  ALL_COLORS.forEach(function(c){ colorCnt10[c] = 0; });
  last10Colors.forEach(function(c){ if(colorCnt10[c]!==undefined) colorCnt10[c]++; });
  var zeroColors = ALL_COLORS.filter(function(c){ return colorCnt10[c]===0; });
  var zeroCount  = zeroColors.length;
  var zeroWaits  = {};
  zeroColors.forEach(function(zc){
    var w = 999;
    for (var zi=0; zi<Math.min(200,n); zi++) {
      if (colorList[zi] === zc) { w = zi+1; break; }
    }
    zeroWaits[zc] = w;
  });
  var shortestZeroColor = zeroColors.length > 0
    ? zeroColors.slice().sort(function(a,b){ return zeroWaits[a]-zeroWaits[b]; })[0]
    : null;

  // ── OVER/UNDER ──
  var streakOU = calcStreakOU(ouList);
  var predOU, ouConf, state = 'BALANCED';

  var ov10 = ouList.slice(0, Math.min(10, n)).filter(function(x){ return x==='OVER'; }).length;
  var ov20 = ouList.slice(0, Math.min(20, n)).filter(function(x){ return x==='OVER'; }).length;
  var pct10    = ov10 / Math.min(10, n);
  var pct20    = ov20 / Math.min(20, n);
  var trendPct = pct10 * 0.6 + pct20 * 0.4;

  // Renk → sayı grupları (sinyal hesabı)
  var CNU = {
    'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
    'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
    'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
  };

  function colorCount(numsArr, color) {
    if (!CNU[color] || !numsArr) return 0;
    return numsArr.filter(function(x){ return CNU[color].indexOf(x) !== -1; }).length;
  }

  var prevNums0  = allNumsArr[0] || [];
  var prevNums1  = allNumsArr[1] || [];
  var prevColor0 = colorList[0];
  var prevColor1 = colorList[1];

  var cnt0 = prevColor0 ? colorCount(prevNums0, prevColor0) : -1;
  var cnt1 = prevColor1 ? colorCount(prevNums1, prevColor1) : -1;

  // Renk bazlı OU sinyal tablosu
  var colorOUSignal = null, colorOUConf = 0, colorOUState = '';
  if      (cnt1===6 && prevColor1==='Sari')    { colorOUSignal='UNDER'; colorOUConf=76; colorOUState='SARI_FULL_ILK_+2'; }
  else if (cnt1===6 && prevColor1==='Yesil')   { colorOUSignal='OVER';  colorOUConf=69; colorOUState='YESIL_FULL_ILK_+2'; }
  else if (cnt0===3 && prevColor0==='Yesil')   { colorOUSignal='UNDER'; colorOUConf=64; colorOUState='YESIL_MAKS3_ILK_+1'; }
  else if ((cnt0===6&&prevColor0==='Mor')||(cnt1===6&&prevColor1==='Mor'))  { colorOUSignal='UNDER'; colorOUConf=61; colorOUState='MOR_FULL_ILK'; }
  else if ((cnt0===3&&prevColor0==='Kirmizi')||(cnt1===3&&prevColor1==='Kirmizi')) { colorOUSignal='OVER'; colorOUConf=65; colorOUState='KIRMIZI_MAKS3_ILK'; }
  else if (cnt0===6 && prevColor0==='Kirmizi') { colorOUSignal='UNDER'; colorOUConf=60; colorOUState='KIRMIZI_FULL_ILK_+1'; }
  else if (cnt1===5 && prevColor1==='Siyah')   { colorOUSignal='OVER';  colorOUConf=62; colorOUState='SIYAH_MAKS5_ILK_+2'; }
  else if (cnt1===3 && prevColor1==='Turuncu') { colorOUSignal='UNDER'; colorOUConf=61; colorOUState='TURUNCU_MAKS3_ILK_+2'; }
  else if (cnt1===3 && prevColor1==='Mor')     { colorOUSignal='OVER';  colorOUConf=61; colorOUState='MOR_MAKS3_ILK_+2'; }

  var sig_mor_over        = (prevColor0 === 'Mor');
  var sig_mor_under_over  = (prevColor0 === 'Mor' && ouList[0] === 'UNDER');

  var msOUSignal = null;
  if (predMs >= 0 && MS_OU_OVER[predMs])  msOUSignal = 'OVER';
  if (predMs >= 0 && MS_OU_UNDER[predMs]) msOUSignal = 'UNDER';

  if      (streakOU.count >= 7) { predOU = streakOU.type==='OVER'?'UNDER':'OVER'; ouConf=92; state='REVERSAL'; }
  else if (streakOU.count >= 5) { predOU = streakOU.type; ouConf=58; state='SERI_DEVAM'; }
  else if (streakOU.count === 4){ predOU = streakOU.type; ouConf=55; state='TREND'; }
  else if (streakOU.count === 3){ predOU = streakOU.type; ouConf=55; state='TREND'; }
  else {
    if      (msOUSignal)                        { predOU=msOUSignal;    ouConf=65; state='MS_OU_SIGNAL'; }
    else if (zeroCount>=3 && sig_mor_under_over){ predOU='OVER';        ouConf=64; state='SIFIR_MOR_OVER'; }
    else if (sig_mor_under_over)                { predOU='OVER';        ouConf=61; state='MOR_UNDER_OVER'; }
    else if (sig_mor_over)                      { predOU='OVER';        ouConf=58; state='MOR_OVER'; }
    else if (colorOUSignal)                     { predOU=colorOUSignal; ouConf=colorOUConf; state=colorOUState; }
    else if (trendPct > 0.62)                   { predOU='OVER';        ouConf=58; state='TREND_OVER'; }
    else if (trendPct < 0.38)                   { predOU='UNDER';       ouConf=58; state='TREND_UNDER'; }
    else                                        { predOU=streakOU.type; ouConf=52; state='BALANCED'; }
  }
  result.over_under = { pred: predOU, conf: ouConf, streak: streakOU, state: state, predMs: predMs, trendPct: Math.round(trendPct*100) };

  // ── RENK: MARKOV + SOĞUKLUK ──
  var colorCounts = {}; ALL_COLORS.forEach(function(c){ colorCounts[c]=0; });
  colorList.slice(0,Math.min(200,n)).forEach(function(c){ if(colorCounts[c]!==undefined) colorCounts[c]++; });

  var colorLastSeen = {}; ALL_COLORS.forEach(function(c){ colorLastSeen[c]=999; });
  colorList.forEach(function(c,ci){ if(colorLastSeen[c]===999) colorLastSeen[c]=ci; });

  var colorMarkov = {};
  for (var cmi=0; cmi<n-1; cmi++) {
    var c2=colorList[cmi], nx=colorList[cmi+1];
    if(!colorMarkov[c2]) colorMarkov[c2]={};
    colorMarkov[c2][nx]=(colorMarkov[c2][nx]||0)+1;
  }
  var lastColor = colorList[0];
  var markovCS  = {};
  ALL_COLORS.forEach(function(c) {
    if (colorMarkov[lastColor]) {
      var tot = Object.keys(colorMarkov[lastColor]).reduce(function(a,k){ return a+colorMarkov[lastColor][k]; },0);
      markovCS[c] = tot > 0 ? (colorMarkov[lastColor][c]||0)/tot*100 : 0;
    } else { markovCS[c]=0; }
  });

  var cc30={}; ALL_COLORS.forEach(function(c){ cc30[c]=0; });
  colorList.slice(0,Math.min(30,n)).forEach(function(c){ if(cc30[c]!==undefined) cc30[c]++; });
  var coldColors = ALL_COLORS.filter(function(c){ return cc30[c]===0; });

  var LONG_WAIT_BONUS = {'Kahve':3.0,'Mor':1.5,'Sari':1.3,'Yesil':1.0,'Turuncu':1.0,'Siyah':0.8,'Kirmizi':0.8,'Mavi':0.8};
  var cs = {};
  ALL_COLORS.forEach(function(c) {
    var baseScore = Math.max(0,25-colorCounts[c])*3 + Math.min(colorLastSeen[c],50)*1.5 + markovCS[c]*2.5;
    var waitBonus = 0;
    if      (colorLastSeen[c]>=35) waitBonus=(colorLastSeen[c]-34)*(LONG_WAIT_BONUS[c]||1.0)*2;
    else if (colorLastSeen[c]>=25) waitBonus=(colorLastSeen[c]-24)*(LONG_WAIT_BONUS[c]||1.0)*1.0;
    cs[c] = baseScore + waitBonus;
  });

  var maxWaitColor = ALL_COLORS.slice().sort(function(a,b){ return colorLastSeen[b]-colorLastSeen[a]; })[0];
  var maxWait      = colorLastSeen[maxWaitColor];

  if (zeroColors.length >= 3) {
    zeroColors.forEach(function(zc) {
      var zWait  = zeroWaits[zc] || 999;
      var zBonus = zc===shortestZeroColor ? 25 : Math.max(0,20-(zWait-11)*0.5);
      cs[zc] = (cs[zc]||0) + zBonus;
    });
  }

  var predColor = coldColors.length > 0
    ? coldColors.sort(function(a,b){ return colorLastSeen[b]-colorLastSeen[a]; })[0]
    : ALL_COLORS.slice().sort(function(a,b){ return cs[b]-cs[a]; })[0];
  var colorConf = coldColors.length>=3?68:coldColors.length===2?55:42;
  if (maxWait >= 35) colorConf = Math.min(colorConf+10, 80);
  result.color = { pred: predColor, conf: colorConf, counts: colorCounts, state: state,
                   maxWaitColor: maxWaitColor, maxWait: maxWait };

  // ── İLK SAYI: FREKANS + SON GÖRÜLME + MARKOV + MS HAVUZU ──
  var firstFreq = {}; for (var i=1; i<=48; i++) firstFreq[i]=0;
  firstNums.forEach(function(num,idx){ firstFreq[num]+=Math.exp(-0.03*idx); });

  var firstLS = {}; for (var i=1; i<=48; i++) firstLS[i]=999;
  firstNums.forEach(function(num,idx){ if(firstLS[num]===999) firstLS[num]=idx; });

  var numMk = {};
  for (var mi=0; mi<n-1; mi++) {
    var pa=firstNums[mi], pb=firstNums[mi+1];
    if(!numMk[pa]) numMk[pa]={};
    numMk[pa][pb]=(numMk[pa][pb]||0)+1;
  }
  var lastNum  = firstNums[0];
  var nmScore  = {};
  for (var i=1; i<=48; i++) {
    if (numMk[lastNum]) {
      var t2 = Object.keys(numMk[lastNum]).reduce(function(a,k){ return a+numMk[lastNum][k]; },0);
      nmScore[i] = t2>0?(numMk[lastNum][i]||0)/t2*100:0;
    } else { nmScore[i]=0; }
  }

  // Düzeltme: msBonus predict() scope'unda tanımlandı (yeni kodda undefined hatasına sebep oluyordu)
  var msBonus = {}; for (var i=1; i<=48; i++) msBonus[i]=0;
  if (predMs >= 0 && MS_FIRST_POOL[predMs]) {
    MS_FIRST_POOL[predMs].forEach(function(num, rank) {
      msBonus[num] = (5-rank)*8;
    });
  }

  var rec20 = firstNums.slice(0, Math.min(20,n));
  var maxFq  = Math.max.apply(null, Object.keys(firstFreq).map(function(k){ return firstFreq[k]; })) || 1;

  var firstColorReliable   = (predColor==='Sari'||predColor==='Siyah'||predColor==='Yesil');
  var msBonusMultiplier    = firstColorReliable ? 2.0 : 0.5;

  // Düzeltme: Recency bonusu (yeni koddan eklendi - mean reversion)
  var recentFreq = {};
  firstNums.slice(0, Math.min(10,n)).forEach(function(num){
    recentFreq[num] = (recentFreq[num]||0)+1;
  });

  var ns = {};
  for (var i=1; i<=48; i++) {
    ns[i] = firstFreq[i]/maxFq*100*0.25
          + Math.min(firstLS[i],30)/30*100*0.25
          + (rec20.indexOf(i)===-1?25:0)*0.20
          + nmScore[i]*0.15
          + msBonus[i]*0.15*msBonusMultiplier
          + ((recentFreq[i]||0)<3?1.5:-0.5)*0.10; // Mean reversion düzeltmesi
  }
  var allC=[]; for (var i=1; i<=48; i++) allC.push(i);
  allC.sort(function(a,b){ return ns[b]-ns[a]; });
  var filtC = allC.filter(function(x){ return predOU==='OVER'?x>24:x<=24; });
  if (filtC.length < 5) filtC = allC;
  result.first_candidates  = filtC.slice(0,5).sort(function(a,b){ return a-b; });
  result.first5_candidates = filtC.slice(0,6).sort(function(a,b){ return a-b; });
  result.firstColorReliable = firstColorReliable;

  // ── TEKRAR ORANLARI ──
  var REPEAT_RATE = {1:0.7358,2:0.7703,3:0.7333,4:0.7162,5:0.7092,6:0.7168,7:0.7476,8:0.7341,9:0.7186,10:0.6950,11:0.7275,12:0.7245,13:0.7127,14:0.7331,15:0.7357,16:0.7072,17:0.7464,18:0.7054,19:0.7360,20:0.7104,21:0.7324,22:0.7400,23:0.7299,24:0.7569,25:0.7583,26:0.7304,27:0.7252,28:0.6969,29:0.7300,30:0.7470,31:0.7027,32:0.7411,33:0.7605,34:0.7024,35:0.7213,36:0.7437,37:0.7159,38:0.7512,39:0.7447,40:0.7250,41:0.7222,42:0.7353,43:0.7244,44:0.7183,45:0.7289,46:0.7387,47:0.7440,48:0.7098};

  var COLOR_FIRST_POOL = {
    'Sari':    [19,42,34,12,17],
    'Yesil':   [6,28,38,40,27],
    'Mavi':    [14,39,33,16,7],
    'Kirmizi': [32,30,7,42,1],
    'Kahve':   [45,31,12,47,25],
    'Turuncu': [24,17,18,35,32],
    'Siyah':   [38,24,10,29,31],
    'Mor':     [37,41,29,27,40]
  };

  // Sinyal tabloları
  var MS_66_SIGNAL  = {964:23.3,958:22.7,949:18.2,953:18.3,952:14.9,961:15.2};
  var MS_88_SIGNAL  = {958:13.6,964:11.7,949:9.9,952:9.2,953:9.0,961:9.1};
  var MS_BAD_88     = {948:1,960:1,962:1,965:1,956:1,963:1};
  var MS_BAD_66     = {960:1,962:1,965:1};
  var MS_77_SIGNAL  = {948:15.4,959:15.2,961:15.2,962:13.0,964:13.3,966:20.0};
  var MS_BAD_77     = {956:1,954:1,963:1};
  var MS_WEAK_PERIOD= {960:1,962:1,965:1};
  var MS_OU_OVER    = {959:1,960:1,961:1,962:1,965:1,966:1};
  var MS_OU_UNDER   = {948:1,957:1};

  var ou3str   = ouList.slice(0,Math.min(3,n)).map(function(x){ return x==='OVER'?'O':'U'; }).join('');
  var sig_uou  = (ou3str==='UOU');
  var sig_uuu  = (ou3str==='UUU');

  var prevColor  = colorList[0];
  var prevColor2 = colorList[1] || '';
  var sig_siyah_prev   = (prevColor==='Siyah');
  var sig_turuncu_prev = (prevColor==='Turuncu');
  var sig_kahve_prev   = (prevColor==='Kahve');

  var COLOR_NUMS_7 = {
    'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
    'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
    'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
  };

  function cntColor(numsArr, color) {
    if (!COLOR_NUMS_7[color]) return 0;
    return numsArr.filter(function(x){ return COLOR_NUMS_7[color].indexOf(x)!==-1; }).length;
  }

  // cnt0/cnt1 COLOR_NUMS_7 bazlı (C7 sinyal hesabı için)
  var cnt0c7 = prevColor  ? cntColor(prevNums0, prevColor)  : -1;
  var cnt1c7 = prevColor2 ? cntColor(prevNums1, prevColor2) : -1;

  var siyahFull    = (cnt0c7===6 && prevColor==='Siyah');
  var sig_c6_strong= (prevColor==='Siyah'||prevColor==='Kahve'||prevColor==='Kirmizi');
  var sig_c6_weak  = false;
  var sig_c8_strong= (cnt0c7===6&&(prevColor==='Siyah'||prevColor==='Turuncu'));
  var sig_c8_weak  = (cnt0c7===6&&(prevColor==='Kirmizi'||prevColor==='Mor'));
  var sig_c7_strong= (
    (cnt0c7===3&&prevColor==='Yesil')  ||
    (cnt0c7===3&&prevColor==='Mor')    ||
    (cnt0c7===6&&prevColor==='Kahve')  ||
    (cnt0c7===4&&prevColor==='Turuncu')
  );
  var sig_c7_weak  = (
    (cnt0c7===6&&prevColor==='Kirmizi')||
    (cnt0c7===3&&prevColor==='Kirmizi')||
    (cnt0c7===3&&prevColor==='Sari')   ||
    (cnt0c7===3&&prevColor==='Siyah')  ||
    (cnt0c7===4&&prevColor==='Mor')    ||
    (cnt0c7===4&&prevColor==='Yesil')
  );

  var msDiff2     = (lastMs>=0&&predMs>=0)?(predMs-lastMs):999;
  var sig_ms_minus1=(msDiff2===-1);

  // Renk ilk sayı bonusunu ms bonusuna ekle
  var colorPool = COLOR_FIRST_POOL[prevColor] || [];
  colorPool.forEach(function(num,rank){ msBonus[num]=(msBonus[num]||0)+(5-rank)*6; });

  var strongSig66=0, strongSig88=0;
  if (predMs>=0&&MS_66_SIGNAL[predMs]) strongSig66++;
  if (predMs>=0&&MS_88_SIGNAL[predMs]) strongSig88++;
  if (sig_uou)          { strongSig66++; strongSig88++; }
  if (sig_uuu)            strongSig88++;
  if (sig_siyah_prev)   { strongSig66++; strongSig88++; }
  if (sig_turuncu_prev)   strongSig88++;
  if (sig_kahve_prev)     strongSig66++;
  if (sig_ms_minus1)      strongSig66++;
  if (sig_c6_strong)      strongSig66++;
  if (sig_c8_strong)      strongSig88++;
  if (siyahFull)        { strongSig66+=2; }

  var badMs88    = (predMs>=0&&MS_BAD_88[predMs])     || sig_c8_weak;
  var badMs66    = (predMs>=0&&MS_BAD_66[predMs])     || sig_c6_weak;
  var weakPeriod = (predMs>=0&&MS_WEAK_PERIOD[predMs]);
  var sig77      = (predMs>=0&&MS_77_SIGNAL[predMs])?1:0;
  if (sig_c7_strong) sig77++;
  var badMs77 = (predMs>=0&&MS_BAD_77[predMs]) || sig_c7_weak;

  // ── KESİN 8 ──
  var prevNums    = allNumsArr[0]&&allNumsArr[0].length>0?allNumsArr[0]:[];
  var c6Scored    = prevNums.slice().sort(function(a,b){ return (REPEAT_RATE[b]||0.72)-(REPEAT_RATE[a]||0.72); });
  var certain8List= c6Scored.slice(0,8);
  result.certain8 = certain8List.slice().sort(function(a,b){ return a-b; });

  // ── KESİN 7 ──
  var posScore7 = {}; for (var pi7=1; pi7<=48; pi7++) posScore7[pi7]=0;
  allNumsArr.slice(0,Math.min(20,n)).forEach(function(nums) {
    nums.slice(0,5).forEach(function(num,pos){ posScore7[num]=(posScore7[num]||0)+(5-pos); });
  });

  var c8Set = {}; certain8List.forEach(function(x){ c8Set[x]=1; });

  var lowColorNums7 = {};
  var prevSet7 = {}; prevNums.forEach(function(x){ prevSet7[x]=1; });
  ALL_COLORS.forEach(function(color) {
    if (!COLOR_NUMS_7[color]) return;
    var cnt = COLOR_NUMS_7[color].filter(function(x){ return prevSet7[x]; }).length;
    if (cnt <= 2) COLOR_NUMS_7[color].forEach(function(x){ lowColorNums7[x]=1; });
  });

  var msExtra7 = {};
  if (predMs>=0 && MS_FIRST_POOL[predMs]) {
    MS_FIRST_POOL[predMs].slice(0,10).forEach(function(num) {
      if (!c8Set[num]) msExtra7[num]=1;
    });
  }

  var priority7 = {};
  Object.keys(lowColorNums7).forEach(function(x){ if(!c8Set[x]) priority7[x]=1; });
  Object.keys(msExtra7).forEach(function(x){ priority7[x]=1; });

  var sorted7   = [];
  var pri_arr   = Object.keys(priority7).map(Number).sort(function(a,b){ return posScore7[b]-posScore7[a]; });
  var rest_arr  = [];
  for (var ri7=1; ri7<=48; ri7++) {
    if (!c8Set[ri7] && !priority7[ri7]) rest_arr.push(ri7);
  }
  rest_arr.sort(function(a,b){ return posScore7[b]-posScore7[a]; });
  sorted7 = pri_arr.concat(rest_arr);
  result.certain7 = sorted7.slice(0,7).sort(function(a,b){ return a-b; });

  // ── KESİN 6: C8'den 3 + C7'den 3 (Yeni kodun MS_CORE_POOL kilidi eklendi) ──
  var c7Only = result.certain7.filter(function(x){ return !c8Set[x]; });

  // Yeni koddan: MS skoru fonksiyonu
  function scoreNum(num) {
    var s = 1;
    if (MS_CORE_POOL.indexOf(num)!==-1) s+=4;
    if (MS_HOT_POOL.indexOf(num)!==-1)  s+=2;
    if (c8Set[num])                      s+=3;
    if (recentFreq[num] && recentFreq[num]>0) s+=1;
    return s;
  }

  // C8'den en yüksek skorlu 3
  var c8Scored2 = certain8List.map(function(n){ return {num:n, score:scoreNum(n)+10}; }).sort(function(a,b){ return b.score-a.score; });
  var selC8     = c8Scored2.slice(0,3).map(function(x){ return x.num; });

  // C7'den (C8'de olmayan) en yüksek skorlu 3
  var c7Scored2 = c7Only.map(function(n){ return {num:n, score:scoreNum(n)}; }).sort(function(a,b){ return b.score-a.score; });
  var selC7     = c7Scored2.slice(0,3).map(function(x){ return x.num; });

  var certain6List = selC8.concat(selC7);

  // MS Çekirdek Kilidi: En az 2 sayı MS_CORE_POOL'dan olsun
  var coreInC6 = certain6List.filter(function(n){ return MS_CORE_POOL.indexOf(n)!==-1; });
  if (coreInC6.length < 2) {
    var missing = MS_CORE_POOL.filter(function(n){ return certain6List.indexOf(n)===-1; });
    for (var mi2=0; mi2<missing.length && certain6List.length<6; mi2++) {
      certain6List.push(missing[mi2]);
    }
    if (certain6List.length > 6) certain6List = certain6List.slice(0,6);
  }

  result.certain6      = certain6List.filter(function(v,i,a){ return a.indexOf(v)===i; }).sort(function(a,b){ return a-b; });
  result.certain6_grpA = selC8.sort(function(a,b){ return a-b; });

  // ── TÜM SİNYAL BİLGİLERİ ──
  result.signals = {
    predMs: predMs, lastMs: lastMs, msDiff: msDiff2,
    ou3: ou3str, prevColor: prevColor,
    weakPeriod: weakPeriod, zeroCount: zeroCount, shortestZeroColor: shortestZeroColor,
    sig66: strongSig66, badMs66: badMs66, c6strong: sig_c6_strong, c6weak: sig_c6_weak, siyahFull: siyahFull,
    sig88: strongSig88, badMs88: badMs88, c8strong: sig_c8_strong, c8weak: sig_c8_weak,
    sig77: sig77, badMs77: badMs77, c7strong: sig_c7_strong, c7weak: sig_c7_weak,
    sig_uou: sig_uou, sig_uuu: sig_uuu,
    sig_siyah_prev: sig_siyah_prev, sig_kahve_prev: sig_kahve_prev, sig_turuncu_prev: sig_turuncu_prev,
    sig_ms_minus1: sig_ms_minus1, strongSig66: strongSig66, strongSig88: strongSig88
  };

  return result;
}

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════

function startDashboard() {
  var app = express();
  app.use(cors());
  var CH = JSON.stringify(COLOR_HEX);

  app.get('/data', function(req, res) {
    var done  = false;
    var timer = setTimeout(function(){ done=true; if(!res.headersSent) res.json({error:'Timeout'}); }, 8000);
    Promise.all([
      db.query('SELECT round,first,over_under,color,all_numbers,created_at FROM draws ORDER BY created_at DESC LIMIT 200'),
      db.query("SELECT COUNT(*) as total, SUM(CASE WHEN over_under='OVER' THEN 1 ELSE 0 END) as over_count FROM draws")
    ]).then(function(r) {
      clearTimeout(timer); if(done) return;
      var total = parseInt(r[1].rows[0].total)||0;
      var oc    = parseInt(r[1].rows[0].over_count)||0;
      var op    = total>0?Math.round(oc/total*100):50;
      if(!res.headersSent) res.json({last200:r[0].rows, stats:{total:total,over_pct:op,under_pct:100-op}, predictions:globalPredCache});
    }).catch(function(e){ clearTimeout(timer); if(!res.headersSent) res.json({error:e.message}); });
  });

  app.get('/draws.json', function(req, res) {
    db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round ASC')
    .then(function(result) {
      var data = result.rows.map(function(r,i){
        return {seq:i+1,round:r.round,first:r.first,ou:r.over_under,color:r.color,numbers:r.all_numbers,ts:r.created_at};
      });
      res.setHeader('Content-Type','application/json');
      res.setHeader('Content-Disposition','attachment; filename="draws.json"');
      res.json(data);
    }).catch(function(e){ res.status(500).json({error:e.message}); });
  });

  app.get('/predictions.json', function(req, res) {
    db.query("SELECT round,pred_ou,pred_color,pred_first,pred_first5,pred_certain6,pred_certain8,actual_first,actual_first5,actual_color,actual_ou,ou_hit,color_hit,first_hit,first5_match,certain6_match,certain8_full_match,created_at FROM predictions WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at ASC")
    .then(function(result) {
      var data = result.rows.map(function(r,i){
        return {
          seq:i+1, round:r.round,
          pred_ou:r.pred_ou, pred_color:r.pred_color,
          pred_first:r.pred_first, pred_first5:r.pred_first5,
          pred_certain6:r.pred_certain6, pred_certain8:r.pred_certain8,
          actual_first:r.actual_first, actual_first5:r.actual_first5,
          actual_color:r.actual_color, actual_ou:r.actual_ou,
          ou_hit:r.ou_hit, color_hit:r.color_hit, first_hit:r.first_hit,
          first5_match:r.first5_match, certain6_match:r.certain6_match,
          certain8_full_match:r.certain8_full_match, ts:r.created_at
        };
      });
      res.setHeader('Content-Type','application/json');
      res.setHeader('Content-Disposition','attachment; filename="predictions.json"');
      res.json(data);
    }).catch(function(e){ res.status(500).json({error:e.message}); });
  });

  app.get('/rapor', function(req, res) {
    db.query("SELECT round,pred_ou,pred_color,pred_first,pred_first5,pred_certain6,pred_certain7,pred_certain8,actual_first,actual_first5,actual_color,actual_ou,ou_hit,color_hit,first_hit,first5_match,certain6_match,certain7_match,certain8_full_match FROM predictions WHERE ou_hit != -1 ORDER BY round DESC LIMIT 200")
    .then(function(r) {
      var rows=r.rows;
      var ouHit=0,ouTotal=0,colorHit=0,colorTotal=0,firstHit=0,firstTotal=0;
      var c6T=0,c6S=0,c8FT=0,c8FS=0;
      var c6Dist={0:0,1:0,2:0,3:0,4:0,5:0,6:0};
      var c8fDist={0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0};
      rows.forEach(function(rr) {
        ouTotal++; if(parseInt(rr.ou_hit)===1) ouHit++;
        colorTotal++; if(parseInt(rr.color_hit)===1) colorHit++;
        firstTotal++; if(parseInt(rr.first_hit)===1) firstHit++;
        var c6m=parseInt(rr.certain6_match); if(c6m>=0){c6T++;c6S+=c6m;c6Dist[Math.min(c6m,6)]=(c6Dist[Math.min(c6m,6)]||0)+1;}
        var cfm=parseInt(rr.certain8_full_match); if(cfm>=0){c8FT++;c8FS+=cfm;c8fDist[Math.min(cfm,8)]=(c8fDist[Math.min(cfm,8)]||0)+1;}
      });
      var ouPct=ouTotal>0?Math.round(ouHit/ouTotal*100):0;
      var colorPct=colorTotal>0?Math.round(colorHit/colorTotal*100):0;
      var firstPct=firstTotal>0?Math.round(firstHit/firstTotal*100):0;
      var c6avg=c6T>0?(c6S/c6T).toFixed(2):'0.00';
      var c8favg=c8FT>0?(c8FS/c8FT).toFixed(2):'0.00';

      var h='<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapor</title>';
      h+='<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1a1d2e;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:580px;margin:0 auto}';
      h+='h1{font-size:20px;text-align:center;font-weight:900;letter-spacing:3px;padding:16px 0}';
      h+='.btn{display:block;width:100%;padding:13px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:12px;text-align:center;text-decoration:none}';
      h+='.st{font-size:10px;color:#5a6180;text-transform:uppercase;letter-spacing:2px;font-weight:700;padding:10px 0 8px;border-bottom:1px solid #2a2f42;margin-bottom:12px}';
      h+='.sr{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e2130}';
      h+='.sl{font-size:13px;color:#aab0c4;font-weight:600}.srr{text-align:right}';
      h+='.sp{font-size:20px;font-weight:900}.ss{font-size:11px;color:#5a6180;margin-top:2px}';
      h+='.bar{height:4px;background:#2a2f42;border-radius:2px;margin-top:5px;width:100px;overflow:hidden}.bf{height:100%;border-radius:2px}';
      h+='.ar{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e2130}';
      h+='.rc{background:#262a3a;border:1px solid #2a2f42;border-radius:12px;padding:12px;margin-bottom:10px}';
      h+='.rh{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:4px}';
      h+='.rn{font-size:12px;color:#5a6180;font-weight:700}';
      h+='.lbl{font-size:10px;color:#5a6180;text-transform:uppercase;letter-spacing:1px;margin:8px 0 4px}';
      h+='.nr{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;align-items:center}';
      h+='.nb{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0}';
      h+='.mi{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #2a2f42}';
      h+='.mc{background:#1e2130;padding:5px 10px;border-radius:8px;font-size:11px}';
      h+='.hit{color:#22c55e}.miss{color:#ef4444}';
      h+='.renk-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:800}';
      h+='</style></head><body>';
      h+='<h1>TAHMIN RAPORU</h1>';
      h+='<a class="btn" href="/">ANA SAYFA</a>';
      h+='<div class="st">Basari Ozeti (Son '+ouTotal+' Tahmin)</div>';

      var ouc=ouPct>=55?'#22c55e':ouPct>=50?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Over/Under</div><div class="srr">';
      h+='<div class="sp" style="color:'+ouc+'">%'+ouPct+'</div><div class="ss">'+ouHit+'/'+ouTotal+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+ouPct+'%;background:'+ouc+'"></div></div></div></div>';

      var cc=colorPct>=20?'#22c55e':colorPct>=12?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Renk</div><div class="srr">';
      h+='<div class="sp" style="color:'+cc+'">%'+colorPct+'</div><div class="ss">'+colorHit+'/'+colorTotal+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(colorPct*4,100)+'%;background:'+cc+'"></div></div></div></div>';

      var fc=firstPct>=15?'#22c55e':firstPct>=10?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Ilk Sayi (5 Aday)</div><div class="srr">';
      h+='<div class="sp" style="color:'+fc+'">%'+firstPct+'</div><div class="ss">'+firstHit+'/'+firstTotal+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(firstPct*4,100)+'%;background:'+fc+'"></div></div></div></div>';

      var c6perfect=c6Dist[6]||0;
      var c6ppct=c6T>0?Math.round(c6perfect/c6T*100):0;
      var c6pc=c6ppct>=20?'#22c55e':c6ppct>=5?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Kesin 6 (6/6 tuttu)</div><div class="srr">';
      h+='<div class="sp" style="color:'+c6pc+'">%'+c6ppct+'</div><div class="ss">'+c6perfect+'/'+c6T+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(c6ppct*4,100)+'%;background:'+c6pc+'"></div></div></div></div>';

      var c7T=0,c7S=0,c7Dist={0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0};
      rows.forEach(function(rr){ var c7m=parseInt(rr.certain7_match); if(!isNaN(c7m)&&c7m>=0){c7T++;c7S+=c7m;c7Dist[Math.min(c7m,7)]=(c7Dist[Math.min(c7m,7)]||0)+1;} });
      var c7avg=c7T>0?(c7S/c7T).toFixed(2):'0.00';
      var c7perfect=c7Dist[7]||0;
      var c7ppct=c7T>0?Math.round(c7perfect/c7T*100):0;
      h+='<div class="sr"><div class="sl">Kesin 7 (7/7 tuttu) \u2014 Rastgele</div><div class="srr">';
      h+='<div class="sp" style="color:#d4a843">%'+c7ppct+'</div><div class="ss">'+c7perfect+'/'+c7T+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(c7ppct*4,100)+'%;background:#d4a843"></div></div></div></div>';

      var c8perfect=c8fDist[8]||0;
      var c8ppct=c8FT>0?Math.round(c8perfect/c8FT*100):0;
      var c8ppc=c8ppct>=10?'#22c55e':c8ppct>=5?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Kesin 8 (8/8 tuttu)</div><div class="srr">';
      h+='<div class="sp" style="color:'+c8ppc+'">%'+c8ppct+'</div><div class="ss">'+c8perfect+'/'+c8FT+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(c8ppct*4,100)+'%;background:'+c8ppc+'"></div></div></div></div>';

      h+='<div class="ar"><div class="sl">Kesin 6 \u2192 35 sayida kac tuttu (ort.)</div>';
      h+='<div style="font-size:16px;font-weight:900;color:#a855f7">'+c6avg+' / 6</div></div>';
      h+='<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">KESIN 6 DAGILIMI (35 SAYI)</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
      for (var _i=0;_i<=6;_i++){var _c=_i>=5?'#22c55e':_i>=4?'#facc15':'#ef4444';var _b=_i>=5?'#22c55e44':_i>=4?'#facc1544':'#2a2f42';h+='<div style="background:#1e2130;border:1px solid '+_b+';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">'+_i+'/6: </span><span style="color:'+_c+';font-weight:800">'+(c6Dist[_i]||0)+'x</span></div>';}
      h+='</div></div>';

      h+='<div class="ar"><div class="sl">Kesin 7 \u2192 35 sayida kac tuttu (ort.) \u2014 Rastgele</div>';
      h+='<div style="font-size:16px;font-weight:900;color:#d4a843">'+c7avg+' / 7</div></div>';
      h+='<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">KESIN 7 DAGILIMI (35 SAYI)</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
      for (var _j=0;_j<=7;_j++){var _cj=_j>=6?'#22c55e':_j>=5?'#facc15':'#d4a843';var _bj=_j>=6?'#22c55e44':_j>=5?'#facc1544':'#2a2f42';h+='<div style="background:#1e2130;border:1px solid '+_bj+';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">'+_j+'/7: </span><span style="color:'+_cj+';font-weight:800">'+(c7Dist[_j]||0)+'x</span></div>';}
      h+='</div></div>';

      h+='<div class="ar"><div class="sl">Kesin 8 \u2192 35 sayida kac tuttu (ort.)</div>';
      h+='<div style="font-size:16px;font-weight:900;color:#a855f7">'+c8favg+' / 8</div></div>';
      h+='<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">KESIN 8 DAGILIMI (35 SAYI) \u2014 6+ PARA ODUYOR</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
      for (var _k=0;_k<=8;_k++){var _e=_k>=6?'#22c55e':_k>=5?'#facc15':'#ef4444';var _brd=_k>=6?'#22c55e44':_k>=5?'#facc1544':'#2a2f42';h+='<div style="background:#1e2130;border:1px solid '+_brd+';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">'+_k+'/8: </span><span style="color:'+_e+';font-weight:800">'+(c8fDist[_k]||0)+'x</span></div>';}
      h+='</div></div>';

      h+='<div class="st" style="margin-top:16px">Cekilis Bazli Detay</div>';

      rows.forEach(function(r) {
        var ouHitR   =parseInt(r.ou_hit)===1;
        var colorHitR=parseInt(r.color_hit)===1;
        var firstHitR=parseInt(r.first_hit)===1;
        var af5 =r.actual_first5?r.actual_first5.split(',').map(Number):[];
        var aAll=[];
        var pf1 =r.pred_first    ?r.pred_first.split(',').map(Number).sort(function(a,b){return a-b;}):[];
        var pc6 =r.pred_certain6 ?r.pred_certain6.split(',').map(Number).sort(function(a,b){return a-b;}):[];
        var pc7 =r.pred_certain7 ?r.pred_certain7.split(',').map(Number).sort(function(a,b){return a-b;}):[];
        var pc8 =r.pred_certain8 ?r.pred_certain8.split(',').map(Number).sort(function(a,b){return a-b;}):[];
        var c6m =parseInt(r.certain6_match)>=0?parseInt(r.certain6_match):'-';
        var c7m =r.certain7_match!==null&&parseInt(r.certain7_match)>=0?parseInt(r.certain7_match):'-';
        var c8fm=parseInt(r.certain8_full_match)>=0?parseInt(r.certain8_full_match):'-';

        function renkBadge(renk,hit){
          if(!renk) return '?';
          var hex=COLOR_HEX[renk]||'#aab0c4';
          var tc=renk==='Siyah'?'#e5e7eb':hex;
          var bg=hit?(renk==='Siyah'?'#374151':'#1a1a2e'):'#1e2130';
          var brd=hit?(renk==='Siyah'?'2px solid #22c55e':'2px solid '+hex):'1px solid '+hex+'66';
          return '<span class="renk-badge" style="color:'+tc+';background:'+bg+';border:'+brd+'">'+renk+'</span>';
        }

        h+='<div class="rc">';
        h+='<div class="rh"><span class="rn">Round '+r.round+'</span>';
        h+='<span style="font-size:13px;font-weight:800">1.S: <span style="font-size:15px;font-weight:900">'+(r.actual_first||'?')+'</span> ';
        h+=renkBadge(r.actual_color,colorHitR)+' ';
        h+='<span class="'+(ouHitR?'hit':'miss')+'">'+(r.actual_ou||'?')+(ouHitR?' \u2713':' \u2717')+'</span></span></div>';

        if(r.pred_ou){
          var ouColor=r.pred_ou==='OVER'?'#22c55e':'#ef4444';
          h+='<div class="lbl">OVER/UNDER TAHMIN\u0130</div><div style="margin-bottom:6px">';
          h+='<span style="font-weight:800;color:'+ouColor+'">'+r.pred_ou+'</span>';
          if(ouHitR){ h+=' <span style="color:#22c55e;font-size:12px;font-weight:800">\u2713 TUTTU</span>'; }
          else { h+=' <span style="color:#ef4444;font-size:12px;font-weight:800">\u2717 KACTI</span><span style="font-size:11px;color:#5a6180">(Gercek: <span style="color:'+(r.actual_ou==='OVER'?'#22c55e':'#ef4444')+';font-weight:700">'+(r.actual_ou||'?')+'</span>)</span>'; }
          h+='</div>';
        }

        if(r.pred_color){
          var ph=COLOR_HEX[r.pred_color]||'#aab0c4';
          var pt=r.pred_color==='Siyah'?'#e5e7eb':ph;
          h+='<div class="lbl">RENK TAHMIN\u0130</div><div style="margin-bottom:6px">';
          h+='<span class="renk-badge" style="color:'+pt+';background:#1e2130;border:1px solid '+ph+'88">'+r.pred_color+'</span>';
          if(colorHitR){ h+=' <span style="color:#22c55e;font-size:12px;font-weight:800">\u2713 TUTTU</span>'; }
          else { h+=' <span style="color:#ef4444;font-size:12px;font-weight:800">\u2717 KACTI</span> <span style="font-size:11px;color:#5a6180">(Gercek: '+renkBadge(r.actual_color,false)+')</span>'; }
          h+='</div>';
        }

        if(pf1.length>0){
          h+='<div class="lbl">TAHMIN 5 \u2014 1. Sayi Adaylari</div><div class="nr">';
          pf1.forEach(function(num){
            var isF=num===parseInt(r.actual_first);
            h+='<div class="nb" style="background:'+(isF?'#14532d':'#1e2130')+';border:'+(isF?'2px solid #22c55e':'1px solid #3b82f6')+';color:'+(isF?'#22c55e':'#93c5fd')+'">'+num+'</div>';
          });
          h+='<span style="font-size:11px;color:'+(firstHitR?'#22c55e':'#ef4444')+';margin-left:6px;font-weight:800">'+(firstHitR?'\u2713 TUTTU':'\u2717 KACTI')+'</span></div>';
        }

        if(af5.length>0){
          h+='<div class="lbl">GERCEK ILK 5</div><div class="nr">';
          af5.forEach(function(num){ h+='<div class="nb" style="background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd">'+num+'</div>'; });
          h+='</div>';
        }

        if(pc6.length>0||c6m!=='-'){
          h+='<div class="lbl">KESIN CIKACAK 6 SAYI \u2014 <span style="color:#a855f7;font-weight:900">'+c6m+'/6 tuttu (35 sayida)</span></div>';
          h+='<div class="nr">';
          pc6.forEach(function(num){
            var inIlk5=af5.indexOf(num)!==-1;
            var inFull=aAll.indexOf(num)!==-1;
            var bg=inIlk5?'#0f4a66':inFull?'#0c2a3a':'#2a3040';
            var brd=inIlk5?'#38bdf8':inFull?'#38bdf8':'#4a5270';
            var cl=inIlk5?'#7dd3fc':inFull?'#38bdf8':'#aab0c4';
            h+='<div class="nb" style="background:'+bg+';border:2px solid '+brd+';color:'+cl+'">'+num+'</div>';
          });
          h+='</div>';
          h+='<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#38bdf8;border:2px solid #38bdf8;vertical-align:middle"></span> Ilk 5\'te cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#0c2a3a;border:2px solid #38bdf8;vertical-align:middle"></span> 35 sayida cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h+='</div>';
        }

        if(pc7.length>0){
          h+='<div class="lbl">KESIN 7 SAYI (RASTGELE) \u2014 <span style="color:#d4a843;font-weight:900">'+c7m+'/7 tuttu (35 sayida)</span></div>';
          h+='<div class="nr">';
          pc7.forEach(function(num){
            var inFull=aAll.indexOf(num)!==-1;
            var bg=inFull?'#2a2000':'#2a3040';
            var brd=inFull?'#d4a843':'#4a5270';
            var cl=inFull?'#d4a843':'#aab0c4';
            h+='<div class="nb" style="background:'+bg+';border:1px solid '+brd+';color:'+cl+'">'+num+'</div>';
          });
          h+='</div>';
          h+='<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a2000;border:1px solid #d4a843;vertical-align:middle"></span> 35 sayida cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h+='</div>';
        }

        if(pc8.length>0){
          h+='<div class="lbl">KESIN CIKACAK 8 SAYI \u2014 <span style="color:#a855f7;font-weight:900">'+c8fm+'/8 tuttu (35 sayida)</span></div>';
          h+='<div class="nr">';
          pc8.forEach(function(num){
            var inIlk5=af5.indexOf(num)!==-1;
            var inFull=aAll.indexOf(num)!==-1;
            var bg=inIlk5?'#14532d':inFull?'#1a3a2a':'#2a3040';
            var brd=inIlk5?'#22c55e':inFull?'#16a34a':'#4a5270';
            var cl=inIlk5?'#22c55e':inFull?'#4ade80':'#aab0c4';
            h+='<div class="nb" style="background:'+bg+';border:1px solid '+brd+';color:'+cl+'">'+num+'</div>';
          });
          h+='</div>';
          h+='<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#14532d;border:1px solid #22c55e;vertical-align:middle"></span> Ilk5\'te cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1a3a2a;border:1px solid #16a34a;vertical-align:middle"></span> 35 sayida cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h+='</div>';
        }

        h+='<div class="mi">';
        h+='<div class="mc">Kesin 6 \u2192 35 sayi: <strong style="color:'+(c6m>=5?'#22c55e':c6m>=4?'#facc15':'#aab0c4')+'">'+c6m+'/6</strong></div>';
        h+='<div class="mc">Kesin 7 \u2192 35 sayi: <strong style="color:#d4a843">'+c7m+'/7</strong></div>';
        h+='<div class="mc">Kesin 8 \u2192 35 sayi: <strong style="color:'+(c8fm>=6?'#22c55e':c8fm>=4?'#facc15':'#aab0c4')+'">'+c8fm+'/8</strong></div>';
        h+='</div></div>';
      });

      h+='</body></html>';
      res.type('html'); res.end(h);
    }).catch(function(e){ res.status(500).send('Rapor hatasi: '+e.message); });
  });

  app.get('/', function(req, res) {
    var h='<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WingoOracle</title>';
    h+='<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:520px;margin:0 auto}';
    h+='h1{font-size:22px;text-align:center;font-weight:800;letter-spacing:2px;margin-bottom:14px}';
    h+='.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    h+='.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    h+='.over{color:#22c55e;font-weight:800}.under{color:#ef4444;font-weight:800}';
    h+='.big{font-size:34px;font-weight:900;margin:4px 0}.conf{font-size:13px;color:#aab0c4;margin-top:3px;font-weight:600}';
    h+='.si{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;font-weight:700}';
    h+='.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}';
    h+='.num{border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff}';
    h+='.row{display:grid;grid-template-columns:60px 38px 90px 60px 30px;align-items:center;padding:6px 0;border-bottom:1px solid #2a2f42;font-size:12px}.row:last-child{border:none}';
    h+='.bar{height:7px;background:#3a3f52;border-radius:4px;margin:8px 0;overflow:hidden}.bf{height:100%;border-radius:4px}';
    h+='.str{display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-bottom:4px}';
    h+='.cb{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:20px;font-size:12px;margin:3px;font-weight:800;color:#fff}';
    h+='.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px;text-decoration:none;text-align:center}';
    h+='.ref{color:#5a6180;font-size:11px;text-align:center;margin-top:10px}';
    h+='.hdr{display:grid;grid-template-columns:60px 38px 90px 60px 30px;padding:4px 0;font-size:10px;color:#5a6180;font-weight:600;border-bottom:1px solid #3a3f52;margin-bottom:4px}';
    h+='</style></head><body>';
    h+='<h1>WINGO ORACLE</h1>';
    h+='<a class="btn" href="/rapor">RAPOR</a>';
    h+='<div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
    h+='<script>var CH='+CH+';';
    h+='function load(){var x=new XMLHttpRequest();x.open("GET","/data");x.onload=function(){try{var d=JSON.parse(x.responseText);';
    h+='if(d.error){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>Hata: "+d.error+"</div>";return;}';
    h+='var pr=d.predictions;var h="";';
    h+='if(pr&&pr.over_under){var ou=pr.over_under;var oc=ou.pred==="OVER"?"#22c55e":"#ef4444";';
    h+='var bc=ou.pred==="OVER"?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)";';
    h+='var rno=(d.last200&&d.last200.length>0)?(d.last200[0].round+1):"?";';
    h+='h+="<div class=\'card\' style=\'border-color:"+bc+"\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Round "+rno+" - Over / Under</span>";';
    h+='var ouState=ou.state||"";';
    h+='var ouBadgeColor=ouState.indexOf("REVERSAL")>=0?"#ef4444":ouState.indexOf("OVER")>=0?"#22c55e":ouState.indexOf("UNDER")>=0?"#ef4444":ouState.indexOf("MS_SIGNAL")>=0?"#a855f7":ouState.indexOf("ILK")>=0?"#f97316":"#5a6180";';
    h+='var ouBadgeLabel=ouState.indexOf("REVERSAL")>=0?"SER\u0130 KIRILDI":ouState.indexOf("TREND_OVER")>=0?"TREND OVER":ouState.indexOf("TREND_UNDER")>=0?"TREND UNDER":ouState.indexOf("MS_SIGNAL")>=0?"MS S\u0130NYAL":ouState.indexOf("ILK")>=0?"RENK S\u0130NYAL":"BALANCED";';
    h+='h+="<span style=\'font-size:9px;color:"+ouBadgeColor+";font-weight:800;padding:2px 6px;border:1px solid "+ouBadgeColor+";border-radius:4px\'>"+ouBadgeLabel+"</span></div>";';
    h+='h+="<div class=\'big\' style=\'color:"+oc+"\'>"+ou.pred+"</div><div class=\'conf\'>Guven: %"+ou.conf+"</div>";';
    h+='if(ou.streak){var sc=ou.streak.count>=7?"#ef4444":ou.streak.count>=5?"#f97316":ou.streak.count>=3?"#facc15":"#aab0c4";';
    h+='var sbg=ou.streak.count>=7?"rgba(239,68,68,0.15)":ou.streak.count>=5?"rgba(249,115,22,0.15)":ou.streak.count>=3?"rgba(250,204,21,0.1)":"rgba(255,255,255,0.05)";';
    h+='h+="<div class=\'si\' style=\'background:"+sbg+";color:"+sc+";border:1px solid "+sc+"44\'>Mevcut Seri: "+ou.streak.type+" "+ou.streak.count+"x</div>";}';
    h+='h+="</div>";}else{h+="<div class=\'card\'><div class=\'title\'>Tahmin</div><div style=\'color:#facc15;padding:10px\'>Tahmin hesaplaniyor...</div></div>";}';
    h+='if(pr&&pr.color){var cl=pr.color;var pc=CH[cl.pred]||"#fff";';
    h+='h+="<div class=\'card\' style=\'border-color:"+pc+"66\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Renk Tahmini</span>";';
    h+='var clState=cl.state||"";';
    h+='var clBadgeColor=cl.conf>=60?"#22c55e":cl.conf>=45?"#facc15":"#ef4444";';
    h+='var clBadgeLabel=cl.conf>=60?"G\u00dcCL\u00dc":cl.conf>=45?"ORTA":"ZAYIF";';
    h+='h+="<span style=\'font-size:9px;color:"+clBadgeColor+";font-weight:800;padding:2px 6px;border:1px solid "+clBadgeColor+";border-radius:4px\'>"+clBadgeLabel+"</span></div>";';
    h+='h+="<div class=\'big\' style=\'color:"+pc+"\'>"+cl.pred+"</div><div class=\'conf\'>Guven: %"+cl.conf+"</div>";';
    h+='if(cl.maxWait>=25){var mwc=cl.maxWait>=35?"#f97316":"#facc15";var mwlbl=cl.maxWait>=35?"ASIRI GECIKTI":"GECIKIYOR";h+="<div style=\'margin-top:8px;padding:5px 10px;background:#1a1f2e;border-radius:6px;border:1px solid "+mwc+"44\'><span style=\'color:"+mwc+";font-size:11px;font-weight:700\'>\u26a0 "+cl.maxWaitColor+": "+cl.maxWait+" TURDUR GELMIYOR - "+mwlbl+"</span></div>";}';
    h+='["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"].forEach(function(cn){';
    h+='var cnt=(cl.counts&&cl.counts[cn])||0;var bg=CH[cn]||"#333";';
    h+='var op=cnt<=(200/8)*0.5?1:cnt<=(200/8)*0.8?0.65:0.3;';
    h+='h+="<span class=\'cb\' style=\'background:"+bg+";opacity:"+op+"\'>"+cn+" "+cnt+"</span>";});';
    h+='h+="</div></div></div>";}';
    h+='if(pr&&pr.first_candidates&&pr.first_candidates.length>0){';
    h+='var fcr=pr.firstColorReliable;';
    h+='var fcrColor=fcr?"#22c55e":"#ef4444";';
    h+='var fcrLabel=fcr?"GUVENILIR":"ZAYIF";';
    h+='h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Ilk Sayi - 5 Aday</span><span style=\'font-size:9px;color:"+fcrColor+";font-weight:800;padding:2px 6px;border:1px solid "+fcrColor+";border-radius:4px\'>"+fcrLabel+"</span></div><div class=\'nums\'>";';
    h+='pr.first_candidates.forEach(function(n){h+="<div class=\'num\' style=\'background:#1e3a5f;border:2px solid #3b82f6\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(pr&&pr.certain6&&pr.certain6.length>0){';
    h+='var sig=pr.signals||{};';
    h+='var c6b=sig.siyahFull?"#00ff88":sig.badMs66?"#ef4444":(sig.sig66>=2||sig.c6strong)?"#22c55e":sig.sig66>=1?"#facc15":"#5a6180";';
    h+='var c6l=sig.siyahFull?"SIYAH FULL":sig.badMs66?"ZAYIF":sig.sig66>=2?"COK GUCLU":sig.sig66>=1||sig.c6strong?"GUCLU":"NORMAL";';
    h+='h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Kesin Cikacak - 6 Sayi</span><span style=\'font-size:9px;color:"+c6b+";font-weight:800;padding:2px 6px;border:1px solid "+c6b+";border-radius:4px\'>"+c6l+"</span></div><div class=\'nums\'>";';
    h+='pr.certain6.forEach(function(n){h+="<div class=\'num\' style=\'background:#0c2a3a;border:2px solid #38bdf8\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(pr&&pr.certain7&&pr.certain7.length>0){';
    h+='var sig7=pr.signals||{};';
    h+='var c7b=(sig7.badMs77||sig7.c7weak)?"#ef4444":(sig7.sig77>=2||sig7.c7strong)?"#22c55e":sig7.sig77>=1?"#facc15":"#5a6180";';
    h+='var c7l=(sig7.badMs77||sig7.c7weak)?"ZAYIF":sig7.sig77>=2?"COK GUCLU":sig7.sig77>=1||sig7.c7strong?"GUCLU":"NORMAL";';
    h+='h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Kesin Cikacak - 7 Sayi</span><span style=\'font-size:9px;color:"+c7b+";font-weight:800;padding:2px 6px;border:1px solid "+c7b+";border-radius:4px\'>"+c7l+"</span></div><div class=\'nums\'>";';
    h+='pr.certain7.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a2000;border:1px solid #d4a843;color:#d4a843\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(pr&&pr.certain8&&pr.certain8.length>0){';
    h+='var sig8=pr.signals||{};';
    h+='var c8b=(sig8.badMs88||sig8.weakPeriod)?"#ef4444":(sig8.sig88>=2||sig8.c8strong)?"#22c55e":sig8.sig88>=1?"#facc15":"#5a6180";';
    h+='var c8l=sig8.weakPeriod?"ZAYIF DONEM":sig8.badMs88?"ZAYIF":sig8.sig88>=2?"COK GUCLU":sig8.sig88>=1||sig8.c8strong?"GUCLU":"NORMAL";';
    h+='h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Kesin Cikacak - 8 Sayi</span><span style=\'font-size:9px;color:"+c8b+";font-weight:800;padding:2px 6px;border:1px solid "+c8b+";border-radius:4px\'>"+c8l+"</span></div><div class=\'nums\'>";';
    h+='pr.certain8.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a3040;border:1px solid #a855f7\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(d.stats){h+="<div class=\'card\'><div class=\'title\'>Istatistik ("+d.stats.total+" Round)</div>";';
    h+='h+="<div class=\'str\'><span class=\'over\'>OVER %"+d.stats.over_pct+"</span><span class=\'under\'>UNDER %"+d.stats.under_pct+"</span></div>";';
    h+='h+="<div class=\'bar\'><div class=\'bf\' style=\'width:"+d.stats.over_pct+"%;background:#22c55e\'></div></div></div>";}';
    h+='if(d.last200&&d.last200.length>0){h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px\'><span class=\'title\' style=\'margin-bottom:0\'>Son 200 Cekilis</span><a href=\'/draws.json\' style=\'font-size:10px;color:#aab0c4;background:#2a2f42;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:700;border:1px solid #3a3f52\'>JSON &#8595;</a><a href=\'/predictions.json\' style=\'font-size:10px;color:#aab0c4;background:#2a2f42;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:700;border:1px solid #3a3f52;margin-left:6px\'>SONUCLAR &#8595;</a></div>";';
    h+='h+="<div class=\'hdr\'><span>Round</span><span>1.S</span><span>Renk</span><span>O/U</span><span>Seri</span></div>";';
    h+='for(var i=0;i<d.last200.length;i++){var r=d.last200[i];';
    h+='var oc2=r.over_under==="OVER"?"#22c55e":"#ef4444";var rc=CH[r.color]||"#aaa";var streak=1;';
    h+='for(var j=i+1;j<d.last200.length;j++){if(d.last200[j].over_under===r.over_under)streak++;else break;}';
    h+='var sc2=streak>=7?"#ef4444":streak>=5?"#f97316":streak>=3?"#facc15":"#5a6180";';
    h+='h+="<div class=\'row\'><span style=\'color:#aab0c4;font-size:11px\'>"+r.round+"</span>";';
    h+='h+="<span style=\'font-weight:900;font-size:14px\'>"+r.first+"</span>";';
    h+='h+="<span style=\'color:"+rc+";font-weight:700\'>"+r.color+"</span>";';
    h+='h+="<span style=\'color:"+oc2+";font-weight:900\'>"+r.over_under+"</span>";';
    h+='h+="<span style=\'color:"+sc2+";font-weight:800;font-size:11px\'>"+streak+"x</span></div>";}';
    h+='h+="</div>";}';
    h+='h+="<div class=\'ref\'>Her 30 saniyede bir guncellenir</div>";';
    h+='document.getElementById("app").innerHTML=h;';
    h+='}catch(e){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>Hata: "+e.message+"</div>";}};';
    h+='x.onerror=function(){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>/data hatasi</div>";};';
    h+='x.send();}load();setInterval(load,30000);';
    h+='</script></body></html>';
    res.type('html'); res.end(h);
  });

  app.listen(process.env.PORT || 3000, '0.0.0.0', function(){ console.log('Dashboard: http://localhost:3000'); });
}

console.log('Basliyor...');
