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

function monteCarlo(draws, simCount) {
  var allNums = draws.map(function(d){ return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });
  var numProb = {};
  for(var i=1;i<=48;i++) numProb[i] = 1;
  allNums.forEach(function(balls, di) {
    balls.forEach(function(num, bi) {
      var weight = 1/(di+1) * (1/(bi+1)*2 + 0.5);
      numProb[num] = (numProb[num]||1) + weight;
    });
  });
  var totalProb = 0;
  for(var i=1;i<=48;i++) totalProb += numProb[i];
  var probs = [];
  for(var i=1;i<=48;i++) probs.push({n:i, p:numProb[i]/totalProb});
  probs.sort(function(a,b){return b.p-a.p;});
  var firstCount = {};
  var top5Count = {};
  for(var i=1;i<=48;i++) { firstCount[i]=0; top5Count[i]=0; }
  var seed = draws.length * 31 + parseInt(draws[0].first) * 17;
  for(var sim=0; sim<simCount; sim++) {
    var pool = probs.slice();
    var drawn = [];
    for(var k=0;k<35;k++) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      var r = Math.abs(seed) / 0xffffffff;
      var cum = 0;
      var chosen = pool[0];
      for(var m=0;m<pool.length;m++) {
        cum += pool[m].p;
        if(r <= cum) { chosen = pool[m]; break; }
      }
      drawn.push(chosen.n);
      pool = pool.filter(function(x){return x.n !== chosen.n;});
      var newTotal = pool.reduce(function(s,x){return s+x.p;},0);
      if(newTotal > 0) pool = pool.map(function(x){return {n:x.n,p:x.p/newTotal};});
    }
    firstCount[drawn[0]]++;
    drawn.slice(0,5).forEach(function(n){top5Count[n]++;});
  }
  return {firstCount:firstCount, top5Count:top5Count};
}

function pairAnalysis(draws) {
  var allNums = draws.map(function(d){ return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });
  var pairs = {};
  allNums.forEach(function(balls) {
    var first5 = balls.slice(0,5);
    first5.forEach(function(a) {
      first5.forEach(function(b) {
        if(a !== b) {
          var key = Math.min(a,b)+'-'+Math.max(a,b);
          pairs[key] = (pairs[key]||0) + 1;
        }
      });
    });
  });
  return pairs;
}

