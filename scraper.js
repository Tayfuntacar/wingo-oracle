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
  return db.query('CREATE TABLE IF NOT EXISTS predictions (id SERIAL PRIMARY KEY, round INT UNIQUE, pred_ou VARCHAR(5), pred_color VARCHAR(20), pred_first TEXT, pred_first5 TEXT, pred_certain8 TEXT, actual_first INT, actual_first5 TEXT, actual_color VARCHAR(20), actual_ou VARCHAR(5), ou_hit SMALLINT DEFAULT -1, color_hit SMALLINT DEFAULT -1, first_hit SMALLINT DEFAULT -1, first5_hit SMALLINT DEFAULT -1, certain8_hit SMALLINT DEFAULT -1, first5_match INT DEFAULT -1, certain8_match INT DEFAULT -1, created_at TIMESTAMP DEFAULT NOW())');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_first5 TEXT');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS first5_match INT DEFAULT -1');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_match INT DEFAULT -1');
}).then(function() {
  return db.query('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_full_match INT DEFAULT -1');
}).then(function() {
  console.log('Tablolar hazir!');
  return loadCacheFromDB();
}).then(function() {
  connect();
  startDashboard();
}).catch(function(e) { console.log('DB hatasi:', e.message); });

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
    updatePredictions(round, first, first5, allNums, ou, renk);
    saveNextPrediction(round);
  }).catch(function(e) { console.log('Draw hatasi:', e.message); });
}

function updatePredictions(round, first, first5, allNums, ou, renk) {
  db.query('SELECT id, pred_ou, pred_color, pred_first, pred_first5, pred_certain8 FROM predictions WHERE round = $1 AND ou_hit = -1', [round])
  .then(function(res) {
    if (res.rows.length === 0) { console.log('Round ' + round + ' icin bekleyen tahmin yok.'); return; }
    res.rows.forEach(function(row) {
      var ouHit    = row.pred_ou    === ou   ? 1 : 0;
      var colorHit = row.pred_color === renk ? 1 : 0;
      var pf  = row.pred_first    ? row.pred_first.split(',').map(Number)    : [];
      var pf5 = row.pred_first5   ? row.pred_first5.split(',').map(Number)   : [];
      var pc8 = row.pred_certain8 ? row.pred_certain8.split(',').map(Number) : [];
      var firstHit    = pf.indexOf(first)  !== -1 ? 1 : 0;
      var f5Hit       = pf5.indexOf(first) !== -1 ? 1 : 0;
      var c8Hit       = pc8.indexOf(first) !== -1 ? 1 : 0;
      var f5Match     = first5.filter(function(n) { return pf5.indexOf(n) !== -1; }).length;
      var c8Match     = first5.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      var c8FullMatch = allNums.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      db.query(
        'UPDATE predictions SET actual_first=$1,actual_first5=$2,actual_color=$3,actual_ou=$4,ou_hit=$5,color_hit=$6,first_hit=$7,first5_hit=$8,certain8_hit=$9,first5_match=$10,certain8_match=$11,certain8_full_match=$12 WHERE id=$13',
        [first, first5.join(','), renk, ou, ouHit, colorHit, firstHit, f5Hit, c8Hit, f5Match, c8Match, c8FullMatch, row.id]
      ).then(function() {
        console.log('>>> Tahmin guncellendi Round ' + round +
          ' | OU:' + (ouHit?'TUTTU':'KACTI') +
          ' | Renk:' + (colorHit?'TUTTU':'KACTI') +
          ' | Sayi:' + (firstHit?'TUTTU':'KACTI') +
          ' | F5:' + f5Match + ' | C8:' + c8Match + ' | C8Full:' + c8FullMatch + '/8');
      }).catch(function(e) { console.log('Update hatasi:', e.message); });
    });
  }).catch(function(e) { console.log('UpdatePred hatasi:', e.message); });
}

