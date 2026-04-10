var WebSocket = require('ws');
var https = require('https');
var express = require('express');
var cors = require('cors');
var { Client } = require('pg');

var DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:LqxXVFqCIrOqDMmNmsSSOvCGLUkvEtsL@junction.proxy.rlwy.net:43663/railway';

var colors = {1:'Sari',9:'Sari',17:'Sari',25:'Sari',33:'Sari',41:'Sari',2:'Yesil',10:'Yesil',18:'Yesil',26:'Yesil',34:'Yesil',42:'Yesil',3:'Mavi',11:'Mavi',19:'Mavi',27:'Mavi',35:'Mavi',43:'Mavi',4:'Kirmizi',12:'Kirmizi',20:'Kirmizi',28:'Kirmizi',36:'Kirmizi',44:'Kirmizi',5:'Kahve',13:'Kahve',21:'Kahve',29:'Kahve',37:'Kahve',45:'Kahve',6:'Turuncu',14:'Turuncu',22:'Turuncu',30:'Turuncu',38:'Turuncu',46:'Turuncu',7:'Siyah',15:'Siyah',23:'Siyah',31:'Siyah',39:'Siyah',47:'Siyah',8:'Mor',16:'Mor',24:'Mor',32:'Mor',40:'Mor',48:'Mor'};
var ALL_COLORS = ['Sari','Yesil','Mavi','Kirmizi','Kahve','Turuncu','Siyah','Mor'];
var COLOR_HEX = {'Sari':'#facc15','Yesil':'#22c55e','Mavi':'#3b82f6','Kirmizi':'#ef4444','Kahve':'#d97706','Turuncu':'#f97316','Siyah':'#9ca3af','Mor':'#a855f7'};

var db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
var lastProcessedWsRound = -1;
var globalPredCache = {};

process.on('uncaughtException', function(e) { console.log('KRITIK HATA:', e.message, e.stack); });
process.on('unhandledRejection', function(e) { console.log('PROMISE HATASI:', e && e.message ? e.message : e); });

db.connect().then(function() {
  console.log('DB baglandi!');
  return db.query('CREATE TABLE IF NOT EXISTS draws (id SERIAL PRIMARY KEY, round INT UNIQUE, first INT, over_under VARCHAR(5), color VARCHAR(20), all_numbers TEXT, created_at TIMESTAMP DEFAULT NOW())');
}).then(function() {
  return db.query('CREATE TABLE IF NOT EXISTS predictions (id SERIAL PRIMARY KEY, round INT UNIQUE, pred_ou VARCHAR(5), pred_color VARCHAR(20), pred_first TEXT, pred_first5 TEXT, pred_certain8 TEXT, pred_certain6 TEXT, actual_first INT, actual_first5 TEXT, actual_color VARCHAR(20), actual_ou VARCHAR(5), ou_hit SMALLINT DEFAULT -1, color_hit SMALLINT DEFAULT -1, first_hit SMALLINT DEFAULT -1, first5_hit SMALLINT DEFAULT -1, certain8_hit SMALLINT DEFAULT -1, first5_match INT DEFAULT -1, certain8_match INT DEFAULT -1, certain8_full_match INT DEFAULT -1, certain6_match INT DEFAULT -1, created_at TIMESTAMP DEFAULT NOW())');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_first5 TEXT');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS first5_match INT DEFAULT -1');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_match INT DEFAULT -1');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_full_match INT DEFAULT -1');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_certain6 TEXT');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain6_match INT DEFAULT -1');
}).then(function() {
  console.log('Tablolar hazir!');
  return loadCacheFromDB();
}).then(function() {
  return backfillCertain6();
}).then(function() {
  connect();
  startDashboard();
}).catch(function(e) { console.log('DB hatasi:', e.message); });

function backfillCertain6() {
  return db.query(
    "SELECT p.id, p.pred_certain6, d.all_numbers FROM predictions p LEFT JOIN draws d ON p.round = d.round WHERE p.ou_hit != -1 AND p.pred_certain6 IS NOT NULL AND p.pred_certain6 != '' AND d.all_numbers IS NOT NULL"
  ).then(function(res) {
    if (res.rows.length === 0) { console.log('Backfill: guncellenecek kayit yok.'); return; }
    console.log('Backfill: ' + res.rows.length + ' kayit certain6_match guncelleniyor...');
    var promises = res.rows.map(function(row) {
      var pc6 = row.pred_certain6.split(',').map(Number);
      var aAll = row.all_numbers.split(',').map(Number);
      var c6Match = aAll.filter(function(n) { return pc6.indexOf(n) !== -1; }).length;
      return db.query('UPDATE predictions SET certain6_match=$1 WHERE id=$2', [c6Match, row.id]);
    });
    return Promise.all(promises).then(function() { console.log('Backfill tamamlandi.'); });
  }).catch(function(e) { console.log('Backfill hatasi:', e.message); });
}

