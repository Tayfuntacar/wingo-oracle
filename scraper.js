var WebSocket = require('ws');
var https = require('https');
var express = require('express');
var cors = require('cors');
var { Client } = require('pg');

var DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:LqxXVFqCIrOqDMmNmsSSOvCGLUkvEtsL@junction.proxy.rlwy.net:43663/railway';

var colors = {1:'Sari',9:'Sari',17:'Sari',25:'Sari',33:'Sari',41:'Sari',2:'Yesil',10:'Yesil',18:'Yesil',26:'Yesil',34:'Yesil',42:'Yesil',3:'Mavi',11:'Mavi',19:'Mavi',27:'Mavi',35:'Mavi',43:'Mavi',4:'Kirmizi',12:'Kirmizi',20:'Kirmizi',28:'Kirmizi',36:'Kirmizi',44:'Kirmizi',5:'Kahve',13:'Kahve',21:'Kahve',29:'Kahve',37:'Kahve',45:'Kahve',6:'Turuncu',14:'Turuncu',22:'Turuncu',30:'Turuncu',38:'Turuncu',46:'Turuncu',7:'Siyah',15:'Siyah',23:'Siyah',31:'Siyah',39:'Siyah',47:'Siyah',8:'Mor',16:'Mor',24:'Mor',32:'Mor',40:'Mor',48:'Mor'};

var db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

db.connect().then(function() {
  console.log('DB baglandi!');
  return db.query('CREATE TABLE IF NOT EXISTS draws (id SERIAL PRIMARY KEY, round INT UNIQUE, first INT, over_under VARCHAR(5), color VARCHAR(20), all_numbers TEXT, created_at TIMESTAMP DEFAULT NOW())');
}).then(function() {
  console.log('Tablo hazir!');
  connect();
  startDashboard();
}).catch(function(e) {
  console.log('DB hatasi:', e.message);
});

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

function startDashboard() {
  var app = express();
  app.use(cors());

  app.get('/data', function(req, res) {
    Promise.all([
      db.query('SELECT round, first, over_under, color FROM draws ORDER BY round DESC LIMIT 20'),
      db.query('SELECT COUNT(*) as total, SUM(CASE WHEN over_under=\'OVER\' THEN 1 ELSE 0 END) as over_count FROM draws'),
      db.query('SELECT first, color FROM draws ORDER BY round DESC LIMIT 100')
    ]).then(function(results) {
      var last20 = results[0].rows;
      var stats = results[1].rows[0];
      var last100 = results[2].rows;
      var total = parseInt(stats.total) || 0;
      var overCount = parseInt(stats.over_count) || 0;
      var overPct = total > 0 ? Math.round(overCount/total*100) : 50;
      var underPct = 100 - overPct;
      var predict = null;
      if (last100.length >= 5) {
        var nums = last100.map(function(r) { return r.first; });
        var cls = last100.map(function(r) { return r.color; });
        var last5over = nums.slice(0,5).filter(function(n) { return n > 24; }).length;
        var predOU, conf;
        if (last5over >= 4) { predOU = 'UNDER'; conf = 70; }
        else if (last5over <= 1) { predOU = 'OVER'; conf = 68; }
        else { predOU = overPct >= 50 ? 'OVER' : 'UNDER'; conf = 55; }
        var cc = {};
        cls.slice(0,30).forEach(function(c) { cc[c] = (cc[c]||0)+1; });
        var predColor = Object.keys(cc).sort(function(a,b) { return cc[a]-cc[b]; })[0];
        predict = { ou: predOU, color: predColor, conf: conf };
      }
      res.json({ last20: last20, stats: { total: total, over_pct: overPct, under_pct: underPct }, predict: predict });
    }).catch(function(e) { res.json({ error: e.message }); });
  });

  app.get('/', function(req, res) {
    var page = '<!DOCTYPE html>';
    page += '<html><head>';
    page += '<meta charset="UTF-8">';
    page += '<meta name="viewport" content="width=device-width,initial-scale=1">';
    page += '<title>WingoOracle</title>';
    page += '<style>';
    page += '*{margin:0;padding:0;box-sizing:border-box}';
    page += 'body{background:#0a0a0a;color:#fff;font-family:monospace;padding:12px}';
    page += 'h1{color:#00d4ff;font-size:22px;margin-bottom:16px;text-align:center}';
    page += '.card{background:#111;border:1px solid #222;border-radius:10px;padding:14px;margin-bottom:12px}';
    page += '.over{color:#00ff88}.under{color:#ff3366}';
    page += '.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #222;font-size:13px}';
    page += '</style></head><body>';
    page += '<h1>WingoOracle</h1>';
    page += '<div id="app">Yukleniyor...</div>';
    page += '<script type="text/javascript">';
    page += 'function load(){';
    page += 'var xhr=new XMLHttpRequest();';
    page += 'xhr.open("GET","/data");';
    page += 'xhr.onload=function(){';
    page += 'var d=JSON.parse(xhr.responseText);';
    page += 'var h="";';
    page += 'if(d.predict){var p=d.predict;var c=p.ou==="OVER"?"#00ff88":"#ff3366";h+="<div class=card><b>Tahmin:</b> <span style=color:"+c+">"+p.ou+"</span> | "+p.color+" | %"+p.conf+"</div>";}';
    page += 'if(d.stats){h+="<div class=card>OVER: %"+d.stats.over_pct+" | UNDER: %"+d.stats.under_pct+" | Toplam: "+d.stats.total+"</div>";}';
    page += 'if(d.last20){h+="<div class=card>";d.last20.forEach(function(r){var c=r.over_under==="OVER"?"#00ff88":"#ff3366";h+="<div class=row><span>"+r.round+"</span><span>"+r.first+"</span><span>"+r.color+"</span><span style=color:"+c+">"+r.over_under+"</span></div>";});h+="</div>";}';
    page += 'document.getElementById("app").innerHTML=h;';
    page += '};xhr.send();}';
    page += 'load();setInterval(load,30000);';
    page += '</sc' + 'ript></body></html>';
    res.type('html');
    res.end(page);
  });

  var PORT = process.env.PORT || 3000;
  app.listen(PORT, function() {
    console.log('Dashboard: http://localhost:' + PORT);
  });
}

console.log('Basliyor...');