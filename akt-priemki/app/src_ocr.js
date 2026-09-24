// ===================== OCR сканов (tesseract.js, всё встроено в файл) =====================
// Инвойс EMAS приходит сканом без текстового слоя. Разбираем его по структуре таблицы:
// выравниваем скан, находим линии строк и колонок, распознаём каждую ячейку отдельно
// (артикул — латиница/цифры, кол-во/цена/сумма — только цифры) и проверяем кол-во × цена = сумма.
// Строки, где проверка не сошлась, показываются менеджеру с картинкой для ручной правки.
const OCR_WORKER_B64 = '__OCR_WORKER_B64__';
let _ocr = null;
async function ocrWorker(){
  if(_ocr) return _ocr;
  if(typeof Tesseract==='undefined' || OCR_WORKER_B64.length<100) throw new Error('В этот файл не встроен модуль распознавания сканов');
  const blob = new Blob([Uint8Array.from(atob(OCR_WORKER_B64), c=>c.charCodeAt(0))], {type:'text/javascript'});
  _ocr = await Tesseract.createWorker('eng', 1, {workerPath:URL.createObjectURL(blob), corePath:'x', langPath:'x', gzip:true, cacheMethod:'none', workerBlobURL:false, logger:()=>{}});
  return _ocr;
}
const PARAMS_CODE = {tessedit_pageseg_mode:'7', tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.'};
const PARAMS_NUM  = {tessedit_pageseg_mode:'7', tessedit_char_whitelist:'0123456789,. ', preserve_interword_spaces:'1'};
const PARAMS_TEXT = {tessedit_pageseg_mode:'3', tessedit_char_whitelist:''};

async function renderPage(page, targetW){
  const v1 = page.getViewport({scale:1}); const vp = page.getViewport({scale:targetW/v1.width});
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
  await page.render({canvasContext:ctx, viewport:vp}).promise; return c;
}
function grayOf(c){ const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; const g=new Uint8Array(c.width*c.height); for(let i=0,j=0;i<d.length;i+=4,j++) g[j]=(d[i]*299+d[i+1]*587+d[i+2]*114)/1000; return g; }
function groupIdx(idx,gap){ const out=[]; for(const i of idx){ if(out.length&&i-out[out.length-1][1]<=gap) out[out.length-1][1]=i; else out.push([i,i]); } return out.map(([a,b])=>Math.round((a+b)/2)); }
function hLines(g,W,H,x0,x1,thr){ const idx=[]; for(let y=0;y<H;y++){ let n=0; const o=y*W; for(let x=x0;x<x1;x++) if(g[o+x]<215) n++; if(n/(x1-x0)>thr) idx.push(y); } return groupIdx(idx,3); }
// перекос скана: сравниваем положение длинных горизонтальных линий слева и справа
function skewDy(c,g){ const W=c.width,H=c.height; const L=hLines(g,W,H,Math.round(W*.04),Math.round(W*.30),.7), R=hLines(g,W,H,Math.round(W*.70),Math.round(W*.97),.7); const ds=[];
  for(const y of L){ let best=null; for(const r of R) if(best===null||Math.abs(r-y)<Math.abs(best-y)) best=r; if(best!==null&&Math.abs(best-y)<H*.012) ds.push(best-y); }
  if(ds.length<2) return 0; ds.sort((a,b)=>a-b); return ds[ds.length>>1]; }
function rotated(c,ang){ const W=c.width,H=c.height; const c2=document.createElement('canvas'); c2.width=W; c2.height=H; const ctx=c2.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,W,H); ctx.translate(W/2,H/2); ctx.rotate(ang); ctx.drawImage(c,-W/2,-H/2); return c2; }
// сколько строк изображения — сплошные горизонтальные линии (чем ровнее скан, тем их больше)
function lineScore(c,g){ const W=c.width,H=c.height; let n=0; for(let y=0;y<H;y++){ let k=0; const o=y*W; for(let x=0;x<W;x++) if(g[o+x]<215) k++; if(k/W>.45) n++; } return n; }
function deskew(c){ const dy=skewDy(c,grayOf(c)); if(Math.abs(dy)<1.5) return c; const ang=Math.atan2(dy, c.width*(0.835-0.17));
  const a=rotated(c,-ang), b=rotated(c,ang); return lineScore(a,grayOf(a))>=lineScore(b,grayOf(b))?a:b; }
