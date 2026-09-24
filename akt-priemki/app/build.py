#!/usr/bin/env python3
"""Сборка одного автономного файла: src.html + библиотеки (vendor/) + шаблон акта (../template.xlsx)."""
import base64, os
here = os.path.dirname(os.path.abspath(__file__)); os.chdir(here)
s = open('src.html', encoding='utf-8').read()
pdf = open('vendor/pdf.min.js', encoding='utf-8').read(); xl = open('vendor/exceljs.min.js', encoding='utf-8').read(); wk = open('vendor/pdf.worker.min.js', encoding='utf-8').read()
s = s.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>', '<script>'+pdf+'</script>\n<script>'+wk+'</script>')
ff = open('vendor/fflate.js', encoding='utf-8').read()
s = s.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js"></script>', '<script>'+xl+'</script>')
s = s.replace('<script src="vendor/fflate.js"></script>', '<script>'+ff+'</script>')
s = s.replace("pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';", "// воркер pdf.js встроен как обычный скрипт (глобал pdfjsWorker) — работает офлайн и с диска")
# OCR: tesseract.js (главный поток) + воркер, в который вшиты ядро wasm и языковые данные (fetch/importScripts перехвачены)
tj = open('vendor/tesseract.min.js', encoding='utf-8').read()
s = s.replace('<script src="vendor/tesseract.min.js"></script>', '<script>'+tj+'</script>')
s = s.replace('<script src="src_ocr.js"></script>', '<script>'+open('src_ocr.js', encoding='utf-8').read()+'</script>')
core_b64 = base64.b64encode(open('vendor/tesseract-core-simd-lstm.wasm.js','rb').read()).decode()
lang_b64 = base64.b64encode(open('vendor/eng.traineddata.gz','rb').read()).decode()
prelude = ('(function(){const dec=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));const core="'+core_b64+'";const lang="'+lang_b64+'";'
  'const cu=URL.createObjectURL(new Blob([dec(core)],{type:"text/javascript"}));const oi=self.importScripts;self.importScripts=function(){return oi.apply(self,[...arguments].map(a=>/tesseract-core/.test(String(a))?cu:a));};'
  'const of=self.fetch.bind(self);self.fetch=function(u,o){if(/traineddata/.test(String(u)))return Promise.resolve(new Response(dec(lang),{status:200,headers:{"Content-Type":"application/octet-stream"}}));return of(u,o);};})();\n')
worker_b64 = base64.b64encode((prelude+open('vendor/tesseract.worker.min.js', encoding='utf-8').read()).encode()).decode()
s = s.replace('__OCR_WORKER_B64__', worker_b64)
s = s.replace('__TEMPLATE_B64__', base64.b64encode(open('../template.xlsx', 'rb').read()).decode())
out = 'Акт приёмки — мастер.html'; open(out, 'w', encoding='utf-8').write(s); print('built', out, len(s)//1024, 'KB')
