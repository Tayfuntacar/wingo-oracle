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
  console.log('Tablolar hazir!');
  connect();
  startDashboard();
}).catch(function(e) { console.log('DB hatasi:', e.message); });

var opt = {hostname:'virtualbingodataprovider-volcano.xtreme.bet',path:'/hubs/messagehub/negotiate?negotiateVersion=1',method:'POST',headers:{'Origin':'https://www.volcanobet.me'},rejectUnauthorized:false};

function connect() {
  https.request(opt, function(r) {
    var b = '';
    r.on('data', function(d) { b += d; });
    r.on('end', function() {
      var t = encodeURIComponent(JSON.parse(b).connectionToken);
      var w = new WebSocket('wss://virtualbingodataprovider-volcano.xtreme.bet/hubs/messagehub?id=' + t, {headers:{'Origin':'https://www.volcanobet.me'},rejectUnauthorized:false});
      var saved = {};
      w.on('open', function() {
        w.send('{"protocol":"json","version":1}\x1e');
        setTimeout(function() {
          w.send('{"arguments":["00000000-0000-0000-0000-000000000000"],"invocationId":"0","target":"SubscribeClient","type":1}\x1e');
        }, 1000);
      });
      w.on('message', function(d) {
        try {
          var j = JSON.parse(d.toString().replace(/\x1e/g, ''));
          if (j.target === 'ReceivePartialResult' && j.arguments[0].ballNumbers.length === 35) {
            var a = j.arguments[0];
            if (!saved[a.number]) {
              saved[a.number] = 1;
              var first = a.ballNumbers[0];
              var first5 = a.ballNumbers.slice(0, 5);
              var ou = first > 24 ? 'OVER' : 'UNDER';
              var renk = colors[first] || 'Bilinmiyor';
              console.log('ROUND:' + a.number + ' FIRST:' + first + ' ' + ou + ' ' + renk);
              saveDraw(a.number, first, first5, ou, renk, a.ballNumbers.join(','));
            }
          }
        } catch(e) { console.log('Mesaj hatasi:', e.message); }
      });
      w.on('close', function() { setTimeout(connect, 3000); });
      w.on('error', function(e) { console.log('WS hatasi:', e.message); });
    });
  }).on('error', function(e) { setTimeout(connect, 5000); }).end();
}

function saveDraw(round, first, first5, ou, renk, allNums) {
  db.query('INSERT INTO draws (round, first, over_under, color, all_numbers) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (round) DO NOTHING',
    [round, first, ou, renk, allNums]).then(function() {
    updatePredictions(round, first, first5, ou, renk);
    saveNextPrediction(round);
  }).catch(function(e) { console.log('Draw hatasi:', e.message); });
}

function updatePredictions(round, first, first5, ou, renk) {
  db.query('SELECT id, pred_ou, pred_color, pred_first, pred_first5, pred_certain8 FROM predictions WHERE round >= $1 AND round <= $2 AND ou_hit = -1',
    [round - 3, round]).then(function(res) {
    res.rows.forEach(function(row) {
      var ouHit = row.pred_ou === ou ? 1 : 0;
      var colorHit = row.pred_color === renk ? 1 : 0;
      var pf = row.pred_first ? row.pred_first.split(',').map(Number) : [];
      var pf5 = row.pred_first5 ? row.pred_first5.split(',').map(Number) : [];
      var pc8 = row.pred_certain8 ? row.pred_certain8.split(',').map(Number) : [];
      var firstHit = pf.indexOf(first) !== -1 ? 1 : 0;
      var f5Hit = pf5.indexOf(first) !== -1 ? 1 : 0;
      var c8Hit = pc8.indexOf(first) !== -1 ? 1 : 0;
      var f5Match = first5.filter(function(n) { return pf5.indexOf(n) !== -1; }).length;
      var c8Match = first5.filter(function(n) { return pc8.indexOf(n) !== -1; }).length;
      db.query('UPDATE predictions SET actual_first=$1,actual_first5=$2,actual_color=$3,actual_ou=$4,ou_hit=$5,color_hit=$6,first_hit=$7,first5_hit=$8,certain8_hit=$9,first5_match=$10,certain8_match=$11 WHERE id=$12',
        [first, first5.join(','), renk, ou, ouHit, colorHit, firstHit, f5Hit, c8Hit, f5Match, c8Match, row.id]).catch(function(e){});
    });
  }).catch(function(e){});
}