// геометрия таблицы: горизонтальные линии строк и вертикальные линии колонок
function tableGeom(c){ const W=c.width,H=c.height,g=grayOf(c);
  const idx=[]; for(let y=1;y<H-1;y++){ let n=0; const o=y*W; for(let x=0;x<W;x++) if(g[o+x]<215||g[o-W+x]<215||g[o+W+x]<215) n++; if(n/W>.45) idx.push(y); }
  const rows0=groupIdx(idx,3); if(rows0.length<3) return null; const top=rows0[0], bot=rows0[rows0.length-1];
  const cidx=[]; for(let x=0;x<W;x++){ let best=0,cur=0; for(let y=top;y<bot;y++){ cur=g[y*W+x]<215?cur+1:0; if(cur>best) best=cur; } if(best>(bot-top)*.25) cidx.push(x); }
  let cols=groupIdx(cidx,4); if(cols.length<6) return null; cols=cols.slice(-6);
  const x0=cols[0], x1=cols[5], ridx=[]; for(let y=1;y<H-1;y++){ let n=0; const o=y*W; for(let x=x0;x<x1;x++) if(g[o+x]<215||g[o-W+x]<215||g[o+W+x]<215) n++; if(n/(x1-x0)>.5) ridx.push(y); }
  const rows=normalizeRows(groupIdx(ridx,3)); return {rows,cols}; }
// линии строк: ложные (печать, жирный текст) режут строку на куски, а пропавшие склеивают две строки.
// Приводим к медианной высоте: линии ближе 0.75·h убираем, промежутки ≈ n·h делим поровну
function normalizeRows(rows){ if(rows.length<4) return rows; const gaps=[]; for(let i=1;i<rows.length;i++) gaps.push(rows[i]-rows[i-1]); const sg=[...gaps].sort((a,b)=>a-b); const h=sg[sg.length>>1]; if(!h) return rows;
  const kept=[rows[0]]; for(let i=1;i<rows.length;i++){ if(rows[i]-kept[kept.length-1]>=h*.75) kept.push(rows[i]); }
  const out=[kept[0]]; for(let i=1;i<kept.length;i++){ const g=kept[i]-kept[i-1]; const n=Math.round(g/h); if(n>=2&&n<=4&&Math.abs(g-n*h)<h*.2){ for(let k=1;k<n;k++) out.push(Math.round(kept[i-1]+g*k/n)); } out.push(kept[i]); }
  return out; }
function cropData(c,r,w){ const k=w/r.width; const c2=document.createElement('canvas'); c2.width=w; c2.height=Math.round(r.height*k); c2.getContext('2d').drawImage(c,r.left,r.top,r.width,r.height,0,0,c2.width,c2.height); return c2.toDataURL('image/jpeg',.8); }
// варианты прочтения чисел с «ценой» правки: OCR часто теряет запятую или добавляет лишнюю цифру
const uniqC=a=>{ const m=new Map(); for(const [v,sc] of a) if(v>0&&isFinite(v)&&(!m.has(v)||m.get(v)>sc)) m.set(v,sc); return [...m.entries()]; };
const subs=(D,sc,f)=>{ const out=[]; for(let i=0;i<D.length;i++) for(let k=0;k<10;k++){ if(D[i]===String(k)) continue; const v=f(D.slice(0,i)+k+D.slice(i+1)); if(v!=null) out.push([v,sc]); } return out; };
function candsPrice(s){ const out=[]; const m=s.match(/^(\d+)[,.](\d{4})$/); if(m) out.push([+(m[1]+'.'+m[2]),0]); const D=s.replace(/\D/g,''); if(D.length>=5) out.push([+(D.slice(0,-4)+'.'+D.slice(-4)),1]); if(D.length===4) out.push([+('0.'+D),1]);
  if(D.length>=5&&D.length<=7) out.push(...subs(D,3,E=>+(E.slice(0,-4)+'.'+E.slice(-4))));
  if(D.length>=6) for(let i=0;i<D.length;i++){ const E=D.slice(0,i)+D.slice(i+1); out.push([+(E.slice(0,-4)+'.'+E.slice(-4)),4]); } return uniqC(out); }
