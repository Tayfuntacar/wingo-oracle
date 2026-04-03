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
  return db.query('CREATE TABLE IF NOT EXISTS predictions (id SERIAL PRIMARY KEY, round INT UNIQUE, pred_ou VARCHAR(5), pred_color VARCHAR(20), pred_first TEXT, pred_first5 TEXT, pred_certain8 TEXT, actual_first INT, actual_color VARCHAR(20), actual_ou VARCHAR(5), ou_hit SMALLINT DEFAULT -1, color_hit SMALLINT DEFAULT -1, first_hit SMALLINT DEFAULT -1, first5_hit SMALLINT DEFAULT -1, certain8_hit SMALLINT DEFAULT -1, created_at TIMESTAMP DEFAULT NOW())');
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
              var ou = first > 24 ? 'OVER' : 'UNDER';
              var renk = colors[first] || 'Bilinmiyor';
              console.log('ROUND:' + a.number + ' FIRST:' + first + ' ' + ou + ' ' + renk);
              saveDraw(a.number, first, ou, renk, a.ballNumbers.join(','));
            }
          }
        } catch(e) { console.log('Mesaj hatasi:', e.message); }
      });
      w.on('close', function() {
        console.log('WS kapandi, yeniden baglaniliyor...');
        setTimeout(connect, 3000);
      });
      w.on('error', function(e) { console.log('WS hatasi:', e.message); });
    });
  }).on('error', function(e) {
    console.log('HTTP hatasi:', e.message);
    setTimeout(connect, 5000);
  }).end();
}

function saveDraw(round, first, ou, renk, allNums) {
  db.query('INSERT INTO draws (round, first, over_under, color, all_numbers) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (round) DO NOTHING',
    [round, first, ou, renk, allNums]).then(function() {
    updatePredictions(round, first, ou, renk);
    saveNextPrediction(round);
  }).catch(function(e) { console.log('Draw kayit hatasi:', e.message); });
}

function updatePredictions(round, first, ou, renk) {
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
      db.query('UPDATE predictions SET actual_first=$1, actual_color=$2, actual_ou=$3, ou_hit=$4, color_hit=$5, first_hit=$6, first5_hit=$7, certain8_hit=$8 WHERE id=$9',
        [first, renk, ou, ouHit, colorHit, firstHit, f5Hit, c8Hit, row.id]).catch(function(e) {
        console.log('Prediction update hatasi:', e.message);
      });
    });
  }).catch(function(e) { console.log('Prediction select hatasi:', e.message); });
}

function saveNextPrediction(round) {
  db.query('SELECT round, first, over_under, color, all_numbers FROM draws ORDER BY round DESC LIMIT 100').then(function(res) {
    var draws = res.rows;
    if (draws.length >= 5) {
      var pred = predict(draws);
      if (pred.over_under) {
        db.query('INSERT INTO predictions (round, pred_ou, pred_color, pred_first, pred_first5, pred_certain8) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (round) DO NOTHING',
          [round + 1, pred.over_under.pred, pred.color ? pred.color.pred : '',
           pred.first_candidates ? pred.first_candidates.join(',') : '',
           pred.first5_candidates ? pred.first5_candidates.join(',') : '',
           pred.certain8 ? pred.certain8.join(',') : ''
          ]).catch(function(e) { console.log('Prediction insert hatasi:', e.message); });
      }
    }
  }).catch(function(e) { console.log('Draw select hatasi:', e.message); });
}