function saveNextPrediction(round) {
  db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round DESC LIMIT 200').then(function(res) {
    var draws = res.rows;
    if (draws.length >= 10) {
      var pred = predict(draws);
      if (pred.over_under) {
        db.query('INSERT INTO predictions (round,pred_ou,pred_color,pred_first,pred_first5,pred_certain8) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (round) DO NOTHING',
          [round+1, pred.over_under.pred, pred.color?pred.color.pred:'',
           pred.first_candidates?pred.first_candidates.join(','):'',
           pred.first5_candidates?pred.first5_candidates.join(','):'',
           pred.certain8?pred.certain8.join(','):'']).catch(function(e){});
      }
    }
  }).catch(function(e){});
}

function sortAsc(arr) { return arr.slice().sort(function(a,b){return a-b;}); }

// ============================================================
// YENİ TAHMİN MOTORU (v2)
// ============================================================

var COLOR_ORDER = ['Sari','Yesil','Mavi','Kirmizi','Kahve','Turuncu','Siyah','Mor'];

var COLOR_MAP = {};
for (var _i = 1; _i <= 48; _i++) {
  COLOR_MAP[_i] = COLOR_ORDER[(_i - 1) % 8];
}

var COLOR_NUMS = {};
COLOR_ORDER.forEach(function(c) { COLOR_NUMS[c] = []; });
for (var _i2 = 1; _i2 <= 48; _i2++) {
  COLOR_NUMS[COLOR_MAP[_i2]].push(_i2);
}

var GLOBAL_BIAS = {
  26:1.66,14:1.52,33:1.43,21:1.35,27:1.35,
  1:1.25,15:1.25,20:1.25,45:1.25,3:1.21,
  38:1.21,19:1.21,11:1.17,22:1.17,24:1.15,
  25:1.14,29:1.13,9:1.10,47:1.10,4:1.05,
  41:1.05,44:1.05,23:1.01,36:1.01,28:1.00,
  17:0.98,8:0.98,16:0.96,48:0.95,34:0.93,
  12:0.90,42:0.90,18:0.90,31:0.90,39:0.88,
  30:0.85,37:0.83,13:0.82,6:0.77,5:0.77,
  46:0.77,40:0.77,10:0.77,7:0.72,35:0.68,
  32:0.68,2:0.68,43:0.60
};

