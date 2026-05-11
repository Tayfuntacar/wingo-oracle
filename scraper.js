require('dotenv').config();
var WebSocket = require('ws');
var https = require('https');
var express = require('express');
var cors = require('cors');
var { Client } = require('pg');

var DB_URL = process.env.DATABASE_URL || 'postgresql://wingo:wingo2026@localhost:5432/wingodb';

var colors = {1:'Sari',9:'Sari',17:'Sari',25:'Sari',33:'Sari',41:'Sari',2:'Yesil',10:'Yesil',18:'Yesil',26:'Yesil',34:'Yesil',42:'Yesil',3:'Mavi',11:'Mavi',19:'Mavi',27:'Mavi',35:'Mavi',43:'Mavi',4:'Kirmizi',12:'Kirmizi',20:'Kirmizi',28:'Kirmizi',36:'Kirmizi',44:'Kirmizi',5:'Kahve',13:'Kahve',21:'Kahve',29:'Kahve',37:'Kahve',45:'Kahve',6:'Turuncu',14:'Turuncu',22:'Turuncu',30:'Turuncu',38:'Turuncu',46:'Turuncu',7:'Siyah',15:'Siyah',23:'Siyah',31:'Siyah',39:'Siyah',47:'Siyah',8:'Mor',16:'Mor',24:'Mor',32:'Mor',40:'Mor',48:'Mor'};
var ALL_COLORS = ['Sari','Yesil','Mavi','Kirmizi','Kahve','Turuncu','Siyah','Mor'];
var COLOR_HEX = {'Sari':'#facc15','Yesil':'#22c55e','Mavi':'#3b82f6','Kirmizi':'#ef4444','Kahve':'#d97706','Turuncu':'#f97316','Siyah':'#9ca3af','Mor':'#a855f7'};

var db = new Client({ connectionString: DB_URL, ssl: false });
var lastProcessedWsRound = -1;
var globalPredCache = {};

function dbQuery(sql, params) {
  return db.query(sql, params).catch(function(e) {
    console.log('DB baglanti hatasi, yeniden baglaniliyor...', e.message);
    return db.end().catch(function(){}).then(function() {
      db = new Client({ connectionString: DB_URL, ssl: false });
      return db.connect();
    }).then(function() {
      console.log('DB yeniden baglandi!');
      return db.query(sql, params);
    });
  });
}

process.on('uncaughtException', function(e) { console.log('KRITIK HATA:', e.message, e.stack); });
process.on('unhandledRejection', function(e) { console.log('PROMISE HATASI:', e && e.message ? e.message : e); });

db.connect().then(function() {
  console.log('DB baglandi!');
  return dbQuery('CREATE TABLE IF NOT EXISTS draws (id SERIAL PRIMARY KEY, round INT UNIQUE, first INT, over_under VARCHAR(5), color VARCHAR(20), all_numbers TEXT, created_at TIMESTAMP DEFAULT NOW())');
}).then(function() {
  return dbQuery('CREATE TABLE IF NOT EXISTS predictions (id SERIAL PRIMARY KEY, round INT UNIQUE, pred_ou VARCHAR(5), pred_color VARCHAR(20), pred_first TEXT, pred_first5 TEXT, pred_certain8 TEXT, pred_certain6 TEXT, actual_first INT, actual_first5 TEXT, actual_color VARCHAR(20), actual_ou VARCHAR(5), ou_hit SMALLINT DEFAULT -1, color_hit SMALLINT DEFAULT -1, first_hit SMALLINT DEFAULT -1, first5_hit SMALLINT DEFAULT -1, certain8_hit SMALLINT DEFAULT -1, first5_match INT DEFAULT -1, certain8_match INT DEFAULT -1, certain8_full_match INT DEFAULT -1, certain6_match INT DEFAULT -1, created_at TIMESTAMP DEFAULT NOW())');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_first5 TEXT');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS first5_match INT DEFAULT -1');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_match INT DEFAULT -1');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain8_full_match INT DEFAULT -1');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_certain6 TEXT');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain6_match INT DEFAULT -1');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_certain7 TEXT');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS certain7_match INT DEFAULT -1');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pred_jackpot TEXT');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS actual_jackpot TEXT');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS jackpot_match INT DEFAULT -1');
}).then(function() {
  return dbQuery('ALTER TABLE draws ADD COLUMN IF NOT EXISTS week_number INT DEFAULT 0');
}).then(function() {
  return dbQuery('ALTER TABLE draws ADD COLUMN IF NOT EXISTS global_round BIGINT');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS week_number INT DEFAULT 0');
}).then(function() {
  return dbQuery('ALTER TABLE predictions ADD COLUMN IF NOT EXISTS global_round BIGINT');
}).then(function() {
  return dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS draws_global_round_idx ON draws(global_round)');
}).then(function() {
  return dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS predictions_global_round_idx ON predictions(global_round)');
}).then(function() {
  return dbQuery('CREATE TABLE IF NOT EXISTS round_uuids (id SERIAL PRIMARY KEY, round_number INT, round_uuid TEXT, start_datetime TEXT, ms_value INT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(round_number, round_uuid))');
}).then(function() {
  return dbQuery('ALTER TABLE round_uuids ADD COLUMN IF NOT EXISTS ms_value INT');
}).then(function() {
  console.log('Tablolar hazir!');
  return loadCacheFromDB();
}).then(function() {
  return backfillCertain6();
}).then(function() {
  return backfillJackpot();
}).then(function() {
  connect();
  startDashboard();
}).catch(function(e) { console.log('DB hatasi:', e.message); });

function backfillJackpot() {
  return dbQuery(
    "SELECT p.id, p.pred_jackpot, d.all_numbers FROM predictions p LEFT JOIN draws d ON p.round = d.round WHERE p.ou_hit != -1 AND p.pred_jackpot IS NOT NULL AND p.pred_jackpot != '' AND d.all_numbers IS NOT NULL AND (p.jackpot_match IS NULL OR p.jackpot_match = -1)"
  ).then(function(res) {
    if (res.rows.length === 0) { console.log('Jackpot backfill: guncellenecek kayit yok.'); return; }
    console.log('Jackpot backfill: ' + res.rows.length + ' kayit guncelleniyor...');
    var promises = res.rows.map(function(row) {
      var pJp = row.pred_jackpot.split(',').map(Number);
      var allNums = row.all_numbers.split(',').map(Number);
      var actualJp = [14,18,22,26,34].map(function(pos){ return pos < allNums.length ? allNums[pos] : null; }).filter(function(x){ return x !== null; });
      var jpMatch = actualJp.filter(function(n){ return pJp.indexOf(n) !== -1; }).length;
      var actualJpStr = actualJp.join(',');
      return dbQuery('UPDATE predictions SET actual_jackpot=$1, jackpot_match=$2 WHERE id=$3', [actualJpStr, jpMatch, row.id]);
    });
    return Promise.all(promises).then(function() { console.log('Jackpot backfill tamamlandi.'); });
  }).catch(function(e) { console.log('Jackpot backfill hatasi:', e.message); });
}

function backfillCertain6() {
  return dbQuery(
    "SELECT p.id, p.pred_certain6, d.all_numbers FROM predictions p LEFT JOIN draws d ON p.round = d.round WHERE p.ou_hit != -1 AND p.pred_certain6 IS NOT NULL AND p.pred_certain6 != '' AND d.all_numbers IS NOT NULL"
  ).then(function(res) {
    if (res.rows.length === 0) { console.log('Backfill: guncellenecek kayit yok.'); return; }
    console.log('Backfill: ' + res.rows.length + ' kayit certain6_match guncelleniyor...');
    var promises = res.rows.map(function(row) {
      var pc6 = row.pred_certain6.split(',').map(Number);
      var aAll = row.all_numbers.split(',').map(Number);
      var c6Match = aAll.filter(function(n) { return pc6.indexOf(n) !== -1; }).length;
      return dbQuery('UPDATE predictions SET certain6_match=$1 WHERE id=$2', [c6Match, row.id]);
    });
    return Promise.all(promises).then(function() { console.log('Backfill tamamlandi.'); });
  }).catch(function(e) { console.log('Backfill hatasi:', e.message); });
}

function loadCacheFromDB() {
  // Önce DB'den son week_number ve round bilgisini yükle
  return dbQuery("SELECT round, week_number, global_round FROM draws ORDER BY global_round DESC NULLS LAST, created_at DESC LIMIT 1")
  .then(function(wRes) {
    if (wRes.rows.length > 0 && wRes.rows[0].week_number !== null) {
      currentWeekNumber = parseInt(wRes.rows[0].week_number) || 0;
      // lastSeenRound sadece mevcut haftanın round'unu takip etmeli
      // Eğer DB'deki son round 1000'den büyükse (eski veri), -1 olarak başlat
      var dbRound = parseInt(wRes.rows[0].round) || -1;
      lastSeenRound = dbRound <= 400 ? dbRound : -1;
      console.log('Global round yuklu: week=' + currentWeekNumber + ' lastRound=' + lastSeenRound + ' (dbRound=' + dbRound + ')');
    }
    return dbQuery("SELECT round, first, over_under, color, all_numbers, created_at FROM draws WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 200");
  })
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

// ── GLOBAL ROUND TAKIBI (haftalık sıfırlamayı aşmak için) ──
var currentWeekNumber = 0;
var lastSeenRound = -1;
function calcGlobalRound(round) {
  if (lastSeenRound > 0 && round < lastSeenRound - 100) {
    currentWeekNumber++;
    console.log('YENİ HAFTA! Week:' + currentWeekNumber + ' ' + lastSeenRound + '->' + round);
  }
  lastSeenRound = round;
  return currentWeekNumber * 10000 + round;
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
                // UUID kaydet - ReceiveOfferUpdate
                if (j.target === 'ReceiveOfferUpdate' && j.arguments && j.arguments[0]) {
                  var offers = j.arguments[0];
                  offers.forEach(function(offer) {
                    var rNum = offer.number;
                    var rUuid = offer.roundId;
                    var rStart = offer.startDatetime || '';
                    // MS değerini startDatetime'dan çıkar (870463 kısmı)
                    var msVal = -1;
                    try { msVal = parseInt(rStart.split('.')[1].replace('Z','').substring(0,3)); } catch(e2) {}
                    dbQuery(
                      'INSERT INTO round_uuids (round_number, round_uuid, start_datetime, ms_value) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
                      [rNum, rUuid, rStart, msVal]
                    ).catch(function(e) { console.log('UUID kayit hata:', e.message); });
                  });
                  console.log('UUID kaydedildi: ' + offers.length + ' round');
                }
                if (j.target === 'ReceivePartialResult' && j.arguments && j.arguments[0] && j.arguments[0].ballNumbers && j.arguments[0].ballNumbers.length === 35) {
                  var a = j.arguments[0];

                  var wsRound = parseInt(a.number);
                  // Aynı global round'u tekrar işleme (hafta değişince aynı round no olabilir)
                  var wsGlobal = (currentWeekNumber * 10000) + wsRound;
                  // Yeni hafta tespiti: round büyük düşüş yaşadıysa hafta değişmiştir
                  if (lastSeenRound > 0 && wsRound < lastSeenRound - 100) {
                    wsGlobal = ((currentWeekNumber + 1) * 10000) + wsRound;
                  }
                  if (wsRound === lastProcessedWsRound && wsGlobal <= (currentWeekNumber * 10000 + lastSeenRound)) return;
                  lastProcessedWsRound = wsRound;
                  var first = parseInt(a.ballNumbers[0]);
                  var first5 = a.ballNumbers.slice(0, 6).map(Number);
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
  var globalRound = calcGlobalRound(round);
  var weekNum = currentWeekNumber;
  dbQuery(
    'INSERT INTO draws (round, first, over_under, color, all_numbers, created_at, week_number, global_round) VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7) ON CONFLICT DO NOTHING RETURNING id',
    [round, first, ou, renk, allNumsStr, weekNum, globalRound]
  ).then(function(ins) {
    if (ins.rows.length === 0) {
      console.log('Round ' + round + ' zaten var - tahmin guncelleniyor...');
    } else {
      console.log('Draw kaydedildi: Round ' + round + ' (global:' + globalRound + ' week:' + weekNum + ')');
    }
    // Once saveNextPrediction (certain6 yazar), sonra updatePredictions (certain6 okur)
    saveNextPrediction(round, globalRound, weekNum, function() {
      updatePredictions(round, first, first5, allNums, ou, renk);
    });
  }).catch(function(e) { console.log('Draw hatasi:', e.message); });
}

function updatePredictions(round, first, first5, allNums, ou, renk) {
  dbQuery('SELECT id, pred_ou, pred_color, pred_first, pred_first5, pred_certain8, pred_certain6, pred_certain7 FROM predictions WHERE round = $1', [round])
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
      var pc7         = row.pred_certain7 ? row.pred_certain7.split(',').map(Number) : [];
      var c7Match     = pc7.length > 0 ? allNums.filter(function(n) { return pc7.indexOf(n) !== -1; }).length : -1;
      // Jackpot: 15-19-23-27-35. pozisyonlardaki gerçek sayılar
      var actualJpNums = [14,18,22,26,34].map(function(pos){ return pos < allNums.length ? allNums[pos] : null; }).filter(function(x){ return x !== null; });
      var pJp = row.pred_jackpot ? row.pred_jackpot.split(',').map(Number) : [];
      var jpMatch = pJp.length > 0 ? actualJpNums.filter(function(n) { return pJp.indexOf(n) !== -1; }).length : -1;
      dbQuery(
        'UPDATE predictions SET actual_first=$1,actual_first5=$2,actual_color=$3,actual_ou=$4,ou_hit=$5,color_hit=$6,first_hit=$7,first5_hit=$8,certain8_hit=$9,first5_match=$10,certain8_match=$11,certain8_full_match=$12,certain6_match=$13,certain7_match=$14,actual_jackpot=$15,jackpot_match=$16 WHERE id=$17',
        [first, first5.join(','), renk, ou, ouHit, colorHit, firstHit, f5Hit, c8Hit, f5Match, c8Match, c8FullMatch, c6Match, c7Match, actualJpNums.join(','), jpMatch, row.id]
      ).then(function() {
        console.log('>>> Round ' + round + ' | OU:' + (ouHit?'TUTTU':'KACTI') + ' | Renk:' + (colorHit?'TUTTU':'KACTI') + ' | C6:' + c6Match + '/6 | C8:' + c8FullMatch + '/8 | JP:' + jpMatch + '/5');
      }).catch(function(e) { console.log('Update hatasi:', e.message); });
    });
  }).catch(function(e) { console.log('UpdatePred hatasi:', e.message); });
}