function predict(draws) {
  var result = {};
  if (!draws || draws.length < 5) return result;
  var allNums = draws.map(function(d) { return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });
  var firstNums = draws.map(function(d) { return parseInt(d.first); });
  var colorList = draws.map(function(d) { return d.color; });
  var n = draws.length;
  var last3over = firstNums.slice(0,3).filter(function(x){return x>24;}).length;
  var last5over = firstNums.slice(0,5).filter(function(x){return x>24;}).length;
  var overPct = Math.round(firstNums.filter(function(x){return x>24;}).length/n*100);
  var predOU='OVER',ouConf=50;
  if(last3over===3){predOU='UNDER';ouConf=75;}
  else if(last3over===0){predOU='OVER';ouConf=75;}
  else if(last5over>=4){predOU='UNDER';ouConf=68;}
  else if(last5over<=1){predOU='OVER';ouConf=68;}
  else if(overPct>58){predOU='UNDER';ouConf=60;}
  else if(overPct<42){predOU='OVER';ouConf=60;}
  else{predOU=overPct>=50?'OVER':'UNDER';ouConf=52;}
  result.over_under={pred:predOU,conf:ouConf};
  var recent30=colorList.slice(0,Math.min(30,n));
  var colorCount30={};ALL_COLORS.forEach(function(c){colorCount30[c]=0;});
  recent30.forEach(function(c){if(colorCount30[c]!==undefined)colorCount30[c]++;});
  var colorLastSeen={};ALL_COLORS.forEach(function(c){colorLastSeen[c]=999;});
  colorList.forEach(function(c,i){if(colorLastSeen[c]===999)colorLastSeen[c]=i;});
  var coldColors=ALL_COLORS.filter(function(c){return colorCount30[c]===0;});
  var colorAlert='';
  if(coldColors.length>=4)colorAlert='KRITIK: '+coldColors.length+' renk hic ilk dusmedi!';
  else if(coldColors.length===3)colorAlert='DIKKAT: 3 soguk renk, biri yakinda gelecek';
  else if(coldColors.length===2)colorAlert='2 soguk renk mevcut';
  var colorScores={};
  ALL_COLORS.forEach(function(c){colorScores[c]=(30-colorCount30[c]*3)+Math.min(colorLastSeen[c],30);});
  var predColor=coldColors.length>0?coldColors.sort(function(a,b){return colorLastSeen[b]-colorLastSeen[a];})[0]:ALL_COLORS.slice().sort(function(a,b){return colorScores[b]-colorScores[a];})[0];
  var colorConf=coldColors.length>=3?65:coldColors.length===2?55:40;
  result.color={pred:predColor,conf:colorConf,alert:colorAlert,counts:colorCount30};
  var numLastSeen={};for(var i=1;i<=48;i++)numLastSeen[i]=999;
  firstNums.forEach(function(num,idx){if(numLastSeen[num]===999)numLastSeen[num]=idx;});
  var recent15first=firstNums.slice(0,Math.min(15,n));
  var coldFirst15=[];for(var i=1;i<=48;i++){if(recent15first.indexOf(i)===-1)coldFirst15.push(i);}
  var candidateScores={};
  for(var i=1;i<=48;i++){candidateScores[i]=(coldFirst15.indexOf(i)!==-1?20:0)+Math.min(numLastSeen[i],30);}
  var filtered=Object.keys(candidateScores).map(Number);
  if(predOU==='OVER'){var ov=filtered.filter(function(x){return x>24;});if(ov.length>=5)filtered=ov;}
  else{var un=filtered.filter(function(x){return x<=24;});if(un.length>=5)filtered=un;}
  result.first_candidates=filtered.sort(function(a,b){return candidateScores[b]-candidateScores[a];}).slice(0,5);
  var first5freq={};allNums.forEach(function(balls){balls.slice(0,5).forEach(function(num){first5freq[num]=(first5freq[num]||0)+1;});});
  var recent20first5=[];allNums.slice(0,Math.min(20,n)).forEach(function(balls){balls.slice(0,5).forEach(function(num){recent20first5.push(num);});});
  var coldFirst5=[];for(var i=1;i<=48;i++){if(recent20first5.indexOf(i)===-1)coldFirst5.push(i);}
  var first5scores={};
  for(var i=1;i<=48;i++){first5scores[i]=(coldFirst5.indexOf(i)!==-1?15:0)-(first5freq[i]||0)*0.5+Math.min(numLastSeen[i],20)*0.5;}
  result.first5_candidates=Object.keys(first5scores).map(Number).sort(function(a,b){return first5scores[b]-first5scores[a];}).slice(0,6);
  var allFreq={};for(var i=1;i<=48;i++)allFreq[i]=0;
  allNums.forEach(function(balls,di){balls.forEach(function(num,bi){allFreq[num]+=1/(di+1)/(bi+1);});});
  var recent10all=[];allNums.slice(0,Math.min(10,n)).forEach(function(balls){balls.forEach(function(num){recent10all.push(num);});});
  var cold10=[];for(var i=1;i<=48;i++){if(recent10all.indexOf(i)===-1)cold10.push(i);}
  var kesinScores={};
  for(var i=1;i<=48;i++){kesinScores[i]=(cold10.indexOf(i)!==-1?15:0)-allFreq[i]*2+Math.min(numLastSeen[i],20)*0.3;}
  result.certain8=Object.keys(kesinScores).map(Number).sort(function(a,b){return kesinScores[b]-kesinScores[a];}).slice(0,8);
  return result;
}