function loadCacheFromDB() {
  return db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round DESC LIMIT 200')
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
                  var first = parseInt(a.ballNumbers[0]);
                  var first5 = a.ballNumbers.slice(0, 5).map(Number);
                  var allNums = a.ballNumbers.map(Number);
                  var ou = first > 24 ? 'OVER' : 'UNDER';
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

function saveDraw(round, first, first5, allNums, ou, renk, allNumsStr) {
  db.query(
    'INSERT INTO draws (round, first, over_under, color, all_numbers) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (round) DO NOTHING RETURNING id',
    [round, first, ou, renk, allNumsStr]
  ).then(function(ins) {
    if (ins.rows.length === 0) {
      console.log('Round ' + round + ' zaten var - tahmin guncelleniyor...');
    } else {
      console.log('Draw kaydedildi: Round ' + round);
    }
    // Once saveNextPrediction (certain6 yazar), sonra updatePredictions (certain6 okur)
    saveNextPrediction(round, function() {
      updatePredictions(round, first, first5, allNums, ou, renk);
    });
  }).catch(function(e) { console.log('Draw hatasi:', e.message); });
}

function updatePredictions(round, first, first5, allNums, ou, renk) {
  db.query('SELECT id, pred_ou, pred_color, pred_first, pred_first5, pred_certain8, pred_certain6 FROM predictions WHERE round = $1', [round])
  .then(function(res) {
    if (res.rows.length === 0) { console.log('Round ' + round + ' icin bekleyen tahmin yok.'); return; }
    res.rows.forEach(function(row) {
      var ouHit       = row.pred_ou    === ou   ? 1 : 0;
      var colorHit    = row.pred_color === renk ? 1 : 0;
      var pf          = row.pred_first    ? row.pred_first.split(',').map(Number)    : [];
      var pf5         = row.pred_first5   ? row.pred_first5.split(',').map(Number)   : [];
      var pc8         = row.pred_certain8 ? row.pred_certain8.split(',').map(Number) : [];
      var pc6         = row.pred_certain6 ? row.pred_certain6.split(',').map(Number) : [];
      var firstHit    = pf.indexOf(first)  !== -1 ? 1 : 0;
      var f5Hit       = pf5.indexOf(first) !== -1 ? 1 : 0;
      var c8Hit       = pc8.indexOf(first) !== -1 ? 1 : 0;
      var f5Match     = first5.filter(function(n) { return pf5.indexOf(n) !== -1; }).length;
      var c8Match     = first5.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      var c8FullMatch = allNums.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      var c6Match     = pc6.length > 0 ? allNums.filter(function(n) { return pc6.indexOf(n) !== -1; }).length : -1;
      db.query(
        'UPDATE predictions SET actual_first=$1,actual_first5=$2,actual_color=$3,actual_ou=$4,ou_hit=$5,color_hit=$6,first_hit=$7,first5_hit=$8,certain8_hit=$9,first5_match=$10,certain8_match=$11,certain8_full_match=$12,certain6_match=$13 WHERE id=$14',
        [first, first5.join(','), renk, ou, ouHit, colorHit, firstHit, f5Hit, c8Hit, f5Match, c8Match, c8FullMatch, c6Match, row.id]
      ).then(function() {
        console.log('>>> Round ' + round + ' | OU:' + (ouHit?'TUTTU':'KACTI') + ' | Renk:' + (colorHit?'TUTTU':'KACTI') + ' | C6:' + c6Match + '/6 | C8:' + c8FullMatch + '/8');
      }).catch(function(e) { console.log('Update hatasi:', e.message); });
    });
  }).catch(function(e) { console.log('UpdatePred hatasi:', e.message); });
}

function saveNextPrediction(round, callback) {
  db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round DESC LIMIT 200')
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
      'INSERT INTO predictions (round,pred_ou,pred_color,pred_first,pred_first5,pred_certain8,pred_certain6) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (round) DO UPDATE SET pred_ou=$2,pred_color=$3,pred_first=$4,pred_first5=$5,pred_certain8=$6,pred_certain6=$7 WHERE predictions.ou_hit=-1',
      [nextRound,
       pred.over_under.pred,
       pred.color ? pred.color.pred : '',
       pred.first_candidates  ? pred.first_candidates.join(',')  : '',
       pred.first5_candidates ? pred.first5_candidates.join(',') : '',
       pred.certain8          ? pred.certain8.join(',')          : '',
       pred.certain6          ? pred.certain6.join(',')          : '']
    ).then(function() { console.log('Tahmin kaydedildi: Round ' + nextRound); if (callback) callback(); })
     .catch(function(e) { console.log('SavePred hatasi:', e.message); if (callback) callback(); });
  }).catch(function(e) { console.log('SaveNextPred hatasi:', e.message); });
}