function candsTotal(s){ const out=[]; const m=s.match(/^(\d+)[,.](\d{1,2})$/); if(m) out.push([+(m[1]+'.'+m[2]),0]); const D=s.replace(/\D/g,''); if(!D) return out; out.push([+D,3]); if(D.length>=3) out.push([+(D.slice(0,-2)+'.'+D.slice(-2)),1]);
  if(D.length>=3&&D.length<=8) out.push(...subs(D,3,E=>+(E.slice(0,-2)+'.'+E.slice(-2)))); if(D.length>=2) out.push([+(D.slice(0,-1)+'.'+D.slice(-1)),2]);
  if(D.length>=4) for(let i=0;i<D.length;i++){ const E=D.slice(0,i)+D.slice(i+1); out.push([+(E.slice(0,-2)+'.'+E.slice(-2)),4]); out.push([+E,4]); } return uniqC(out); }
function candsQty(s){ const D=s.replace(/\D/g,''); const out=[]; if(D) out.push([+D,0]); for(let k=0;k<10;k++) out.push([+(D+k),3]); // потерянная последняя цифра
  if(D.length<=5) out.push(...subs(D,2,E=>+E)); if(D.length>=2) for(let i=0;i<D.length;i++) out.push([+(D.slice(0,i)+D.slice(i+1)),4]); return uniqC(out); }
// допуск: цена в инвойсе печатается с 4 знаками, а сумма считается от точной цены — расхождение растёт с количеством
const tol=q=>0.011+Math.min(q,3000)*0.00006;
function resolveRow(raw){ const Q=candsQty(raw.qty), P=candsPrice(raw.price), T=candsTotal(raw.total); let best=null;
  for(const [q,sq] of Q) for(const [p,sp] of P) for(const [t,st] of T) if(Math.abs(q*p-t)<=tol(q)){ const sc=sq+sp+st+st*0.1; if(!best||sc<best.score) best={qty:q,price:p,value:t,score:Math.round(sc)}; } // сумма — как напечатано в инвойсе (считана от точной цены)
  if(best) return best;
  // кол-во не прочиталось: выводим из суммы и цены, но только если оно согласуется с прочитанными цифрами
  const rq=raw.qty.replace(/\D/g,'');
  for(const [p,sp] of P) for(const [t,st] of T){ const q=Math.round(t/p); if(q>0&&q<100000&&Math.abs(q*p-t)<=tol(q)&&(!rq||String(q).startsWith(rq)||String(q).endsWith(rq))&&(rq.length>=3||q<10000)) return {qty:q,price:p,value:Math.round(q*p*100)/100,score:99,derived:true}; }
  return null; }
const looksCode=c=>/^[A-Z0-9][A-Z0-9\-\/.]{1,24}$/.test(c)&&(/\d/.test(c)||c.length<=6);
// вертикальные линии колонок закрашиваем белым, иначе OCR читает их как «1»
// стираем только саму линию колонки в полосе строки: тёмные пиксели, идущие сквозь всю высоту строки (цифры так не идут)
function eraseRules(c,cols,top,h,K){ const ctx=c.getContext('2d'); const pad=Math.round(8*K); for(const x of cols){ const x0=Math.max(0,Math.round(x-pad)), w=2*pad; const im=ctx.getImageData(x0,top,w,h); const d=im.data; for(let xx=0;xx<w;xx++){ let n=0; for(let yy=0;yy<h;yy++){ const i=(yy*w+xx)*4; if((d[i]*299+d[i+1]*587+d[i+2]*114)/1000<215) n++; } if(n>h*.8){ for(let yy=0;yy<h;yy++){ const i=(yy*w+xx)*4; d[i]=d[i+1]=d[i+2]=255; } } } ctx.putImageData(im,x0,top); } }
function cropCanvas(c,r){ const c2=document.createElement('canvas'); c2.width=r.width; c2.height=r.height; c2.getContext('2d').drawImage(c,r.left,r.top,r.width,r.height,0,0,r.width,r.height); return c2; }
// слова числового блока раскладываем по колонкам по их положению
function wordsOf(d){ if(d.words) return d.words; const out=[]; for(const b of d.blocks||[]) for(const p of b.paragraphs||[]) for(const l of p.lines||[]) for(const w of l.words||[]) out.push(w); return out; }
function splitByCols(data,bounds,left){ const words=wordsOf(data); if(!words.length){ const t=(data.text||'').trim().split(/\s+/).filter(Boolean); return [t[0]||'',t[1]||'',t.slice(2).join('')]; } const abs=words.some(w=>w.bbox.x1>bounds[bounds.length-1]-left+8); const cols=['','','']; for(const w of words){ const cx=(w.bbox.x0+w.bbox.x1)/2+(abs?0:left); let k=0; while(k<bounds.length&&cx>bounds[k]) k++; cols[Math.min(k,2)]+=w.text.replace(/\s/g,''); } return cols; }