function raporHTML(chStr) {
  var p = '<!DOCTYPE html><html><head>';
  p += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapor</title>';
  p += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:600px;margin:0 auto}';
  p += 'h1{color:#fff;font-size:20px;margin-bottom:14px;text-align:center;font-weight:800}';
  p += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
  p += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
  p += '.srow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #3a3f52;font-size:14px}.srow:last-child{border:none}';
  p += '.good{color:#22c55e}.bad{color:#ef4444}.mid{color:#facc15}';
  p += '.trow{display:grid;grid-template-columns:55px 40px 70px 28px 28px 28px 28px 28px;gap:3px;padding:7px 0;border-bottom:1px solid #3a3f52;font-size:12px;align-items:center}.trow:last-child{border:none}';
  p += '.hit{color:#22c55e;font-weight:900;font-size:15px}.miss{color:#ef4444;font-weight:900;font-size:15px}';
  p += '.bar{height:8px;background:#3a3f52;border-radius:4px;margin-top:6px;overflow:hidden}.barfill{height:100%;border-radius:4px;background:#22c55e}';
  p += '.btn{display:block;width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;margin-bottom:10px}';
  p += '</style></head><body>';
  p += '<h1>TAHMIN RAPORU</h1>';
  p += '<button class=btn onclick="window.location.href=\'/'+'\'">ANA SAYFA</button>';
  p += '<div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
  p += '<script type="text/javascript">';
  p += 'var CH=' + chStr + ';';
  p += 'function load(){';
  p += 'var xhr=new XMLHttpRequest();';
  p += 'xhr.open("GET","/report");';
  p += 'xhr.onload=function(){';
  p += 'try{';
  p += 'var d=JSON.parse(xhr.responseText);';
  p += 'var h="";';
  p += 'var s=d.summary;';
  p += 'h+="<div class=card><div class=title>Basari Ozeti (Son 50 Tahmin)</div>";';
  p += 'var cats=[["Over/Under",s.ou],["Renk",s.color],["Ilk Sayi 5 Aday",s.first],["Ilk 5 - 6 Aday",s.first5],["Kesin 8 Sayi",s.certain8]];';
  p += 'cats.forEach(function(cat){';
  p += 'var name=cat[0];var st=cat[1];var pct=st.pct;';
  p += 'var cls=pct>=60?"good":pct>=45?"mid":"bad";';
  p += 'h+="<div class=srow>";';
  p += 'h+="<span style=font-weight:700>"+name+"</span>";';
  p += 'h+="<div style=text-align:right>";';
  p += 'h+="<span style=font-size:22px;font-weight:900 class="+cls+">%"+pct+"</span>";';
  p += 'h+="<div style=font-size:11px;color:#aab0c4>"+st.hit+"/"+st.total+" tuttu</div>";';
  p += 'h+="<div class=bar><div class=barfill style=width:"+pct+"%></div></div>";';
  p += 'h+="</div></div>";';
  p += '});';
  p += 'h+="</div>";';
  p += 'if(d.rows&&d.rows.length>0){';
  p += 'h+="<div class=card><div class=title>Son 50 Tahmin Detayi</div>";';
  p += 'h+="<div class=trow>";';
  p += 'h+="<span style=color:#aab0c4>Round</span>";';
  p += 'h+="<span style=color:#aab0c4>1.S</span>";';
  p += 'h+="<span style=color:#aab0c4>Renk</span>";';
  p += 'h+="<span style=color:#aab0c4>OU</span>";';
  p += 'h+="<span style=color:#aab0c4>R</span>";';
  p += 'h+="<span style=color:#aab0c4>1S</span>";';
  p += 'h+="<span style=color:#aab0c4>15</span>";';
  p += 'h+="<span style=color:#aab0c4>K8</span>";';
  p += 'h+="</div>";';
  p += 'd.rows.forEach(function(r){';
  p += 'var rc=CH[r.actual_color]||"#aaa";';
  p += 'var ous=parseInt(r.ou_hit)===1?"✓":"✗";';
  p += 'var cs=parseInt(r.color_hit)===1?"✓":"✗";';
  p += 'var fs=parseInt(r.first_hit)===1?"✓":"✗";';
  p += 'var f5s=parseInt(r.first5_hit)===1?"✓":"✗";';
  p += 'var c8s=parseInt(r.certain8_hit)===1?"✓":"✗";';
  p += 'var ouc=parseInt(r.ou_hit)===1?"hit":"miss";';
  p += 'var cc=parseInt(r.color_hit)===1?"hit":"miss";';
  p += 'var fc=parseInt(r.first_hit)===1?"hit":"miss";';
  p += 'var f5c=parseInt(r.first5_hit)===1?"hit":"miss";';
  p += 'var c8c=parseInt(r.certain8_hit)===1?"hit":"miss";';
  p += 'h+="<div class=trow>";';
  p += 'h+="<span style=color:#aab0c4;font-size:11px>"+r.round+"</span>";';
  p += 'h+="<span style=font-weight:900>"+r.actual_first+"</span>";';
  p += 'h+="<span style=color:"+rc+";font-weight:700>"+r.actual_color+"</span>";';
  p += 'h+="<span class="+ouc+">"+ous+"</span>";';
  p += 'h+="<span class="+cc+">"+cs+"</span>";';
  p += 'h+="<span class="+fc+">"+fs+"</span>";';
  p += 'h+="<span class="+f5c+">"+f5s+"</span>";';
  p += 'h+="<span class="+c8c+">"+c8s+"</span>";';
  p += 'h+="</div>";';
  p += '});';
  p += 'h+="</div>";';
  p += '}else{';
  p += 'h+="<div class=card style=text-align:center;padding:30px;color:#5a6180>Henuz yeterli veri yok.</div>";';
  p += '}';
  p += 'document.getElementById("app").innerHTML=h;';
  p += '}catch(e){document.getElementById("app").innerHTML="Hata: "+e.message;}';
  p += '};xhr.send();}load();';
  p += '</sc'+'ript></body></html>';
  return p;
}