function saveNextPrediction(round) {
  db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round DESC LIMIT 200')
  .then(function(res) {
    var draws = res.rows;
    if (draws.length < 10) { console.log('Yeterli veri yok (' + draws.length + '/10)'); return; }
    var pred;
    try { pred = predict(draws); } catch(e) { console.log('Predict hatasi:', e.message); return; }
    if (!pred || !pred.over_under) { console.log('Tahmin uretilmedi'); return; }
    globalPredCache = pred;
    var nextRound = round + 1;
    console.log('--- TAHMIN: Round ' + nextRound + ' -> ' + pred.over_under.pred + ' / ' + (pred.color ? pred.color.pred : '?') + ' ---');
    db.query(
      'INSERT INTO predictions (round,pred_ou,pred_color,pred_first,pred_first5,pred_certain8) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (round) DO UPDATE SET pred_ou=$2,pred_color=$3,pred_first=$4,pred_first5=$5,pred_certain8=$6 WHERE predictions.ou_hit=-1',
      [nextRound, pred.over_under.pred, pred.color ? pred.color.pred : '',
       pred.first_candidates  ? pred.first_candidates.join(',')  : '',
       pred.first5_candidates ? pred.first5_candidates.join(',') : '',
       pred.certain8          ? pred.certain8.join(',')          : '']
    ).then(function() { console.log('Tahmin kaydedildi: Round ' + nextRound); })
     .catch(function(e) { console.log('SavePred hatasi:', e.message); });
  }).catch(function(e) { console.log('SaveNextPred hatasi:', e.message); });
}

function calcStreak(ouList) {
  if (!ouList || ouList.length === 0) return { type: 'OVER', count: 1 };
  var last = ouList[0];
  var count = 1;
  for (var i = 1; i < ouList.length; i++) {
    if (ouList[i] === last) count++; else break;
  }
  return { type: last, count: count };
}