function computeScores(history) {
  var n = history.length;
  var scores = {};
  for (var i = 1; i <= 48; i++) scores[i] = 0;

  for (var num = 1; num <= 48; num++) {
    var bias = GLOBAL_BIAS[num] || 1.0;
    scores[num] += Math.log(bias + 0.5) * 2.5;
  }

  var seenAt = {};
  for (var i = 0; i < n; i++) {
    var num = history[i].first;
    if (!seenAt[num]) seenAt[num] = [];
    seenAt[num].push(i);
  }

  for (var num = 1; num <= 48; num++) {
    var apps = seenAt[num] || [];
    if (apps.length > 0) {
      var wait = n - 1 - apps[apps.length - 1];
      var avgInterval = 40;
      if (apps.length >= 2) {
        var ivs = [];
        for (var j = 1; j < apps.length; j++) ivs.push(apps[j] - apps[j-1]);
        var recent = ivs.slice(-5);
        avgInterval = recent.reduce(function(a,b){return a+b;},0) / recent.length;
      }
      var ratio = wait / Math.max(avgInterval, 1);
      scores[num] += 4.5 * Math.tanh(ratio * 0.65);
    } else {
      scores[num] += 4.5;
    }
  }

  var colorAfter = {};
  COLOR_ORDER.forEach(function(c) { colorAfter[c] = {}; });
  for (var i = 0; i < n - 1; i++) {
    var c1 = history[i].color;
    var c2 = history[i+1].color;
    colorAfter[c1][c2] = (colorAfter[c1][c2] || 0) + 1;
  }

  var lastColor = history[n-1].color;
  var streak = 1;
  for (var i = n-2; i >= Math.max(n-8, 0); i--) {
    if (history[i].color === lastColor) streak++;
    else break;
  }

  var colorProbs = {};
  COLOR_ORDER.forEach(function(c) { colorProbs[c] = 1/8; });

  if (colorAfter[lastColor] && Object.keys(colorAfter[lastColor]).length > 0) {
    var total = Object.values(colorAfter[lastColor]).reduce(function(a,b){return a+b;}, 0);
    var raw = {};
    Object.keys(colorAfter[lastColor]).forEach(function(c) {
      var cnt = colorAfter[lastColor][c];
      var p = cnt / total;
      if (c === lastColor) {
        var penalties = [1, 0.80, 0.45, 0.20, 0.10];
        p *= penalties[Math.min(streak - 1, 4)];
      }
      raw[c] = p;
    });
    var s = Object.values(raw).reduce(function(a,b){return a+b;}, 0);
    if (s > 0) {
      COLOR_ORDER.forEach(function(c) { colorProbs[c] = (raw[c] || 0.01) / s; });
    }
  }

  for (var num = 1; num <= 48; num++) {
    var c = COLOR_MAP[num];
    scores[num] += 3.0 * colorProbs[c] * 8;
  }

  COLOR_ORDER.forEach(function(c) {
    var numsInC = COLOR_NUMS[c];
    var cApps = {};
    var cIdx = 0;
    history.forEach(function(r) {
      if (numsInC.indexOf(r.first) !== -1) {
        if (!cApps[r.first]) cApps[r.first] = [];
        cApps[r.first].push(cIdx);
        cIdx++;
      }
    });

    numsInC.forEach(function(num) {
      var apps = cApps[num] || [];
      if (apps.length > 0) {
        var wait = cIdx - 1 - apps[apps.length - 1];
        var avgIv = 6;
        if (apps.length >= 2) {
          var ivs = [];
          for (var j = 1; j < apps.length; j++) ivs.push(apps[j] - apps[j-1]);
          avgIv = ivs.reduce(function(a,b){return a+b;},0) / ivs.length;
        }
        scores[num] += 2.0 * Math.tanh(wait / Math.max(avgIv, 1) * 0.5);
      } else {
        scores[num] += 2.0;
      }
    });
  });

  var numAfter = {};
  for (var i = 0; i < n - 1; i++) {
    var a = history[i].first;
    var b = history[i+1].first;
    if (!numAfter[a]) numAfter[a] = {};
    numAfter[a][b] = (numAfter[a][b] || 0) + 1;
  }

  var lastNum = history[n-1].first;
  if (numAfter[lastNum]) {
    var total2 = Object.values(numAfter[lastNum]).reduce(function(a,b){return a+b;}, 0);
    if (total2 >= 5) {
      Object.keys(numAfter[lastNum]).forEach(function(num) {
        var cnt = numAfter[lastNum][num];
        scores[parseInt(num)] += 2.0 * (cnt / total2) * 10;
      });
    }
  }

  var last30 = history.slice(-30).map(function(r){return r.first;});
  var freq30 = {};
  last30.forEach(function(n) { freq30[n] = (freq30[n] || 0) + 1; });
  var exp30 = 30 / 48;
  for (var num = 1; num <= 48; num++) {
    var f = freq30[num] || 0;
    if (f < exp30 * 0.5) scores[num] += 0.8;
  }

  return scores;
}

function predictColorV2(history) {
  var colorAfter = {};
  COLOR_ORDER.forEach(function(c) { colorAfter[c] = {}; });
  for (var i = 0; i < history.length - 1; i++) {
    var c1 = history[i].color;
    var c2 = history[i+1].color;
    colorAfter[c1][c2] = (colorAfter[c1][c2] || 0) + 1;
  }

  var lastColor = history[history.length-1].color;
  var streak = 1;
  for (var i = history.length - 2; i >= Math.max(history.length - 8, 0); i--) {
    if (history[i].color === lastColor) streak++;
    else break;
  }

  var bestColor = lastColor;
  var bestProb = 0;
  var colorProbs = {};

  if (colorAfter[lastColor] && Object.keys(colorAfter[lastColor]).length > 0) {
    var total = Object.values(colorAfter[lastColor]).reduce(function(a,b){return a+b;}, 0);
    Object.keys(colorAfter[lastColor]).forEach(function(c) {
      var cnt = colorAfter[lastColor][c];
      var p = cnt / total;
      if (c === lastColor) {
        var penalties = [1, 0.80, 0.45, 0.20, 0.10];
        p *= penalties[Math.min(streak - 1, 4)];
      }
      colorProbs[c] = p;
    });
    var s = Object.values(colorProbs).reduce(function(a,b){return a+b;}, 0);
    Object.keys(colorProbs).forEach(function(c) { colorProbs[c] /= s; });
  } else {
    COLOR_ORDER.forEach(function(c) { colorProbs[c] = 1/8; });
  }

  Object.keys(colorProbs).forEach(function(c) {
    if (colorProbs[c] > bestProb) { bestProb = colorProbs[c]; bestColor = c; }
  });

  return { color: bestColor, prob: bestProb, streak: streak, colorProbs: colorProbs };
}