function startDashboard() {
  var app = express();
  app.use(cors());
  var chStr = JSON.stringify(COLOR_HEX);

  app.get('/data', function(req, res) {
    Promise.all([
      db.query('SELECT round, first, over_under, color, all_numbers FROM draws ORDER BY round DESC LIMIT 100'),
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
    db.query('SELECT * FROM predictions WHERE ou_hit != -1 ORDER BY round DESC LIMIT 50').then(function(result) {
      var rows = result.rows;
      var ouHit=0,ouTotal=0,colorHit=0,colorTotal=0,firstHit=0,firstTotal=0,f5Hit=0,f5Total=0,c8Hit=0,c8Total=0;
      rows.forEach(function(r) {
        ouTotal++;if(parseInt(r.ou_hit)===1)ouHit++;
        colorTotal++;if(parseInt(r.color_hit)===1)colorHit++;
        firstTotal++;if(parseInt(r.first_hit)===1)firstHit++;
        f5Total++;if(parseInt(r.first5_hit)===1)f5Hit++;
        c8Total++;if(parseInt(r.certain8_hit)===1)c8Hit++;
      });
      res.json({
        summary:{
          ou:{hit:ouHit,total:ouTotal,pct:ouTotal>0?Math.round(ouHit/ouTotal*100):0},
          color:{hit:colorHit,total:colorTotal,pct:colorTotal>0?Math.round(colorHit/colorTotal*100):0},
          first:{hit:firstHit,total:firstTotal,pct:firstTotal>0?Math.round(firstHit/firstTotal*100):0},
          first5:{hit:f5Hit,total:f5Total,pct:f5Total>0?Math.round(f5Hit/f5Total*100):0},
          certain8:{hit:c8Hit,total:c8Total,pct:c8Total>0?Math.round(c8Hit/c8Total*100):0}
        },
        rows:rows
      });
    }).catch(function(e){res.json({error:e.message});});
  });

  app.get('/', function(req, res) {
    var p = '<!DOCTYPE html><html><head>';
    p += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WingoOracle</title>';
    p += '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#1e2130;color:#fff;font-family:Arial,sans-serif;padding:12px;max-width:480px;margin:0 auto}';
    p += 'h1{color:#fff;font-size:22px;margin-bottom:14px;text-align:center;font-weight:800;letter-spacing:2px}';
    p += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    p += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    p += '.over{color:#22c55e;font-weight:800}.under{color:#ef4444;font-weight:800}';
    p += '.big{font-size:34px;font-weight:900;margin:4px 0}.conf{font-size:13px;color:#aab0c4;margin-top:3px;font-weight:600}';
    p += '.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}';
    p += '.num{border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff}';
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
    p += 'h+="<div style=margin-top:12px><div class=title>Son 30 Renk Dagilimi</div><div style=margin-top:6px>";';
    p += 'var cnames=["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"];';
    p += 'cnames.forEach(function(cn){var cnt=cl.counts[cn]||0;var bg=CH[cn]||"#333";';
    p += 'var op=cnt===0?1:cnt<=2?0.65:0.3;var shadow=cnt===0?"box-shadow:0 0 14px "+bg+";border:2px solid "+bg:"border:1px solid "+bg+"44";';
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
    res.type('html');
    res.end(raporHTML(chStr));
  });

  var PORT = process.env.PORT || 3000;
  app.listen(PORT, function() { console.log('Dashboard: http://localhost:' + PORT); });
}

console.log('Basliyor...');