async function ocrInvoice(file, progress){
  const pdf = await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise; const w = await ocrWorker();
  const rows=[], flagged=[]; let header='', footer='', dropped=0;
  for(let p=1;p<=pdf.numPages;p++){
    progress(`страница ${p} из ${pdf.numPages}: подготовка изображения…`);
    const page=await pdf.getPage(p); let c=await renderPage(page,3300); c=deskew(c); const G=tableGeom(c);
    if(p===1){ const small=deskew(await renderPage(page,1653)); await w.setParameters(PARAMS_TEXT); header=(await w.recognize(cropCanvas(small,{left:0,top:0,width:small.width,height:Math.round(small.height*.25)}))).data.text; }
    if(p===pdf.numPages){ const small=deskew(await renderPage(page,1653)); await w.setParameters(PARAMS_TEXT); footer=(await w.recognize(cropCanvas(small,{left:Math.round(small.width*.5),top:0,width:Math.round(small.width*.5),height:small.height}))).data.text; }
    if(!G) continue;
    const [x0,x1,x2,x3,x4,x5]=G.cols, K=c.width/1653; // K — масштаб относительно скана 200 dpi
    const clean=cropCanvas(c,{left:0,top:0,width:c.width,height:c.height}); for(let i=0;i<G.rows.length-1;i++){ const h=G.rows[i+1]-G.rows[i]; if(h>=15*K&&h<=40*K) eraseRules(clean,G.cols,G.rows[i]+2,h-4,K); }
    for(let i=0;i<G.rows.length-1;i++){
      const h=G.rows[i+1]-G.rows[i]; if(h<15*K||h>40*K) continue;
      const y=G.rows[i]+3*K, hh=h-6*K, rect=(a,b)=>({left:Math.round(a+3*K),top:Math.round(y),width:Math.round(b-a-6*K),height:Math.round(hh)});
      progress(`страница ${p} из ${pdf.numPages}: строка ${i+1} из ${G.rows.length-1}`);
      await w.setParameters(PARAMS_CODE); const code=(await w.recognize(clean,{rectangle:rect(x0,x1)})).data.text.trim().replace(/\s+/g,'');
      if(!code||/^PARTCODE/.test(code)) continue;
      await w.setParameters(PARAMS_NUM); const rn=rect(x2,x5); const d=(await w.recognize(clean,{rectangle:rn},{text:true,blocks:true})).data;
      const [q,pr,t]=splitByCols(d,[x3,x4],rn.left); const raw={qty:q,price:pr,total:t};
      const digits=[q,pr,t].filter(v=>/\d/.test(v)).length;
      if(digits===0&&(!looksCode(code)||code.length<=2)){ dropped++; continue; } // совсем пустая строка-шум; всё остальное — на проверку с картинкой // шум (печать, подпись), не строка таблицы
      const res=resolveRow(raw);
      const gq=parseInt(q.replace(/\D/g,''))||0, gp=(candsPrice(pr)[0]||[0])[0];
      const row={pg:p, i, code, desc:'', score:res?res.score:null, qty:res?res.qty:gq, price:res?res.price:gp, value:res?res.value:Math.round(gq*gp*100)/100, ocr:true, ok:!!res, raw};
      if(!res){ row.img=cropData(c,{left:x0,top:G.rows[i],width:x5-x0,height:h},1000); flagged.push(row); }
      rows.push(row);
    }
  }
  const numbers=[...new Set(header.match(/[A-Z]{2,4}\d{10,}/g)||[])]; const dm=header.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const gt=(footer.match(/[\d.]+,\d{2}\s*EUR/g)||[]).map(s=>num(s.replace(/\s*EUR/,''))); const grand=gt.length?Math.max(...gt):0;
  const pm=footer.match(/([\d.]+)\s*PCS/); const supplier=/EMAS|emas/.test(header+file.name)||/эмас/i.test(file.name)?'EMAS':(/CETINKAYA|ÇETİNKAYA/i.test(header)?'Cetinkaya Pano':'');
  if(dropped) log(`OCR: пропущено ${dropped} строк-шумов (печати/подписи)`);
  return {number:numbers.join(', ')||'?', date:dm?new Date(+dm[3],+dm[2]-1,+dm[1]):null, total:grand||rows.reduce((a,r)=>a+r.value,0), supplier, rows, ocr:true, flagged, pcs:pm?parseInt(pm[1].replace(/\./g,'')):0, grand};
}
// есть ли в PDF текстовый слой
async function pdfHasText(file){ const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise; let n=0; for(let p=1;p<=Math.min(2,pdf.numPages);p++){ const tc=await (await pdf.getPage(p)).getTextContent(); n+=tc.items.reduce((a,i)=>a+i.str.trim().length,0); } return n>80; }

