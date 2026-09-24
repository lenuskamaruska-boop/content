const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'); const path=require('path'); const fs=require('fs');
(async()=>{ const C='/home/user/content/akt-priemki/cases/EMAS-4-2026/'; const SP='/tmp/claude-0/-home-user-content/67848746-47dc-59e1-85f2-41e3992002c7/scratchpad/';
  const b=await chromium.launch(); const ctx=await b.newContext({acceptDownloads:true}); const p=await ctx.newPage(); p.on('pageerror',e=>console.log('PAGEERROR',e.message)); p.on('dialog',d=>{console.log('ALERT',d.message());d.dismiss();});
  p.on('console',m=>{ if(m.type()==='error') console.log('CONSOLE',m.text().slice(0,200)); });
  await p.goto('file://'+path.resolve('Акт приёмки — мастер.html')); const t0=Date.now();
  await p.setInputFiles('#sup input[type=file]',C+'Invoice_EMAS_4_26.pdf');
  let last=''; while(!(await p.evaluate(()=>!!S.sup))){ await p.waitForTimeout(5000); const m=await p.evaluate(()=>S.ocr&&S.ocr.msg||''); if(m!==last&&/страница \d+ из \d+: (подготовка|строка (1|40|70) )/.test(m)){ console.log(Math.round((Date.now()-t0)/1000)+'s',m); last=m; } if(Date.now()-t0>900000) throw new Error('OCR timeout'); }
  console.log('OCR done in',Math.round((Date.now()-t0)/1000),'s');
  const r=await p.evaluate(()=>{ const s=S.sup; return {number:s.number,date:s.date,supplier:s.supplier,total:s.total,grand:s.grand,pcs:s.pcs,rows:s.rows.length,ok:s.rows.filter(r=>r.ok).length,sumRows:+s.rows.reduce((a,r)=>a+r.value,0).toFixed(2),sumQty:s.rows.reduce((a,r)=>a+r.qty,0),bad:s.rows.filter(r=>!r.ok).map(r=>[r.code,r.raw.qty,r.raw.price,r.raw.total])}; });
  console.log(JSON.stringify(r,null,1));
  await p.evaluate(()=>go(3)); await p.setInputFiles('#pack input[type=file]',C+'Packing_EMAS_4_26.pdf'); await p.waitForFunction(()=>S.pack);
  console.log('pack:',await p.evaluate(()=>{ const p=S.pack; return {boxes:p.boxes,pallets:p.pallets,volume:p.volume,gross:p.gross,net:p.net,pieces:p.pieces,codes:Object.keys(p.items).length,container:p.container,inv:p.invoices}; }));
  console.log('fixed codes:',await p.evaluate(()=>S.sup.rows.filter(r=>r.fixed).map(r=>r.orig+'>'+r.code)));
  console.log('pack1 diffs:',await p.evaluate(()=>{ const C=compute(); return {n:C.pack1.length,sample:C.pack1.slice(0,12)}; }));
  await p.screenshot({path:SP+'akt/emas_step1.png',fullPage:true});
  fs.writeFileSync(SP+'akt/emas_sup.json',JSON.stringify(await p.evaluate(()=>S.sup.rows.map(r=>({code:r.code,qty:r.qty,price:r.price,value:r.value,ok:r.ok,raw:r.raw}))),null,1));
  await b.close(); })().catch(e=>{console.error('FAIL',e);process.exit(1);});
