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
s = s.replace('__TEMPLATE_B64__', base64.b64encode(open('../template.xlsx', 'rb').read()).decode())
out = 'Акт приёмки — мастер.html'; open(out, 'w', encoding='utf-8').write(s); print('built', out, len(s)//1024, 'KB')