// ════════════════════════════════════════════════════════════
// TAHMİN MOTORU
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

  // ── MS HAVUZU: 1337 çekiliş analizi ──
  // Her ms grubunun ilk sayı havuzu (test: %14.3 isabet vs rastgele %10.4)
  var MS_FIRST_POOL = {
    948:[14,8,5,30,15], 949:[21,19,10,29,48], 950:[6,5,35,29,34],
    951:[48,19,10,13,40], 952:[20,7,5,21,33], 953:[32,21,2,22,38],
    954:[38,17,18,40,39], 955:[43,5,1,31,47], 956:[22,48,27,29,39],
    957:[15,24,8,12,18], 958:[15,27,42,1,38], 959:[29,37,26,18,38],
    960:[12,42,38,30,10], 961:[48,36,33,44,30], 962:[29,30,23,39,41],
    963:[17,27,29,37,46], 964:[27,7,21,32,5], 965:[34,29,9,23,35]
  };
  // Ms → OU sinyali (güçlü olanlar: ms=957 %77 UNDER, ms=961 %70 OVER)
  var MS_OU_SIGNAL = {
    948:'UNDER', 949:'UNDER', 957:'UNDER',
    950:'OVER', 951:'OVER', 961:'OVER', 962:'OVER', 965:'OVER'
  };

  // Son çekilişin ms değerini çıkar
  var lastMs = -1;
  var predMs = -1;
  if (draws[0] && draws[0].created_at) {
    try {
      var tsStr = draws[0].created_at.toString();
      var msPart = tsStr.split('.')[1];
      if (msPart) lastMs = parseInt(msPart.replace('Z','').substring(0,3));
    } catch(e) {}
  }
  // Ms geçiş tablosu: önceki ms → sonraki ms tahmini
  var msTrans = {};
  draws.forEach(function(d) {
    if (!d.created_at) return;
    try {
      var msPart = d.created_at.toString().split('.')[1];
      if (msPart) {
        var ms = parseInt(msPart.replace('Z','').substring(0,3));
        if (!msTrans[ms]) msTrans[ms] = {};
        msTrans[ms][ms] = (msTrans[ms][ms] || 0) + 1; // placeholder
      }
    } catch(e) {}
  });
  // Gerçek geçiş: draws DESC sırada, [0]=en son
  for (var msi = 0; msi < draws.length - 1; msi++) {
    if (!draws[msi].created_at || !draws[msi+1].created_at) continue;
    try {
      var msA = parseInt(draws[msi+1].created_at.toString().split('.')[1].replace('Z','').substring(0,3)); // önceki
      var msB = parseInt(draws[msi].created_at.toString().split('.')[1].replace('Z','').substring(0,3));   // sonraki
      if (!msTrans[msA]) msTrans[msA] = {};
      msTrans[msA][msB] = (msTrans[msA][msB] || 0) + 1;
    } catch(e) {}
  }
  // Bir sonraki ms tahmini
  if (lastMs >= 0 && msTrans[lastMs]) {
    var bestCnt = 0;
    Object.keys(msTrans[lastMs]).forEach(function(ms) {
      if (msTrans[lastMs][ms] > bestCnt) { bestCnt = msTrans[lastMs][ms]; predMs = parseInt(ms); }
    });
  }

  // ── OVER/UNDER: SERİ BAZLI + DÖNEM EĞİLİMİ + MS SİNYALİ ──
  var streakOU = calcStreakOU(ouList);
  var predOU, ouConf, state = 'BALANCED';

  // Son 10 ve 20 çekilişin OVER oranı (dönem eğilimi)
  var ov10 = ouList.slice(0, Math.min(10, n)).filter(function(x) { return x === 'OVER'; }).length;
  var ov20 = ouList.slice(0, Math.min(20, n)).filter(function(x) { return x === 'OVER'; }).length;
  var pct10 = ov10 / Math.min(10, n); // son 10'daki OVER oranı
  var pct20 = ov20 / Math.min(20, n); // son 20'deki OVER oranı
  // Dönem eğilimi: son 10 ağırlıklı
  var trendPct = pct10 * 0.6 + pct20 * 0.4;
  // trendPct < 0.42 → UNDER dönemi, > 0.58 → OVER dönemi

  if (streakOU.count >= 7) {
    predOU = streakOU.type === 'OVER' ? 'UNDER' : 'OVER'; ouConf = 92; state = 'REVERSAL';
  } else if (streakOU.count >= 5) {
    predOU = streakOU.type === 'OVER' ? 'UNDER' : 'OVER'; ouConf = 84; state = 'REVERSAL';
  } else if (streakOU.count === 4) {
    predOU = streakOU.type === 'OVER' ? 'UNDER' : 'OVER'; ouConf = 78; state = 'REVERSAL';
  } else if (streakOU.count === 3) {
    // 3x seride dönem eğilimi de dikkate al
    if (trendPct > 0.60) predOU = 'UNDER';
    else if (trendPct < 0.40) predOU = 'OVER';
    else predOU = streakOU.type === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 62; state = 'WARNING';
  } else {
    // 1-2x seri: dönem eğilimini esas al
    if (trendPct < 0.38) {
      // Güçlü UNDER dönemi
      predOU = 'UNDER'; ouConf = 65; state = 'TREND_UNDER';
    } else if (trendPct > 0.62) {
      // Güçlü OVER dönemi
      predOU = 'OVER'; ouConf = 65; state = 'TREND_OVER';
    } else if (predMs >= 0 && MS_OU_SIGNAL[predMs]) {
      // Dönem nötr → ms sinyali
      predOU = MS_OU_SIGNAL[predMs];
      ouConf = 60; state = 'MS_SIGNAL';
    } else if (trendPct < 0.45) {
      // Hafif UNDER eğilimi
      predOU = 'UNDER'; ouConf = 55; state = 'SLIGHT_UNDER';
    } else if (trendPct > 0.55) {
      // Hafif OVER eğilimi
      predOU = 'OVER'; ouConf = 55; state = 'SLIGHT_OVER';
    } else {
      // Tam denge: son serinin tersine git
      predOU = streakOU.type === 'OVER' ? 'UNDER' : 'OVER';
      ouConf = 52; state = 'BALANCED';
    }
  }
  result.over_under = { pred: predOU, conf: ouConf, streak: streakOU, state: state, predMs: predMs, trendPct: Math.round(trendPct*100) };

  // ── RENK: MARKOV + SOĞUKLUK (son 200 baz) ──
  var colorCounts = {}; ALL_COLORS.forEach(function(c) { colorCounts[c] = 0; });
  colorList.slice(0, Math.min(200, n)).forEach(function(c) { if (colorCounts[c] !== undefined) colorCounts[c]++; });

  var colorLastSeen = {}; ALL_COLORS.forEach(function(c) { colorLastSeen[c] = 999; });
  colorList.forEach(function(c, ci) { if (colorLastSeen[c] === 999) colorLastSeen[c] = ci; });

  var colorMarkov = {};
  for (var cmi = 0; cmi < n - 1; cmi++) {
    var c2 = colorList[cmi]; var nx = colorList[cmi + 1];
    if (!colorMarkov[c2]) colorMarkov[c2] = {};
    colorMarkov[c2][nx] = (colorMarkov[c2][nx] || 0) + 1;
  }
  var lastColor = colorList[0];
  var markovCS = {};
  ALL_COLORS.forEach(function(c) {
    if (colorMarkov[lastColor]) {
      var tot = Object.keys(colorMarkov[lastColor]).reduce(function(a, k) { return a + colorMarkov[lastColor][k]; }, 0);
      markovCS[c] = tot > 0 ? (colorMarkov[lastColor][c] || 0) / tot * 100 : 0;
    } else { markovCS[c] = 0; }
  });

  var cc30 = {}; ALL_COLORS.forEach(function(c) { cc30[c] = 0; });
  colorList.slice(0, Math.min(30, n)).forEach(function(c) { if (cc30[c] !== undefined) cc30[c]++; });
  var coldColors = ALL_COLORS.filter(function(c) { return cc30[c] === 0; });

  var cs = {};
  ALL_COLORS.forEach(function(c) {
    cs[c] = Math.max(0, 25 - colorCounts[c]) * 3 + Math.min(colorLastSeen[c], 50) * 1.5 + markovCS[c] * 2.5;
  });
  var predColor = coldColors.length > 0
    ? coldColors.sort(function(a, b) { return colorLastSeen[b] - colorLastSeen[a]; })[0]
    : ALL_COLORS.slice().sort(function(a, b) { return cs[b] - cs[a]; })[0];
  var colorConf = coldColors.length >= 3 ? 68 : coldColors.length === 2 ? 55 : 42;
  result.color = { pred: predColor, conf: colorConf, counts: colorCounts, state: state };

  // ── İLK SAYI: FREKANS + SON GÖRÜLME + MARKOV + MS HAVUZU ──
  var firstFreq = {}; for (var i = 1; i <= 48; i++) firstFreq[i] = 0;
  firstNums.forEach(function(num, idx) { firstFreq[num] += Math.exp(-0.03 * idx); });

  var firstLS = {}; for (var i = 1; i <= 48; i++) firstLS[i] = 999;
  firstNums.forEach(function(num, idx) { if (firstLS[num] === 999) firstLS[num] = idx; });

  var numMk = {};
  for (var mi = 0; mi < n - 1; mi++) {
    var pa = firstNums[mi]; var pb = firstNums[mi + 1];
    if (!numMk[pa]) numMk[pa] = {};
    numMk[pa][pb] = (numMk[pa][pb] || 0) + 1;
  }
  var lastNum = firstNums[0];
  var nmScore = {};
  for (var i = 1; i <= 48; i++) {
    if (numMk[lastNum]) {
      var t2 = Object.keys(numMk[lastNum]).reduce(function(a, k) { return a + numMk[lastNum][k]; }, 0);
      nmScore[i] = t2 > 0 ? (numMk[lastNum][i] || 0) / t2 * 100 : 0;
    } else { nmScore[i] = 0; }
  }

  // Ms ilk sayı havuzu bonusu (test: %14.3 vs rastgele %10.4)
  var msBonus = {}; for (var i = 1; i <= 48; i++) msBonus[i] = 0;
  if (predMs >= 0 && MS_FIRST_POOL[predMs]) {
    MS_FIRST_POOL[predMs].forEach(function(num, rank) {
      msBonus[num] = (5 - rank) * 8; // 1.sıra=40, 5.sıra=8 puan
    });
  }

  var rec20 = firstNums.slice(0, Math.min(20, n));
  var maxFq = Math.max.apply(null, Object.keys(firstFreq).map(function(k) { return firstFreq[k]; })) || 1;
  var ns = {};
  for (var i = 1; i <= 48; i++) {
    ns[i] = firstFreq[i] / maxFq * 100 * 0.25   // frekans
           + Math.min(firstLS[i], 30) / 30 * 100 * 0.25  // son görülme
           + (rec20.indexOf(i) === -1 ? 25 : 0) * 0.20   // soğukluk
           + nmScore[i] * 0.15                            // markov
           + msBonus[i] * 0.15;                           // ms havuzu bonusu
  }
  var allC = []; for (var i = 1; i <= 48; i++) allC.push(i);
  allC.sort(function(a, b) { return ns[b] - ns[a]; });
  var filtC = allC.filter(function(x) { return predOU === 'OVER' ? x > 24 : x <= 24; });
  if (filtC.length < 5) filtC = allC;
  result.first_candidates  = filtC.slice(0, 5).sort(function(a, b) { return a - b; });
  result.first5_candidates = filtC.slice(0, 6).sort(function(a, b) { return a - b; });

  // ── TEKRAR ORANLARI: 1362 çekiliş analizi ──
  var REPEAT_RATE = {1:0.7358,2:0.7703,3:0.7333,4:0.7162,5:0.7092,6:0.7168,7:0.7476,8:0.7341,9:0.7186,10:0.6950,11:0.7275,12:0.7245,13:0.7127,14:0.7331,15:0.7357,16:0.7072,17:0.7464,18:0.7054,19:0.7360,20:0.7104,21:0.7324,22:0.7400,23:0.7299,24:0.7569,25:0.7583,26:0.7304,27:0.7252,28:0.6969,29:0.7300,30:0.7470,31:0.7027,32:0.7411,33:0.7605,34:0.7024,35:0.7213,36:0.7437,37:0.7159,38:0.7512,39:0.7447,40:0.7250,41:0.7222,42:0.7353,43:0.7244,44:0.7183,45:0.7289,46:0.7387,47:0.7440,48:0.7098};

  // ── RENK SONRASI İLK SAYI HAVUZU: 1362 çekiliş ──
  var COLOR_FIRST_POOL = {
    'Sari':    [19,21,12,15,30],
    'Yesil':   [6,29,32,12,25],
    'Mavi':    [39,20,42,35,16],
    'Kirmizi': [7,2,42,47,30],
    'Kahve':   [45,25,47,31,21],
    'Turuncu': [24,13,5,36,43],
    'Siyah':   [38,31,18,24,22],
    'Mor':     [27,41,25,43,26]
  };

  // ── SİNYAL TESPİTİ: 1362 çekiliş analizinden ──
  var MS_66_SIGNAL = {964:28.0, 949:21.4, 953:19.2, 961:21.7};
  var MS_88_SIGNAL = {964:14.0, 961:13.0, 949:12.2};
  var MS_BAD_88    = {948:1, 960:1, 962:1, 965:1};

  // OU son 3 tur sinyali
  var ou3str = ouList.slice(0,Math.min(3,n)).map(function(x){return x==='OVER'?'O':'U';}).join('');
  var sig_uou = (ou3str==='UOU');
  var sig_uuu = (ou3str==='UUU');

  // Önceki renk sinyalleri
  var prevColor = colorList[0];
  var sig_siyah_prev   = (prevColor==='Siyah');
  var sig_turuncu_prev = (prevColor==='Turuncu');
  var sig_kahve_prev   = (prevColor==='Kahve');

  // Ms değişimi
  var msDiff2 = (lastMs>=0 && predMs>=0) ? (predMs-lastMs) : 999;
  var sig_ms_minus1 = (msDiff2===-1);

  // Renk ilk sayı bonusunu ms bonusuna ekle
  var colorPool = COLOR_FIRST_POOL[prevColor] || [];
  colorPool.forEach(function(num, rank) {
    msBonus[num] = (msBonus[num]||0) + (5-rank)*6;
  });

  // Güçlü sinyal sayısı
  var strongSig66=0, strongSig88=0;
  if (predMs>=0 && MS_66_SIGNAL[predMs]) strongSig66++;
  if (predMs>=0 && MS_88_SIGNAL[predMs]) strongSig88++;
  if (sig_uou)          { strongSig66++; strongSig88++; }
  if (sig_uuu)          strongSig88++;
  if (sig_siyah_prev)   { strongSig66++; strongSig88++; }
  if (sig_turuncu_prev) strongSig88++;
  if (sig_kahve_prev)   strongSig66++;
  if (sig_ms_minus1)    strongSig66++;
  var badMs88 = (predMs>=0 && MS_BAD_88[predMs]);

  // ── KESİN 6 + KESİN 8: TEKRAR ORANI + SİNYAL ──
  var prevNums = allNumsArr[0] && allNumsArr[0].length>0 ? allNumsArr[0] : [];
  var c6Scored = prevNums.slice().sort(function(a,b){return (REPEAT_RATE[b]||0.72)-(REPEAT_RATE[a]||0.72);});

  var certain6List, certain8List;

  // 2+ güçlü sinyal: son 2 çekilişin kesişimini öne al
  if (strongSig66>=2 && allNumsArr[1] && allNumsArr[1].length>0) {
    var p2      = allNumsArr[1];
    var ov6     = c6Scored.filter(function(x){return p2.indexOf(x)!==-1;});
    var re6     = c6Scored.filter(function(x){return p2.indexOf(x)===-1;});
    certain6List = ov6.concat(re6).slice(0,6);
  } else {
    certain6List = c6Scored.slice(0,6);
  }

  if (!badMs88 && strongSig88>=2 && allNumsArr[1] && allNumsArr[1].length>0) {
    var p2b     = allNumsArr[1];
    var ov8     = c6Scored.filter(function(x){return p2b.indexOf(x)!==-1;});
    var re8     = c6Scored.filter(function(x){return p2b.indexOf(x)===-1;});
    certain8List = ov8.concat(re8).slice(0,8);
  } else {
    certain8List = c6Scored.slice(0,8);
  }

  result.certain6      = certain6List.slice().sort(function(a,b){return a-b;});
  result.certain6_grpA = certain6List.slice(0,3).sort(function(a,b){return a-b;});
  result.certain8      = certain8List.slice().sort(function(a,b){return a-b;});

  result.signals = {
    predMs:predMs, lastMs:lastMs, msDiff:msDiff2,
    ou3:ou3str, prevColor:prevColor,
    sig_uou:sig_uou, sig_siyah_prev:sig_siyah_prev,
    sig_kahve_prev:sig_kahve_prev, sig_turuncu_prev:sig_turuncu_prev,
    sig_ms_minus1:sig_ms_minus1,
    strongSig66:strongSig66, strongSig88:strongSig88, badMs88:badMs88
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
    var done = false;
    var timer = setTimeout(function() { done = true; if (!res.headersSent) res.json({ error: 'Timeout' }); }, 8000);
    Promise.all([
      db.query('SELECT round,first,over_under,color,all_numbers,created_at FROM draws ORDER BY round DESC LIMIT 200'),
      db.query("SELECT COUNT(*) as total, SUM(CASE WHEN over_under='OVER' THEN 1 ELSE 0 END) as over_count FROM draws")
    ]).then(function(r) {
      clearTimeout(timer); if (done) return;
      var total = parseInt(r[1].rows[0].total) || 0;
      var oc    = parseInt(r[1].rows[0].over_count) || 0;
      var op    = total > 0 ? Math.round(oc / total * 100) : 50;
      if (!res.headersSent) res.json({ last200: r[0].rows, stats: { total: total, over_pct: op, under_pct: 100 - op }, predictions: globalPredCache });
    }).catch(function(e) { clearTimeout(timer); if (!res.headersSent) res.json({ error: e.message }); });
  });

  app.get('/draws.json', function(req, res) {
    db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round ASC')
    .then(function(result) {
      var data = result.rows.map(function(r, i) {
        return { seq: i + 1, round: r.round, first: r.first, ou: r.over_under, color: r.color, numbers: r.all_numbers, ts: r.created_at };
      });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="draws.json"');
      res.json(data);
    }).catch(function(e) { res.status(500).json({ error: e.message }); });
  });

  app.get('/rapor', function(req, res) {
    db.query('SELECT p.*,d.all_numbers as actual_all FROM predictions p LEFT JOIN draws d ON p.round=d.round WHERE p.ou_hit != -1 ORDER BY p.round DESC LIMIT 1000').then(function(result) {
      var rows = result.rows;
      var ouHit = 0, ouTotal = 0, colorHit = 0, colorTotal = 0, firstHit = 0, firstTotal = 0;
      var c6T = 0, c6S = 0, c8FT = 0, c8FS = 0;
      var c6Dist = {0:0,1:0,2:0,3:0,4:0,5:0,6:0};
      var c8fDist = {0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0};

      rows.forEach(function(r) {
        ouTotal++;    if (parseInt(r.ou_hit) === 1) ouHit++;
        colorTotal++; if (parseInt(r.color_hit) === 1) colorHit++;
        firstTotal++; if (parseInt(r.first_hit) === 1) firstHit++;
        var c6m = parseInt(r.certain6_match); if (c6m >= 0) { c6T++; c6S += c6m; c6Dist[Math.min(c6m,6)] = (c6Dist[Math.min(c6m,6)] || 0) + 1; }
        var cfm = parseInt(r.certain8_full_match); if (cfm >= 0) { c8FT++; c8FS += cfm; c8fDist[Math.min(cfm,8)] = (c8fDist[Math.min(cfm,8)] || 0) + 1; }
      });

      var ouPct    = ouTotal    > 0 ? Math.round(ouHit    / ouTotal    * 100) : 0;
      var colorPct = colorTotal > 0 ? Math.round(colorHit / colorTotal * 100) : 0;
      var firstPct = firstTotal > 0 ? Math.round(firstHit / firstTotal * 100) : 0;
      var c6avg    = c6T  > 0 ? (c6S  / c6T).toFixed(2)  : '0.00';
      var c8favg   = c8FT > 0 ? (c8FS / c8FT).toFixed(2) : '0.00';

      var h = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapor</title>';
      h += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1a1d2e;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:580px;margin:0 auto}';
      h += 'h1{font-size:20px;text-align:center;font-weight:900;letter-spacing:3px;padding:16px 0}';
      h += '.btn{display:block;width:100%;padding:13px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:12px;text-align:center;text-decoration:none}';
      h += '.st{font-size:10px;color:#5a6180;text-transform:uppercase;letter-spacing:2px;font-weight:700;padding:10px 0 8px;border-bottom:1px solid #2a2f42;margin-bottom:12px}';
      h += '.sr{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e2130}';
      h += '.sl{font-size:13px;color:#aab0c4;font-weight:600}.srr{text-align:right}';
      h += '.sp{font-size:20px;font-weight:900}.ss{font-size:11px;color:#5a6180;margin-top:2px}';
      h += '.bar{height:4px;background:#2a2f42;border-radius:2px;margin-top:5px;width:100px;overflow:hidden}.bf{height:100%;border-radius:2px}';
      h += '.ar{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e2130}';
      h += '.rc{background:#262a3a;border:1px solid #2a2f42;border-radius:12px;padding:12px;margin-bottom:10px}';
      h += '.rh{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:4px}';
      h += '.rn{font-size:12px;color:#5a6180;font-weight:700}';
      h += '.lbl{font-size:10px;color:#5a6180;text-transform:uppercase;letter-spacing:1px;margin:8px 0 4px}';
      h += '.nr{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;align-items:center}';
      h += '.nb{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0}';
      h += '.mi{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #2a2f42}';
      h += '.mc{background:#1e2130;padding:5px 10px;border-radius:8px;font-size:11px}';
      h += '.hit{color:#22c55e}.miss{color:#ef4444}';
      h += '.renk-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:800}';
      h += '</style></head><body>';

      h += '<h1>TAHMIN RAPORU</h1>';
      h += '<a class="btn" href="/">ANA SAYFA</a>';
      h += '<div class="st">Basari Ozeti (Son ' + ouTotal + ' Tahmin)</div>';

      var ouc = ouPct >= 55 ? '#22c55e' : ouPct >= 50 ? '#facc15' : '#ef4444';
      h += '<div class="sr"><div class="sl">Over/Under</div><div class="srr">';
      h += '<div class="sp" style="color:' + ouc + '">%' + ouPct + '</div><div class="ss">' + ouHit + '/' + ouTotal + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + ouPct + '%;background:' + ouc + '"></div></div></div></div>';

      var cc = colorPct >= 20 ? '#22c55e' : colorPct >= 12 ? '#facc15' : '#ef4444';
      h += '<div class="sr"><div class="sl">Renk</div><div class="srr">';
      h += '<div class="sp" style="color:' + cc + '">%' + colorPct + '</div><div class="ss">' + colorHit + '/' + colorTotal + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + Math.min(colorPct * 4, 100) + '%;background:' + cc + '"></div></div></div></div>';

      var fc = firstPct >= 15 ? '#22c55e' : firstPct >= 10 ? '#facc15' : '#ef4444';
      h += '<div class="sr"><div class="sl">Ilk Sayi (5 Aday)</div><div class="srr">';
      h += '<div class="sp" style="color:' + fc + '">%' + firstPct + '</div><div class="ss">' + firstHit + '/' + firstTotal + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + Math.min(firstPct * 4, 100) + '%;background:' + fc + '"></div></div></div></div>';

      // Kesin 6 özet + dağılım
      var c6perfect = c6Dist[6] || 0;
      var c6ppct = c6T > 0 ? Math.round(c6perfect / c6T * 100) : 0;
      var c6pc = c6ppct >= 20 ? '#22c55e' : c6ppct >= 5 ? '#facc15' : '#ef4444';
      h += '<div class="sr"><div class="sl">Kesin 6 (6/6 tuttu)</div><div class="srr">';
      h += '<div class="sp" style="color:' + c6pc + '">%' + c6ppct + '</div><div class="ss">' + c6perfect + '/' + c6T + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + Math.min(c6ppct * 4, 100) + '%;background:' + c6pc + '"></div></div></div></div>';
      // Kesin 8 (8/8 tuttu)
      var c8perfect = c8fDist[8] || 0;
      var c8ppct = c8FT > 0 ? Math.round(c8perfect / c8FT * 100) : 0;
      var c8ppc = c8ppct >= 10 ? '#22c55e' : c8ppct >= 5 ? '#facc15' : '#ef4444';
      h += '<div class="sr"><div class="sl">Kesin 8 (8/8 tuttu)</div><div class="srr">';
      h += '<div class="sp" style="color:' + c8ppc + '">%' + c8ppct + '</div><div class="ss">' + c8perfect + '/' + c8FT + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + Math.min(c8ppct * 4, 100) + '%;background:' + c8ppc + '"></div></div></div></div>';
      h += '<div class="ar"><div class="sl">Kesin 6 \u2192 35 sayida kac tuttu (ort.)</div>';
      h += '<div style="font-size:16px;font-weight:900;color:#a855f7">' + c6avg + ' / 6</div></div>';
      h += '<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">KESIN 6 DAGILIMI (35 SAYI)</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
      for (var _i = 0; _i <= 6; _i++) {
        var _c = _i >= 5 ? '#22c55e' : _i >= 4 ? '#facc15' : '#ef4444';
        var _b = _i >= 5 ? '#22c55e44' : _i >= 4 ? '#facc1544' : '#2a2f42';
        h += '<div style="background:#1e2130;border:1px solid ' + _b + ';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">' + _i + '/6: </span><span style="color:' + _c + ';font-weight:800">' + (c6Dist[_i] || 0) + 'x</span></div>';
      }
      h += '</div></div>';

      // Kesin 8 özet + dağılım
      h += '<div class="ar"><div class="sl">Kesin 8 \u2192 35 sayida kac tuttu (ort.)</div>';
      h += '<div style="font-size:16px;font-weight:900;color:#a855f7">' + c8favg + ' / 8</div></div>';
      h += '<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">KESIN 8 DAGILIMI (35 SAYI) \u2014 6+ PARA ODUYOR</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
      for (var _k = 0; _k <= 8; _k++) {
        var _e   = _k >= 6 ? '#22c55e' : _k >= 5 ? '#facc15' : '#ef4444';
        var _brd = _k >= 6 ? '#22c55e44' : _k >= 5 ? '#facc1544' : '#2a2f42';
        h += '<div style="background:#1e2130;border:1px solid ' + _brd + ';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">' + _k + '/8: </span><span style="color:' + _e + ';font-weight:800">' + (c8fDist[_k] || 0) + 'x</span></div>';
      }
      h += '</div></div>';

      h += '<div class="st" style="margin-top:16px">Cekilis Bazli Detay</div>';

      rows.forEach(function(r) {
        var ouHitR    = parseInt(r.ou_hit)    === 1;
        var colorHitR = parseInt(r.color_hit) === 1;
        var firstHitR = parseInt(r.first_hit) === 1;

        var af5  = r.actual_first5 ? r.actual_first5.split(',').map(Number) : [];
        var aAll = r.actual_all    ? r.actual_all.split(',').map(Number)    : [];
        var pf1  = r.pred_first    ? r.pred_first.split(',').map(Number).sort(function(a,b){return a-b;})    : [];
        var pc6  = r.pred_certain6 ? r.pred_certain6.split(',').map(Number).sort(function(a,b){return a-b;}) : [];
        var pc8  = r.pred_certain8 ? r.pred_certain8.split(',').map(Number).sort(function(a,b){return a-b;}) : [];

        var c6m  = parseInt(r.certain6_match)      >= 0 ? parseInt(r.certain6_match)      : '-';
        var c8fm = parseInt(r.certain8_full_match)  >= 0 ? parseInt(r.certain8_full_match)  : '-';

        function renkBadge(renk, hit) {
          if (!renk) return '?';
          var hex = COLOR_HEX[renk] || '#aab0c4';
          var tc  = renk === 'Siyah' ? '#e5e7eb' : hex;
          var bg  = hit ? (renk === 'Siyah' ? '#374151' : '#1a1a2e') : '#1e2130';
          var brd = hit ? (renk === 'Siyah' ? '2px solid #22c55e' : '2px solid ' + hex) : '1px solid ' + hex + '66';
          return '<span class="renk-badge" style="color:' + tc + ';background:' + bg + ';border:' + brd + '">' + renk + '</span>';
        }

        h += '<div class="rc">';
        h += '<div class="rh"><span class="rn">Round ' + r.round + '</span>';
        h += '<span style="font-size:13px;font-weight:800">1.S: <span style="font-size:15px;font-weight:900">' + (r.actual_first || '?') + '</span> ';
        h += renkBadge(r.actual_color, colorHitR) + ' ';
        h += '<span class="' + (ouHitR ? 'hit' : 'miss') + '">' + (r.actual_ou || '?') + (ouHitR ? ' \u2713' : ' \u2717') + '</span></span></div>';

        // OU tahmini
        if (r.pred_ou) {
          var ouColor = r.pred_ou === 'OVER' ? '#22c55e' : '#ef4444';
          h += '<div class="lbl">OVER/UNDER TAHMIN\u0130</div><div style="margin-bottom:6px">';
          h += '<span style="font-weight:800;color:' + ouColor + '">' + r.pred_ou + '</span>';
          if (ouHitR) {
            h += ' <span style="color:#22c55e;font-size:12px;font-weight:800">\u2713 TUTTU</span>';
          } else {
            h += ' <span style="color:#ef4444;font-size:12px;font-weight:800">\u2717 KACTI</span>';
            h += ' <span style="font-size:11px;color:#5a6180">(Gercek: <span style="color:' + (r.actual_ou==='OVER'?'#22c55e':'#ef4444') + ';font-weight:700">' + (r.actual_ou||'?') + '</span>)</span>';
          }
          h += '</div>';
        }

        // Renk tahmini
        if (r.pred_color) {
          var ph = COLOR_HEX[r.pred_color] || '#aab0c4';
          var pt = r.pred_color === 'Siyah' ? '#e5e7eb' : ph;
          h += '<div class="lbl">RENK TAHMIN\u0130</div><div style="margin-bottom:6px">';
          h += '<span class="renk-badge" style="color:' + pt + ';background:#1e2130;border:1px solid ' + ph + '88">' + r.pred_color + '</span>';
          if (colorHitR) {
            h += ' <span style="color:#22c55e;font-size:12px;font-weight:800">\u2713 TUTTU</span>';
          } else {
            h += ' <span style="color:#ef4444;font-size:12px;font-weight:800">\u2717 KACTI</span> <span style="font-size:11px;color:#5a6180">(Gercek: ' + renkBadge(r.actual_color, false) + ')</span>';
          }
          h += '</div>';
        }

        // Tahmin 5 - ilk sayı
        if (pf1.length > 0) {
          h += '<div class="lbl">TAHMIN 5 \u2014 1. Sayi Adaylari</div><div class="nr">';
          pf1.forEach(function(num) {
            var isF = num === parseInt(r.actual_first);
            h += '<div class="nb" style="background:' + (isF?'#14532d':'#1e2130') + ';border:' + (isF?'2px solid #22c55e':'1px solid #3b82f6') + ';color:' + (isF?'#22c55e':'#93c5fd') + '">' + num + '</div>';
          });
          h += '<span style="font-size:11px;color:' + (firstHitR?'#22c55e':'#ef4444') + ';margin-left:6px;font-weight:800">' + (firstHitR?'\u2713 TUTTU':'\u2717 KACTI') + '</span></div>';
        }

        // Gerçek ilk 5
        if (af5.length > 0) {
          h += '<div class="lbl">GERCEK ILK 5</div><div class="nr">';
          af5.forEach(function(num) {
            h += '<div class="nb" style="background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd">' + num + '</div>';
          });
          h += '</div>';
        }

        // Kesin 6
        if (pc6.length > 0 || c6m !== '-') {
          h += '<div class="lbl">KESIN CIKACAK 6 SAYI \u2014 <span style="color:#a855f7;font-weight:900">' + c6m + '/6 tuttu (35 sayida)</span></div>';
          h += '<div class="nr">';
          pc6.forEach(function(num) {
            var inIlk5 = af5.indexOf(num) !== -1;
            var inFull = aAll.indexOf(num) !== -1;
            // Yeşil = ilk 5'te çıktı | Kırmızı/turuncu = 35'te çıktı | Gri = çıkmadı
            var bg  = inIlk5 ? '#0f4a66' : inFull ? '#0c2a3a' : '#2a3040';
            var brd = inIlk5 ? '#38bdf8'  : inFull ? '#38bdf8' : '#4a5270';
            var cl  = inIlk5 ? '#7dd3fc'  : inFull ? '#38bdf8' : '#aab0c4';
            h += '<div class="nb" style="background:' + bg + ';border:2px solid ' + brd + ';color:' + cl + '">' + num + '</div>';
          });
          h += '</div>';
          h += '<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#38bdf8;border:2px solid #38bdf8;vertical-align:middle"></span> Ilk 5\'te cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#0c2a3a;border:2px solid #38bdf8;vertical-align:middle"></span> 35 sayida cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h += '</div>';
        }

        // Kesin 8
        if (pc8.length > 0) {
          h += '<div class="lbl">KESIN CIKACAK 8 SAYI \u2014 <span style="color:#a855f7;font-weight:900">' + c8fm + '/8 tuttu (35 sayida)</span></div>';
          h += '<div class="nr">';
          pc8.forEach(function(num) {
            var inIlk5 = af5.indexOf(num) !== -1;
            var inFull = aAll.indexOf(num) !== -1;
            var bg  = inIlk5 ? '#14532d' : inFull ? '#1a3a2a' : '#2a3040';
            var brd = inIlk5 ? '#22c55e' : inFull ? '#16a34a' : '#4a5270';
            var cl  = inIlk5 ? '#22c55e' : inFull ? '#4ade80' : '#aab0c4';
            h += '<div class="nb" style="background:' + bg + ';border:1px solid ' + brd + ';color:' + cl + '">' + num + '</div>';
          });
          h += '</div>';
          h += '<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#14532d;border:1px solid #22c55e;vertical-align:middle"></span> Ilk5\'te cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1a3a2a;border:1px solid #16a34a;vertical-align:middle"></span> 35 sayida cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h += '</div>';
        }

        // Özet
        h += '<div class="mi">';
        h += '<div class="mc">Kesin 6 \u2192 35 sayi: <strong style="color:' + (c6m>=5?'#22c55e':c6m>=4?'#facc15':'#aab0c4') + '">' + c6m + '/6</strong></div>';
        h += '<div class="mc">Kesin 8 \u2192 35 sayi: <strong style="color:' + (c8fm>=6?'#22c55e':c8fm>=4?'#facc15':'#aab0c4') + '">' + c8fm + '/8</strong></div>';
        h += '</div></div>';
      });

      h += '</body></html>';
      res.type('html'); res.end(h);
    }).catch(function(e) { res.status(500).send('Rapor hatasi: ' + e.message); });
  });

  app.get('/', function(req, res) {
    var h = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WingoOracle</title>';
    h += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:520px;margin:0 auto}';
    h += 'h1{font-size:22px;text-align:center;font-weight:800;letter-spacing:2px;margin-bottom:14px}';
    h += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    h += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    h += '.over{color:#22c55e;font-weight:800}.under{color:#ef4444;font-weight:800}';
    h += '.big{font-size:34px;font-weight:900;margin:4px 0}.conf{font-size:13px;color:#aab0c4;margin-top:3px;font-weight:600}';
    h += '.si{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;font-weight:700}';
    h += '.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}';
    h += '.num{border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff}';
    h += '.row{display:grid;grid-template-columns:60px 38px 90px 60px 30px;align-items:center;padding:6px 0;border-bottom:1px solid #2a2f42;font-size:12px}.row:last-child{border:none}';
    h += '.bar{height:7px;background:#3a3f52;border-radius:4px;margin:8px 0;overflow:hidden}.bf{height:100%;border-radius:4px}';
    h += '.str{display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-bottom:4px}';
    h += '.cb{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:20px;font-size:12px;margin:3px;font-weight:800;color:#fff}';
    h += '.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px;text-decoration:none;text-align:center}';
    h += '.ref{color:#5a6180;font-size:11px;text-align:center;margin-top:10px}';
    h += '.hdr{display:grid;grid-template-columns:60px 38px 90px 60px 30px;padding:4px 0;font-size:10px;color:#5a6180;font-weight:600;border-bottom:1px solid #3a3f52;margin-bottom:4px}';
    h += '</style></head><body>';
    h += '<h1>WINGO ORACLE</h1>';
    h += '<a class="btn" href="/rapor">RAPOR</a>';
    h += '<div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
    h += '<script>var CH=' + CH + ';';
    h += 'function load(){var x=new XMLHttpRequest();x.open("GET","/data");x.onload=function(){try{var d=JSON.parse(x.responseText);';
    h += 'if(d.error){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>Hata: "+d.error+"</div>";return;}';
    h += 'var pr=d.predictions;var h="";';
    h += 'if(pr&&pr.over_under){var ou=pr.over_under;var oc=ou.pred==="OVER"?"#22c55e":"#ef4444";';
    h += 'var bc=ou.pred==="OVER"?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)";';
    h += 'var rno=(d.last200&&d.last200.length>0)?(d.last200[0].round+1):"?";';
    h += 'h+="<div class=\'card\' style=\'border-color:"+bc+"\'><div class=\'title\'>Round "+rno+" - Over / Under Tahmini</div>";';
    h += 'h+="<div class=\'big\' style=\'color:"+oc+"\'>"+ou.pred+"</div><div class=\'conf\'>Guven: %"+ou.conf+"</div>";';
    h += 'if(ou.streak){var sc=ou.streak.count>=7?"#ef4444":ou.streak.count>=5?"#f97316":ou.streak.count>=3?"#facc15":"#aab0c4";';
    h += 'var sbg=ou.streak.count>=7?"rgba(239,68,68,0.15)":ou.streak.count>=5?"rgba(249,115,22,0.15)":ou.streak.count>=3?"rgba(250,204,21,0.1)":"rgba(255,255,255,0.05)";';
    h += 'h+="<div class=\'si\' style=\'background:"+sbg+";color:"+sc+";border:1px solid "+sc+"44\'>Mevcut Seri: "+ou.streak.type+" "+ou.streak.count+"x</div>";}';
    h += 'h+="</div>";}else{h+="<div class=\'card\'><div class=\'title\'>Tahmin</div><div style=\'color:#facc15;padding:10px\'>Tahmin hesaplaniyor...</div></div>";}';
    h += 'if(pr&&pr.color){var cl=pr.color;var pc=CH[cl.pred]||"#fff";';
    h += 'h+="<div class=\'card\' style=\'border-color:"+pc+"66\'><div class=\'title\'>Renk Tahmini</div>";';
    h += 'h+="<div class=\'big\' style=\'color:"+pc+"\'>"+cl.pred+"</div><div class=\'conf\'>Guven: %"+cl.conf+"</div>";';
    h += 'h+="<div style=\'margin-top:12px\'><div class=\'title\'>Son 200 Cekilis Renk Dagilimi</div><div style=\'margin-top:6px\'>";';
    h += '["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"].forEach(function(cn){';
    h += 'var cnt=(cl.counts&&cl.counts[cn])||0;var bg=CH[cn]||"#333";';
    h += 'var op=cnt<=(200/8)*0.5?1:cnt<=(200/8)*0.8?0.65:0.3;';
    h += 'h+="<span class=\'cb\' style=\'background:"+bg+";opacity:"+op+"\'>"+cn+" "+cnt+"</span>";});';
    h += 'h+="</div></div></div>";}';
    h += 'if(pr&&pr.first_candidates&&pr.first_candidates.length>0){';
    h += 'h+="<div class=\'card\'><div class=\'title\'>Ilk Sayi - 5 Aday</div><div class=\'nums\'>";';
    h += 'pr.first_candidates.forEach(function(n){h+="<div class=\'num\' style=\'background:#1e3a5f;border:2px solid #3b82f6\'>"+n+"</div>";});';
    h += 'h+="</div></div>";}';
    h += 'if(pr&&pr.certain6&&pr.certain6.length>0){';
    h += 'h+="<div class=\'card\'><div class=\'title\'>Kesin Cikacak - 6 Sayi</div><div class=\'nums\'>";';
    h += 'pr.certain6.forEach(function(n){var isE=pr.certain6_grpA&&pr.certain6_grpA.indexOf(n)!==-1;';
    h += 'h+="<div class=\'num\' style=\'background:"+("#0c2a3a")+";border:2px solid "+("#38bdf8")+"\'>"+ n+"</div>";});';
    h += 'h+="</div><div style=\'margin-top:8px;font-size:10px;color:#aab0c4;display:flex;gap:12px\'>";';
    h += 'h+="</div></div>";}';
    h += 'if(pr&&pr.certain8&&pr.certain8.length>0){';
    h += 'h+="<div class=\'card\'><div class=\'title\'>Kesin Cikacak - 8 Sayi</div><div class=\'nums\'>";';
    h += 'pr.certain8.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a3040;border:1px solid #a855f7\'>"+n+"</div>";});';
    h += 'h+="</div></div>";}';
    h += 'if(d.stats){h+="<div class=\'card\'><div class=\'title\'>Istatistik ("+d.stats.total+" Round)</div>";';
    h += 'h+="<div class=\'str\'><span class=\'over\'>OVER %"+d.stats.over_pct+"</span><span class=\'under\'>UNDER %"+d.stats.under_pct+"</span></div>";';
    h += 'h+="<div class=\'bar\'><div class=\'bf\' style=\'width:"+d.stats.over_pct+"%;background:#22c55e\'></div></div></div>";}';
    h += 'if(d.last200&&d.last200.length>0){h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px\'><span class=\'title\' style=\'margin-bottom:0\'>Son 200 Cekilis</span><a href=\'/draws.json\' style=\'font-size:10px;color:#aab0c4;background:#2a2f42;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:700;border:1px solid #3a3f52\'>JSON &#8595;</a></div>";';
    h += 'h+="<div class=\'hdr\'><span>Round</span><span>1.S</span><span>Renk</span><span>O/U</span><span>Seri</span></div>";';
    h += 'for(var i=0;i<d.last200.length;i++){var r=d.last200[i];';
    h += 'var oc2=r.over_under==="OVER"?"#22c55e":"#ef4444";var rc=CH[r.color]||"#aaa";var streak=1;';
    h += 'for(var j=i+1;j<d.last200.length;j++){if(d.last200[j].over_under===r.over_under)streak++;else break;}';
    h += 'var sc2=streak>=7?"#ef4444":streak>=5?"#f97316":streak>=3?"#facc15":"#5a6180";';
    h += 'h+="<div class=\'row\'><span style=\'color:#aab0c4;font-size:11px\'>"+r.round+"</span>";';
    h += 'h+="<span style=\'font-weight:900;font-size:14px\'>"+r.first+"</span>";';
    h += 'h+="<span style=\'color:"+rc+";font-weight:700\'>"+r.color+"</span>";';
    h += 'h+="<span style=\'color:"+oc2+";font-weight:900\'>"+r.over_under+"</span>";';
    h += 'h+="<span style=\'color:"+sc2+";font-weight:800;font-size:11px\'>"+streak+"x</span></div>";}';
    h += 'h+="</div>";}';
    h += 'h+="<div class=\'ref\'>Her 30 saniyede bir guncellenir</div>";';
    h += 'document.getElementById("app").innerHTML=h;';
    h += '}catch(e){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>Hata: "+e.message+"</div>";}};';
    h += 'x.onerror=function(){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>/data hatasi</div>";};';
    h += 'x.send();}load();setInterval(load,30000);';
    h += '</script></body></html>';
    res.type('html'); res.end(h);
  });

  app.listen(process.env.PORT || 3000, '0.0.0.0', function() { console.log('Dashboard: http://localhost:3000'); });
}

console.log('Basliyor...');