function predict(draws) {
  var result = {};
  if (!draws || draws.length < 5) return result;

  var history = draws.map(function(d) {
    return {
      first: parseInt(d.first),
      color: d.color || COLOR_MAP[parseInt(d.first)] || 'Sari'
    };
  }).reverse();

  var n = history.length;
  var firstNums = draws.map(function(d){ return parseInt(d.first); });

  var scores = computeScores(history);
  var sorted = Object.keys(scores).map(function(k){ return {n:parseInt(k), s:scores[k]}; })
                                  .sort(function(a,b){return b.s-a.s;});

  var last20 = history.slice(-20);
  var over20 = last20.filter(function(r){return r.first > 24;}).length;
  var predOU = over20 < 10 ? 'OVER' : (over20 > 10 ? 'UNDER' : 'OVER');

  var streakType = firstNums[0] > 24 ? 'OVER' : 'UNDER';
  var streakCount = 1;
  for (var i = 1; i < firstNums.length; i++) {
    var cur = firstNums[i] > 24 ? 'OVER' : 'UNDER';
    if (cur === streakType) streakCount++;
    else break;
  }

  var ouConf = 55;
  var streakNote = '';
  if (streakCount >= 7) {
    predOU = streakType === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 88;
    streakNote = streakType + ' ' + streakCount + 'x seri! DONUYOR';
  } else if (streakCount >= 5) {
    predOU = streakType === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 80;
    streakNote = streakType + ' ' + streakCount + 'x seri, karsi tarafa geciliyor';
  } else if (streakCount === 4) {
    predOU = streakType === 'OVER' ? 'UNDER' : 'OVER';
    ouConf = 68;
    streakNote = streakType + ' ' + streakCount + 'x seri, donus yaklasıyor';
  } else if (streakCount === 3) {
    predOU = streakType;
    ouConf = 62;
    streakNote = streakType + ' ' + streakCount + 'x seri, devam edebilir';
  } else if (streakCount === 2) {
    predOU = streakType;
    ouConf = 58;
    streakNote = streakType + ' ' + streakCount + 'x seri';
  } else {
    ouConf = 55;
  }

  // Bir sonraki round numarası
  var nextRound = draws.length > 0 ? parseInt(draws[0].round) + 1 : 0;

  result.over_under = {
    pred: predOU,
    conf: ouConf,
    streak: { type: streakType, count: streakCount },
    note: streakNote,
    next_round: nextRound
  };

  var colorPred = predictColorV2(history);
  var confPct = Math.round(colorPred.prob * 100);
  result.color = {
    pred: colorPred.color,
    conf: confPct,
    alert: colorPred.streak >= 4 ? colorPred.color + ' ' + colorPred.streak + 'x streak!' : '',
    counts: (function(){
      var cnt = {};
      ALL_COLORS.forEach(function(c){ cnt[c] = 0; });
      draws.slice(0,100).forEach(function(d){ if(cnt[d.color]!==undefined) cnt[d.color]++; });
      return cnt;
    })()
  };

  var filtered = sorted.slice();
  if (predOU === 'OVER') {
    var ov = filtered.filter(function(x){return x.n > 24;});
    if (ov.length >= 5) filtered = ov;
  } else {
    var un = filtered.filter(function(x){return x.n <= 24;});
    if (un.length >= 5) filtered = un;
  }
  result.first_candidates = sortAsc(filtered.slice(0,5).map(function(x){return x.n;}));
  result.first5_candidates = sortAsc(sorted.slice(0,6).map(function(x){return x.n;}));
  result.certain8 = sortAsc(sorted.slice(0,8).map(function(x){return x.n;}));

  return result;
}

// ============================================================
// DASHBOARD
// ============================================================

