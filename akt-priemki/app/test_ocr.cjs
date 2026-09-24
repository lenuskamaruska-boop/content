// node test_ocr.cjs <инвойс.pdf> [упаковочный.pdf] [out.json] — прогон OCR через мастер
const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'); const path=require('path'); const fs=require('fs');
(async()=>{ const [inv,pack,out]=process.argv.slice(2); const b=await chromium.launch(); const p=await (await b.newContext()).newPage(); p.on('pageerror',e=>console.log('PAGEERROR',e.message)); p.on('dialog',d=>{console.log('ALERT',d.message());d.dismiss();});
  await p.goto('file://'+path.resolve('Акт приёмки — мастер.html')); const t0=Date.now();
  await p.setInputFiles('#sup input[type=file]',inv);
  while(!(await p.evaluate(()=>!!S.sup))){ await p.waitForTimeout(5000); if(Date.now()-t0>1200000) throw new Error('OCR timeout'); }
  console.log('OCR done in',Math.round((Date.now()-t0)/1000),'s');
  const r=await p.evaluate(()=>{ const s=S.sup; return {number:s.number,date:s.date,supplier:s.supplier,total:s.total,grand:s.grand,pcs:s.pcs,rows:s.rows.length,ok:s.rows.filter(r=>r.ok).length,sumRows:+s.rows.reduce((a,r)=>a+r.value,0).toFixed(2),sumQty:s.rows.reduce((a,r)=>a+r.qty,0),bad:s.rows.filter(r=>!r.ok).map(r=>[r.pg,r.i,r.code,r.raw.qty,r.raw.price,r.raw.total])}; });
  console.log(JSON.stringify(r,null,1));
  if(pack){ await p.evaluate(()=>go(3)); await p.setInputFiles('#pack input[type=file]',pack); await p.waitForFunction(()=>S.pack&&!S.ocr,{timeout:300000}); console.log('pack totals:',await p.evaluate(()=>({boxes:S.pack.boxes,pallets:S.pack.pallets,volume:S.pack.volume,gross:S.pack.gross,net:S.pack.net,inv:S.pack.invoices})));
    if(await p.evaluate(()=>!!S.packFile)){ const t1=Date.now(); await p.evaluate(()=>ocrPackItems()); await p.waitForFunction(()=>S.pack&&S.pack.items&&!S.ocr,{timeout:900000}); console.log('items OCR in',Math.round((Date.now()-t1)/1000),'s'); } console.log('pack:',await p.evaluate(()=>S.pack&&{boxes:S.pack.boxes,pallets:S.pack.pallets,volume:S.pack.volume,gross:S.pack.gross,net:S.pack.net,pieces:S.pack.pieces,codes:S.pack.items&&Object.keys(S.pack.items).length})); }
  if(out) fs.writeFileSync(out,JSON.stringify(await p.evaluate(()=>S.sup.rows.map(r=>({pg:r.pg,i:r.i,code:r.code,qty:r.qty,price:r.price,value:r.value,ok:r.ok,score:r.score,raw:r.raw}))),null,1));
  await b.close(); })().catch(e=>{console.error('FAIL',e);process.exit(1);});
