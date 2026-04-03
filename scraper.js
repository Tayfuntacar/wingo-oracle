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
  console.log('Tablo hazir!');
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
              db.query('INSERT INTO draws (round, first, over_under, color, all_numbers) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (round) DO NOTHING', [a.number, first, ou, renk, a.ballNumbers.join(',')]).catch(function(e) { console.log('DB hatasi:', e.message); });
            }
          }
        } catch(e) {}
      });
      w.on('close', function() { setTimeout(connect, 3000); });
      w.on('error', function() { setTimeout(connect, 3000); });
    });
  }).end();
}

function predict(draws) {
  var result = {};
  if (!draws || draws.length < 5) return result;
  var allNums = draws.map(function(d) { return d.all_numbers ? d.all_numbers.split(',').map(Number) : []; });
  var firstNums = draws.map(function(d) { return parseInt(d.first); });
  var colorList = draws.map(function(d) { return d.color; });
  var n = draws.length;

  // OVER/UNDER
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

  // RENK
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

  // İLK SAYI 5 ADAY - son 15 çekilişte ilk düşmeyen sayılar
  var recent15first = firstNums.slice(0, Math.min(15, n));
  var coldFirst15 = [];
  for(var i=1;i<=48;i++){
    if(recent15first.indexOf(i)===-1) coldFirst15.push(i);
  }

  // Son düşüşten bu yana kaç çekiliş geçti
  var numLastSeen = {};
  for(var i=1;i<=48;i++) numLastSeen[i] = 999;
  firstNums.forEach(function(num, idx){ if(numLastSeen[num]===999) numLastSeen[num]=idx; });

  // Skor: uzun süredir gelmeyen + soğuk = yüksek
  var candidateScores = {};
  for(var i=1;i<=48;i++){
    var coldBonus = coldFirst15.indexOf(i)!==-1 ? 20 : 0;
    var lastSeenScore = Math.min(numLastSeen[i], 30);
    candidateScores[i] = coldBonus + lastSeenScore;
  }

  // Over/Under tahminine göre filtrele
  var filtered = Object.keys(candidateScores).map(Number);
  if(predOU === 'OVER') {
    filtered = filtered.filter(function(x){ return x > 24; });
    if(filtered.length < 5) filtered = Object.keys(candidateScores).map(Number);
  } else {
    filtered = filtered.filter(function(x){ return x <= 24; });
    if(filtered.length < 5) filtered = Object.keys(candidateScores).map(Number);
  }

  result.first_candidates = filtered.sort(function(a,b){ return candidateScores[b]-candidateScores[a]; }).slice(0,5);

  // İLK 5'TE ÇIKACAK 6 ADAY
  var first5freq={};
  allNums.forEach(function(balls){balls.slice(0,5).forEach(function(num){first5freq[num]=(first5freq[num]||0)+1;});});
  var recent20first5=[];
  allNums.slice(0,Math.min(20,n)).forEach(function(balls){balls.slice(0,5).forEach(function(num){recent20first5.push(num);});});
  var coldFirst5=[];
  for(var i=1;i<=48;i++){if(recent20first5.indexOf(i)===-1)coldFirst5.push(i);}
  var first5scores={};
  for(var i=1;i<=48;i++){
    first5scores[i]=(coldFirst5.indexOf(i)!==-1?15:0)-(first5freq[i]||0)*0.5+Math.min(numLastSeen[i],20)*0.5;
  }
  result.first5_candidates=Object.keys(first5scores).map(Number).sort(function(a,b){return first5scores[b]-first5scores[a];}).slice(0,6);

  // KESİN 8 SAYI
  var allFreq={};for(var i=1;i<=48;i++)allFreq[i]=0;
  allNums.forEach(function(balls,di){balls.forEach(function(num,bi){allFreq[num]+=1/(di+1)/(bi+1);});});
  var recent10all=[];
  allNums.slice(0,Math.min(10,n)).forEach(function(balls){balls.forEach(function(num){recent10all.push(num);});});
  var cold10=[];
  for(var i=1;i<=48;i++){if(recent10all.indexOf(i)===-1)cold10.push(i);}
  var kesinScores={};
  for(var i=1;i<=48;i++){
    kesinScores[i]=(cold10.indexOf(i)!==-1?15:0)-allFreq[i]*2+Math.min(numLastSeen[i],20)*0.3;
  }
  result.certain8=Object.keys(kesinScores).map(Number).sort(function(a,b){return kesinScores[b]-kesinScores[a];}).slice(0,8);

  return result;
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

  app.get('/', function(req, res) {
    var p = '<!DOCTYPE html><html><head>';
    p += '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WingoOracle</title>';
    p += '<style>';
    p += '*{margin:0;padding:0;box-sizing:border-box}';
    p += 'body{background:#1e2130;color:#ffffff;font-family:Arial,sans-serif;padding:12px;max-width:480px;margin:0 auto}';
    p += 'h1{color:#ffffff;font-size:22px;margin-bottom:14px;text-align:center;font-weight:800;letter-spacing:2px}';
    p += '.card{background:#262a3a;border:1px solid #3a3f52;border-radius:14px;padding:14px;margin-bottom:10px}';
    p += '.title{font-size:11px;color:#aab0c4;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;font-weight:700}';
    p += '.over{color:#22c55e;font-weight:800}.under{color:#ef4444;font-weight:800}';
    p += '.big{font-size:34px;font-weight:900;margin:4px 0}';
    p += '.conf{font-size:13px;color:#aab0c4;margin-top:3px;font-weight:600}';
    p += '.nums{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}';
    p += '.num{border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#ffffff}';
    p += '.row{display:grid;grid-template-columns:65px 45px 110px 70px;align-items:center;padding:9px 0;border-bottom:1px solid #3a3f52;font-size:13px}';
    p += '.row:last-child{border:none}';
    p += '.bar{height:7px;background:#3a3f52;border-radius:4px;margin:8px 0;overflow:hidden}';
    p += '.barfill{height:100%;border-radius:4px}';
    p += '.statrow{display:flex;justify-content:space-between;font-size:16px;font-weight:800;margin-bottom:4px}';
    p += '.alert{background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.6);border-radius:8px;padding:10px;margin-bottom:10px;font-size:13px;color:#ff6b6b;font-weight:700}';
    p += '.cbox{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border-radius:20px;font-size:12px;margin:3px;font-weight:800;color:#fff}';
    p += '.ref{color:#5a6180;font-size:11px;text-align:center;margin-top:10px}';
    p += '</style></head><body>';
    p += '<h1>WINGO ORACLE</h1><div id="app"><div style="text-align:center;padding:40px;color:#5a6180">Yukleniyor...</div></div>';
    p += '<script type="text/javascript">';
    p += 'var CH='+chStr+';';
    p += 'function load(){var xhr=new XMLHttpRequest();xhr.open("GET","/data");xhr.onload=function(){try{';
    p += 'var d=JSON.parse(xhr.responseText);var pr=d.predictions;var h="";';
    p += 'if(pr&&pr.over_under){var ou=pr.over_under;var oc=ou.pred==="OVER"?"#22c55e":"#ef4444";';
    p += 'h+="<div class=card style=border-color:"+(ou.pred==="OVER"?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)")+"><div class=title>Over / Under Tahmini</div>";';
    p += 'h+="<div class=big style=color:"+oc+">"+ou.pred+"</div><div class=conf>Guven: %"+ou.conf+"</div></div>";}';
    p += 'if(pr&&pr.color){var cl=pr.color;var pc=CH[cl.pred]||"#fff";';
    p += 'h+="<div class=card style=border-color:"+pc+"66><div class=title>Renk Tahmini</div>";';
    p += 'if(cl.alert){h+="<div class=alert>"+cl.alert+"</div>";}';
    p += 'h+="<div class=big style=color:"+pc+">"+cl.pred+"</div><div class=conf>Guven: %"+cl.conf+"</div>";';
    p += 'h+="<div style=margin-top:12px><div class=title>Son 30 Cekilis Renk Dagilimi</div><div style=margin-top:6px>";';
    p += 'var cnames=["Sari","Yesil","Mavi","Kirmizi","Kahve","Turuncu","Siyah","Mor"];';
    p += 'cnames.forEach(function(cn){var cnt=cl.counts[cn]||0;var bg=CH[cn]||"#333";';
    p += 'var op=cnt===0?1:cnt<=2?0.65:0.3;';
    p += 'var shadow=cnt===0?"box-shadow:0 0 14px "+bg+";border:2px solid "+bg:"border:1px solid "+bg+"44";';
    p += 'h+="<span class=cbox style=background:"+bg+";opacity:"+op+";"+shadow+">"+cn+" "+cnt+"</span>";});';
    p += 'h+="</div></div></div>";}';
    p += 'if(pr&&pr.first_candidates){h+="<div class=card><div class=title>Ilk Sayi - 5 Aday</div><div class=nums>";';
    p += 'pr.first_candidates.forEach(function(n){h+="<div class=num style=background:#1e3a5f;border:2px solid #3b82f6>"+n+"</div>";});';
    p += 'h+="</div></div>";}';
    p += 'if(pr&&pr.first5_candidates){h+="<div class=card><div class=title>Ilk 5te Cikacak - 6 Aday</div><div class=nums>";';
    p += 'pr.first5_candidates.forEach(function(n){h+="<div class=num style=background:#2a3040;border:1px solid #4a5270>"+n+"</div>";});';
    p += 'h+="</div></div>";}';
    p += 'if(pr&&pr.certain8){h+="<div class=card><div class=title>Kesin Cikacak - 8 Sayi</div><div class=nums>";';
    p += 'pr.certain8.forEach(function(n){h+="<div class=num style=background:#2a3040;border:1px solid #4a5270>"+n+"</div>";});';
    p += 'h+="</div></div>";}';
    p += 'if(d.stats){h+="<div class=card><div class=title>Genel Istatistik ("+d.stats.total+" Round)</div>";';
    p += 'h+="<div class=statrow><span class=over>OVER %"+d.stats.over_pct+"</span><span class=under>UNDER %"+d.stats.under_pct+"</span></div>";';
    p += 'h+="<div class=bar><div class=barfill style=width:"+d.stats.over_pct+"%;background:#22c55e></div></div></div>";}';
    p += 'if(d.last20){h+="<div class=card><div class=title>Son Cekilisler</div>";';
    p += 'd.last20.forEach(function(r){var oc=r.over_under==="OVER"?"#22c55e":"#ef4444";var rc=CH[r.color]||"#aaa";';
    p += 'h+="<div class=row><span style=color:#aab0c4;font-size:12px;font-weight:600>"+r.round+"</span><span style=font-weight:900;font-size:17px;color:#ffffff>"+r.first+"</span><span style=color:"+rc+";font-weight:800;font-size:13px>"+r.color+"</span><span style=color:"+oc+";font-weight:900;font-size:14px;text-align:right>"+r.over_under+"</span></div>";});';
    p += 'h+="</div>";}';
    p += 'h+="<div class=ref>Her 30 saniyede bir guncellenir</div>";';
    p += 'document.getElementById("app").innerHTML=h;';
    p += '}catch(e){document.getElementById("app").innerHTML="<div style=color:#ef4444;padding:20px>Hata: "+e.message+"</div>";}';
    p += '};xhr.send();}load();setInterval(load,30000);';
    p += '</sc'+'ript></body></html>';
    res.type('html');
    res.end(p);
  });

  var PORT = process.env.PORT || 3000;
  app.listen(PORT, function() { console.log('Dashboard: http://localhost:' + PORT); });
}

console.log('Basliyor...');