function saveNextPrediction(round, globalRound, weekNum, callback) {
  dbQuery("SELECT round, first, over_under, color, all_numbers, created_at FROM draws WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 200")
  .then(function(res) {
    var draws = res.rows;
    if (draws.length < 10) { console.log('Yeterli veri yok (' + draws.length + '/10)'); if (callback) callback(); return; }
    var pred;
    try { pred = predict(draws); } catch(e) { console.log('Predict hatasi:', e.message); if (callback) callback(); return; }
    if (!pred || !pred.over_under) { console.log('Tahmin uretilmedi'); if (callback) callback(); return; }
    globalPredCache = pred;
    var nextRound = round + 1;
    var nextGlobalRound = globalRound + 1;
    console.log('--- TAHMIN: Round ' + nextRound + ' (global:' + nextGlobalRound + ') -> ' + pred.over_under.pred + ' / ' + (pred.color ? pred.color.pred : '?') + ' ---');
    dbQuery(
      'INSERT INTO predictions (round,week_number,global_round,pred_ou,pred_color,pred_first,pred_first5,pred_certain8,pred_certain6,pred_certain7,pred_jackpot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',
      [nextRound, weekNum, nextGlobalRound,
       pred.over_under.pred,
       pred.color ? pred.color.pred : '',
       pred.first_candidates  ? pred.first_candidates.join(',')  : '',
       pred.first_candidates  ? pred.first_candidates.join(',')  : '',
       pred.certain8          ? pred.certain8.join(',')          : '',
       pred.certain6          ? pred.certain6.join(',')          : '',
       pred.certain7          ? pred.certain7.join(',')          : '',
       pred.jackpot           ? pred.jackpot.join(',')           : '']
    ).then(function() { console.log('Tahmin kaydedildi: Round ' + nextRound + ' (global:' + nextGlobalRound + ')'); if (callback) callback(); })
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

  // ── MS HAVUZU: DİNAMİK (son 15 çekilişten otomatik hesaplanır) ──
  // Test: 10-30 arası fark minimal, 15 en hızlı adaptasyon + yeterli örnek
  var msFP = {};   // ms → ilk sayı frekansı
  var msOU = {};   // ms → {OVER: n, UNDER: n}
  draws.slice(0, Math.min(15, n)).forEach(function(d, di) {
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

  // Dinamik MS_FIRST_POOL: her ms için top 5 ilk sayı
  var MS_FIRST_POOL = {};
  Object.keys(msFP).forEach(function(ms2) {
    var freq = msFP[ms2];
    var sorted2 = Object.keys(freq).map(Number).sort(function(a,b){return freq[b]-freq[a];});
    MS_FIRST_POOL[parseInt(ms2)] = sorted2.slice(0,5);
  });

  // Dinamik MS_OU_SIGNAL: %60+ olan ms'ler
  var MS_OU_SIGNAL = {};
  Object.keys(msOU).forEach(function(ms2) {
    var d2 = msOU[ms2];
    var tot2 = d2.OVER + d2.UNDER;
    if (tot2 < 8) return; // az veri varsa sinyal verme
    var overPct = d2.OVER / tot2 * 100;
    if (overPct >= 60) MS_OU_SIGNAL[parseInt(ms2)] = 'OVER';
    else if (overPct <= 40) MS_OU_SIGNAL[parseInt(ms2)] = 'UNDER';
  });

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
  // Gerçek geçiş: draws DESC sırada, [0]=en son — son 15 çekiliş
  for (var msi = 0; msi < Math.min(draws.length - 1, 15); msi++) {
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

  // ── MS REGIME CLASSIFIER (GPT önerisi) ──
  // LOW: UNDER + düşük first bias | HIGH: OVER + yüksek first bias | MID: nötr
  var msRegime = 'MID';
  if (predMs >= 958) msRegime = 'HIGH';
  else if (predMs <= 954 && predMs >= 950) msRegime = 'LOW';

  // ── LAST 2 DRAW TRANSITION / MEAN REVERSION (GPT önerisi) ──
  // Aynı bant 2 kez üst üste gelince ters banda geç (mean reversion)
  var last2TransBias = null; // 'HIGH_BAND' veya 'LOW_BAND'
  if (firstNums.length >= 2) {
    var f0 = firstNums[0]; // son çekiliş
    var f1 = firstNums[1]; // bir önceki
    var f2n = firstNums[2] || null; // iki önceki
    var f0High = f0 > 24;
    var f1High = f1 > 24;
    // İki üst üste aynı bant → karşı banda geç
    if (f0High && f1High) {
      last2TransBias = 'LOW_BAND';  // 25-48 → 1-24 bekleniyor
    } else if (!f0High && !f1High) {
      last2TransBias = 'HIGH_BAND'; // 1-24 → 25-48 bekleniyor
    }
    // Üç üst üste aynı bant çok nadir → sinyal daha güçlü
    if (f2n !== null) {
      var f2High = f2n > 24;
      if (f0High && f1High && f2High) {
        last2TransBias = 'LOW_BAND_STRONG';
      } else if (!f0High && !f1High && !f2High) {
        last2TransBias = 'HIGH_BAND_STRONG';
      }
    }
  }

  // ── RECENCY WEIGHTED CLUSTER (GPT önerisi) ──
  // Son 20 çekilişin tüm sayıları için decay ağırlıklı frekans
  var clusterFreq = {}; for (var ci = 1; ci <= 48; ci++) clusterFreq[ci] = 0;
  allNumsArr.slice(0, Math.min(20, n)).forEach(function(arr, idx) {
    var w = Math.exp(-0.1 * idx); // recency decay
    arr.forEach(function(num) {
      if (num >= 1 && num <= 48) clusterFreq[num] += w;
    });
  });
  // Cluster skorunu normalize et ve limit uygula (max 3 sayı aynı cluster'dan)
  var clusterSorted = Object.keys(clusterFreq).map(Number)
    .sort(function(a, b) { return clusterFreq[b] - clusterFreq[a]; });

  // ── SIFIR RENK SİNYALİ (son 10 turda) ──
  // 2414 çekiliş: 3 sıfır + en kısa bekleyen gelince %64 OVER
  var last10Colors = colorList.slice(0, Math.min(11, n));
  var colorCnt11 = {};
  ALL_COLORS.forEach(function(c){ colorCnt11[c] = 0; });
  last10Colors.forEach(function(c){ if(colorCnt11[c]!==undefined) colorCnt11[c]++; });
  var zeroColors = ALL_COLORS.filter(function(c){ return colorCnt11[c]===0; });
  var zeroCount = zeroColors.length;
  var zeroWaits = {};
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

  // ── OVER/UNDER: SERİ BAZLI + DÖNEM EĞİLİMİ + MS SİNYALİ + RENK SİNYALİ ──
  var streakOU = calcStreakOU(ouList);
  var predOU, ouConf, state = 'BALANCED';

  // Son 10 ve 20 çekilişin OVER oranı (dönem eğilimi)
  var ov10 = ouList.slice(0, Math.min(10, n)).filter(function(x) { return x === 'OVER'; }).length;
  var ov20 = ouList.slice(0, Math.min(20, n)).filter(function(x) { return x === 'OVER'; }).length;
  var pct10 = ov10 / Math.min(10, n);
  var pct20 = ov20 / Math.min(20, n);
  var trendPct = pct10 * 0.6 + pct20 * 0.4;

  // ── RENK BAZLI OU SİNYALLERİ (1500 çekiliş analizi) ──
  // Format: önceki N turda hangi renk hangi koşulda → şimdiki / gelecek tur sinyal
  var colorOUSignal = null; // 'OVER' veya 'UNDER'
  var colorOUConf   = 0;
  var colorOUState  = '';

  // Renk → sayı grupları (sinyal hesabı için)
  var CNU = {
    'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
    'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
    'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
  };

  function colorCount(numsArr, color) {
    if (!CNU[color] || !numsArr) return 0;
    return numsArr.filter(function(x){ return CNU[color].indexOf(x) !== -1; }).length;
  }

  // Son 2 çekilişin verileri
  var prevNums0 = allNumsArr[0] || []; // 1 tur önce
  var prevNums1 = allNumsArr[1] || []; // 2 tur önce
  var prevColor0 = colorList[0];       // 1 tur önceki ilk renk
  var prevColor1 = colorList[1];       // 2 tur önceki ilk renk

  var cnt0 = prevColor0 ? colorCount(prevNums0, prevColor0) : -1;
  var cnt1 = prevColor1 ? colorCount(prevNums1, prevColor1) : -1;

  // ── SİNYAL TABLOSU (test: 1500 çekiliş, fark >10 puan olanlar) ──
  // Sarı Full+İlk → +2. turda UNDER %76 (fark -28)
  if (cnt1 === 6 && prevColor1 === 'Sari') {
    colorOUSignal = 'UNDER'; colorOUConf = 76; colorOUState = 'SARI_FULL_ILK_+2';
  }
  // Yeşil Full+İlk → +2. turda OVER %69 (fark +17)
  else if (cnt1 === 6 && prevColor1 === 'Yesil') {
    colorOUSignal = 'OVER'; colorOUConf = 69; colorOUState = 'YESIL_FULL_ILK_+2';
  }
  // Yeşil Maks3+İlk → +1. turda UNDER %64 (fark -16)
  else if (cnt0 === 3 && prevColor0 === 'Yesil') {
    colorOUSignal = 'UNDER'; colorOUConf = 64; colorOUState = 'YESIL_MAKS3_ILK_+1';
  }
  // Mor Full+İlk → +1. ve +2. turda UNDER %39 (fark -13)
  else if ((cnt0 === 6 && prevColor0 === 'Mor') || (cnt1 === 6 && prevColor1 === 'Mor')) {
    colorOUSignal = 'UNDER'; colorOUConf = 61; colorOUState = 'MOR_FULL_ILK';
  }
  // Kırmızı Maks3+İlk → +1. ve +2. turda OVER %65 (fark +13)
  else if ((cnt0 === 3 && prevColor0 === 'Kirmizi') || (cnt1 === 3 && prevColor1 === 'Kirmizi')) {
    colorOUSignal = 'OVER'; colorOUConf = 65; colorOUState = 'KIRMIZI_MAKS3_ILK';
  }
  // Kırmızı Full+İlk → +1. turda UNDER %60 (fark -12)
  else if (cnt0 === 6 && prevColor0 === 'Kirmizi') {
    colorOUSignal = 'UNDER'; colorOUConf = 60; colorOUState = 'KIRMIZI_FULL_ILK_+1';
  }
  // Siyah Maks5+İlk → +2. turda OVER %62 (fark +10)
  else if (cnt1 === 5 && prevColor1 === 'Siyah') {
    colorOUSignal = 'OVER'; colorOUConf = 62; colorOUState = 'SIYAH_MAKS5_ILK_+2';
  }
  // Turuncu Maks3+İlk → +2. turda UNDER %61 (fark -13)
  else if (cnt1 === 3 && prevColor1 === 'Turuncu') {
    colorOUSignal = 'UNDER'; colorOUConf = 61; colorOUState = 'TURUNCU_MAKS3_ILK_+2';
  }
  // Mor Maks3+İlk → +2. ve +3. turda OVER %61 (fark +9)
  else if (cnt1 === 3 && prevColor1 === 'Mor') {
    colorOUSignal = 'OVER'; colorOUConf = 61; colorOUState = 'MOR_MAKS3_ILK_+2';
  }

  // ── KARAR MANTIĞI ──
  // Mor sonrası OVER sinyali (%58.4), Mor+UNDER sonrası %60.8
  var sig_mor_over = (prevColor0 === 'Mor');
  var sig_mor_under_over = (prevColor0 === 'Mor' && ouList[0] === 'UNDER');

  // Renk çifti OU sinyalleri (2652 çekiliş)
  var COLOR_PAIR_OU = {
    'Yesil_Yesil':  'OVER',   // %70.0 (n=40)
    'Yesil_Mor':    'OVER',   // %67.4 (n=43)
    'Mor_Mor':      'OVER',   // %66.7 (n=39)
    'Turuncu_Yesil':'UNDER',  // %67.3 (n=49)
  };
  var colorPairOuKey = (prevColor1||'') + '_' + (prevColor0||'');
  var colorPairOuSignal = COLOR_PAIR_OU[colorPairOuKey] || null;
  // MS OU sinyali
  var msOUSignal = null;
  if (predMs >= 0 && MS_OU_OVER[predMs])  { msOUSignal = 'OVER';  }
  if (predMs >= 0 && MS_OU_UNDER[predMs]) { msOUSignal = 'UNDER'; }

  if (streakOU.count >= 7) {
    predOU = streakOU.type === 'OVER' ? 'UNDER' : 'OVER'; ouConf = 92; state = 'REVERSAL';
  } else if (streakOU.count >= 5) {
    // 2414 çekiliş analizi: 5x OVER → %58.3 OVER (ters değil, seri devam!)
    predOU = streakOU.type; ouConf = 58; state = 'SERI_DEVAM';
  } else if (streakOU.count === 4) {
    // 4x UNDER sonrası %53.8 UNDER (seri devam)
    predOU = streakOU.type; ouConf = 55; state = 'TREND';
  } else if (streakOU.count === 3) {
    predOU = streakOU.type; ouConf = 55; state = 'TREND';
  } else {
    // 1-2x seri: MS OU sinyali en önce (en güçlü %65.6)
    if (msOUSignal) {
      predOU = msOUSignal; ouConf = 65; state = 'MS_OU_SIGNAL';
    } else if (zeroCount >= 3 && sig_mor_under_over) {
      predOU = 'OVER'; ouConf = 64; state = 'SIFIR_MOR_OVER';
    } else if (sig_mor_under_over) {
      predOU = 'OVER'; ouConf = 61; state = 'MOR_UNDER_OVER';
    } else if (colorPairOuSignal) {
      predOU = colorPairOuSignal; ouConf = 67; state = 'PAIR_OU';
    } else if (sig_mor_over) {
      predOU = 'OVER'; ouConf = 58; state = 'MOR_OVER';
    } else if (colorOUSignal) {
      predOU = colorOUSignal; ouConf = colorOUConf; state = colorOUState;
    } else if (trendPct > 0.62) {
      predOU = 'OVER'; ouConf = 58; state = 'TREND_OVER';
    } else if (trendPct < 0.38) {
      predOU = 'UNDER'; ouConf = 58; state = 'TREND_UNDER';
    } else {
      predOU = streakOU.type; ouConf = 52; state = 'BALANCED';
    }
  }

  // ── MS REGIME + LAST2TRANS OU DÜZELTME (GPT önerisi) ──
  // Mevcut sinyal zayıfsa (BALANCED/TREND) regime ve transition bias devreye girer
  if (state === 'BALANCED' || state === 'TREND_OVER' || state === 'TREND_UNDER') {
    if (msRegime === 'HIGH') {
      predOU = 'OVER'; ouConf = Math.max(ouConf, 56); state = 'MS_REGIME_HIGH';
    } else if (msRegime === 'LOW') {
      predOU = 'UNDER'; ouConf = Math.max(ouConf, 56); state = 'MS_REGIME_LOW';
    }
  }
  // Last2Trans: bant bias ile OU uyumuyorsa düzelt (güçlü sinyal)
  if (last2TransBias === 'HIGH_BAND_STRONG') {
    predOU = 'OVER'; ouConf = Math.max(ouConf, 60); state = 'L2T_HIGH_STRONG';
  } else if (last2TransBias === 'LOW_BAND_STRONG') {
    predOU = 'UNDER'; ouConf = Math.max(ouConf, 60); state = 'L2T_LOW_STRONG';
  } else if (last2TransBias === 'HIGH_BAND' && (state === 'BALANCED' || state === 'MS_REGIME_LOW')) {
    predOU = 'OVER'; ouConf = Math.max(ouConf, 54); state = 'L2T_HIGH';
  } else if (last2TransBias === 'LOW_BAND' && (state === 'BALANCED' || state === 'MS_REGIME_HIGH')) {
    predOU = 'UNDER'; ouConf = Math.max(ouConf, 54); state = 'L2T_LOW';
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

  // Uzun gelmemezlik bonusu (2414 çekiliş analizi)
  // Kahve 30+ tur → %31.6, Mor 30+ → %16.7, Sarı 30+ → %15.5
  // Max gelmemezlik: Mavi 67, Siyah 65, Kırmızı 64 tur
  var LONG_WAIT_BONUS = {'Kahve': 3.0, 'Mor': 1.5, 'Sari': 1.3, 'Yesil': 1.0,
                         'Turuncu': 1.0, 'Siyah': 0.8, 'Kirmizi': 0.8, 'Mavi': 0.8};

  var cs = {};
  ALL_COLORS.forEach(function(c) {
    var baseScore = Math.max(0, 25 - colorCounts[c]) * 3 + Math.min(colorLastSeen[c], 50) * 1.5 + markovCS[c] * 2.5;
    // Uzun gelmemezlik bonusu: 25+ turdur gelmeyene bonus
    var waitBonus = 0;
    if (colorLastSeen[c] >= 35) {
      waitBonus = (colorLastSeen[c] - 34) * (LONG_WAIT_BONUS[c] || 1.0) * 2;
    } else if (colorLastSeen[c] >= 25) {
      waitBonus = (colorLastSeen[c] - 24) * (LONG_WAIT_BONUS[c] || 1.0) * 1.0;
    }
    cs[c] = baseScore + waitBonus;
  });

  // En uzun bekleyen rengi tespit et (sinyal için)
  var maxWaitColor = ALL_COLORS.slice().sort(function(a,b){ return colorLastSeen[b]-colorLastSeen[a]; })[0];
  var maxWait = colorLastSeen[maxWaitColor];

  // Sıfır renk bonusu: son 10'da sıfır olan renkler daha kısa bekleme süresiyle bonus alır
  if (zeroColors.length >= 3) {
    zeroColors.forEach(function(zc) {
      var zWait = zeroWaits[zc] || 999;
      // En kısa bekleyene en yüksek bonus
      var zBonus = zc === shortestZeroColor ? 25 : Math.max(0, 20 - (zWait - 11) * 0.5);
      cs[zc] = (cs[zc] || 0) + zBonus;
    });
  }

  var predColor = coldColors.length > 0
    ? coldColors.sort(function(a, b) { return colorLastSeen[b] - colorLastSeen[a]; })[0]
    : ALL_COLORS.slice().sort(function(a, b) { return cs[b] - cs[a]; })[0];
  var colorConf = coldColors.length >= 3 ? 68 : coldColors.length === 2 ? 55 : 42;
  // Uzun bekleme sinyali varsa güven artır
  if (maxWait >= 35) colorConf = Math.min(colorConf + 10, 80);
  result.color = { pred: predColor, conf: colorConf, counts: colorCounts, state: state,
                   maxWaitColor: maxWaitColor, maxWait: maxWait };

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

  // İlk sayı renk filtresi: Sarı/Siyah/Yeşil → güvenilir (%58.9/%22.5/%18.5 hit)
  // Diğer renklerde hit=%0 → ms bonusunu yarıya indir
  var firstColorReliable = (predColor === 'Sari' || predColor === 'Siyah' || predColor === 'Yesil');
  var msBonusMultiplier  = firstColorReliable ? 2.0 : 0.5;

  var ns = {};
  for (var i = 1; i <= 48; i++) {
    ns[i] = firstFreq[i] / maxFq * 100 * 0.25
           + Math.min(firstLS[i], 30) / 30 * 100 * 0.25
           + (rec20.indexOf(i) === -1 ? 25 : 0) * 0.20
           + nmScore[i] * 0.15
           + msBonus[i] * 0.15 * msBonusMultiplier;
  }
  var allC = []; for (var i = 1; i <= 48; i++) allC.push(i);
  allC.sort(function(a, b) { return ns[b] - ns[a]; });

  // ── LAST2TRANS + MS REGIME FIRST BAND BIAS (GPT önerisi) ──
  // Hangi bant bekleniyor? buna göre filtrele
  var preferHighBand = null;
  if (last2TransBias === 'HIGH_BAND_STRONG' || last2TransBias === 'HIGH_BAND') preferHighBand = true;
  if (last2TransBias === 'LOW_BAND_STRONG'  || last2TransBias === 'LOW_BAND')  preferHighBand = false;
  // MS regime ile destekle (bias yoksa devreye girer)
  if (preferHighBand === null) {
    if (msRegime === 'HIGH') preferHighBand = true;
    else if (msRegime === 'LOW') preferHighBand = false;
  }

  // ── FIRST8: %100 kendi renginden geliyor (4315 çekiliş analizi) ──
  var COLOR_NUMS_FIRST = {
    'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
    'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
    'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
  };
  var MS_RENK_FIRST = {
    '957_Turuncu':30,'956_Mor':32,'957_Mor':40,
    '958_Siyah':31,'959_Turuncu':30,'958_Mavi':27,'957_Yesil':26,
    '960_Mavi':27,'960_Turuncu':27,'961_Kirmizi':12,'961_Turuncu':6
  };
  // 7400+ analiz: MS=959 -> 30, MS=960 -> 27, MS=961 -> 12 (en güçlü sinyaller)
  var MS_STRONG_FIRST = {959:30, 960:27, 961:12};

  // Önceki first -> bu tur first geçiş (7400+ analiz, rastgelenin 3-4 katı)
  var FIRST_TRANSITION = {12:32,27:37,25:2,26:46,42:19,32:2,34:5,7:17,20:4,35:31,36:43};

  // Renk doygunluğu (4+) sonrası en çok çıkan first sayılar
  var COLOR_SAT_FIRST = {
    'Kahve':[6,13,46,25,29],'Kirmizi':[39,28,32,29,26],
    'Yesil':[10,19,33,37,43],'Turuncu':[31,38,16,14,35],
    'Mavi':[10,43,27,35,29],'Siyah':[21,29,45,30,48],
    'Mor':[36,7,43,40,23],'Sari':[27,13,31,34,35]
  };

  var msRenkFirstKey = predMs + '_' + predColor;
  var msRenkFirstNum = MS_RENK_FIRST[msRenkFirstKey] || MS_STRONG_FIRST[predMs] || null;
  var colorNumsFirst = COLOR_NUMS_FIRST[predColor] || [];

  // OU filtresini uygula
  var filtByOU = colorNumsFirst.filter(function(x){ return predOU==='OVER'?x>24:x<=24; });
  if (filtByOU.length < 3) filtByOU = colorNumsFirst; // uyuşmazsa tümünü al

  // NS skoruna göre sırala
  var filtC = filtByOU.slice().sort(function(a,b){ return ns[b]-ns[a]; });

  // MS+Renk sinyali varsa başa al
  if (msRenkFirstNum) {
    var mIdx = filtC.indexOf(msRenkFirstNum);
    if (mIdx > 0) { filtC.splice(mIdx,1); filtC.unshift(msRenkFirstNum); }
    else if (mIdx === -1) { filtC.unshift(msRenkFirstNum); }
  }

  // 8'e tamamla — diğer sayılardan ekle
  for (var ai=0; filtC.length<8 && ai<allC.length; ai++) {
    if (filtC.indexOf(allC[ai])===-1) filtC.push(allC[ai]);
  }

  result.first_candidates  = filtC.slice(0,8).sort(function(a,b){return a-b;});
  result.first5_candidates = filtC.slice(0,8).sort(function(a,b){return a-b;});
  result.firstColorReliable = firstColorReliable;

  // ── SICAK SAYI BONUSU (son 3 turda 3+ kez → %98 sonraki 3 turda gelir) ──
  var hotNums = {};
  var recent3Nums = [];
  allNumsArr.slice(0,3).forEach(function(arr){ recent3Nums = recent3Nums.concat(arr); });
  var numFreq3 = {};
  recent3Nums.forEach(function(x){ numFreq3[x] = (numFreq3[x]||0)+1; });
  for (var hk in numFreq3) {
    if (numFreq3[hk] >= 3) hotNums[hk] = 1;
  }

  // ── TEKRAR ORANLARI: 1362 çekiliş analizi ──
  var REPEAT_RATE = {1:0.7358,2:0.7703,3:0.7333,4:0.7162,5:0.7092,6:0.7168,7:0.7476,8:0.7341,9:0.7186,10:0.6950,11:0.7275,12:0.7245,13:0.7127,14:0.7331,15:0.7357,16:0.7072,17:0.7464,18:0.7054,19:0.7360,20:0.7104,21:0.7324,22:0.7400,23:0.7299,24:0.7569,25:0.7583,26:0.7304,27:0.7252,28:0.6969,29:0.7300,30:0.7470,31:0.7027,32:0.7411,33:0.7605,34:0.7024,35:0.7213,36:0.7437,37:0.7159,38:0.7512,39:0.7447,40:0.7250,41:0.7222,42:0.7353,43:0.7244,44:0.7183,45:0.7289,46:0.7387,47:0.7440,48:0.7098};

  // ── RENK SONRASI İLK SAYI HAVUZU: 1362 çekiliş ──
  // COLOR_FIRST_POOL: 2414 çekiliş analizi (güncel)
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

  // Renk doygunluk sinyali: önceki turda bir renk 4+ sayı çıkardıysa
  // o rengin saturation sonrası first adaylarını öne al
  (function() {
    var prevF15 = allNumsArr[0] ? allNumsArr[0].slice(0,15) : [];
    var prevF15Set = {};
    prevF15.forEach(function(x){ prevF15Set[x]=1; });
    var COLOR_NUMS_ALL = {
      'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
      'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
      'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
    };
    ALL_COLORS.forEach(function(color) {
      var cnt = (COLOR_NUMS_ALL[color]||[]).filter(function(x){ return prevF15Set[x]; }).length;
      if (cnt >= 4 && COLOR_SAT_FIRST[color]) {
        // Bu renk doydu - saturation sonrası first adaylarını NS'ye ekle
        COLOR_SAT_FIRST[color].forEach(function(n, i) {
          if (ns[n] !== undefined) ns[n] += (5-i) * 3;
        });
      }
    });

    // Önceki first sayısına göre geçiş bonusu
    var prevFirstNum = allNumsArr[0] && allNumsArr[0].length > 0 ? allNumsArr[0][0] : null;
    if (prevFirstNum) {
      var transTarget = FIRST_TRANSITION[prevFirstNum];
      if (transTarget && ns[transTarget] !== undefined) {
        ns[transTarget] += 20; // güçlü geçiş sinyali
      }
    }
  })();

  // ── SİNYAL TESPİTİ: 1900 çekiliş analizinden ──
  // C6 güçlü ms (6/6 oranı %15+)
  // 2414 çekiliş analizinden güncellendi
  // C6 güçlü ms (6/6 oranı %15+): ms=958(%22.7), ms=964(%23.3), ms=949(%18.2), ms=953(%18.3), ms=952(%14.9)
  var MS_66_SIGNAL = {964:23.3, 958:22.7, 949:18.2, 953:18.3, 952:14.9, 961:15.2};
  // C8 güçlü ms (8/8 oranı %8+): ms=958(%13.6), ms=964(%11.7), ms=949(%9.9), ms=952(%9.2), ms=953(%9.0)
  var MS_88_SIGNAL = {958:13.6, 964:11.7, 949:9.9, 952:9.2, 953:9.0, 961:9.1};
  // C8 zayıf ms (8/8 oranı %5 altı)
  var MS_BAD_88    = {948:1, 960:1, 962:1, 965:1, 956:1, 963:1};
  // C6 zayıf ms (6/6 oranı %10 altı): ms=960(%4.3), ms=965(%8.3), ms=956(%11.0 sınırda)
  var MS_BAD_66    = {960:1, 962:1, 965:1};
  // C7 güçlü ms (7/7 oranı %13+): 2414 çekiliş analizi
  // ms=948(%15.4), ms=959(%15.2), ms=961(%15.2), ms=962(%13.0), ms=964(%13.3)
  var MS_77_SIGNAL = {948:15.4, 959:15.2, 961:15.2, 962:13.0, 964:13.3, 966:20.0};
  // C7 zayıf ms (7/7 oranı %8 altı)
  var MS_BAD_77    = {956:1, 954:1, 963:1};
  // Zayıf dönem: ms=960(%4.3 C6), ms=962(%8.7), ms=965(%8.3)
  var MS_WEAK_PERIOD = {960:1, 962:1, 965:1};
  // OU sinyali: ms=959-965 OVER ağırlıklı (%65.6), ms=948/957 UNDER ağırlıklı (%65.7)
  var MS_OU_OVER  = {959:1, 960:1, 961:1, 962:1, 965:1, 966:1};
  var MS_OU_UNDER = {948:1, 957:1};
  // Uzun bekleyen renk geri dönüş OU eğilimleri
  var LONG_WAIT_OU_OVER  = ['Sari','Yesil','Kahve','Turuncu']; // %55-65 OVER
  var LONG_WAIT_OU_UNDER = ['Mavi','Kirmizi','Siyah','Mor'];   // %54-59 UNDER

  // OU son 3 tur sinyali
  var ou3str = ouList.slice(0,Math.min(3,n)).map(function(x){return x==='OVER'?'O':'U';}).join('');
  var sig_uou = (ou3str==='UOU');
  var sig_uuu = (ou3str==='UUU');

  // Önceki renk sinyalleri
  var prevColor = colorList[0];
  var prevColor2 = colorList[1] || '';
  var prevOU = ouList[0] || '';
  var sig_siyah_prev   = (prevColor==='Siyah');
  var sig_turuncu_prev = (prevColor==='Turuncu');
  var sig_kahve_prev   = (prevColor==='Kahve');

  // Önceki çekilişlerin renk doluluk sayıları (sinyal için)
  var prevNums0 = allNumsArr[0] || [];
  var prevNums1 = allNumsArr[1] || [];

  function cntColor(numsArr, color) {
    if (!COLOR_NUMS_7 || !COLOR_NUMS_7[color]) return 0;
    return numsArr.filter(function(x){ return COLOR_NUMS_7[color].indexOf(x) !== -1; }).length;
  }

  var cnt0 = prevColor  ? cntColor(prevNums0, prevColor)  : -1;
  var cnt1 = prevColor2 ? cntColor(prevNums1, prevColor2) : -1;

  // C6 renk sinyalleri (önceki renk full/zayıf)
  // C6 badge: 2414 çekiliş analizi
  // Siyah FULL → %23.8 (genel %13), Kırmızı ve Kahve önce renk, Siyah güçlü
  var siyahFull = (cnt0===6 && prevColor==='Siyah');   // %23.8 → ÇOK GÜÇLÜ
  var sig_c6_strong = (prevColor==='Siyah' || prevColor==='Kahve' || prevColor==='Kirmizi');
  var sig_c6_weak   = false;  // Kırmızı FULL paradoksu: aslında zayıf değil (%14.6)

  // C8 renk sinyalleri
  var sig_c8_strong = (cnt0===6 && (prevColor==='Siyah' || prevColor==='Turuncu')); // 8/8 +%4-4
  var sig_c8_weak   = (cnt0===6 && (prevColor==='Kirmizi' || prevColor==='Mor'));   // 8/8 -%3-4

  // C7 renk sinyalleri - 2414 çekiliş analizi
  // GÜÇLÜ: Yeşil cnt3(%18.9), Mor cnt3(%15.6), Turuncu cnt4(%15.1), Kahve cnt6(%15.4)
  // ZAYIF: Kırmızı cnt6(%0.0), Kırmızı cnt3(%3.6), Sarı cnt3(%3.6), Siyah cnt3(%4.3)
  var sig_c7_strong = (
    (cnt0===3 && prevColor==='Yesil')   ||   // %18.9
    (cnt0===3 && prevColor==='Mor')     ||   // %15.6
    (cnt0===6 && prevColor==='Kahve')   ||   // %15.4
    (cnt0===4 && prevColor==='Turuncu')      // %15.1
  );
  var sig_c7_weak = (
    (cnt0===6 && prevColor==='Kirmizi') ||   // %0.0 KESİN ZAYIF
    (cnt0===3 && prevColor==='Kirmizi') ||   // %3.6
    (cnt0===3 && prevColor==='Sari')    ||   // %3.6
    (cnt0===3 && prevColor==='Siyah')   ||   // %4.3
    (cnt0===4 && prevColor==='Mor')     ||   // %6.9
    (cnt0===4 && prevColor==='Yesil')        // %6.7
  );

  // Ms değişimi
  var msDiff2 = (lastMs>=0 && predMs>=0) ? (predMs-lastMs) : 999;
  var sig_ms_minus1 = (msDiff2===-1);

  // Renk ilk sayı bonusunu ms bonusuna ekle
  var colorPool = COLOR_FIRST_POOL[prevColor] || [];
  colorPool.forEach(function(num, rank) {
    msBonus[num] = (msBonus[num]||0) + (5-rank)*6;
  });

  // Sıcak sayı bonusu
  for (var hn in hotNums) {
    msBonus[parseInt(hn)] = (msBonus[parseInt(hn)]||0) + 20;
  }

  // ── RENK ÇİFTİ BONUS (doğrulanmış: Turuncu→Siyah→25 %94.4) ──
  var COLOR_PAIR_BONUS = {
    'Turuncu_Siyah': [25],    // %94.4
    'Siyah_Mor':     [24],    // %82.1
    'Kirmizi_Siyah': [15],    // %85.7
    'Turuncu_Kirmizi':[22],   // %85.7
    'Siyah_Siyah':   [5],     // %88.1
    'Mor_Yesil':     [12],    // %88.1
    'Yesil_Mor':     [11],    // %85.0
  };

  // ── UZUN BEKLEME GERİ DÖNÜŞ SİNYALİ ──
  // 15+ tur bekleyen renk, hangi önceki renkten sonra geliyor?
  // colorLastSeen ile uzun bekleyeni tespit edip renk skoruna bonus ver
  var LONG_WAIT_TRIGGER = {
    'Siyah':   ['Mavi'],          // Mavi gelince Siyah %34.1
    'Sari':    ['Kahve'],         // Kahve gelince Sarı %24.4
    'Kirmizi': ['Sari','Turuncu'],// Sarı/Turuncu gelince Kırmızı %21.7/%19.6
    'Kahve':   ['Sari','Mor'],    // Sarı/Mor gelince Kahve %23.7/%21.1
    'Turuncu': ['Mor','Siyah'],   // Mor/Siyah gelince Turuncu %18.2
    'Mavi':    ['Kahve','Yesil'], // Kahve/Yeşil gelince Mavi %20
    'Yesil':   ['Kirmizi','Mor'], // Kırmızı/Mor gelince Yeşil %18.9/%16.2
    'Mor':     ['Turuncu','Siyah','Yesil','Mavi'], // Eşit dağılmış
  };
  // Uzun bekleyen + tetikleyici renk varsa güçlü bonus
  ALL_COLORS.forEach(function(c) {
    if (colorLastSeen[c] >= 15) {
      var triggers = LONG_WAIT_TRIGGER[c] || [];
      if (triggers.indexOf(lastColor) !== -1) {
        // Tetikleyici geldi, uzun bekleyen renge güçlü bonus
        var waitBonus = Math.min((colorLastSeen[c] - 14) * 3, 30);
        cs[c] = (cs[c] || 0) + waitBonus;
      }
    }
  });
  var pairKey = (prevColor1||'') + '_' + (prevColor0||'');
  var pairBonus = COLOR_PAIR_BONUS[pairKey] || [];
  pairBonus.forEach(function(num) {
    msBonus[num] = (msBonus[num]||0) + 40; // Güçlü bonus
  });

  // ── MS + RENK KOMBİNASYON BONUSU (doğrulanmış %90+) ──
  var MS_RENK_BONUS = {
    '955_Siyah':   [47],      // %91.4
    '956_Sari':    [20,42],   // %90.0
    '952_Siyah':   [9,23,32], // %90.3
    '953_Yesil':   [38],      // %91.7
    '957_Siyah':   [32,47],   // %90.3
    '956_Mor':     [32],      // %90.2
    '954_Mor':     [26],      // %90.0
    '956_Yesil':   [30],      // %90.0
    '953_Siyah':   [15],      // %91.1
    '958_Kahve':   [36],      // %100 (n=23)
    '957_Sari':    [47],      // %96.3 (n=27)
    '959_Turuncu': [44],      // %96.0 (n=25)
    '958_Mavi':    [23],      // %100 (n=18)
    '958_Kirmizi': [23],      // %95.2 (n=21)
    '956_Sari':    [9,20,42], // %100 (n=21) - güncellendi
  };

  // MS→MS geçiş bonusu (önceki ms + şimdiki ms → sayı)
  var MS_MS_BONUS = {
    '957_955': [37],   // %97.1 (n=34) EN GÜÇLÜ
    '958_959': [6],    // %100 (n=16)
    '958_955': [21,48],// %100 (n=16)
    '954_957': [9],    // %100 (n=17)
    '959_955': [31],   // %100 (n=14)
    '959_960': [13],   // %100 (n=12)
    '956_952': [7],    // %100 (n=14)
    '953_957': [2],    // %100 (n=15)
    '951_952': [25],   // %95.2 (n=21)
    '958_958': [43],   // %95.7 (n=23)
  };
  var msMsKey = lastMs + '_' + predMs;
  var msMsNums = MS_MS_BONUS[msMsKey] || [];
  msMsNums.forEach(function(num) {
    msBonus[num] = (msBonus[num]||0) + 45; // Çok güçlü bonus
  });
  var msRenkKey = predMs + '_' + prevColor0;
  var msRenkNums = MS_RENK_BONUS[msRenkKey] || [];
  msRenkNums.forEach(function(num) {
    msBonus[num] = (msBonus[num]||0) + 35;
  });

  // Güçlü sinyal sayısı - C6/C8
  var strongSig66=0, strongSig88=0;
  if (predMs>=0 && MS_66_SIGNAL[predMs]) strongSig66++;
  if (predMs>=0 && MS_88_SIGNAL[predMs]) strongSig88++;
  if (sig_uou)          { strongSig66++; strongSig88++; }
  if (sig_uuu)          strongSig88++;
  if (sig_siyah_prev)   { strongSig66++; strongSig88++; }
  if (sig_turuncu_prev) strongSig88++;
  if (sig_kahve_prev)   strongSig66++;
  if (sig_ms_minus1)    strongSig66++;
  if (sig_c6_strong)    strongSig66++;
  if (sig_c8_strong)    strongSig88++;
  if (siyahFull)         { strongSig66 += 2; } // Siyah full %23.8 → ÇOK GÜÇLÜ

  var badMs88 = (predMs>=0 && MS_BAD_88[predMs]) || sig_c8_weak;
  var badMs66 = (predMs>=0 && MS_BAD_66[predMs]) || sig_c6_weak;
  var weakPeriod = (predMs>=0 && MS_WEAK_PERIOD[predMs]);

  // C7 sinyal durumu
  var sig77 = (predMs>=0 && MS_77_SIGNAL[predMs]) ? 1 : 0;
  if (sig_c7_strong) sig77++;
  var badMs77 = (predMs>=0 && MS_BAD_77[predMs]) || sig_c7_weak;

  // ── RENK+OU ÖZEL GRUPLARI (doğrulanmış %17-20 6/6) ──
  // ── RENK+OU ÖZEL C6 GRUPLARI (750 tahmin + 2414 çekiliş doğrulanmış) ──
  var RENK_OU_C6 = {
    'Siyah_UNDER':   [23,40,39,11,38,47],  // %22.2 6/6 ★ EN İYİ
    'Mor_UNDER':     [12,27,35,36,48,43],  // %19.6 6/6
    'Turuncu_UNDER': [34,42,14,11,10,15],  // %16.3 6/6
    'Mavi_OVER':     [1,17,9,8,43,16],     // %17.3 6/6
    'Sari_UNDER':    [9,17,8,1,2,43],      // %19.9 6/6
    'Kahve_UNDER':   [2,5,22,39,46,47],    // %16.7 6/6
  };
  // Önceki renk bazlı C6 (renk+OU yoksa)
  var PREV_RENK_C6 = {
    'Siyah':   [18,3,9,5,33,22],    // %19.5 6/6
    'Kirmizi': [14,31,34,5,13,40],  // %18.4 6/6
    'Mavi':    [40,41,10,13,6,34],  // %17.5 6/6
    'Sari':    [46,27,35,36,43,48], // %16.3 6/6
    'Turuncu': [26,6,16,22,12,5],   // %14.0 6/6
    'Mor':     [31,40,23,8,24,15],  // %13.9 6/6
  };
  // Renk bazlı C6 (şimdiki renk, fallback)
  var RENK_C6 = {
    'Siyah':   [11,15,23,39,46,47],
    'Turuncu': [2,11,30,38,39,47],
    'Yesil':   [11,15,34,39,42,47],
    'Mor':     [6,39,40,41,46,47],
  };
  // Renk+OU C7 grupları
  var RENK_OU_C7 = {
    'Siyah_UNDER':   [23,40,39,11,38,47,15],
    'Mor_UNDER':     [12,27,35,36,48,43,24],
    'Turuncu_UNDER': [34,42,14,11,10,15,6],
    'Mavi_OVER':     [1,17,9,8,43,16,27],
    'Sari_UNDER':    [9,17,8,1,2,43,25],
    'Kahve_UNDER':   [2,5,22,39,46,47,13],
  };
  // Renk çifti C7 grupları (doğrulanmış)
  var PAIR_C7 = {
    'Mavi_Mavi':     [2,6,32,39,44,46,47],  // %31.6 7/7
    'Yesil_Siyah':   [6,11,31,38,39,46,47], // %17.6 7/7
    'Kirmizi_Siyah': [1,10,11,15,39,46,47], // %14.3 7/7
    'Mor_Kahve':     [4,6,11,39,42,46,47],  // %14.3 7/7
  };
  var renkOuKey = (predColor||'') + '_' + (predOU||'');
  var specialC6 = RENK_OU_C6[renkOuKey] || null;

  // ── KESİN 6 + KESİN 8: TEKRAR ORANI + SİNYAL ──
  // 2414 çekiliş analizi: S8 (3xC8 + 3xC7) en iyi 6/6 = %14.4
  var prevNums = allNumsArr[0] && allNumsArr[0].length>0 ? allNumsArr[0] : [];
  var c6Scored = prevNums.slice().sort(function(a,b){return (REPEAT_RATE[b]||0.72)-(REPEAT_RATE[a]||0.72);});

  // ── MS BAZLI OPTİMAL C8 GRUPLARI (2652 çekiliş analizi) ──
  var MS_C8 = {
    951:  [46,28,40,2,47,1,27,11],   // 8/8=%17.3
    959:  [14,22,2,41,33,34,6,44],   // 8/8=%16.2
    962:  [11,39,4,8,23,28,1,33],    // 8/8=%20.0
    964:  [13,48,23,19,40,21,4,47],  // 8/8=%25.0
    957:  [47,14,25,12,36,39,26,46], // 8/8=%12.8
    961:  [8,40,24,39,20,28,26,46],  // 8/8=%12.8
  };
  // MS+OU bazlı optimal C8
  var MS_OU_C8 = {
    '961_OVER':  [8,40,45,43,15,24,3,10],   // 8/8=%45.0
    '960_UNDER': [47,38,2,5,16,41,24,46],   // 8/8=%35.7
    '962_OVER':  [43,18,4,23,36,28,46,9],   // 8/8=%31.2
    '959_UNDER': [22,23,24,35,2,44,18,4],   // 8/8=%27.6
    '951_OVER':  [8,28,39,10,47,25,40,27],  // 8/8=%25.7
    '951_UNDER': [46,11,2,3,1,19,40,14],    // 8/8=%25.0
    '959_OVER':  [14,47,41,2,13,33,22,6],   // 8/8=%15.4
    '961_UNDER': [20,24,39,38,26,35,2,27],  // 8/8=%15.8
  };
  // MS+Renk bazlı optimal C8 (en güçlüler)
  var MS_RENK_C8 = {
    '959_Mavi':     [6,35,2,12,13,34,33,44],   // 8/8=%47.4
    '952_Turuncu':  [15,20,5,24,34,8,30,27],   // 8/8=%40.0
    '959_Turuncu':  [44,6,12,36,22,42,33,41],  // 8/8=%37.5
    '958_Sari':     [46,3,29,28,9,12,4,43],    // 8/8=%36.8
    '958_Yesil':    [5,1,32,21,16,3,19,34],    // 8/8=%35.3
    '953_Mor':      [43,42,2,17,34,44,13,24],  // 8/8=%34.2
    '952_Mavi':     [24,12,21,10,47,26,17,30], // 8/8=%33.3
    '957_Turuncu':  [39,14,12,7,8,29,26,10],   // 8/8=%32.0
    '952_Kirmizi':  [46,19,24,47,20,9,5,6],    // 8/8=%30.0
    '957_Sari':     [47,33,41,24,44,12,16,48], // 8/8=%29.6
    '956_Siyah':    [47,45,11,38,40,46,17,16], // 8/8=%29.0
    '952_Siyah':    [32,3,14,37,31,9,30,2],    // 8/8=%28.1
    '957_Kirmizi':  [43,47,3,13,10,4,21,12],   // 8/8=%27.8
    '954_Mor':      [41,40,8,11,32,26,19,17],  // 8/8=%27.7
    '957_Siyah':    [39,47,25,44,31,1,15,28],  // 8/8=%27.5
    '957_Yesil':    [41,9,23,19,42,26,12,47],  // 8/8=%27.3
    '953_Siyah':    [18,38,5,27,15,23,45,20],  // 8/8=%26.5
    '955_Turuncu':  [38,48,19,22,1,7,34,2],    // 8/8=%25.4
    '953_Yesil':    [5,46,14,38,6,2,21,39],    // 8/8=%25.0
    '952_Sari':     [31,2,17,39,33,48,25,15],  // 8/8=%25.0
    '956_Sari':     [20,48,9,42,24,46,2,33],   // 8/8=%24.4
    '956_Yesil':    [43,32,42,10,4,39,6,27],   // 8/8=%24.3
    '953_Kirmizi':  [43,12,41,23,21,7,42,28],  // 8/8=%24.2
    '955_Siyah':    [40,23,15,48,47,32,18,3],  // 8/8=%23.3
    '956_Kahve':    [37,31,22,19,5,10,39,28],  // 8/8=%25.6
    '954_Mavi':     [31,15,46,19,40,47,4,35],  // 8/8=%21.1
    '955_Kahve':    [37,29,30,5,2,40,39,45],   // 8/8=%16.4
    '955_Mavi':     [47,43,40,2,37,5,1,48],    // 8/8=%15.2
    '954_Sari':     [2,8,23,9,4,38,37,39],     // 8/8=%20.0
    '954_Siyah':    [11,23,19,7,15,37,28,6],   // 8/8=%19.6
    '955_Sari':     [11,9,13,41,23,40,19,33],  // 8/8=%18.9
    '957_Mavi':     [41,27,44,40,25,47,2,1],   // 8/8=%17.6
    '956_Mor':      [32,9,11,40,48,1,36,45],   // 8/8=%17.6
    '954_Turuncu':  [33,35,14,34,17,9,5,30],   // 8/8=%16.1
    '954_Kahve':    [21,8,45,17,12,48,1,29],   // 8/8=%16.1
    '956_Turuncu':  [8,48,14,38,36,11,35,15],  // 8/8=%16.3
    '956_Kirmizi':  [3,18,45,8,21,46,41,27],   // 8/8=%21.2
    '958_Kahve':    [36,22,48,27,5,15,6,13],   // 8/8=%26.1
    '958_Turuncu':  [46,45,3,14,24,12,6,39],   // 8/8=%20.8
    '956_Mavi':     [44,19,25,27,15,11,14,4],  // 8/8=%20.8
    '953_Sari':     [41,16,42,7,40,9,18,37],   // 8/8=%17.8
    '952_Yesil':    [6,42,30,10,44,22,34,21],  // 8/8=%20.7
    '955_Kirmizi':  [37,12,45,32,28,16,27,31], // 8/8=%19.6
    '952_Kahve':    [38,21,18,37,12,22,6,20],  // 8/8=%24.0
    '952_Mor':      [32,16,9,29,11,27,44,18],  // 8/8=%17.4
    '958_Mavi':     [23,11,9,43,1,42,22,41],   // 8/8=%27.8
    '957_Mor':      [46,44,21,6,48,37,31,10],  // 8/8=%21.9
    '959_Kahve':    [22,14,21,27,45,25,36,33], // 8/8=%21.7
    '957_Kahve':    [18,27,19,14,23,38,7,37],  // 8/8=%21.7
  };

  // C8 seçim önceliği: MS+Renk > MS+OU > PrevRenk+MS > MS bazlı > tekrar oranı
  var msRenkC8Key    = predMs + '_' + (colorList[0]||'');
  var msOuC8Key      = predMs + '_' + (ouList[0]||'');
  var prevRenkMsC8Key = (colorList[1]||'') + '_' + predMs;

  // PrevRenk+MS özel grupları
  var PREV_RENK_MS_C8 = {
    'Kirmizi_958': [3,46,17,43,6,45,47,38],   // %41.2
    'Kirmizi_952': [30,26,31,42,20,18,46,1],  // %39.3
    'Sari_952':    [32,23,14,19,33,17,28,29], // %39.1
    'Turuncu_957': [2,22,3,14,12,47,19,24],   // %37.5
    'Kahve_959':   [6,10,2,39,32,14,22,24],   // %36.8
    'Mor_952':     [36,12,24,42,5,6,32,37],   // %35.3
    'Kirmizi_959': [11,48,47,35,15,16,7,18],  // %33.3
    'Siyah_952':   [47,27,21,4,46,17,16,39],  // %31.6
    'Mor_957':     [44,20,14,37,3,33,8,41],   // %31.2
    'Mavi_953':    [17,27,46,42,3,37,44,13],  // %31.2
    'Siyah_958':   [34,35,18,6,24,11,2,46],   // %31.2
    'Sari_957':    [25,31,26,8,30,39,18,9],   // %28.0
    'Mavi_959':    [41,26,33,13,11,3,45,17],  // %26.3
    'Yesil_958':   [23,17,1,41,25,44,42,13],  // %26.1
  };

  var specialC8 = MS_RENK_C8[msRenkC8Key] || MS_OU_C8[msOuC8Key] || PREV_RENK_MS_C8[prevRenkMsC8Key] || MS_C8[predMs] || null;

  var certain8List;
  if (specialC8 && specialC8.length === 8) {
    certain8List = specialC8.slice();
  } else {
    // ── CLUSTER LİMİT (GPT önerisi): aynı renk grubundan max 3 sayı ──
    var c8Base = c6Scored.slice(0, 8);
    var colorGroupCount = {};
    var c8WithLimit = [];
    c8Base.forEach(function(num) {
      var numColor = colors[num] || 'X';
      colorGroupCount[numColor] = (colorGroupCount[numColor] || 0) + 1;
      if (colorGroupCount[numColor] <= 3) {
        c8WithLimit.push(num);
      }
    });
    // Eksik kalırsa clusterSorted'dan tamamla (limitli)
    for (var cli = 0; c8WithLimit.length < 8 && cli < clusterSorted.length; cli++) {
      var cn = clusterSorted[cli];
      if (c8WithLimit.indexOf(cn) === -1) {
        var cnColor = colors[cn] || 'X';
        colorGroupCount[cnColor] = (colorGroupCount[cnColor] || 0);
        if (colorGroupCount[cnColor] < 3) {
          colorGroupCount[cnColor]++;
          c8WithLimit.push(cn);
        }
      }
    }
    // Hala eksikse limit olmadan tamamla
    for (var cli2 = 0; c8WithLimit.length < 8 && cli2 < c6Scored.length; cli2++) {
      if (c8WithLimit.indexOf(c6Scored[cli2]) === -1) c8WithLimit.push(c6Scored[cli2]);
    }
    certain8List = c8WithLimit.slice(0, 8);
  }
  result.certain8 = certain8List.slice().sort(function(a,b){return a-b;});

  // ── KESİN 7: AZ ÇIKAN RENK + MS DIŞI SAYILAR ──
  // Strateji (1470 çekiliş test): ort=5.129, 6+=%39.0, 7/7=%10.4
  // C8 ile %100 farklı sayılar — hiç örtüşme yok
  //
  // 1. Önceki çekilişte ≤2 sayı çıkan renklerin tüm 6 sayısı → az renk havuzu
  // 2. Ms havuzundan C6/C8'de olmayan sayılar → ms dışı havuz
  // 3. Birleştir, pozisyon skoru ile sırala, C8'de olmayanları al, top 7 seç

  // Renk → sayı grupları
  var COLOR_NUMS_7 = {
    'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
    'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
    'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
  };

  // Pozisyon skoru (son 20 çekiliş)
  var posScore7 = {}; for (var pi7=1; pi7<=48; pi7++) posScore7[pi7] = 0;
  allNumsArr.slice(0, Math.min(20,n)).forEach(function(nums) {
    nums.slice(0,5).forEach(function(num, pos) { posScore7[num] = (posScore7[num]||0) + (5-pos); });
  });

  // C8 seti
  var c8Set = {};
  certain8List.forEach(function(x){ c8Set[x] = 1; });

  // 1. Az çıkan renk sayıları (önceki çekilişte ≤2 sayı çıkan renklerin tüm 6 sayısı)
  var lowColorNums7 = {};
  var prevSet7 = {}; prevNums.forEach(function(x){ prevSet7[x]=1; });
  ALL_COLORS.forEach(function(color) {
    if (!COLOR_NUMS_7[color]) return;
    var cnt = COLOR_NUMS_7[color].filter(function(x){ return prevSet7[x]; }).length;
    if (cnt <= 2) {
      COLOR_NUMS_7[color].forEach(function(x){ lowColorNums7[x] = 1; });
    }
  });

  // 2. Ms havuzundan C8'de olmayan sayılar
  var msExtra7 = {};
  if (predMs >= 0 && MS_FIRST_POOL[predMs]) {
    MS_FIRST_POOL[predMs].slice(0,10).forEach(function(num) {
      if (!c8Set[num]) msExtra7[num] = 1;
    });
  }

  // 3. Öncelikli havuz = az renk + ms dışı (C8 haricinde)
  var priority7 = {};
  Object.keys(lowColorNums7).forEach(function(x){ if (!c8Set[x]) priority7[x]=1; });
  Object.keys(msExtra7).forEach(function(x){ priority7[x]=1; });

  // 4. Sırala: önce öncelikli, sonra geri kalanlar (hepsi C8 haricinde)
  var sorted7 = [];
  // Öncelikli olanlar - pozisyon skoruna göre
  var pri_arr = Object.keys(priority7).map(Number).sort(function(a,b){ return posScore7[b]-posScore7[a]; });
  // Geri kalanlar
  var rest_arr = [];
  for (var ri7=1; ri7<=48; ri7++) {
    if (!c8Set[ri7] && !priority7[ri7]) rest_arr.push(ri7);
  }
  rest_arr.sort(function(a,b){ return posScore7[b]-posScore7[a]; });
  sorted7 = pri_arr.concat(rest_arr);

  // C7 seçim önceliği: Renk çifti > Renk+OU > Mevcut motor
  var pairC7Key = (prevColor||'') + '_' + (predColor||'');
  var specialC7 = PAIR_C7[pairC7Key] || RENK_OU_C7[renkOuKey] || null;
  // OVER+Siyah C7 grubunu kaldır — gerçek veri düşük (%4.8)
  if (specialC7 && specialC7.length >= 7) {
    result.certain7 = specialC7.slice(0,7).sort(function(a,b){return a-b;});
  } else {
    result.certain7 = sorted7.slice(0,7).sort(function(a,b){return a-b;});
  }

  // ── KESİN 6: C8'den 3 + C7'den 3 (büyük-küçük karışık) ──
  var c8Set = {};
  certain8List.forEach(function(x){ c8Set[x] = 1; });
  var c7Only = result.certain7.filter(function(x){ return !c8Set[x]; });

  // C8'den ilk 3 + C7'den ilk 3 (her ikisi kendi motorunun sıralamasına göre)
  var certain6List = certain8List.slice(0,3).concat(c7Only.slice(0,3));
  // Eğer C7'den 3 bulunamazsa C8'den tamamla
  for (var c6j=3; certain6List.length<6 && c6j<certain8List.length; c6j++) {
    certain6List.push(certain8List[c6j]);
  }

  // ── KESİN 6: DİNAMİK MOTOR - Volcanobet istatistik bazlı ──
  // Global yüksek frekans + son 30'da soğuk + MS bonus + önceki renk
  (function() {
    // Global frekans (tüm veride ilk 15'te en çok çıkan sayılar)
    var GLOBAL_FREQ = {
      1:0.317,2:0.318,3:0.316,4:0.315,5:0.316,6:0.317,7:0.315,8:0.317,
      9:0.316,10:0.316,11:0.317,12:0.315,13:0.316,14:0.317,15:0.315,
      16:0.317,17:0.317,18:0.316,19:0.317,20:0.315,21:0.316,22:0.315,
      23:0.316,24:0.317,25:0.316,26:0.315,27:0.318,28:0.316,29:0.315,
      30:0.317,31:0.316,32:0.318,33:0.315,34:0.316,35:0.322,36:0.315,
      37:0.317,38:0.317,39:0.318,40:0.317,41:0.318,42:0.318,43:0.316,
      44:0.315,45:0.315,46:0.319,47:0.318,48:0.315
    };

    // Son 30 çekilişte ilk 15'te frekans
    var recentFreq = {};
    var recentWindow = Math.min(30, n);
    allNumsArr.slice(0, recentWindow).forEach(function(nums) {
      nums.slice(0, 15).forEach(function(num) {
        recentFreq[num] = (recentFreq[num]||0) + 1;
      });
    });

    // Skor: global yüksek + son 30'da soğuk
    var scores = {};
    for (var n2 = 1; n2 <= 48; n2++) {
      var globalScore = (GLOBAL_FREQ[n2]||0.315) * 100;
      var coldScore = (recentWindow - (recentFreq[n2]||0)) * 3;
      scores[n2] = globalScore + coldScore;
    }

    // MS bonus
    if (predMs >= 959) {
      [1,8,25,30,31,48].forEach(function(n2){ scores[n2] += 25; });
    } else if (predMs >= 956) {
      [3,9,27,31,40,41].forEach(function(n2){ scores[n2] += 20; });
    } else if (predMs >= 954) {
      [6,14,22,30,35,42].forEach(function(n2){ scores[n2] += 15; });
    }

    // Önceki renk bonusu
    var COLOR_BONUS = {
      'Sari':[33,41,25,17,9,1],'Yesil':[42,34,26,18,10,2],
      'Mavi':[43,35,27,19,11,3],'Kirmizi':[44,36,28,20,12,4],
      'Kahve':[45,37,29,21,13,5],'Turuncu':[46,38,30,22,14,6],
      'Siyah':[47,39,31,23,15,7],'Mor':[48,40,32,24,16,8]
    };
    (COLOR_BONUS[prevColor]||[]).forEach(function(n2, i){ scores[n2] += (6-i)*3; });

    // Son 55 çekilişin İLK 20 sayısında frekans (backtest W=55 en iyi)
    var first20Freq = {};
    allNumsArr.slice(0, Math.min(55, n)).forEach(function(nums) {
      nums.slice(0, 20).forEach(function(x){ first20Freq[x] = (first20Freq[x]||0) + 1; });
    });
    var first20Sorted = Object.keys(first20Freq).map(Number).sort(function(a,b){ return (first20Freq[a]||0)-(first20Freq[b]||0); });
    // En az çıkan (soğuk) - güçlü bonus
    first20Sorted.slice(0,10).forEach(function(n2, i){ scores[n2] += (10-i)*3; });
    // En çok çıkan - bonus
    first20Sorted.slice(-5).forEach(function(n2, i){ scores[n2] += (i+1)*2; });

    // Son 3 turda çıkan sayılara ceza (tekrar azaltma)
    var recentAll = {};
    allNumsArr.slice(0, Math.min(3, n)).forEach(function(nums){
      nums.slice(0,15).forEach(function(x){ recentAll[x] = (recentAll[x]||0)+1; });
    });
    Object.keys(recentAll).forEach(function(x){ scores[parseInt(x)] -= recentAll[x]*15; });

    // RENK DOYGUNLUK SİNYALİ
    // Önceki turda bir renk 4+ sayı çıkardıysa sonraki turda o renk azalır/artar
    var COLOR_NUMS_MAP = {
      'Sari':[1,9,17,25,33,41],'Yesil':[2,10,18,26,34,42],'Mavi':[3,11,19,27,35,43],
      'Kirmizi':[4,12,20,28,36,44],'Kahve':[5,13,21,29,37,45],'Turuncu':[6,14,22,30,38,46],
      'Siyah':[7,15,23,31,39,47],'Mor':[8,16,24,32,40,48]
    };
    // Son 1 turdaki renk doygunluğunu hesapla
    if (allNumsArr[0] && allNumsArr[0].length > 0) {
      var prevFirst15Set = {};
      allNumsArr[0].slice(0,15).forEach(function(x){ prevFirst15Set[x]=1; });
      Object.keys(COLOR_NUMS_MAP).forEach(function(color) {
        var cnums = COLOR_NUMS_MAP[color];
        var cnt = cnums.filter(function(x){ return prevFirst15Set[x]; }).length;
        if (cnt >= 4) {
          // Kahve/Kirmizi 4+: sonraki tur bu renk düşüyor -> ceza
          if (color === 'Kahve' || color === 'Kirmizi') {
            cnums.forEach(function(x){ scores[x] -= 20; });
          }
          // Turuncu 4+: sonraki tur hafif artıyor -> bonus
          if (color === 'Turuncu') {
            cnums.forEach(function(x){ scores[x] += 10; });
          }
        }
        if (cnt >= 5) {
          // Yesil 5+: sonraki tur belirgin artış -> güçlü bonus
          if (color === 'Yesil') {
            cnums.forEach(function(x){ scores[x] += 25; });
          }
          // Mavi 5+: sonraki tur düşüyor -> ceza
          if (color === 'Mavi') {
            cnums.forEach(function(x){ scores[x] -= 25; });
          }
        }
      });
    }

    // Top 6 seç
    var ranked = Object.keys(scores).map(Number).sort(function(a,b){ return scores[b]-scores[a]; });
    result.certain6 = ranked.slice(0,6).sort(function(a,b){return a-b;});
  })();
  result.certain6_grpA = (certain8List||[]).slice(0,3).sort(function(a,b){return a-b;});

  // ── JACKPOT TAHMİNİ (15. 19. 23. 27. 35. pozisyonlar) ──
  // 3 güçlü sinyal:
  // 1. Pozisyon bazlı tarihsel favoriler (son 200 roundda o pozisyonda en sık çıkan)
  // 2. Sıcak sayılar MS=0/1 (az önce çıkmış) → bonus puan
  // 3. Önceki roundun JP sayıları → kara liste (tekrar ihtimali düşük %10.2 vs beklenen %10.4)

  var JP_POSITIONS = [14, 18, 22, 26, 34]; // 0-indexed

  // --- Sinyal 1: Pozisyon bazlı tarihsel frekans (son 200 round) ---
  var jpFreq = {};
  JP_POSITIONS.forEach(function(pos) { jpFreq[pos] = {}; });
  var jpDraws = draws.slice(0, Math.min(200, n));
  jpDraws.forEach(function(d) {
    if (!d.all_numbers) return;
    var nums = d.all_numbers.split(',').map(Number);
    JP_POSITIONS.forEach(function(pos) {
      if (pos < nums.length) {
        var num = nums[pos];
        jpFreq[pos][num] = (jpFreq[pos][num] || 0) + 1;
      }
    });
  });

  // --- Sinyal 2: Sıcak sayılar — son 5 roundda çıkan sayılar (MS=0/1 proxy) ---
  var hotNums = {};
  draws.slice(0, Math.min(5, n)).forEach(function(d, di) {
    if (!d.all_numbers) return;
    d.all_numbers.split(',').map(Number).forEach(function(num) {
      // Yakın geçmiş → daha yüksek ağırlık
      hotNums[num] = (hotNums[num] || 0) + (5 - di);
    });
  });

  // --- Sinyal 3: Kara liste — önceki roundun JP sayıları ---
  var jpBlacklist = {};
  if (draws[0] && draws[0].all_numbers) {
    var prevNums0jp = draws[0].all_numbers.split(',').map(Number);
    JP_POSITIONS.forEach(function(pos) {
      if (pos < prevNums0jp.length) {
        jpBlacklist[prevNums0jp[pos]] = true;
      }
    });
  }

  // --- Skorlama: her pozisyon için aday listesi oluştur ---
  var jpCandidates = [];
  var usedJp = {};

  JP_POSITIONS.forEach(function(pos) {
    var freq = jpFreq[pos];
    // Her aday için birleşik skor hesapla
    var scored = Object.keys(freq).map(Number).map(function(num) {
      var freqScore = freq[num] / Math.min(200, n) * 100; // tarihsel frekans puanı
      var hotBonus  = hotNums[num] ? (hotNums[num] / 5) * 30 : 0; // sıcak sayı bonusu (max +30)
      var blackPenalty = jpBlacklist[num] ? -50 : 0; // kara liste cezası
      return { num: num, score: freqScore + hotBonus + blackPenalty };
    });

    // Skora göre sırala
    scored.sort(function(a, b) { return b.score - a.score; });

    // En yüksek skorlu, daha önce seçilmemiş sayıyı al
    for (var si = 0; si < scored.length; si++) {
      var candidate = scored[si].num;
      if (!usedJp[candidate]) {
        jpCandidates.push(candidate);
        usedJp[candidate] = true;
        break;
      }
    }
  });

  result.jackpot = jpCandidates.sort(function(a, b) { return a - b; });


  // ── TÜM SİNYAL BİLGİLERİ ──
  result.signals = {
    predMs: predMs, lastMs: lastMs, msDiff: msDiff2,
    ou3: ou3str, prevColor: prevColor,
    weakPeriod: weakPeriod,
    zeroCount: zeroCount,
    shortestZeroColor: shortestZeroColor,
    colorCnt10: colorCnt11,
    // GPT: MS Regime + Last2Trans
    msRegime: msRegime,
    last2TransBias: last2TransBias,
    // C6 sinyalleri
    sig66: strongSig66, badMs66: badMs66,
    c6strong: sig_c6_strong, c6weak: sig_c6_weak, siyahFull: siyahFull,
    // C8 sinyalleri
    sig88: strongSig88, badMs88: badMs88,
    c8strong: sig_c8_strong, c8weak: sig_c8_weak,
    // C7 sinyalleri
    sig77: sig77, badMs77: badMs77,
    c7strong: sig_c7_strong, c7weak: sig_c7_weak,
    // OU sinyalleri
    sig_uou: sig_uou, sig_uuu: sig_uuu,
    sig_siyah_prev: sig_siyah_prev,
    sig_kahve_prev: sig_kahve_prev,
    sig_turuncu_prev: sig_turuncu_prev,
    sig_ms_minus1: sig_ms_minus1,
    strongSig66: strongSig66, strongSig88: strongSig88
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
      dbQuery('SELECT round,first,over_under,color,all_numbers,created_at FROM draws ORDER BY created_at DESC LIMIT 200'),
      dbQuery("SELECT COUNT(*) as total, SUM(CASE WHEN over_under='OVER' THEN 1 ELSE 0 END) as over_count FROM draws")
    ]).then(function(r) {
      clearTimeout(timer); if (done) return;
      var total = parseInt(r[1].rows[0].total) || 0;
      var oc    = parseInt(r[1].rows[0].over_count) || 0;
      var op    = total > 0 ? Math.round(oc / total * 100) : 50;
      if (!res.headersSent) res.json({ last200: r[0].rows, stats: { total: total, over_pct: op, under_pct: 100 - op }, predictions: globalPredCache });
    }).catch(function(e) { clearTimeout(timer); if (!res.headersSent) res.json({ error: e.message }); });
  });

  app.get('/reset-predictions', function(req, res) {
    db.query('DELETE FROM predictions').then(function() {
      res.json({ ok: true, message: 'Tüm tahminler silindi.' });
    }).catch(function(err) {
      res.json({ ok: false, error: err.message });
    });
  });

  app.get('/draws.json', function(req, res) {
    dbQuery('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY global_round ASC NULLS LAST, created_at ASC')
    .then(function(result) {
      var data = result.rows.map(function(r, i) {
        return { seq: i + 1, round: r.round, first: r.first, ou: r.over_under, color: r.color, numbers: r.all_numbers, ts: r.created_at };
      });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="draws.json"');
      res.json(data);
    }).catch(function(e) { res.status(500).json({ error: e.message }); });
  });

  app.get('/predictions.json', function(req, res) {
    dbQuery("SELECT round, pred_ou, pred_color, pred_first, pred_first5, pred_certain6, pred_certain8, actual_first, actual_first5, actual_color, actual_ou, ou_hit, color_hit, first_hit, first5_match, certain6_match, certain8_full_match, created_at FROM predictions WHERE created_at > NOW() - INTERVAL '7 days' ORDER BY created_at ASC")
    .then(function(result) {
      var data = result.rows.map(function(r, i) {
        return {
          seq: i + 1,
          round: r.round,
          pred_ou: r.pred_ou, pred_color: r.pred_color,
          pred_first: r.pred_first, pred_first5: r.pred_first5,
          pred_certain6: r.pred_certain6, pred_certain8: r.pred_certain8,
          actual_first: r.actual_first, actual_first5: r.actual_first5,
          actual_color: r.actual_color, actual_ou: r.actual_ou,
          ou_hit: r.ou_hit, color_hit: r.color_hit, first_hit: r.first_hit,
          first5_match: r.first5_match,
          certain6_match: r.certain6_match,
          certain8_full_match: r.certain8_full_match,
          ts: r.created_at
        };
      });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="predictions.json"');
      res.json(data);
    }).catch(function(e) { res.status(500).json({ error: e.message }); });
  });

  app.get('/uuids.json', function(req, res) {
    dbQuery('SELECT round_number, round_uuid, start_datetime, created_at FROM round_uuids ORDER BY round_number ASC')
    .then(function(result) {
      var data = result.rows.map(function(r) {
        return { round: r.round_number, uuid: r.round_uuid, start: r.start_datetime, ms: r.ms_value, ts: r.created_at };
      });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="uuids.json"');
      res.json(data);
    }).catch(function(e) { res.status(500).json({error: e.message}); });
  });

  app.get('/rapor', function(req, res) {
    dbQuery("SELECT DISTINCT ON (p.id) p.*,d.all_numbers as actual_all FROM predictions p LEFT JOIN draws d ON p.global_round=d.global_round WHERE p.ou_hit != -1 AND p.created_at > NOW() - INTERVAL '7 days' ORDER BY p.id DESC, p.created_at DESC LIMIT 1000").then(function(result) {
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
      h += '<div class="sr"><div class="sl">Ilk Sayi (8 Aday)</div><div class="srr">';
      h += '<div class="sp" style="color:' + fc + '">%' + firstPct + '</div><div class="ss">' + firstHit + '/' + firstTotal + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + Math.min(firstPct * 4, 100) + '%;background:' + fc + '"></div></div></div></div>';

      // Kesin 6 özet + dağılım
      var c6perfect = c6Dist[6] || 0;
      var c6ppct = c6T > 0 ? Math.round(c6perfect / c6T * 100) : 0;
      var c6pc = c6ppct >= 20 ? '#22c55e' : c6ppct >= 5 ? '#facc15' : '#ef4444';
      h += '<div class="sr"><div class="sl">Kesin 6 (6/6 tuttu)</div><div class="srr">';
      h += '<div class="sp" style="color:' + c6pc + '">%' + c6ppct + '</div><div class="ss">' + c6perfect + '/' + c6T + ' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:' + Math.min(c6ppct * 4, 100) + '%;background:' + c6pc + '"></div></div></div></div>';
      // Kesin 7 (7/7 tuttu) - Rastgele
      var c7T = 0, c7S = 0, c7Dist = {0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0};
      rows.forEach(function(rr){ var c7m=parseInt(rr.certain7_match); if(!isNaN(c7m)&&c7m>=0){c7T++;c7S+=c7m;c7Dist[Math.min(c7m,7)]=(c7Dist[Math.min(c7m,7)]||0)+1;} });
      var c7avg = c7T>0?(c7S/c7T).toFixed(2):'0.00';
      var c7perfect = c7Dist[7]||0;
      var c7ppct = c7T>0?Math.round(c7perfect/c7T*100):0;
      h += '<div class="sr"><div class="sl">Kesin 7 (7/7 tuttu) — Rastgele</div><div class="srr">';
      h += '<div class="sp" style="color:#d4a843">%'+c7ppct+'</div><div class="ss">'+c7perfect+'/'+c7T+' tuttu</div>';
      h += '<div class="bar"><div class="bf" style="width:'+Math.min(c7ppct*4,100)+'%;background:#d4a843"></div></div></div></div>';

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

      // Kesin 7 dagilim
      h += '<div class="ar"><div class="sl">Kesin 7 \u2192 35 sayida kac tuttu (ort.) \u2014 Rastgele</div>';
      h += '<div style="font-size:16px;font-weight:900;color:#d4a843">'+c7avg+' / 7</div></div>';
      h += '<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">KESIN 7 DAGILIMI (35 SAYI)</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
      for (var _j=0;_j<=7;_j++){var _cj=_j>=6?'#22c55e':_j>=5?'#facc15':'#d4a843';var _bj=_j>=6?'#22c55e44':_j>=5?'#facc1544':'#2a2f42';h+='<div style="background:#1e2130;border:1px solid '+_bj+';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">'+_j+'/7: </span><span style="color:'+_cj+';font-weight:800">'+(c7Dist[_j]||0)+'x</span></div>';}
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

      // Jackpot istatistik
      var jpT = 0, jpS = 0, jpDist = {0:0,1:0,2:0,3:0,4:0,5:0};
      rows.forEach(function(rr) {
        if (!rr.pred_jackpot || rr.pred_jackpot === '') return;
        var jm = parseInt(rr.jackpot_match);
        // jackpot_match yoksa actual_jackpot'tan hesapla
        if ((isNaN(jm) || jm < 0) && rr.actual_jackpot && rr.actual_jackpot !== '') {
          var pj = rr.pred_jackpot.split(',').map(Number);
          var aj = rr.actual_jackpot.split(',').map(Number);
          jm = aj.filter(function(n){ return pj.indexOf(n) !== -1; }).length;
        }
        if (!isNaN(jm) && jm >= 0) { jpT++; jpS += jm; jpDist[Math.min(jm,5)] = (jpDist[Math.min(jm,5)]||0)+1; }
      });
      if (jpT > 0) {
        var jpAvg = (jpS/jpT).toFixed(2);
        var jpPerfect = jpDist[5]||0;
        var jpPpct = Math.round(jpPerfect/jpT*100);
        var jppc = jpPpct >= 5 ? '#22c55e' : '#facc15';
        h += '<div class="sr"><div class="sl">Jackpot (5/5 tam tuttu)</div><div class="srr">';
        h += '<div class="sp" style="color:' + jppc + '">%' + jpPpct + '</div><div class="ss">' + jpPerfect + '/' + jpT + ' tam tuttu</div>';
        h += '<div class="bar"><div class="bf" style="width:' + Math.min(jpPpct*10,100) + '%;background:' + jppc + '"></div></div></div></div>';
        h += '<div class="ar"><div class="sl">Jackpot \u2192 ort. kac sayi tuttu</div>';
        h += '<div style="font-size:16px;font-weight:900;color:#facc15">' + jpAvg + ' / 5</div></div>';
        h += '<div style="padding:8px 0;border-bottom:1px solid #1e2130"><div style="font-size:10px;color:#5a6180;margin-bottom:6px">JACKPOT DAGILIMI (3+ = \u0130Y\u0130)</div><div style="display:flex;flex-wrap:wrap;gap:5px">';
        for (var _jp=0; _jp<=5; _jp++) {
          var _jc = _jp>=4?'#22c55e':_jp>=3?'#facc15':'#ef4444';
          var _jb = _jp>=4?'#22c55e44':_jp>=3?'#facc1544':'#2a2f42';
          h += '<div style="background:#1e2130;border:1px solid '+_jb+';border-radius:8px;padding:4px 8px;font-size:12px"><span style="color:#aab0c4">'+_jp+'/5: </span><span style="color:'+_jc+';font-weight:800">'+(jpDist[_jp]||0)+'x</span></div>';
        }
        h += '</div></div>';
      }

      h += '<div class="st" style="margin-top:16px">Cekilis Bazli Detay</div>';

      rows.forEach(function(r) {
        var ouHitR    = parseInt(r.ou_hit)    === 1;
        var colorHitR = parseInt(r.color_hit) === 1;
        var firstHitR = parseInt(r.first_hit) === 1;

        var af5raw = r.actual_first5 ? r.actual_first5.split(',').map(Number) : [];
        var aAll = r.actual_all    ? r.actual_all.split(',').map(Number)    : [];
        // Eski kayıtlarda 5 eleman var, all_numbers'dan ilk 6'yı al
        var af5 = af5raw.length >= 6 ? af5raw : (aAll.length >= 6 ? aAll.slice(0, 6) : af5raw);
        var pf1  = r.pred_first    ? r.pred_first.split(',').map(Number).sort(function(a,b){return a-b;})    : [];
        var pc6  = r.pred_certain6 ? r.pred_certain6.split(',').map(Number).sort(function(a,b){return a-b;}) : [];
        var pc7  = r.pred_certain7 ? r.pred_certain7.split(',').map(Number).sort(function(a,b){return a-b;}) : [];
        var pc8  = r.pred_certain8 ? r.pred_certain8.split(',').map(Number).sort(function(a,b){return a-b;}) : [];

        var c6m  = parseInt(r.certain6_match)      >= 0 ? parseInt(r.certain6_match)      : '-';
        var c7m  = r.certain7_match !== null && parseInt(r.certain7_match) >= 0 ? parseInt(r.certain7_match) : '-';
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
          h += '<div class="lbl">TAHMIN 8 \u2014 1. Sayi Adaylari</div><div class="nr">';
          pf1.forEach(function(num) {
            var isF = num === parseInt(r.actual_first);
            h += '<div class="nb" style="background:' + (isF?'#14532d':'#1e2130') + ';border:' + (isF?'2px solid #22c55e':'1px solid #3b82f6') + ';color:' + (isF?'#22c55e':'#93c5fd') + '">' + num + '</div>';
          });
          h += '<span style="font-size:11px;color:' + (firstHitR?'#22c55e':'#ef4444') + ';margin-left:6px;font-weight:800">' + (firstHitR?'\u2713 TUTTU':'\u2717 KACTI') + '</span></div>';
        }

        // Gerçek ilk 6
        if (af5.length > 0) {
          h += '<div class="lbl">GERCEK ILK 6</div><div class="nr">';
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
            // Mavi dolu = ilk 6'da çıktı | Mavi açık = 35'te çıktı | Gri = çıkmadı
            var bg  = inIlk5 ? '#0f4a66' : inFull ? '#0c2a3a' : '#2a3040';
            var brd = inIlk5 ? '#38bdf8'  : inFull ? '#38bdf8' : '#4a5270';
            var cl  = inIlk5 ? '#7dd3fc'  : inFull ? '#38bdf8' : '#aab0c4';
            h += '<div class="nb" style="background:' + bg + ';border:2px solid ' + brd + ';color:' + cl + '">' + num + '</div>';
          });
          h += '</div>';
          h += '<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#38bdf8;border:2px solid #38bdf8;vertical-align:middle"></span> Ilk 6\'da cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#0c2a3a;border:2px solid #38bdf8;vertical-align:middle"></span> 35 sayida cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h += '</div>';
        }

        // Kesin 7 - Rastgele
        if (pc7.length > 0) {
          h += '<div class="lbl">KESIN 7 SAYI (RASTGELE) — <span style="color:#d4a843;font-weight:900">'+c7m+'/7 tuttu (35 sayida)</span></div>';
          h += '<div class="nr">';
          pc7.forEach(function(num) {
            var inIlk5 = af5.indexOf(num) !== -1;
            var inFull = aAll.indexOf(num) !== -1;
            var bg  = inIlk5 ? '#3a2e00' : inFull ? '#2a2000' : '#2a3040';
            var brd = inIlk5 ? '#facc15' : inFull ? '#d4a843' : '#4a5270';
            var cl  = inIlk5 ? '#facc15' : inFull ? '#d4a843' : '#aab0c4';
            h += '<div class="nb" style="background:'+bg+';border:1px solid '+brd+';color:'+cl+'">'+num+'</div>';
          });
          h += '</div>';
          h += '<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#facc15;border:1px solid #facc15;vertical-align:middle"></span> Ilk6\'da cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a2000;border:1px solid #d4a843;vertical-align:middle"></span> 35 sayida cikti</span>';
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
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#14532d;border:1px solid #22c55e;vertical-align:middle"></span> Ilk6\'da cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1a3a2a;border:1px solid #16a34a;vertical-align:middle"></span> 35 sayida cikti</span>';
          h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2a3040;border:1px solid #4a5270;vertical-align:middle"></span> Cikmadi</span>';
          h += '</div>';
        }

        // Jackpot
        var pJp2 = r.pred_jackpot ? r.pred_jackpot.split(',').map(Number).sort(function(a,b){return a-b;}) : [];
        var aJp2 = r.actual_jackpot ? r.actual_jackpot.split(',').map(Number) : [];
        // jackpot_match DB'de yoksa actual_jackpot'tan hesapla
        var jpM2raw = parseInt(r.jackpot_match);
        var jpM2;
        if (jpM2raw >= 0) {
          jpM2 = jpM2raw;
        } else if (pJp2.length > 0 && aJp2.length > 0) {
          jpM2 = aJp2.filter(function(n){ return pJp2.indexOf(n) !== -1; }).length;
        } else {
          jpM2 = '-';
        }
        if (pJp2.length > 0) {
          var jpColor = jpM2 !== '-' ? (jpM2 >= 4 ? '#22c55e' : '#facc15') : '#5a6180';
          var jpLabel = jpM2 !== '-' ? (jpM2 + '/5 tuttu') : 'Bekleniyor';
          h += '<div class="lbl">JACKPOT TAHMİNİ \u2014 <span style="color:'+jpColor+';font-weight:900">'+jpLabel+'</span></div>';
          h += '<div class="nr">';
          pJp2.forEach(function(num) {
            var inJp = aJp2.indexOf(num) !== -1;
            var bg  = inJp ? '#3a2000' : '#1e2130';
            var brd = (jpM2 !== '-' && inJp) ? '#facc15' : '#4a5270';
            var cl  = (jpM2 !== '-' && inJp) ? '#facc15' : '#aab0c4';
            h += '<div class="nb" style="background:'+bg+';border:2px solid '+brd+';color:'+cl+'">'+num+'</div>';
          });
          h += '</div>';
          if (aJp2.length > 0) {
            h += '<div class="lbl" style="margin-top:4px">GERCEK JACKPOT SAYILARI</div><div class="nr">';
            aJp2.forEach(function(num) {
              var inPred = pJp2.indexOf(num) !== -1;
              var brd = inPred ? '#facc15' : '#3a3f52';
              var cl  = inPred ? '#facc15' : '#5a6180';
              h += '<div class="nb" style="background:#1e2130;border:2px solid '+brd+';color:'+cl+'">'+num+'</div>';
            });
            h += '</div>';
            h += '<div style="font-size:10px;color:#5a6180;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">';
            h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#3a2000;border:2px solid #facc15;vertical-align:middle"></span> Tuttu</span>';
            h += '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1e2130;border:1px solid #4a5270;vertical-align:middle"></span> Tutmadi</span>';
            h += '</div>';
          }
        }

        // Özet
        h += '<div class="mi">';
        h += '<div class="mc">Kesin 6 \u2192 35 sayi: <strong style="color:' + (c6m>=5?'#22c55e':c6m>=4?'#facc15':'#aab0c4') + '">' + c6m + '/6</strong></div>';
        h += '<div class="mc">Kesin 7 \u2192 35 sayi: <strong style="color:#d4a843">' + c7m + '/7</strong></div>';
        h += '<div class="mc">Kesin 8 \u2192 35 sayi: <strong style="color:' + (c8fm>=6?'#22c55e':c8fm>=4?'#facc15':'#aab0c4') + '">' + c8fm + '/8</strong></div>';
        if (jpM2 !== '-') {
          h += '<div class="mc">Jackpot: <strong style="color:' + (jpM2>=4?'#22c55e':jpM2>=3?'#facc15':'#aab0c4') + '">' + jpM2 + '/5</strong></div>';
        }
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
    h += 'h+="<div class=\'card\' style=\'border-color:"+bc+"\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Round "+rno+" - Over / Under</span>";';
    h += 'var ouState=ou.state||"";';
    h += 'var ouBadgeColor=ouState.indexOf("REVERSAL")>=0?"#ef4444":ouState.indexOf("OVER")>=0?"#22c55e":ouState.indexOf("UNDER")>=0?"#ef4444":ouState.indexOf("MS_SIGNAL")>=0?"#a855f7":ouState.indexOf("ILK")>=0?"#f97316":"#5a6180";';
    h += 'var ouBadgeLabel=ouState.indexOf("REVERSAL")>=0?"SERİ KIRILDI":ouState.indexOf("TREND_OVER")>=0?"TREND OVER":ouState.indexOf("TREND_UNDER")>=0?"TREND UNDER":ouState.indexOf("MS_SIGNAL")>=0?"MS SİNYAL":ouState.indexOf("ILK")>=0?"RENK SİNYAL":ouState==="TREND"?"SERİ":"BALANCED";';
    h += 'h+="<span style=\'font-size:9px;color:"+ouBadgeColor+";font-weight:800;padding:2px 6px;border:1px solid "+ouBadgeColor+";border-radius:4px\'>"+ouBadgeLabel+"</span></div>";';
    h += 'h+="<div class=\'big\' style=\'color:"+oc+"\'>"+ou.pred+"</div><div class=\'conf\'>Guven: %"+ou.conf+"</div>";';
    h += 'if(ou.streak){var sc=ou.streak.count>=7?"#ef4444":ou.streak.count>=5?"#f97316":ou.streak.count>=3?"#facc15":"#aab0c4";';
    h += 'var sbg=ou.streak.count>=7?"rgba(239,68,68,0.15)":ou.streak.count>=5?"rgba(249,115,22,0.15)":ou.streak.count>=3?"rgba(250,204,21,0.1)":"rgba(255,255,255,0.05)";';
    h += 'h+="<div class=\'si\' style=\'background:"+sbg+";color:"+sc+";border:1px solid "+sc+"44\'>Mevcut Seri: "+ou.streak.type+" "+ou.streak.count+"x</div>";}';
    h += 'h+="</div>";}else{h+="<div class=\'card\'><div class=\'title\'>Tahmin</div><div style=\'color:#facc15;padding:10px\'>Tahmin hesaplaniyor...</div></div>";}';
    h += 'if(pr&&pr.color){var cl=pr.color;var pc=CH[cl.pred]||"#fff";';
    h += 'h+="<div class=\'card\' style=\'border-color:"+pc+"66\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Renk Tahmini</span>";';
    h += 'var clState=cl.state||"";';
    h += 'var clBadgeColor=cl.conf>=60?"#22c55e":cl.conf>=45?"#facc15":"#ef4444";';
    h += 'var clBadgeLabel=cl.conf>=60?"GÜÇLÜ":cl.conf>=45?"ORTA":"ZAYIF";';
    h += 'h+="<span style=\'font-size:9px;color:"+clBadgeColor+";font-weight:800;padding:2px 6px;border:1px solid "+clBadgeColor+";border-radius:4px\'>"+clBadgeLabel+"</span></div>";';
    h += 'h+="<div class=\'big\' style=\'color:"+pc+"\'>"+cl.pred+"</div><div class=\'conf\'>Guven: %"+cl.conf+"</div>";';
    h += 'if(cl.maxWait>=25){var mwc=cl.maxWait>=35?"#f97316":"#facc15";var mwlbl=cl.maxWait>=35?"ASIRI GECIKTI":"GECIKIYOR";h+="<div style=\'margin-top:8px;padding:5px 10px;background:#1a1f2e;border-radius:6px;border:1px solid "+mwc+"44\'><span style=\'color:"+mwc+";font-size:11px;font-weight:700\'>⚠ "+cl.maxWaitColor+": "+cl.maxWait+" TURDUR GELMIYOR - "+mwlbl+"</span></div>";}'
    h += '["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"].forEach(function(cn){';
    h += 'var cnt=(cl.counts&&cl.counts[cn])||0;var bg=CH[cn]||"#333";';
    h += 'var op=cnt<=(200/8)*0.5?1:cnt<=(200/8)*0.8?0.65:0.3;';
    h += 'h+="<span class=\'cb\' style=\'background:"+bg+";opacity:"+op+"\'>"+cn+" "+cnt+"</span>";});';
    h += 'h+="</div>";'
    h += 'var sig10=(pr&&pr.signals)||{};var cnt10=sig10.colorCnt10||{};var zc10=sig10.zeroCount||0;var szc10=sig10.shortestZeroColor||"";'
    h += 'h+="<div style=\'margin-top:8px;margin-bottom:8px;display:flex;flex-wrap:nowrap;gap:5px;justify-content:center;align-items:center\'>";'
    h += '["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"].forEach(function(rcn){'
    h += 'var rc10=(cnt10[rcn]||0);var rbg=CH[rcn]||"#555";'
    h += 'var isSh=(rcn===szc10&&zc10>=4);'
    h += 'var tc=(rcn==="Siyah")?"#e5e7eb":"#fff";'
    h += 'var brd=isSh?"3px solid #f97316":rc10===0?"2px solid "+rbg+"99":"2px solid "+rbg+"33";'
    h += 'h+="<div style=\'width:30px;height:30px;border-radius:50%;background:"+rbg+";opacity:0.75;border:"+brd+";display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:"+tc+"\'>"+(rc10===0?"0":rc10)+"</div>";'
    h += '});'
    h += 'h+="</div>";'
    h += 'if(zc10>=4){h+="<div style=\'margin-top:6px;padding:3px 8px;background:#2a1500;border-radius:4px\'>"'
    h += '  +"<span style=\'color:#f97316;font-size:10px;font-weight:700\'>⚡ "+zc10+" RENK 0 — son: "+szc10+"</span></div>";}'
    h += 'h+="</div></div></div>";'
    h += '}';
    h += 'if(pr&&pr.first_candidates&&pr.first_candidates.length>0){';
    h += 'var fcr=pr.firstColorReliable;';
    h += 'var fcrColor=fcr?"#22c55e":"#ef4444";';
    h += 'var fcrLabel=fcr?"GUVENILIR":"ZAYIF";';
    h += 'h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Ilk Sayi - 8 Aday</span><span style=\'font-size:9px;color:"+fcrColor+";font-weight:800;padding:2px 6px;border:1px solid "+fcrColor+";border-radius:4px\'>"+fcrLabel+"</span></div><div class=\'nums\'>";';
    h += 'pr.first_candidates.forEach(function(n){h+="<div class=\'num\' style=\'background:#1e3a5f;border:2px solid #3b82f6\'>"+n+"</div>";});';
    h += 'h+="</div></div>";}';
    h += 'if(pr&&pr.certain6&&pr.certain6.length>0){';
    h += 'var sig=pr.signals||{};';
    h += 'var c6b=sig.siyahFull?"#00ff88":sig.badMs66?"#ef4444":(sig.sig66>=2||sig.c6strong)?"#22c55e":sig.sig66>=1?"#facc15":"#5a6180";';
    h += 'var c6l=sig.siyahFull?"SIYAH FULL":sig.badMs66?"ZAYIF":sig.sig66>=2?"COK GUCLU":sig.sig66>=1||sig.c6strong?"GUCLU":"NORMAL";';
    h += 'h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Kesin Cikacak - 6 Sayi</span><span style=\'font-size:9px;color:"+c6b+";font-weight:800;padding:2px 6px;border:1px solid "+c6b+";border-radius:4px\'>"+c6l+"</span></div><div class=\'nums\'>";';
    h += 'pr.certain6.forEach(function(n){var isE=pr.certain6_grpA&&pr.certain6_grpA.indexOf(n)!==-1;';
    h += 'h+="<div class=\'num\' style=\'background:"+("#0c2a3a")+";border:2px solid "+("#38bdf8")+"\'>"+ n+"</div>";});';
    h += 'h+="</div><div style=\'margin-top:8px;font-size:10px;color:#aab0c4;display:flex;gap:12px\'>";';
    h += 'h+="</div></div>";}';
    h += 'if(pr&&pr.certain7&&pr.certain7.length>0){';
    h += 'var sig7=pr.signals||{};';
    h += 'var c7b=(sig7.badMs77||sig7.c7weak)?"#ef4444":(sig7.sig77>=2||sig7.c7strong)?"#22c55e":sig7.sig77>=1?"#facc15":"#5a6180";';
    h += 'var c7l=(sig7.badMs77||sig7.c7weak)?"ZAYIF":sig7.sig77>=2?"COK GUCLU":sig7.sig77>=1||sig7.c7strong?"GUCLU":"NORMAL";';
    h += 'h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Kesin Cikacak - 7 Sayi</span><span style=\'font-size:9px;color:"+c7b+";font-weight:800;padding:2px 6px;border:1px solid "+c7b+";border-radius:4px\'>"+c7l+"</span></div><div class=\'nums\'>";';
    h += 'pr.certain7.forEach(function(n){';
    h += 'h+="<div class=\'num\' style=\'background:#2a2000;border:2px solid #d4a843;color:#e5c07b\'>"+ n+"</div>";';
    h += '});';
    h += '';
    h += 'h+="</div></div>";}';
    h += 'if(pr&&pr.certain8&&pr.certain8.length>0){';
    h += 'var sig8=pr.signals||{};';
    h += 'var c8b=(sig8.badMs88||sig8.weakPeriod)?"#ef4444":(sig8.sig88>=2||sig8.c8strong)?"#22c55e":sig8.sig88>=1?"#facc15":"#5a6180";';
    h += 'var c8l=sig8.weakPeriod?"ZAYIF DONEM":sig8.badMs88?"ZAYIF":sig8.sig88>=2?"COK GUCLU":sig8.sig88>=1||sig8.c8strong?"GUCLU":"NORMAL";';
    h += 'h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Kesin Cikacak - 8 Sayi</span><span style=\'font-size:9px;color:"+c8b+";font-weight:800;padding:2px 6px;border:1px solid "+c8b+";border-radius:4px\'>"+c8l+"</span></div><div class=\'nums\'>";';
    h += 'pr.certain8.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a3040;border:1px solid #a855f7\'>"+n+"</div>";});';
    h += 'h+="</div></div>";}';
    h += 'if(pr&&pr.jackpot&&pr.jackpot.length>0){';
    h += 'h+="<div class=\'card\' style=\'border-color:#facc1566\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\'><span class=\'title\' style=\'margin-bottom:0\'>Jackpot Tahmini</span><span style=\'font-size:9px;color:#facc15;font-weight:800;padding:2px 6px;border:1px solid #facc15;border-radius:4px\'>5 SAYI</span></div><div class=\'nums\'>";';
    h += 'pr.jackpot.forEach(function(n){h+="<div class=\'num\' style=\'background:#2a1f00;border:2px solid #facc15;color:#facc15\'>"+n+"</div>";});';
    h += 'h+="</div></div>";}';
    h += 'if(d.stats){h+="<div class=\'card\'><div class=\'title\'>Istatistik ("+d.stats.total+" Round)</div>";';
    h += 'h+="<div class=\'str\'><span class=\'over\'>OVER %"+d.stats.over_pct+"</span><span class=\'under\'>UNDER %"+d.stats.under_pct+"</span></div>";';
    h += 'h+="<div class=\'bar\'><div class=\'bf\' style=\'width:"+d.stats.over_pct+"%;background:#22c55e\'></div></div></div>";}';
    h += 'if(d.last200&&d.last200.length>0){h+="<div class=\'card\'><div style=\'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px\'><span class=\'title\' style=\'margin-bottom:0\'>Son 200 Cekilis</span><a href=\'/draws.json\' style=\'font-size:10px;color:#aab0c4;background:#2a2f42;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:700;border:1px solid #3a3f52\'>JSON &#8595;</a><a href=\'/predictions.json\' style=\'font-size:10px;color:#aab0c4;background:#2a2f42;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:700;border:1px solid #3a3f52;margin-left:6px\'>SONUCLAR &#8595;</a><a href=\'/uuids.json\' style=\'font-size:10px;color:#3a3f52;background:#1a1f2e;padding:4px 10px;border-radius:6px;text-decoration:none;font-weight:700;border:1px solid #2a2f42;margin-left:6px\'>&#8595;</a></div>";';
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