function predict(draws) {
  var result = {};
  if (!draws || draws.length < 10) return result;
  var n = draws.length;
  var firstNums = draws.map(function(d) { return parseInt(d.first); });
  var colorList = draws.map(function(d) { return d.color; });
  var ouList    = draws.map(function(d) { return d.over_under; });
  var allNumsArr = draws.map(function(d) { return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });

  // ── OVER/UNDER: SERİ BAZLI ──────────────────────────────
  var streak = calcStreak(ouList);
  var predOU, ouConf, streakNote = '', state = 'BALANCED';

  if (streak.count >= 7) {
    predOU = streak.type === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 87;
    streakNote = streak.type + ' ' + streak.count + 'x — KESIN DONIYOR';
    state = 'REVERSAL';
  } else if (streak.count >= 5) {
    predOU = streak.type === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 79;
    streakNote = streak.type + ' ' + streak.count + 'x — karsi tarafa gec';
    state = 'REVERSAL';
  } else if (streak.count === 4) {
    predOU = streak.type === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 67;
    streakNote = streak.type + ' 4x — donus yaklasıyor';
    state = 'WARNING';
  } else if (streak.count === 3) {
    // 3x — son 50 çekilişin dengesine bak
    var ov50 = ouList.slice(0, Math.min(50, n)).filter(function(x){return x==='OVER';}).length;
    var pct50 = ov50 / Math.min(50, n);
    if (pct50 > 0.58) { predOU = 'UNDER'; ouConf = 60; }
    else if (pct50 < 0.42) { predOU = 'OVER'; ouConf = 60; }
    else { predOU = streak.type; ouConf = 56; }
    streakNote = streak.type + ' 3x';
    state = 'CAUTION';
  } else if (streak.count === 2) {
    var ov30 = ouList.slice(0, Math.min(30, n)).filter(function(x){return x==='OVER';}).length;
    var pct30 = ov30 / Math.min(30, n);
    predOU = pct30 > 0.55 ? 'UNDER' : pct30 < 0.45 ? 'OVER' : streak.type;
    ouConf = 54;
    streakNote = streak.type + ' 2x';
    state = 'BALANCED';
  } else {
    // 1x — sadece genel denge
    var ov20 = ouList.slice(0, Math.min(20, n)).filter(function(x){return x==='OVER';}).length;
    var pct20 = ov20 / Math.min(20, n);
    predOU = pct20 > 0.60 ? 'UNDER' : pct20 < 0.40 ? 'OVER' : (streak.type === 'OVER' ? 'UNDER' : 'OVER');
    ouConf = 52;
    state = 'BALANCED';
  }
  result.over_under = { pred: predOU, conf: ouConf, streak: streak, state: state };

  // ── RENK: AÇIK GELİŞMİŞ SKOR ────────────────────────────
  var colorCounts = {};
  ALL_COLORS.forEach(function(c){ colorCounts[c] = 0; });
  colorList.slice(0, Math.min(100, n)).forEach(function(c){ if(colorCounts[c] !== undefined) colorCounts[c]++; });

  var colorCounts30 = {};
  ALL_COLORS.forEach(function(c){ colorCounts30[c] = 0; });
  colorList.slice(0, Math.min(30, n)).forEach(function(c){ if(colorCounts30[c] !== undefined) colorCounts30[c]++; });

  var colorLastSeen = {};
  ALL_COLORS.forEach(function(c){ colorLastSeen[c] = 999; });
  colorList.forEach(function(c, ci){ if(colorLastSeen[c] === 999) colorLastSeen[c] = ci; });

  // Son 30'da 0 gelen = soğuk = yüksek öncelik
  var coldColors = ALL_COLORS.filter(function(c){ return colorCounts30[c] === 0; });

  var expected100 = 100 / 8; // ~12.5
  var expected30  = 30  / 8; // ~3.75
  var cs = {};
  ALL_COLORS.forEach(function(c) {
    var deficit100 = Math.max(0, expected100 - colorCounts[c]);   // son 100'de ne kadar az geldi
    var deficit30  = Math.max(0, expected30  - colorCounts30[c]); // son 30'da ne kadar az geldi
    var lastSeenScore = Math.min(colorLastSeen[c], 50);           // ne zamandır gelmiyor
    cs[c] = deficit100 * 2.5 + deficit30 * 5 + lastSeenScore * 1.5;
  });

  var predColor;
  if (coldColors.length > 0) {
    // Soğuk renkler arasında en uzun süredir gelmeyeni seç
    predColor = coldColors.slice().sort(function(a,b){ return colorLastSeen[b] - colorLastSeen[a]; })[0];
  } else {
    predColor = ALL_COLORS.slice().sort(function(a,b){ return cs[b] - cs[a]; })[0];
  }
  var colorConf = coldColors.length >= 3 ? 68 : coldColors.length === 2 ? 55 : 40;
  result.color = { pred: predColor, conf: colorConf, counts: colorCounts, state: state };

  // ── SAYI SKORLARI ────────────────────────────────────────

  // 1. Son görülme (en güçlü sinyal)
  var numLastSeen = {};
  for(var i=1; i<=48; i++) numLastSeen[i] = 999;
  firstNums.forEach(function(num, idx){ if(numLastSeen[num] === 999) numLastSeen[num] = idx; });

  // 2. Frekans decay (son çekilişler daha ağırlıklı)
  var freqDecay = {};
  for(var i=1; i<=48; i++) freqDecay[i] = 0;
  firstNums.forEach(function(num, idx){ freqDecay[num] += Math.exp(-0.04 * idx); });
  var maxFreq = Math.max.apply(null, Object.keys(freqDecay).map(function(k){return freqDecay[k];})) || 1;

  // 3. Son 20'de gelmeyen sayılar (soğuk)
  var recent20 = firstNums.slice(0, Math.min(20, n));
  var coldNums = [];
  for(var i=1; i<=48; i++){ if(recent20.indexOf(i) === -1) coldNums.push(i); }

  // 4. Zaman bazlı
  var hour = new Date().getUTCHours() + 3; if(hour >= 24) hour -= 24;
  var tf = {};
  for(var i=1; i<=48; i++) tf[i] = 0;
  draws.forEach(function(d){
    if(!d.created_at) return;
    var h = new Date(d.created_at).getUTCHours() + 3; if(h >= 24) h -= 24;
    if(Math.abs(h - hour) <= 2) tf[parseInt(d.first)] = (tf[parseInt(d.first)]||0) + 1;
  });

  // 5. Pair analizi (son sayıdan sonra ne geliyor)
  var pairs = {};
  for(var pi = 0; pi < n-1; pi++){
    var pa = firstNums[pi]; var pb = firstNums[pi+1];
    var pk = Math.min(pa,pb) + '-' + Math.max(pa,pb);
    pairs[pk] = (pairs[pk]||0) + 1;
  }
  var lastN = firstNums[0];

  // 6. İlk 5 pozisyon frekansı (kesin 8 için)
  var pos5freq = {};
  for(var i=1; i<=48; i++) pos5freq[i] = 0;
  allNumsArr.forEach(function(balls){
    balls.slice(0,5).forEach(function(num){ pos5freq[num]++; });
  });
  var maxPos5 = Math.max.apply(null, Object.keys(pos5freq).map(function(k){return pos5freq[k];})) || 1;

  // 7. Full çekiliş (35 sayı) frekansı
  var fullFreq = {};
  for(var i=1; i<=48; i++) fullFreq[i] = 0;
  allNumsArr.forEach(function(balls, di){
    balls.forEach(function(num){ fullFreq[num] += Math.exp(-0.02*di); });
  });
  var maxFull = Math.max.apply(null, Object.keys(fullFreq).map(function(k){return fullFreq[k];})) || 1;

  // KOMBİNE SKOR — İlk sayı için
  var ns = {};
  for(var i=1; i<=48; i++){
    var lsNorm  = Math.min(numLastSeen[i], 50) / 50 * 100;
    var frNorm  = (1 - freqDecay[i] / maxFreq) * 100;
    var cold20  = coldNums.indexOf(i) !== -1 ? 30 : 0;
    var pairScore = 0;
    var pk3 = Math.min(lastN, i) + '-' + Math.max(lastN, i);
    if(pairs[pk3]) pairScore = pairs[pk3] * 3;
    var timeScore = (tf[i]||0) * 4;

    ns[i] = lsNorm * 0.35 + frNorm * 0.20 + cold20 * 0.25 + pairScore * 0.12 + timeScore * 0.08;
  }

  // Over/Under filtreyle ilk sayı
  var allCands = [];
  for(var i=1; i<=48; i++) allCands.push(i);
  allCands.sort(function(a,b){ return ns[b] - ns[a]; });

  var filtCands = allCands.filter(function(x){ return predOU === 'OVER' ? x > 24 : x <= 24; });
  if(filtCands.length < 5) filtCands = allCands; // fallback
  result.first_candidates  = filtCands.slice(0, 5).sort(function(a,b){ return a-b; });
  result.first5_candidates = filtCands.slice(0, 6).sort(function(a,b){ return a-b; });

  // Kesin 8 — full çekiliş baz alınır, hem frekans hem soğukluk
  var ks = {};
  for(var i=1; i<=48; i++){
    var fullNorm = fullFreq[i] / maxFull * 100;
    var pos5Norm = pos5freq[i] / maxPos5 * 100;
    var lsNorm2  = Math.min(numLastSeen[i], 50) / 50 * 100;
    var cold5    = 0;
    var recent5all = [];
    allNumsArr.slice(0,5).forEach(function(b){ b.forEach(function(x){ recent5all.push(x); }); });
    if(recent5all.indexOf(i) === -1) cold5 = 25;
    ks[i] = fullNorm * 0.40 + pos5Norm * 0.25 + lsNorm2 * 0.20 + cold5 * 0.15;
  }
  var ksCands = [];
  for(var i=1; i<=48; i++) ksCands.push(i);
  ksCands.sort(function(a,b){ return ks[b] - ks[a]; });
  result.certain8 = ksCands.slice(0, 8).sort(function(a,b){ return a-b; });

  return result;
}

