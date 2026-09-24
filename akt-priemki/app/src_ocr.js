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
const PARAMS_NUM  = {tessedit_pageseg_mode:'7', tessedit_char_whitelist:'0123456789,.'};
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
  const rows=groupIdx(ridx,3); return {rows,cols}; }
function cropData(c,r,w){ const k=w/r.width; const c2=document.createElement('canvas'); c2.width=w; c2.height=Math.round(r.height*k); c2.getContext('2d').drawImage(c,r.left,r.top,r.width,r.height,0,0,c2.width,c2.height); return c2.toDataURL('image/jpeg',.8); }
// варианты прочтения чисел: OCR часто теряет запятую или добавляет лишнюю цифру
const uniq=a=>[...new Set(a)].filter(v=>v>0&&isFinite(v));
function candsPrice(s){ const out=[]; const m=s.match(/^(\d+)[,.](\d{4})$/); if(m) out.push(+(m[1]+'.'+m[2])); const D=s.replace(/\D/g,''); if(D.length>=5) out.push(+(D.slice(0,-4)+'.'+D.slice(-4))); if(D.length===4) out.push(+('0.'+D));
  if(D.length>=6) for(let i=0;i<D.length;i++){ const E=D.slice(0,i)+D.slice(i+1); out.push(+(E.slice(0,-4)+'.'+E.slice(-4))); } return uniq(out); }
function candsTotal(s){ const out=[]; const m=s.match(/^(\d+)[,.](\d{1,2})$/); if(m) out.push(+(m[1]+'.'+m[2])); const D=s.replace(/\D/g,''); if(!D) return out; out.push(+D); if(D.length>=3) out.push(+(D.slice(0,-2)+'.'+D.slice(-2))); if(D.length>=2) out.push(+(D.slice(0,-1)+'.'+D.slice(-1)));
  if(D.length>=4) for(let i=0;i<D.length;i++){ const E=D.slice(0,i)+D.slice(i+1); out.push(+(E.slice(0,-2)+'.'+E.slice(-2))); out.push(+E); } return uniq(out); }
function candsQty(s){ const D=s.replace(/\D/g,''); const out=[]; if(D) out.push(+D); const sw={'0':'8','8':'0','9':'0','6':'0','5':'6','1':'7','7':'1','2':'7','3':'8'};
  for(let i=0;i<D.length;i++) if(sw[D[i]]) out.push(+(D.slice(0,i)+sw[D[i]]+D.slice(i+1))); if(D.length>=2) for(let i=0;i<D.length;i++) out.push(+(D.slice(0,i)+D.slice(i+1))); return uniq(out); }
function resolveRow(raw){ const Q=candsQty(raw.qty), P=candsPrice(raw.price), T=candsTotal(raw.total); const eq=(a,b)=>Math.abs(a-b)<0.011; let best=null;
  for(let qi=0;qi<Q.length;qi++) for(let pi=0;pi<P.length;pi++) for(let ti=0;ti<T.length;ti++) if(eq(Math.round(Q[qi]*P[pi]*100)/100,T[ti])){ const sc=qi+pi+ti; if(!best||sc<best.score) best={qty:Q[qi],price:P[pi],value:T[ti],score:sc}; }
  if(best) return best;
  for(const p of P) for(const t of T){ const q=Math.round(t/p); if(q>0&&eq(Math.round(q*p*100)/100,t)) return {qty:q,price:p,value:t,score:99,derived:true}; }
  return null; }

async function ocrInvoice(file, progress){
  const pdf = await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise; const w = await ocrWorker();
  const rows=[], flagged=[]; let header='', footer='';
  for(let p=1;p<=pdf.numPages;p++){
    progress(`страница ${p} из ${pdf.numPages}: подготовка изображения…`);
    const page=await pdf.getPage(p); let c=await renderPage(page,3300); c=deskew(c); const G=tableGeom(c);
    if(p===1){ await w.setParameters(PARAMS_TEXT); header=(await w.recognize(c,{rectangle:{left:0,top:0,width:c.width,height:Math.round(c.height*.22)}})).data.text; }
    if(p===pdf.numPages){ await w.setParameters(PARAMS_TEXT); footer=(await w.recognize(c,{rectangle:{left:Math.round(c.width*.5),top:0,width:Math.round(c.width*.5),height:c.height}})).data.text; }
    if(!G) continue;
    const [x0,x1,x2,x3,x4,x5]=G.cols, K=c.width/1653; // K — масштаб относительно скана 200 dpi
    for(let i=0;i<G.rows.length-1;i++){
      const h=G.rows[i+1]-G.rows[i]; if(h<15*K||h>40*K) continue;
      const y=G.rows[i]+3*K, hh=h-6*K, rect=(a,b)=>({left:Math.round(a+3*K),top:Math.round(y),width:Math.round(b-a-6*K),height:Math.round(hh)});
      progress(`страница ${p} из ${pdf.numPages}: строка ${i+1} из ${G.rows.length-1}`);
      await w.setParameters(PARAMS_CODE); const code=(await w.recognize(c,{rectangle:rect(x0,x1)})).data.text.trim().replace(/\s+/g,'');
      if(!code||/^PARTCODE/.test(code)) continue;
      await w.setParameters(PARAMS_NUM);
      const raw={qty:(await w.recognize(c,{rectangle:rect(x2,x3)})).data.text.trim(), price:(await w.recognize(c,{rectangle:rect(x3,x4)})).data.text.trim(), total:(await w.recognize(c,{rectangle:rect(x4,x5)})).data.text.trim()};
      const res=resolveRow(raw);
      const row={code, desc:'', qty:res?res.qty:(parseInt(raw.qty.replace(/\D/g,''))||0), price:res?res.price:(candsPrice(raw.price)[0]||0), value:res?res.value:(candsTotal(raw.total)[0]||0), ocr:true, ok:!!res, raw};
      if(!res){ row.img=cropData(c,{left:x0,top:G.rows[i],width:x5-x0,height:h},1000); flagged.push(row); }
      rows.push(row);
    }
  }
  const numbers=[...new Set(header.match(/[A-Z]{2,4}\d{10,}/g)||[])]; const dm=header.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const gt=(footer.match(/[\d.]+,\d{2}\s*EUR/g)||[]).map(s=>num(s.replace(/\s*EUR/,''))); const grand=gt.length?Math.max(...gt):0;
  const pm=footer.match(/([\d.]+)\s*PCS/); const supplier=/EMAS|emas/.test(header+file.name)||/эмас/i.test(file.name)?'EMAS':(/CETINKAYA|ÇETİNKAYA/i.test(header)?'Cetinkaya Pano':'');
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
  let cur=null, expect=false; const isCode=x=>/^[A-Z][A-Z0-9\-\/.]{1,}$/.test(x);
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
