const { chromium } = require('/opt/node22/lib/node_modules/playwright/index.js'); const path=require('path');
(async()=>{
  const C='/home/user/content/akt-priemki/cases/CP-1-2026/'; const SP='/tmp/claude-0/-home-user-content/67848746-47dc-59e1-85f2-41e3992002c7/scratchpad/';
  // Playwright setInputFiles silently ignores paths with non-ASCII characters -> stage xlsx under ASCII names
  require('fs').copyFileSync(C+'пакинг факт.xlsx',SP+'fact.xlsx'); require('fs').copyFileSync(C+'Приобретение Четинкая Пано.xlsx',SP+'receipt.xlsx');
  const b=await chromium.launch(); const ctx=await b.newContext({acceptDownloads:true}); const p=await ctx.newPage();
  p.on('pageerror',e=>console.log('PAGEERROR',e.message)); p.on('console',m=>console.log('CONSOLE',m.type(),m.text().slice(0,200)));
  p.on('dialog',d=>{ console.log('ALERT:',d.message()); d.dismiss(); });
  await p.goto('file://'+path.resolve('Акт приёмки — мастер.html'));
  const up=async(id,files)=>{ await p.setInputFiles(`#${id} input[type=file]`, files); await p.waitForTimeout(400); };
  const st=async(i)=>{ await p.evaluate(i=>go(i),i); await p.waitForTimeout(150); };
  await st(0); await up('sup',[C+'a0e0f688-____________________1___26_1.pdf']); await p.waitForFunction(()=>S.sup); console.log('sup:',await p.evaluate(()=>({n:S.sup.number,t:S.sup.total,rows:S.sup.rows.length,sum:+S.sup.rows.reduce((a,r)=>a+r.value,0).toFixed(2)})));
  await st(1); await up('kvt',['0c277976-_________________1044____28______2026_.__________.pdf','208c9d72-___________________-1164____18.08.2026.pdf','50e3d248-___________________-1241____03.09.2026.pdf','956ab42b-_________________1244____7__________2026_.__________.pdf','kvt_1043.pdf','kvt_1165.pdf'].map(f=>C+f)); await p.waitForFunction(()=>S.kvt.length>=6,{timeout:20000});
  await p.evaluate(()=>{ S.kvt.push({number:'1276',date:new Date(2026,8,10),currency:'RUB',total:58163.16,vat:10488.44,category:'rf_broker',desc:'СВХ',manual:true}); render(); });
  console.log('kvt:',await p.evaluate(()=>S.kvt.map(k=>[k.number,k.currency,k.total,k.category])));
  await st(2); await up('gtd',[C+'GTD_10131010_240826_5298969.pdf']); await p.waitForFunction(()=>S.gtd,{timeout:60000}); console.log('gtd:',await p.evaluate(()=>S.gtd));
  await st(3); await up('pack',[C+'Inseda_Packing_List.pdf']); await p.waitForFunction(()=>S.pack); console.log('pack:',await p.evaluate(()=>S.pack));
  await st(4); await up('fact',[SP+'fact.xlsx']); await p.waitForFunction(()=>S.fact); console.log('fact keys:',await p.evaluate(()=>Object.keys(S.fact).length));
  await st(5); await up('receipt',[SP+'receipt.xlsx']); await p.waitForFunction(()=>S.receipt); console.log('receipt:',await p.evaluate(()=>({n:Object.keys(S.receipt.items).length,anom:S.receipt.anomalies.map(a=>a.code+':'+a.diff)})));
  await st(6); await p.evaluate(()=>{ Object.assign(S.params,{act_no:'1',label:'СР отгрузка 1 в 26',act_date:'2026-09-14',pickup_date:'2026-07-17',depart_date:'2026-07-28',to_date:'2026-08-24',arrival_date:'2026-09-07',usd_rate:'82.9211',eur_rate:'96.8601'}); });
  await st(7); console.log('compute:',await p.evaluate(()=>{const C=compute();return {cat:C.cat,fee:C.fee,duty:C.duty,vat:C.vat,total:+C.totalRub.toFixed(2),pct:+C.pct.toFixed(2),stage2:+C.stage2.toFixed(2),diffs:C.diffs.length,priceDiffs:C.priceDiffs.length,uom:C.uom.length};}));
  await p.screenshot({path:'/tmp/claude-0/-home-user-content/67848746-47dc-59e1-85f2-41e3992002c7/scratchpad/akt/app_step8.png',fullPage:true});
  const [dl]=await Promise.all([p.waitForEvent('download',{timeout:60000}), p.click('button.pri')]); const out='/tmp/claude-0/-home-user-content/67848746-47dc-59e1-85f2-41e3992002c7/scratchpad/akt/app_out.xlsx'; await dl.saveAs(out); console.log('downloaded:',dl.suggestedFilename());
  await b.close();
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