function predict(draws) {
  var result = {};
  if (!draws || draws.length < 5) return result;
  var allNums = draws.map(function(d){ return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });
  var firstNums = draws.map(function(d){ return parseInt(d.first); });
  var colorList = draws.map(function(d){ return d.color; });
  var n = draws.length;

  // OVER/UNDER
  var last3over = firstNums.slice(0,3).filter(function(x){return x>24;}).length;
  var last5over = firstNums.slice(0,5).filter(function(x){return x>24;}).length;
  var last10over = firstNums.slice(0,10).filter(function(x){return x>24;}).length;
  var overPct = Math.round(firstNums.filter(function(x){return x>24;}).length/n*100);
  var lowFirst = firstNums.filter(function(x){return x<=24;}).length;
  var positionBias = lowFirst > n/2 ? 'UNDER' : 'OVER';
  var predOU='OVER', ouConf=50;
  if(last3over===3){predOU='UNDER';ouConf=78;}
  else if(last3over===0){predOU='OVER';ouConf=78;}
  else if(last5over>=4){predOU='UNDER';ouConf=70;}
  else if(last5over<=1){predOU='OVER';ouConf=70;}
  else if(last10over>=8){predOU='UNDER';ouConf=65;}
  else if(last10over<=2){predOU='OVER';ouConf=65;}
  else if(overPct>58){predOU='UNDER';ouConf=60;}
  else if(overPct<42){predOU='OVER';ouConf=60;}
  else{predOU=positionBias;ouConf=52;}
  result.over_under={pred:predOU,conf:ouConf};

  // RENK - 100 çekiliş bazlı
  var recent100=colorList.slice(0,Math.min(100,n));
  var colorCount100={};ALL_COLORS.forEach(function(c){colorCount100[c]=0;});
  recent100.forEach(function(c){if(colorCount100[c]!==undefined)colorCount100[c]++;});
  var colorLastSeen={};ALL_COLORS.forEach(function(c){colorLastSeen[c]=999;});
  colorList.forEach(function(c,i){if(colorLastSeen[c]===999)colorLastSeen[c]=i;});
  var coldColors=ALL_COLORS.filter(function(c){return colorCount100[c]===0;});
  var colorAlert='';
  if(coldColors.length>=4)colorAlert='KRITIK: '+coldColors.length+' renk hic ilk dusmedi!';
  else if(coldColors.length===3)colorAlert='DIKKAT: 3 soguk renk, biri yakinda gelecek';
  else if(coldColors.length===2)colorAlert='2 soguk renk mevcut';
  var colorScores={};
  ALL_COLORS.forEach(function(c){
    var cold100 = (100/8 - colorCount100[c]) * 2;
    var lastSeenBonus = Math.min(colorLastSeen[c], 50) * 2;
    colorScores[c] = cold100 + lastSeenBonus;
  });
  var predColor = ALL_COLORS.slice().sort(function(a,b){return colorScores[b]-colorScores[a];})[0];
  if(coldColors.length > 0) predColor = coldColors.sort(function(a,b){return colorLastSeen[b]-colorLastSeen[a];})[0];
  var colorConf=coldColors.length>=4?82:coldColors.length>=3?68:coldColors.length===2?55:42;
  result.color={pred:predColor,conf:colorConf,alert:colorAlert,counts:colorCount100};

  // SAYI SKORLARI
  var markov={};
  for(var i=0;i<Math.min(n-1,200);i++){
    var cur=firstNums[i+1];var nxt=firstNums[i];
    if(!markov[cur])markov[cur]={};
    markov[cur][nxt]=(markov[cur][nxt]||0)+1;
  }
  var lastFirst=firstNums[0];
  var markovTotal=0;
  if(markov[lastFirst]) Object.keys(markov[lastFirst]).forEach(function(k){markovTotal+=markov[lastFirst][k];});
  var markovScores={};
  for(var i=1;i<=48;i++){
    markovScores[i]=markov[lastFirst]&&markov[lastFirst][i]&&markovTotal>0?(markov[lastFirst][i]/markovTotal)*100:0;
  }

  var w1=0.30,w2=0.25,w3=0.25,w4=0.20;
  var freq={};for(var i=1;i<=48;i++)freq[i]=0;
  firstNums.forEach(function(num){freq[num]++;});
  var numLastSeen={};for(var i=1;i<=48;i++)numLastSeen[i]=999;
  firstNums.forEach(function(num,idx){if(numLastSeen[num]===999)numLastSeen[num]=idx;});
  var maxFreq=Math.max.apply(null,Object.keys(freq).map(function(k){return freq[k];}))||1;
  var hybridScores={};
  for(var i=1;i<=48;i++){
    var freqScore=(maxFreq-freq[i])/maxFreq*100;
    var recencyScore=Math.min(numLastSeen[i],50)*2;
    var gapAvg=n/(freq[i]||1);
    var gapScore=numLastSeen[i]>=gapAvg?80:20;
    var recent10=firstNums.slice(0,10);
    var trendScore=recent10.indexOf(i)===-1?60:20;
    hybridScores[i]=w1*freqScore+w2*recencyScore+w3*gapScore+w4*trendScore;
  }

  var mc=monteCarlo(draws,3000);
  var mcFirstMax=Math.max.apply(null,Object.keys(mc.firstCount).map(function(k){return mc.firstCount[k];}))||1;
  var mcTop5Max=Math.max.apply(null,Object.keys(mc.top5Count).map(function(k){return mc.top5Count[k];}))||1;

  var pairs=pairAnalysis(draws);
  var pairScores={};for(var i=1;i<=48;i++)pairScores[i]=0;
  Object.keys(pairs).forEach(function(key){
    var parts=key.split('-').map(Number);
    if(parts[0]===lastFirst||parts[1]===lastFirst){
      var other=parts[0]===lastFirst?parts[1]:parts[0];
      pairScores[other]=(pairScores[other]||0)+pairs[key];
    }
  });
  var maxPair=Math.max.apply(null,Object.values(pairScores))||1;

  var neighborBonus={};
  for(var i=1;i<=48;i++){var dist=Math.abs(i-lastFirst);neighborBonus[i]=dist<=3&&dist>0?(4-dist)*4:0;}

  var hour=new Date().getUTCHours()+3;if(hour>=24)hour-=24;
  var timeFreq={};for(var i=1;i<=48;i++)timeFreq[i]=0;
  draws.forEach(function(d){
    if(!d.created_at)return;
    var h=new Date(d.created_at).getUTCHours()+3;if(h>=24)h-=24;
    if(Math.abs(h-hour)<=2)timeFreq[parseInt(d.first)]=(timeFreq[parseInt(d.first)]||0)+1;
  });

  var last10even=firstNums.slice(0,10).filter(function(x){return x%2===0;}).length;
  var evenBonus=last10even<=3?1:0;

  var numScores={};
  for(var i=1;i<=48;i++){
    numScores[i]=
      hybridScores[i]*0.30+
      markovScores[i]*0.25+
      (mc.firstCount[i]/mcFirstMax)*100*0.20+
      (pairScores[i]/maxPair)*50*0.10+
      neighborBonus[i]*0.05+
      (timeFreq[i]||0)*5*0.05+
      (i%2===0?evenBonus*10:0)*0.05;
  }

  var filtered=Object.keys(numScores).map(Number);
  if(predOU==='OVER'){var ov=filtered.filter(function(x){return x>24;});if(ov.length>=5)filtered=ov;}
  else{var un=filtered.filter(function(x){return x<=24;});if(un.length>=5)filtered=un;}
  result.first_candidates=sortAsc(filtered.sort(function(a,b){return numScores[b]-numScores[a];}).slice(0,5));

  var first5scores={};
  for(var i=1;i<=48;i++){
    first5scores[i]=
      (mc.top5Count[i]/mcTop5Max)*100*0.40+
      hybridScores[i]*0.30+
      (pairScores[i]/maxPair)*50*0.20+
      (timeFreq[i]||0)*5*0.10;
  }
  result.first5_candidates=sortAsc(Object.keys(first5scores).map(Number).sort(function(a,b){return first5scores[b]-first5scores[a];}).slice(0,6));

  var kesinScores={};
  for(var i=1;i<=48;i++){
    kesinScores[i]=
      (mc.top5Count[i]/mcTop5Max)*100*0.45+
      hybridScores[i]*0.30+
      markovScores[i]*0.15+
      (pairScores[i]/maxPair)*50*0.10;
  }
  result.certain8=sortAsc(Object.keys(kesinScores).map(Number).sort(function(a,b){return kesinScores[b]-kesinScores[a];}).slice(0,8));
  return result;
}

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
      res.json({last20:draws.slice(0,20),stats:{total:total,over_pct:overPct,under_pct:100-overPct},predictions:predict(draws)});
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
    p += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#ffffff;font-family:Arial,sans-serif;padding:12px;max-width:480px;margin:0 auto}';
    p += 'h1{color:#ffffff;font-size:22px;margin-bottom:14px;text-align:center;font-weight:800;letter-spacing:2px}';
    p += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    p += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    p += '.over{color:#22c55e;font-weight:800}.under{color:#ef4444;font-weight:800}';
    p += '.big{font-size:34px;font-weight:900;margin:4px 0}.conf{font-size:13px;color:#aab0c4;margin-top:3px;font-weight:600}';
    p += '.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}';
    p += '.num{border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#ffffff}';
    p += '.row{display:grid;grid-template-columns:65px 45px 110px 70px;align-items:center;padding:9px 0;border-bottom:1px solid #3a3f52;font-size:13px}.row:last-child{border:none}';
    p += '.bar{height:7px;background:#3a3f52;border-radius:4px;margin:8px 0;overflow:hidden}.barfill{height:100%;border-radius:4px}';
    p += '.statrow{display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-bottom:4px}';
    p += '.alert{background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.6);border-radius:8px;padding:10px;margin-bottom:10px;font-size:13px;color:#ff6b6b;font-weight:700}';
    p += '.cbox{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:20px;font-size:12px;margin:3px;font-weight:800;color:#fff}';
    p += '.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px;letter-spacing:1px}';
    p += '.ref{color:#5a6180;font-size:11px;text-align:center;margin-top:10px}</style></head><body>';
    p += '<h1>WINGO ORACLE</h1>';
    p += '<button class=btn onclick="window.location.href=\'/rapor\'">RAPOR</button>';
    p += '<div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
    p += '<script type="text/javascript">var CH='+chStr+';';
    p += 'function load(){var xhr=new XMLHttpRequest();xhr.open("GET","/data");xhr.onload=function(){try{';
    p += 'var d=JSON.parse(xhr.responseText);var pr=d.predictions;var h="";';
    p += 'if(pr&&pr.over_under){var ou=pr.over_under;var oc=ou.pred==="OVER"?"#22c55e":"#ef4444";';
    p += 'h+="<div class=card style=border-color:"+(ou.pred==="OVER"?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)")+"><div class=title>Over / Under Tahmini</div><div class=big style=color:"+oc+">"+ou.pred+"</div><div class=conf>Guven: %"+ou.conf+"</div></div>";}';
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
    p += 'if(pr&&pr.first_candidates){h+="<div class=card><div class=title>Ilk Sayi - 5 Aday</div><div class=nums>";';
    p += 'pr.first_candidates.forEach(function(n){h+="<div class=num style=background:#1e3a5f;border:2px solid #3b82f6>"+n+"</div>";});h+="</div></div>";}';
    p += 'if(pr&&pr.first5_candidates){h+="<div class=card><div class=title>Ilk 5te Cikacak - 6 Aday</div><div class=nums>";';
    p += 'pr.first5_candidates.forEach(function(n){h+="<div class=num style=background:#2a3040;border:1px solid #4a5270>"+n+"</div>";});h+="</div></div>";}';
    p += 'if(pr&&pr.certain8){h+="<div class=card><div class=title>Kesin Cikacak - 8 Sayi</div><div class=nums>";';
    p += 'pr.certain8.forEach(function(n){h+="<div class=num style=background:#2a3040;border:1px solid #4a5270>"+n+"</div>";});h+="</div></div>";}';
    p += 'if(d.stats){h+="<div class=card><div class=title>Istatistik ("+d.stats.total+" Round)</div>";';
    p += 'h+="<div class=statrow><span class=over>OVER %"+d.stats.over_pct+"</span><span class=under>UNDER %"+d.stats.under_pct+"</span></div>";';
    p += 'h+="<div class=bar><div class=barfill style=width:"+d.stats.over_pct+"%;background:#22c55e></div></div></div>";}';
    p += 'if(d.last20){h+="<div class=card><div class=title>Son Cekilisler</div>";';
    p += 'd.last20.forEach(function(r){var oc=r.over_under==="OVER"?"#22c55e":"#ef4444";var rc=CH[r.color]||"#aaa";';
    p += 'h+="<div class=row><span style=color:#aab0c4;font-size:12px;font-weight:600>"+r.round+"</span><span style=font-weight:900;font-size:17px>"+r.first+"</span><span style=color:"+rc+";font-weight:800>"+r.color+"</span><span style=color:"+oc+";font-weight:900;text-align:right>"+r.over_under+"</span></div>";});';
    p += 'h+="</div>";}h+="<div class=ref>Her 30 saniyede bir guncellenir</div>";';
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
    p += 'h+="<div style=margin-bottom:6px><span style=font-size:11px;color:#aab0c4>Gercek Ilk 5: </span>";';
    p += 'af5.forEach(function(n){h+="<span class=ns nreal>"+n+"</span>";});';
    p += 'h+="</div>";';
    p += 'h+="<div style=margin-bottom:6px><span style=font-size:11px;color:#aab0c4>Ilk 5 Adayim ("+fm+"/5): </span>";';
    p += 'pf5.forEach(function(n){var hit=af5.indexOf(n)!==-1;var cls=hit?"ns nhit":"ns nmiss";h+="<span class="+cls+">"+n+"</span>";});';
    p += 'h+="</div>";';
    p += 'h+="<div><span style=font-size:11px;color:#aab0c4>Kesin 8 ("+cm+"/5): </span>";';
    p += 'pc8.forEach(function(n){var hit=af5.indexOf(n)!==-1;var cls=hit?"ns nhit":"ns nmiss";h+="<span class="+cls+">"+n+"</span>";});';
    p += 'h+="</div></div>";});';
    p += 'h+="</div>";}';
    p += 'else{h+="<div class=card style=text-align:center;padding:30px;color:#5a6180>Henuz yeterli veri yok.</div>";}';
    p += 'document.getElementById("app").innerHTML=h;';
    p += '}catch(e){document.getElementById("app").innerHTML="Hata: "+e.message;}';
    p += '};xhr.send();}load();';
    p += '</sc'+'ript></body></html>';
    res.type('html');
    res.end(p);
  });

  var PORT = process.env.PORT || 3000;
  app.listen(PORT, function() { console.log('Dashboard: http://localhost:' + PORT); });
}

console.log('Basliyor...');