function colorStyle(renk, hit) {
  if (renk === 'Siyah') {
    return hit
      ? 'background:#374151;border:2px solid #22c55e;color:#e5e7eb'
      : 'background:#374151;border:1px solid #6b7280;color:#e5e7eb';
  }
  var hex = COLOR_HEX[renk] || '#aab0c4';
  return hit
    ? 'background:#14532d;border:2px solid ' + hex + ';color:' + hex
    : 'background:#1e2130;border:1px solid ' + hex + '88;color:' + hex;
}

function startDashboard() {
  var app = express();
  app.use(cors());
  var CH = JSON.stringify(COLOR_HEX);

  app.get('/data', function(req, res) {
    var done = false;
    var timer = setTimeout(function() { done=true; if(!res.headersSent) res.json({error:'Timeout'}); }, 8000);
    Promise.all([
      db.query('SELECT round,first,over_under,color,all_numbers,created_at FROM draws ORDER BY round DESC LIMIT 200'),
      db.query("SELECT COUNT(*) as total, SUM(CASE WHEN over_under='OVER' THEN 1 ELSE 0 END) as over_count FROM draws")
    ]).then(function(r) {
      clearTimeout(timer); if(done) return;
      var total=parseInt(r[1].rows[0].total)||0;
      var oc=parseInt(r[1].rows[0].over_count)||0;
      var op=total>0?Math.round(oc/total*100):50;
      if(!res.headersSent) res.json({last200:r[0].rows,stats:{total:total,over_pct:op,under_pct:100-op},predictions:globalPredCache});
    }).catch(function(e){clearTimeout(timer);if(!res.headersSent)res.json({error:e.message});});
  });

  app.get('/rapor', function(req, res) {
    db.query('SELECT p.*,d.all_numbers as actual_all FROM predictions p LEFT JOIN draws d ON p.round=d.round WHERE p.ou_hit != -1 ORDER BY p.round DESC LIMIT 500').then(function(result) {
      var rows=result.rows;
      var ouHit=0,ouTotal=0,colorHit=0,colorTotal=0,firstHit=0,firstTotal=0;
      var f5T=0,f5S=0,c8T=0,c8S=0,c8FT=0,c8FS=0;
      rows.forEach(function(r){
        ouTotal++;   if(parseInt(r.ou_hit)===1)ouHit++;
        colorTotal++;if(parseInt(r.color_hit)===1)colorHit++;
        firstTotal++;if(parseInt(r.first_hit)===1)firstHit++;
        var fm=parseInt(r.first5_match);   if(fm>=0){f5T++;f5S+=fm;}
        var cm=parseInt(r.certain8_match); if(cm>=0){c8T++;c8S+=cm;}
        var cfm=parseInt(r.certain8_full_match); if(cfm>=0){c8FT++;c8FS+=cfm;}
      });
      var ouPct    = ouTotal>0    ? Math.round(ouHit/ouTotal*100)       : 0;
      var colorPct = colorTotal>0 ? Math.round(colorHit/colorTotal*100) : 0;
      var firstPct = firstTotal>0 ? Math.round(firstHit/firstTotal*100) : 0;
      var f5avg    = f5T>0  ? (f5S/f5T).toFixed(2)  : '0.00';
      var c8avg    = c8T>0  ? (c8S/c8T).toFixed(2)  : '0.00';
      var c8favg   = c8FT>0 ? (c8FS/c8FT).toFixed(2): '0.00';

      var h='<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapor</title>';
      h+='<style>';
      h+='*{margin:0;padding:0;box-sizing:border-box}';
      h+='body{background:#1a1d2e;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:580px;margin:0 auto}';
      h+='h1{font-size:20px;text-align:center;font-weight:900;letter-spacing:3px;padding:16px 0}';
      h+='.btn{display:block;width:100%;padding:13px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:12px;text-align:center;text-decoration:none}';
      h+='.st{font-size:10px;color:#5a6180;text-transform:uppercase;letter-spacing:2px;font-weight:700;padding:10px 0 8px;border-bottom:1px solid #2a2f42;margin-bottom:12px}';
      h+='.sr{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e2130}';
      h+='.sl{font-size:13px;color:#aab0c4;font-weight:600}';
      h+='.srr{text-align:right}';
      h+='.sp{font-size:20px;font-weight:900}';
      h+='.ss{font-size:11px;color:#5a6180;margin-top:2px}';
      h+='.bar{height:4px;background:#2a2f42;border-radius:2px;margin-top:5px;width:100px;overflow:hidden}';
      h+='.bf{height:100%;border-radius:2px}';
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
      h+='<div class="sp" style="color:'+ouc+'">%'+ouPct+'</div>';
      h+='<div class="ss">'+ouHit+'/'+ouTotal+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+ouPct+'%;background:'+ouc+'"></div></div>';
      h+='</div></div>';

      var cc=colorPct>=20?'#22c55e':colorPct>=12?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Renk</div><div class="srr">';
      h+='<div class="sp" style="color:'+cc+'">%'+colorPct+'</div>';
      h+='<div class="ss">'+colorHit+'/'+colorTotal+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(colorPct*4,100)+'%;background:'+cc+'"></div></div>';
      h+='</div></div>';

      var fc=firstPct>=15?'#22c55e':firstPct>=10?'#facc15':'#ef4444';
      h+='<div class="sr"><div class="sl">Ilk Sayi (5 Aday)</div><div class="srr">';
      h+='<div class="sp" style="color:'+fc+'">%'+firstPct+'</div>';
      h+='<div class="ss">'+firstHit+'/'+firstTotal+' tuttu</div>';
      h+='<div class="bar"><div class="bf" style="width:'+Math.min(firstPct*4,100)+'%;background:'+fc+'"></div></div>';
      h+='</div></div>';

      h+='<div class="ar"><div class="sl">6 Aday \u2192 Gercek ilk5\'te kac tuttu (ort.)</div>';
      h+='<div style="font-size:16px;font-weight:900;color:#3b82f6">'+f5avg+' / 5</div></div>';
      h+='<div class="ar"><div class="sl">8 Aday \u2192 Gercek ilk5\'te kac tuttu (ort.)</div>';
      h+='<div style="font-size:16px;font-weight:900;color:#3b82f6">'+c8avg+' / 5</div></div>';
      h+='<div class="ar"><div class="sl">8 Aday \u2192 Full cekilis (35 sayi)\'de kac tuttu (ort.)</div>';
      h+='<div style="font-size:16px;font-weight:900;color:#a855f7">'+c8favg+' / 8</div></div>';

      h+='<div class="st" style="margin-top:16px">Cekilis Bazli Detay</div>';

      rows.forEach(function(r){
        var ouHitR    = parseInt(r.ou_hit)===1;
        var colorHitR = parseInt(r.color_hit)===1;
        var firstHitR = parseInt(r.first_hit)===1;

        var af5  = r.actual_first5 ? r.actual_first5.split(',').map(Number) : [];
        var aAll = r.actual_all    ? r.actual_all.split(',').map(Number)    : [];

        var pf1 = r.pred_first    ? r.pred_first.split(',').map(Number).sort(function(a,b){return a-b;})    : [];
        var pf5 = r.pred_first5   ? r.pred_first5.split(',').map(Number).sort(function(a,b){return a-b;})   : [];
        var pc8 = r.pred_certain8 ? r.pred_certain8.split(',').map(Number).sort(function(a,b){return a-b;}) : [];

        var f5m  = parseInt(r.first5_match)        >= 0 ? parseInt(r.first5_match)        : '-';
        var c8m  = parseInt(r.certain8_match)      >= 0 ? parseInt(r.certain8_match)      : '-';
        var c8fm = parseInt(r.certain8_full_match)  >= 0 ? parseInt(r.certain8_full_match)  : '-';

        function renkBadge(renk, hit) {
          if (!renk) return '?';
          var hex = COLOR_HEX[renk] || '#aab0c4';
          var textColor = renk === 'Siyah' ? '#e5e7eb' : hex;
          var bg = hit ? (renk === 'Siyah' ? '#374151' : '#1a1a2e') : '#1e2130';
          var border = hit ? (renk === 'Siyah' ? '2px solid #22c55e' : '2px solid '+hex) : '1px solid '+hex+'66';
          return '<span class="renk-badge" style="color:'+textColor+';background:'+bg+';border:'+border+'">'+renk+'</span>';
        }

        h+='<div class="rc">';
        h+='<div class="rh">';
        h+='<span class="rn">Round '+r.round+'</span>';
        h+='<span style="font-size:13px;font-weight:800">';
        h+='1.S: <span style="font-size:15px;font-weight:900">'+(r.actual_first||'?')+'</span> ';
        h+=renkBadge(r.actual_color, colorHitR)+' ';
        h+='<span class="'+(ouHitR?'hit':'miss')+'">'+(r.actual_ou||'?')+(ouHitR?' \u2713':' \u2717')+'</span>';
        h+='</span>';
        h+='</div>';

        if(r.pred_color){
          var predRenkHex = COLOR_HEX[r.pred_color] || '#aab0c4';
          var predRenkText = r.pred_color === 'Siyah' ? '#e5e7eb' : predRenkHex;
          h+='<div class="lbl">RENK TAHMIN\u0130</div>';
          h+='<div style="margin-bottom:6px">';
          h+='<span class="renk-badge" style="color:'+predRenkText+';background:#1e2130;border:1px solid '+predRenkHex+'88">'+r.pred_color+'</span>';
          if(colorHitR){
            h+=' <span style="color:#22c55e;font-size:12px;font-weight:800">\u2713 TUTTU</span>';
          } else {
            h+=' <span style="color:#ef4444;font-size:12px;font-weight:800">\u2717 KACTI</span>';
            h+=' <span style="font-size:11px;color:#5a6180">(Gercek: '+renkBadge(r.actual_color, false)+')</span>';
          }
          h+='</div>';
        }

        if(pf1.length>0){
          h+='<div class="lbl">TAHMIN 5 \u2014 1. Sayi Adaylari</div>';
          h+='<div class="nr">';
          pf1.forEach(function(n){
            var isFirst = n===parseInt(r.actual_first);
            h+='<div class="nb" style="background:'+(isFirst?'#14532d':'#1e2130')+';border:'+(isFirst?'2px solid #22c55e':'1px solid #3b82f6')+';color:'+(isFirst?'#22c55e':'#93c5fd')+'">'+n+'</div>';
          });
          h+='<span style="font-size:11px;color:'+(firstHitR?'#22c55e':'#ef4444')+';margin-left:6px;font-weight:800">'+(firstHitR?'\u2713 TUTTU':'\u2717 KACTI')+'</span>';
          h+='</div>';
        }

        if(af5.length>0){
          h+='<div class="lbl">GERCEK ILK 5</div>';
          h+='<div class="nr">';
          af5.forEach(function(n){
            h+='<div class="nb" style="background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd">'+n+'</div>';
          });
          h+='</div>';
        }

        if(pf5.length>0){
          h+='<div class="lbl">TAHMIN 6 \u2014 Ilk 5\'te Cikacak</div>';
          h+='<div class="nr">';
          pf5.forEach(function(n){
            var inIlk5 = af5.indexOf(n)!==-1;
            h+='<div class="nb" style="background:'+(inIlk5?'#14532d':'#2a3040')+';border:1px solid '+(inIlk5?'#22c55e':'#4a5270')+';color:'+(inIlk5?'#22c55e':'#aab0c4')+'">'+n+'</div>';
          });
          h+='<span style="font-size:11px;color:'+(f5m>0?'#22c55e':'#aab0c4')+';margin-left:6px;font-weight:800">'+f5m+'/5 tuttu</span>';
          h+='</div>';
        }

        if(pc8.length>0){
          h+='<div class="lbl">TAHMIN 8 \u2014 Kesin Cikacak &nbsp;<span style="color:#a855f7;font-weight:900">'+c8fm+'/8 tuttu (35 sayida)</span></div>';
          h+='<div class="nr">';
          pc8.forEach(function(n){
            var inIlk5 = af5.indexOf(n)!==-1;
            var inFull = aAll.indexOf(n)!==-1;
            var bg  = inIlk5 ? '#14532d' : inFull ? '#1a3a2a' : '#2a3040';
            var brd = inIlk5 ? '#22c55e' : inFull ? '#16a34a' : '#4a5270';
            var cl  = inIlk5 ? '#22c55e' : inFull ? '#4ade80' : '#aab0c4';
            h+='<div class="nb" style="background:'+bg+';border:1px solid '+brd+';color:'+cl+'">'+n+'</div>';
          });
          h+='</div>';
          h+='<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#14532d;border:1px solid #22c55e;vertical-align:middle"></span> Ilk5\'te cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1a3a2a;border:1px solid #16a34a;vertical-align:middle"></span> 35 sayida cikti</span>';
          h+='<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h+='</div>';
        }

        h+='<div class="mi">';
        h+='<div class="mc">6 aday \u2192 ilk5: <strong style="color:'+(f5m>0?'#22c55e':'#aab0c4')+'">'+f5m+'/5</strong></div>';
        h+='<div class="mc">8 aday \u2192 ilk5: <strong style="color:'+(c8m>0?'#22c55e':'#aab0c4')+'">'+c8m+'/5</strong></div>';
        h+='<div class="mc">8 aday \u2192 35 sayi: <strong style="color:'+(c8fm>=4?'#22c55e':c8fm>=2?'#facc15':'#aab0c4')+'">'+c8fm+'/8</strong></div>';
        h+='</div>';

        h+='</div>';
      });

      h+='</body></html>';
      res.type('html'); res.end(h);
    }).catch(function(e){res.status(500).send('Rapor hatasi: '+e.message);});
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
    h+='if(pr&&pr.over_under){';
    h+='var ou=pr.over_under;var oc=ou.pred==="OVER"?"#22c55e":"#ef4444";';
    h+='var bc=ou.pred==="OVER"?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)";';
    h+='var rno=(d.last200&&d.last200.length>0)?(d.last200[0].round+1):"?";';
    h+='h+="<div class=\'card\' style=\'border-color:"+bc+"\'>";';
    h+='h+="<div class=\'title\'>Round "+rno+" - Over / Under Tahmini</div>";';
    h+='h+="<div class=\'big\' style=\'color:"+oc+"\'>"+ou.pred+"</div>";';
    h+='h+="<div class=\'conf\'>Guven: %"+ou.conf+"</div>";';
    h+='if(ou.streak){';
    h+='var sc=ou.streak.count>=7?"#ef4444":ou.streak.count>=5?"#f97316":ou.streak.count>=3?"#facc15":"#aab0c4";';
    h+='var sbg=ou.streak.count>=7?"rgba(239,68,68,0.15)":ou.streak.count>=5?"rgba(249,115,22,0.15)":ou.streak.count>=3?"rgba(250,204,21,0.1)":"rgba(255,255,255,0.05)";';
    h+='h+="<div class=\'si\' style=\'background:"+sbg+";color:"+sc+";border:1px solid "+sc+"44\'>Mevcut Seri: "+ou.streak.type+" "+ou.streak.count+"x</div>";';
    h+='}h+="</div>";}';
    h+='else{h+="<div class=\'card\'><div class=\'title\'>Tahmin</div><div style=\'color:#facc15;padding:10px\'>Tahmin hesaplaniyor, bekleyin...</div></div>";}';
    h+='if(pr&&pr.color){var cl=pr.color;var pc=CH[cl.pred]||"#fff";';
    h+='h+="<div class=\'card\' style=\'border-color:"+pc+"66\'>";';
    h+='h+="<div class=\'title\'>Renk Tahmini</div>";';
    h+='h+="<div class=\'big\' style=\'color:"+pc+"\'>"+cl.pred+"</div>";';
    h+='h+="<div class=\'conf\'>Guven: %"+cl.conf+"</div>";';
    h+='h+="<div style=\'margin-top:12px\'><div class=\'title\'>Son 100 Cekilis Renk Dagilimi</div><div style=\'margin-top:6px\'>";';
    h+='["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"].forEach(function(cn){';
    h+='var cnt=(cl.counts&&cl.counts[cn])||0;var bg=CH[cn]||"#333";';
    h+='var op=cnt<=(100/8)*0.5?1:cnt<=(100/8)*0.8?0.65:0.3;';
    h+='h+="<span class=\'cb\' style=\'background:"+bg+";opacity:"+op+"\'>"+cn+" "+cnt+"</span>";';
    h+='});h+="</div></div></div>";}';
    h+='if(pr&&pr.first_candidates&&pr.first_candidates.length>0){';
    h+='h+="<div class=\'card\'><div class=\'title\'>Ilk Sayi - 5 Aday</div><div class=\'nums\'>";';
    h+='pr.first_candidates.forEach(function(n){h+="<div class=\'num\' style=\'background:#1e3a5f;border:2px solid #3b82f6\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(pr&&pr.first5_candidates&&pr.first5_candidates.length>0){';
    h+='h+="<div class=\'card\'><div class=\'title\'>Ilk 5te Cikacak - 6 Aday</div><div class=\'nums\'>";';
    h+='pr.first5_candidates.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a3040;border:1px solid #4a5270\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(pr&&pr.certain8&&pr.certain8.length>0){';
    h+='h+="<div class=\'card\'><div class=\'title\'>Kesin Cikacak - 8 Sayi</div><div class=\'nums\'>";';
    h+='pr.certain8.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a3040;border:1px solid #a855f7\'>"+n+"</div>";});';
    h+='h+="</div></div>";}';
    h+='if(d.stats){';
    h+='h+="<div class=\'card\'><div class=\'title\'>Istatistik ("+d.stats.total+" Round)</div>";';
    h+='h+="<div class=\'str\'><span class=\'over\'>OVER %"+d.stats.over_pct+"</span><span class=\'under\'>UNDER %"+d.stats.under_pct+"</span></div>";';
    h+='h+="<div class=\'bar\'><div class=\'bf\' style=\'width:"+d.stats.over_pct+"%;background:#22c55e\'></div></div></div>";}';
    h+='if(d.last200&&d.last200.length>0){';
    h+='h+="<div class=\'card\'><div class=\'title\'>Son 200 Cekilis</div>";';
    h+='h+="<div class=\'hdr\'><span>Round</span><span>1.S</span><span>Renk</span><span>O/U</span><span>Seri</span></div>";';
    h+='for(var i=0;i<d.last200.length;i++){';
    h+='var r=d.last200[i];var oc2=r.over_under==="OVER"?"#22c55e":"#ef4444";';
    h+='var rc=CH[r.color]||"#aaa";var streak=1;';
    h+='for(var j=i+1;j<d.last200.length;j++){if(d.last200[j].over_under===r.over_under)streak++;else break;}';
    h+='var sc2=streak>=7?"#ef4444":streak>=5?"#f97316":streak>=3?"#facc15":"#5a6180";';
    h+='h+="<div class=\'row\'>";';
    h+='h+="<span style=\'color:#aab0c4;font-size:11px\'>"+r.round+"</span>";';
    h+='h+="<span style=\'font-weight:900;font-size:14px\'>"+r.first+"</span>";';
    h+='h+="<span style=\'color:"+rc+";font-weight:700\'>"+r.color+"</span>";';
    h+='h+="<span style=\'color:"+oc2+";font-weight:900\'>"+r.over_under+"</span>";';
    h+='h+="<span style=\'color:"+sc2+";font-weight:800;font-size:11px\'>"+streak+"x</span>";';
    h+='h+="</div>";}h+="</div>";}';
    h+='h+="<div class=\'ref\'>Her 30 saniyede bir guncellenir</div>";';
    h+='document.getElementById("app").innerHTML=h;';
    h+='}catch(e){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>Hata: "+e.message+"</div>";}};';
    h+='x.onerror=function(){document.getElementById("app").innerHTML="<div style=\'color:#ef4444;padding:20px\'>/data hatasi</div>";};';
    h+='x.send();}load();setInterval(load,30000);';
    h+='</script></body></html>';
    res.type('html'); res.end(h);
  });

  app.listen(process.env.PORT || 3000, '0.0.0.0', function() { console.log('Dashboard: http://localhost:3000'); });
}

console.log('Basliyor...');