function startDashboard() {
  var app = express();
  app.use(cors());
  var chStr = JSON.stringify(COLOR_HEX);

  app.get('/data', function(req, res) {
    Promise.all([
      db.query('SELECT round, first, over_under, color, all_numbers, created_at FROM draws ORDER BY round DESC LIMIT 200'),
      db.query('SELECT COUNT(*) as total, SUM(CASE WHEN over_under=\'OVER\' THEN 1 ELSE 0 END) as over_count FROM draws')
    ]).then(function(results) {
      var draws = results[0].rows;
      var stats = results[1].rows[0];
      var total = parseInt(stats.total)||0;
      var overCount = parseInt(stats.over_count)||0;
      var overPct = total>0?Math.round(overCount/total*100):50;
      res.json({last200:draws,stats:{total:total,over_pct:overPct,under_pct:100-overPct},predictions:predict(draws)});
    }).catch(function(e){res.json({error:e.message});});
  });

  app.get('/report', function(req, res) {
    db.query('SELECT * FROM predictions WHERE ou_hit != -1 ORDER BY round DESC LIMIT 500').then(function(result) {
      var rows = result.rows;
      var ouHit=0,ouTotal=0,colorHit=0,colorTotal=0,firstHit=0,firstTotal=0;
      var f5Total=0,f5Sum=0,c8Total=0,c8Sum=0;
      rows.forEach(function(r) {
        ouTotal++;if(parseInt(r.ou_hit)===1)ouHit++;
        colorTotal++;if(parseInt(r.color_hit)===1)colorHit++;
        firstTotal++;if(parseInt(r.first_hit)===1)firstHit++;
        var fm=parseInt(r.first5_match);if(fm>=0){f5Total++;f5Sum+=fm;}
        var cm=parseInt(r.certain8_match);if(cm>=0){c8Total++;c8Sum+=cm;}
      });
      res.json({
        summary:{
          ou:{hit:ouHit,total:ouTotal,pct:ouTotal>0?Math.round(ouHit/ouTotal*100):0},
          color:{hit:colorHit,total:colorTotal,pct:colorTotal>0?Math.round(colorHit/colorTotal*100):0},
          first:{hit:firstHit,total:firstTotal,pct:firstTotal>0?Math.round(firstHit/firstTotal*100):0},
          f5avg:f5Total>0?(f5Sum/f5Total).toFixed(1):0,
          c8avg:c8Total>0?(c8Sum/c8Total).toFixed(1):0
        },
        rows:rows
      });
    }).catch(function(e){res.json({error:e.message});});
  });

  app.get('/', function(req, res) {
    var p = '<!DOCTYPE html><html><head>';
    p += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WingoOracle</title>';
    p += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#ffffff;font-family:Arial,sans-serif;padding:12px;max-width:520px;margin:0 auto}';
    p += 'h1{color:#ffffff;font-size:22px;margin-bottom:14px;text-align:center;font-weight:800;letter-spacing:2px}';
    p += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    p += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    p += '.over{color:#22c55e;font-weight:800}.under{color:#ef4444;font-weight:800}';
    p += '.big{font-size:34px;font-weight:900;margin:4px 0}.conf{font-size:13px;color:#aab0c4;margin-top:3px;font-weight:600}';
    p += '.streak-info{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:12px;font-weight:700}';
    p += '.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}';
    p += '.num{border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#ffffff}';
    // SON 200 tablosu: seri sütunu kaldırıldı, 4 sütun
    p += '.row{display:grid;grid-template-columns:70px 44px 110px 70px;align-items:center;padding:6px 0;border-bottom:1px solid #2a2f42;font-size:12px}.row:last-child{border:none}';
    p += '.bar{height:7px;background:#3a3f52;border-radius:4px;margin:8px 0;overflow:hidden}.barfill{height:100%;border-radius:4px}';
    p += '.statrow{display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-bottom:4px}';
    p += '.alert{background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.6);border-radius:8px;padding:10px;margin-bottom:10px;font-size:13px;color:#ff6b6b;font-weight:700}';
    p += '.cbox{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:20px;font-size:12px;margin:3px;font-weight:800;color:#fff}';
    p += '.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px;letter-spacing:1px}';
    p += '.ref{color:#5a6180;font-size:11px;text-align:center;margin-top:10px}';
    // SON 200 başlık: seri sütunu kaldırıldı, 4 sütun
    p += '.hdr{display:grid;grid-template-columns:70px 44px 110px 70px;padding:4px 0;font-size:10px;color:#5a6180;font-weight:600;border-bottom:1px solid #3a3f52;margin-bottom:4px}';
    p += '.next-round{display:inline-block;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.5);border-radius:6px;padding:3px 10px;font-size:13px;font-weight:700;color:#60a5fa;margin-bottom:6px}';
    p += '</style></head><body>';
    p += '<h1>WINGO ORACLE</h1>';
    p += '<button class=btn onclick="window.location.href=\'/rapor\'">RAPOR</button>';
    p += '<div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
    p += '<script type="text/javascript">var CH='+chStr+';';
    p += 'function load(){var xhr=new XMLHttpRequest();xhr.open("GET","/data");xhr.onload=function(){try{';
    p += 'var d=JSON.parse(xhr.responseText);var pr=d.predictions;var h="";';

    // OVER/UNDER - sıradaki round numarasıyla (solda)
    p += 'if(pr&&pr.over_under){var ou=pr.over_under;var oc=ou.pred==="OVER"?"#22c55e":"#ef4444";';
    p += 'h+="<div class=card style=border-color:"+(ou.pred==="OVER"?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)")+"><div style=display:flex;align-items:center;gap:10px;margin-bottom:10px>";';
    p += 'if(ou.next_round){h+="<div class=next-round>Round #"+ou.next_round+"</div>";}';
    p += 'h+="<div class=title style=margin-bottom:0>Over / Under Tahmini</div></div>";';
    p += 'h+="<div class=big style=color:"+oc+">"+ou.pred+"</div>";';
    p += 'h+="<div class=conf>Guven: %"+ou.conf+"</div>";';
    p += 'if(ou.streak){';
    p += 'var sc=ou.streak.count>=7?"#ef4444":ou.streak.count>=5?"#f97316":ou.streak.count>=3?"#facc15":"#aab0c4";';
    p += 'var sbg=ou.streak.count>=7?"rgba(239,68,68,0.15)":ou.streak.count>=5?"rgba(249,115,22,0.15)":ou.streak.count>=3?"rgba(250,204,21,0.1)":"rgba(255,255,255,0.05)";';
    p += 'h+="<div class=streak-info style=background:"+sbg+";color:"+sc+";border:1px solid "+sc+"44>";';
    p += 'h+="Mevcut Seri: "+ou.streak.type+" "+ou.streak.count+"x";';
    p += 'if(ou.note)h+=" — "+ou.note;';
    p += 'h+="</div>";}';
    p += 'h+="</div>";}';

    // RENK
    p += 'if(pr&&pr.color){var cl=pr.color;var pc=CH[cl.pred]||"#fff";';
    p += 'h+="<div class=card style=border-color:"+pc+"66><div class=title>Renk Tahmini</div>";';
    p += 'if(cl.alert){h+="<div class=alert>"+cl.alert+"</div>";}';
    p += 'h+="<div class=big style=color:"+pc+">"+cl.pred+"</div><div class=conf>Guven: %"+cl.conf+"</div>";';
    p += 'h+="<div style=margin-top:12px><div class=title>Son 100 Cekilis Renk Dagilimi</div><div style=margin-top:6px>";';
    p += 'var cnames=["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"];';
    p += 'cnames.forEach(function(cn){var cnt=cl.counts[cn]||0;var bg=CH[cn]||"#333";';
    p += 'var expected=100/8;var op=cnt<=expected*0.5?1:cnt<=expected*0.8?0.65:0.3;';
    p += 'var shadow=cnt===0?"box-shadow:0 0 14px "+bg+";border:2px solid "+bg:cnt<=expected*0.5?"border:2px solid "+bg+"aa":"border:1px solid "+bg+"44";';
    p += 'h+="<span class=cbox style=background:"+bg+";opacity:"+op+";"+shadow+">"+cn+" "+cnt+"</span>";});';
    p += 'h+="</div></div></div>";}';

    // SAYILAR
    p += 'if(pr&&pr.first_candidates){h+="<div class=card><div class=title>Ilk Sayi - 5 Aday</div><div class=nums>";';
    p += 'pr.first_candidates.forEach(function(n){h+="<div class=num style=background:#1e3a5f;border:2px solid #3b82f6>"+n+"</div>";});h+="</div></div>";}';
    p += 'if(pr&&pr.first5_candidates){h+="<div class=card><div class=title>Ilk 5te Cikacak - 6 Aday</div><div class=nums>";';
    p += 'pr.first5_candidates.forEach(function(n){h+="<div class=num style=background:#2a3040;border:1px solid #4a5270>"+n+"</div>";});h+="</div></div>";}';
    p += 'if(pr&&pr.certain8){h+="<div class=card><div class=title>Kesin Cikacak - 8 Sayi</div><div class=nums>";';
    p += 'pr.certain8.forEach(function(n){h+="<div class=num style=background:#2a3040;border:1px solid #4a5270>"+n+"</div>";});h+="</div></div>";}';

    // İSTATİSTİK
    p += 'if(d.stats){h+="<div class=card><div class=title>Istatistik ("+d.stats.total+" Round)</div>";';
    p += 'h+="<div class=statrow><span class=over>OVER %"+d.stats.over_pct+"</span><span class=under>UNDER %"+d.stats.under_pct+"</span></div>";';
    p += 'h+="<div class=bar><div class=barfill style=width:"+d.stats.over_pct+"%;background:#22c55e></div></div></div>";}';

    // SON 200 ÇEKİLİŞ - eskiden yeniye sıralı, seri sütunu yok, her satır gösterilir
    p += 'if(d.last200&&d.last200.length>0){';
    p += 'h+="<div class=card><div class=title>Son 200 Cekilis (Yeniden Eskiye)</div>";';
    p += 'h+="<div class=hdr><span>Round</span><span>1.Sayi</span><span>Renk</span><span>O/U</span></div>";';
    // DB'den DESC geliyor (yeni->eski), aynen kullan
    p += 'var sorted200=d.last200.slice();';
    p += 'for(var i=0;i<sorted200.length;i++){';
    p += 'var r=sorted200[i];';
    p += 'var oc2=r.over_under==="OVER"?"#22c55e":"#ef4444";';
    p += 'var rc=CH[r.color]||"#aaa";';
    p += 'h+="<div class=row>";';
    p += 'h+="<span style=color:#aab0c4;font-size:11px>#"+r.round+"</span>";';
    p += 'h+="<span style=font-weight:900;font-size:14px>"+r.first+"</span>";';
    p += 'h+="<span style=color:"+rc+";font-weight:700>"+r.color+"</span>";';
    p += 'h+="<span style=color:"+oc2+";font-weight:900>"+r.over_under+"</span>";';
    p += 'h+="</div>";';
    p += '}';
    p += 'h+="</div>";}';

    p += 'h+="<div class=ref>Her 30 saniyede bir guncellenir</div>";';
    p += 'document.getElementById("app").innerHTML=h;';
    p += '}catch(e){document.getElementById("app").innerHTML="<div style=color:#ef4444;padding:20px>Hata: "+e.message+"</div>";}';
    p += '};xhr.send();}load();setInterval(load,30000);';
    p += '</sc'+'ript></body></html>';
    res.type('html');
    res.end(p);
  });

  app.get('/rapor', function(req, res) {
    var p = '<!DOCTYPE html><html><head>';
    p += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapor</title>';
    p += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#ffffff;font-family:Arial,sans-serif;padding:12px;max-width:600px;margin:0 auto}';
    p += 'h1{color:#ffffff;font-size:20px;margin-bottom:14px;text-align:center;font-weight:800}';
    p += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    p += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    p += '.srow{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #3a3f52}.srow:last-child{border:none}';
    p += '.drow{padding:12px 0;border-bottom:1px solid #3a3f52}.drow:last-child{border:none}';
    p += '.dtop{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}';
    p += '.bar{height:8px;background:#3a3f52;border-radius:4px;margin-top:6px;overflow:hidden}.barfill{height:100%;border-radius:4px;background:#22c55e}';
    p += '.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px}';
    p += '.ns{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;font-size:12px;font-weight:800;margin:2px}';
    p += '.nhit{background:rgba(34,197,94,0.3);border:2px solid #22c55e;color:#22c55e}';
    p += '.nmiss{background:#2a3040;border:1px solid #3a3f52;color:#6b7280}';
    p += '.nreal{background:rgba(59,130,246,0.3);border:2px solid #3b82f6;color:#60a5fa}';
    p += '</style></head><body>';
    p += '<h1>TAHMIN RAPORU</h1>';
    p += '<button class=btn onclick="window.location.href=\'/'+'\'">ANA SAYFA</button>';
    p += '<div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
    p += '<script type="text/javascript">var CH='+chStr+';';
    p += 'function load(){var xhr=new XMLHttpRequest();xhr.open("GET","/report");xhr.onload=function(){try{';
    p += 'var d=JSON.parse(xhr.responseText);var h="";var s=d.summary;';
    p += 'h+="<div class=card><div class=title>Basari Ozeti (Son 500 Tahmin)</div>";';
    p += 'var cats=[["Over/Under",s.ou],["Renk",s.color],["Ilk Sayi (5 Aday)",s.first]];';
    p += 'cats.forEach(function(c){var name=c[0];var st=c[1];var pct=st.pct;';
    p += 'var col=pct>=60?"#22c55e":pct>=45?"#facc15":"#ef4444";';
    p += 'h+="<div class=srow><span style=font-weight:700>"+name+"</span>";';
    p += 'h+="<div style=text-align:right><span style=font-size:20px;font-weight:900;color:"+col+">%"+pct+"</span>";';
    p += 'h+="<div style=font-size:11px;color:#aab0c4>"+st.hit+"/"+st.total+" tuttu</div>";';
    p += 'h+="<div class=bar><div class=barfill style=width:"+pct+"%></div></div></div></div>";});';
    p += 'h+="<div class=srow><span style=font-weight:700>Ilk 5 Adayi Ort.</span><span style=font-size:20px;font-weight:900;color:#3b82f6>"+s.f5avg+"/5</span></div>";';
    p += 'h+="<div class=srow><span style=font-weight:700>Kesin 8 Ort.</span><span style=font-size:20px;font-weight:900;color:#3b82f6>"+s.c8avg+"/5</span></div>";';
    p += 'h+="</div>";';
    p += 'if(d.rows&&d.rows.length>0){h+="<div class=card><div class=title>Cekilis Bazli Detay</div>";';
    p += 'd.rows.forEach(function(r){';
    p += 'if(!r.actual_first5)return;';
    p += 'var rc=CH[r.actual_color]||"#aaa";';
    p += 'var ouc=parseInt(r.ou_hit)===1?"#22c55e":"#ef4444";';
    p += 'var ous=parseInt(r.ou_hit)===1?"✓":"✗";';
    p += 'var af5=r.actual_first5?r.actual_first5.split(",").map(Number):[];';
    p += 'var pf5=r.pred_first5?r.pred_first5.split(",").map(Number):[];';
    p += 'var pc8=r.pred_certain8?r.pred_certain8.split(",").map(Number):[];';
    p += 'var fm=parseInt(r.first5_match);var cm=parseInt(r.certain8_match);';
    p += 'h+="<div class=drow>";';
    p += 'h+="<div class=dtop><span style=color:#aab0c4;font-size:12px>Round "+r.round+"</span>";';
    p += 'h+="<span>1.S: <b style=font-size:16px>"+r.actual_first+"</b> <span style=color:"+rc+">"+r.actual_color+"</span> <span style=color:"+ouc+">"+ous+"</span></span></div>";';
    p += 'if(af5.length>0){';
    p += 'h+="<div style=margin-bottom:6px><span style=font-size:10px;color:#5a6180;margin-right:6px>GERCEK ILK5:</span>";';
    p += 'af5.forEach(function(n){h+="<span class=ns nreal>"+n+"</span>";});h+="</div>";';
    p += 'h+="<div style=margin-bottom:4px><span style=font-size:10px;color:#5a6180;margin-right:6px>TAHMIN 6:</span>";';
    p += 'pf5.forEach(function(n){var hit=af5.indexOf(n)!==-1;h+="<span class=ns style= class="+(hit?"nhit":"nmiss")+">"+n+"</span>";});h+="</div>";}';
    p += 'h+="<div style=font-size:11px;color:#aab0c4>5\'te "+fm+"/6 tahmin tuttu | 8\'de "+cm+"/8 tahmin tuttu</div>";';
    p += 'h+="</div>";});';
    p += 'h+="</div>";}';
    p += 'document.getElementById("app").innerHTML=h;';
    p += '}catch(e){document.getElementById("app").innerHTML="<div style=color:#ef4444;padding:20px>Hata: "+e.message+"</div>";}';
    p += '};xhr.send();}load();';
    p += '</sc'+'ript></body></html>';
    res.type('html');
    res.end(p);
  });

  var port = process.env.PORT || 3000;
  app.listen(port, function() { console.log('Dashboard: http://localhost:' + port); });
}