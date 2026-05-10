const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox']});
  const p = await b.newPage();
  await p.goto('https://www.volcanobet.me/wingo', {waitUntil:'networkidle2', timeout:30000});
  await new Promise(r=>setTimeout(r,3000));
  
  const buttons = await p.$$eval('button', btns => btns.map(b => b.textContent.trim()));
  console.log('Butonlar:', buttons.slice(0,10));
  
  const inputs = await p.$$eval('input', ins => ins.map(i => ({type:i.type, name:i.name, placeholder:i.placeholder})));
  console.log('Inputlar:', JSON.stringify(inputs.slice(0,5)));
  
  await b.close();
})().catch(console.error);