// ===================== упаковочный лист EMAS (текстовый PDF, по коробкам) =====================
function parsePackingEmas(lines){
  const t=lines.join('\n'); if(!/Coli No/i.test(t)&&!/BOXES ON/i.test(t)) return null;
  const p={pallets:0,boxes:0,volume:0,gross:0,net:0,pieces:0,items:{},container:'',invoices:[],kind:'emas'};
  let m=t.match(/TOTAL\s+(\d+)\s+BOXES\s+ON\s+(\d+)\s+PALLETS?\s+([\d.,]+)\s*CBM/i); if(m){p.boxes=+m[1];p.pallets=+m[2];p.volume=num(m[3]);}
  m=t.match(/GROSS WEIGHT:\s*([\d.,]+)\s*KG/i); if(m)p.gross=num(m[1]); m=t.match(/NET WEIGHT:\s*([\d.,]+)\s*KG/i); if(m)p.net=num(m[1]);
  m=t.match(/\b([A-Z]{4}\d{7})\b/); if(m)p.container=m[1]; p.invoices=[...new Set(t.match(/[A-Z]{2,4}\d{10,}/g)||[])];
  let cur=null, expect=false; const isCode=x=>/^[A-Z0-9][A-Z0-9\-\/.]{1,}$/.test(x)&&/[A-Z]/.test(x);
  for(const l of lines){ const f=l.split('\t').map(s=>s.trim()).filter(Boolean); if(!f.length||/^(TOTAL|GROSS|F-ST)/.test(f[0])) continue;
    let i=0; if(/^Coli No/i.test(f[0])){ i=1; while(i<f.length&&(/cm$/i.test(f[i])||/KG$/i.test(f[i]))) i++; expect=true; cur=null; }
    if(expect&&i<f.length&&isCode(f[i])){ cur=f[i]; expect=false; const last=f[f.length-1]; if(f.length>i+1&&/^\d+$/.test(last)){ p.items[cur]=(p.items[cur]||0)+ +last; cur=null; expect=true; } continue; }
    if(cur&&/^\d+$/.test(f[f.length-1])){ p.items[cur]=(p.items[cur]||0)+ +f[f.length-1]; cur=null; expect=true; } }
  p.pieces=Object.values(p.items).reduce((a,b)=>a+b,0); return p;
}

// ===================== уточнение артикулов после OCR по надёжным источникам =====================
// OCR путает O/0, I/1, S/5, B/8, Z/2, G/6, D/0. Артикулы из упаковочного листа, факта и 1С — точные,
// поэтому нераспознанный артикул заменяем на единственный подходящий из них.
const CANON={'O':'0','I':'1','L':'1','S':'5','B':'8','Z':'2','G':'6','Q':'0','D':'0'};
const canon=c=>norm(c).replace(/[-./]/g,'').replace(/[OILSBZGQD]/g,ch=>CANON[ch]);
function fixCodes(){
  if(!S.sup||!S.sup.ocr) return 0;
  const refs=new Set([...(S.pack&&S.pack.items?Object.keys(S.pack.items):[]),...(S.fact?Object.keys(S.fact):[]),...(S.receipt?Object.keys(S.receipt.items):[])].map(norm)); if(!refs.size) return 0;
  const byCanon={}; for(const r of refs) (byCanon[canon(r)]=byCanon[canon(r)]||[]).push(r);
  let n=0; for(const row of S.sup.rows){ const k=norm(row.code); if(refs.has(k)) continue; const cand=byCanon[canon(k)]; if(cand&&cand.length===1){ row.orig=row.orig||row.code; row.code=cand[0]; row.fixed=true; n++; } }
  if(n) log(`Артикулы уточнены по упаковочному листу / факту / 1С: ${n}`); return n;
}
