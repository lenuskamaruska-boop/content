#!/usr/bin/env python3
"""
Генератор «Акта приёмки ТМЦ» (РИТЕТ) из первичных документов.

Вход (папка с файлами, любые имена):
  • инвойс поставщика (PDF)              — строки товара, сумма EUR, номер/дата
  • счета КВТ Сервис (PDF, любое число)  — доставка/ПРР/брокер/хранение → категории раздела 6
  • ГТД / ДТ (PDF)                       — сбор/пошлина/НДС, дата ТО, курс EUR
  • упаковочный лист (PDF/XLSX)          — места, паллеты, вес, объём → шапка акта
  • пакинг «факт» (XLSX)                 — фактически пришедшее кол-во → этап 2
  • заказ поставщику (XLSX)              — этап 4 (справочно)
  • params.json                          — номер акта, даты, ярлык отгрузки, ответственные

Выход: заполненный шаблон «Акт приёмки … .xlsx» + summary.json (что откуда взято).

Использование:
  python3 akt.py <папка_с_документами> [--template template.xlsx] [--out результат.xlsx]
"""
from __future__ import annotations
import re, sys, json, glob, os, argparse, datetime as dt
from dataclasses import dataclass, field, asdict
from typing import Optional

# ---------- вспомогательные ----------
RU_MONTHS_GEN = {1:'января',2:'февраля',3:'марта',4:'апреля',5:'мая',6:'июня',7:'июля',8:'августа',9:'сентября',10:'октября',11:'ноября',12:'декабря'}
RU_MONTHS = {'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,'июля':7,
             'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12}

def norm(code) -> str:
    """Нормализация артикула для сопоставления: без пробелов, верхний регистр."""
    return re.sub(r'\s+', '', str(code)).upper()

def num(s: str) -> float:
    """'1 606 036,83' / '169988.26' / '2 050,00' -> float"""
    s = s.replace('\xa0',' ').replace(' ','').replace(' ','')
    if ',' in s and '.' in s:      # 1.606.036,83
        s = s.replace('.','').replace(',','.')
    else:
        s = s.replace(',','.')
    return float(s)

def pdf_text(path: str) -> str:
    import pymupdf
    return '\n'.join(p.get_text() for p in pymupdf.open(path)).replace('\xa0',' ')

def ru_date(s: str) -> Optional[dt.date]:
    m = re.search(r'(\d{1,2})\s+([а-я]+)\s+(\d{4})', s)
    if m and m.group(2) in RU_MONTHS:
        return dt.date(int(m.group(3)), RU_MONTHS[m.group(2)], int(m.group(1)))
    m = re.search(r'(\d{2})[./](\d{2})[./](\d{2,4})', s)
    if m:
        y = int(m.group(3)); y = y+2000 if y < 100 else y
        return dt.date(y, int(m.group(2)), int(m.group(1)))
    return None

# ---------- модели ----------
@dataclass
class KvtInvoice:
    number: str; date: Optional[dt.date]; currency: str  # RUB / USD / EUR
    total: float; vat: float; lines: list = field(default_factory=list)
    category: str = ''   # border | rf_broker | prr | other
    file: str = ''

@dataclass
class Gtd:
    number: str = ''; date: Optional[dt.date] = None
    currency: str = ''; invoice_sum: float = 0.0; rate: float = 0.0
    fee: float = 0.0; duty: float = 0.0; vat: float = 0.0; total: float = 0.0
    duty_rate: str = ''; vat_rate: str = ''; file: str = ''

@dataclass
class SupplierInvoice:
    number: str = ''; date: Optional[dt.date] = None; currency: str = 'EUR'
    total: float = 0.0; rows: list = field(default_factory=list)   # (code, desc, qty, price, value)
    supplier: str = ''; file: str = ''

@dataclass
class Packing:
    boxes: int = 0; pallets: int = 0; volume: float = 0.0
    gross: float = 0.0; net: float = 0.0; pieces: int = 0; file: str = ''
    items: dict = field(default_factory=dict)  # {артикул: кол-во} — только для формата EMAS (по коробкам)

# ---------- классификация счетов КВТ ----------
CATEGORY_RULES = [
    # (категория, регулярка по тексту услуги)
    ('prr',       r'ПРР|погрузо-?разгрузочн'),
    ('border',    r'(ISTANBUL|СТАМБУЛ|TURKIYE|ТУРЦИЯ).{0,200}(порт Новороссийск|РФ)|международной перевозки груза по маршруту:.{0,120}(TURK|ТУРЦ|ISTANBUL)'),
    ('rf_broker', r'таможенн|брокер|ДТ \d{8}/|хранени|СВХ|терминальн|линейный сбор|сверхнормативн|Организация перевозки груза по маршруту: Росси|Славянск|Новороссийск порт - '),
]

def classify(text: str, currency: str) -> str:
    t = text.replace('\n',' ')
    for cat, rx in CATEGORY_RULES:
        if re.search(rx, t, re.I):
            # ПРР в порту Новороссийск упоминает Стамбул в маршруте — ПРР проверяем первым
            return cat
    if currency == 'USD':   # фрахт до границы КВТ выставляет в USD
        return 'border'
    return 'other'

def parse_kvt(path: str) -> Optional[KvtInvoice]:
    t = pdf_text(path)
    if 'КВТ СЕРВИС' not in t.upper() or 'Счет на оплату' not in t:
        return None
    m = re.search(r'Счет на оплату №\s*(\d+)\s+от\s+([^\n]+)', t)
    number = m.group(1) if m else '?'
    date = ru_date(m.group(2)) if m else None
    cur = 'RUB'
    if re.search(r'\((Usd|USD)\d?\)', t): cur = 'USD'
    elif re.search(r'\((Eur|EUR)\d?\)', t): cur = 'EUR'
    mt = re.search(r'Всего к оплате:\s*\n?\s*([\d\s.,]+)', t)
    total = num(mt.group(1)) if mt else 0.0
    mv = re.search(r'(?:Сумма НДС|В том числе НДС):\s*\n?\s*([\d\s.,]+)', t)
    vat = num(mv.group(1)) if mv else 0.0
    # блок услуг — между заголовком таблицы и "Итого:"
    body = t.split('Сумма',1)[-1].split('Итого:')[0]
    cat = classify(body, cur)
    return KvtInvoice(number, date, cur, total, vat, [body.strip()[:400]], cat, os.path.basename(path))

# ---------- ГТД ----------
def parse_gtd(path: str) -> Optional[Gtd]:
    t = pdf_text(path)
    if 'ДЕКЛАРАЦИЯ НА ТОВАРЫ' not in t:
        return None
    g = Gtd(file=os.path.basename(path))
    nums = re.findall(r'\d{8}/\d{6}/\d{7}', t)
    fn = re.search(r'(\d{8})[_/](\d{6})[_/](\d{7})', os.path.basename(path))
    pick = f"{fn.group(1)}/{fn.group(2)}/{fn.group(3)}" if fn else (max(set(nums), key=nums.count) if nums else '')
    if pick:
        g.number = pick; d = pick.split('/')[1]
        g.date = dt.date(2000+int(d[4:6]), int(d[2:4]), int(d[0:2]))
    # графа 22/23: валюта, сумма по счёту, курс
    flat = t.replace('\n',' ')
    m = re.search(r'\b(EUR|USD)\b\s+([\d]+\.\d{2})\s+(\d{2,3}\.\d{4})', flat)
    if m:
        g.currency, g.invoice_sum, g.rate = m.group(1), float(m.group(2)), float(m.group(3))
    # раздел B: 1010-сумма-643-ИНН  (итоги по видам платежей за всю ДТ)
    sums = {}
    for kind, val in re.findall(r'\b(1010|2010|5010)-([\d]+\.\d{2})-643-', flat):
        sums[kind] = sums.get(kind, 0.0) + float(val)
    g.fee, g.duty, g.vat = sums.get('1010',0.0), sums.get('2010',0.0), sums.get('5010',0.0)
    g.total = round(g.fee+g.duty+g.vat, 2)
    mr = re.search(r'2010\D{0,40}?(\d{1,2}(?:\.\d)?%)', flat); g.duty_rate = mr.group(1) if mr else ''
    mv = re.search(r'5010\D{0,60}?(\d{2}%)', flat); g.vat_rate = mv.group(1) if mv else ''
    return g

# ---------- инвойс поставщика ----------
def parse_supplier_invoice(path: str) -> Optional[SupplierInvoice]:
    t = pdf_text(path)
    if 'INVOICE' not in t.upper() or 'КВТ' in t or 'ДЕКЛАРАЦИЯ' in t:
        return None
    inv = SupplierInvoice(file=os.path.basename(path))
    m = re.search(r'\b([A-Z]{2,4}\d{10,})\b\s*\n\s*(\d{2}\.\d{2}\.\d{4})', t)
    if m: inv.number = m.group(1); inv.date = ru_date(m.group(2))
    if 'ÇETİNKAYA' in t or 'CETINKAYA' in t.upper(): inv.supplier = 'Cetinkaya Pano'
    elif 'EMAS' in t: inv.supplier = 'EMAS'
    mt = re.search(r'€\s*([\d.]+,\d{2})', t)
    if mt: inv.total = num(mt.group(1))
    lines = [l.strip() for l in t.split('\n')]
    i = 0
    while i < len(lines)-4:
        code, desc, q, p, v = lines[i:i+5]
        if (re.fullmatch(r'[A-Z][A-Z0-9][A-Z0-9\-\. /]{1,}', code) and re.fullmatch(r'\d{1,3}(?:\.\d{3})*', q)
                and re.fullmatch(r'[\d.]*\d,\d{2}', p) and re.fullmatch(r'[\d.]*\d,\d{2}', v)):
            inv.rows.append((code, desc, int(q.replace('.','')), num(p), num(v))); i += 5
        else:
            i += 1
    return inv

# ---------- упаковочный лист (PDF) ----------
def parse_packing_pdf(path: str) -> Optional[Packing]:
    t = pdf_text(path)
    if 'PACKING LIST' not in t.upper() and 'COLI NO' not in t.upper(): return None
    p = Packing(file=os.path.basename(path)); flat = re.sub(r'\s+', ' ', t)
    # формат EMAS: по коробкам («Coli No:N»), итог «TOTAL 500 BOXES ON 20 PALLETS 51,6 CBM. GROSS WEIGHT: … NET WEIGHT: …»
    m = re.search(r'TOTAL\s+(\d+)\s+BOXES\s+ON\s+(\d+)\s+PALLETS?\s+([\d.,]+)\s*CBM', flat, re.I)
    if m:
        p.boxes, p.pallets, p.volume = int(m.group(1)), int(m.group(2)), num(m.group(3))
        g = re.search(r'GROSS WEIGHT:\s*([\d.,]+)\s*KG', flat, re.I); n = re.search(r'NET WEIGHT:\s*([\d.,]+)\s*KG', flat, re.I)
        if g: p.gross = num(g.group(1))
        if n: p.net = num(n.group(1))
        lines = [l.strip() for l in t.split('\n') if l.strip()]
        idx = [i for i, l in enumerate(lines) if l.startswith('Coli No:')]
        for k, i in enumerate(idx):
            j = idx[k+1] if k+1 < len(idx) else len(lines); cur = None; expect_code = True
            for b in lines[i+1:j]:
                if re.fullmatch(r'[\d.,x ]+cm', b) or re.fullmatch(r'[\d ,.]+KG', b) or b.startswith(('F-ST', 'TOTAL', 'GROSS')): continue
                if expect_code and re.fullmatch(r'[A-Z][A-Z0-9\-/.]{1,}', b): cur = b; expect_code = False
                elif cur and re.fullmatch(r'\d+', b): p.items[cur] = p.items.get(cur, 0) + int(b); cur = None; expect_code = True
        p.pieces = sum(p.items.values())
        return p
    def grab(rx):
        mm = re.search(rx, flat, re.I); return mm.group(1) if mm else None
    v = grab(r'Total Quantity of Package\s*:\s*([\d.,]+)')
    if v: p.pallets = int(num(v))
    v = grab(r'Total Quantity of (?:Box|Carton|Koli)\w*\s*:\s*([\d.,]+)')
    if v: p.boxes = int(num(v))
    v = grab(r'Total Volume\s*:\s*([\d.,]+)')
    if v: p.volume = num(v)
    v = grab(r'Total Net K\.?g\.?\s*:\s*([\d.,]+)')
    if v: p.net = num(v)
    v = grab(r'Total Gross K\.?g\.?\s*:\s*([\d.,]+)')
    if v: p.gross = num(v)
    v = grab(r'Total Quantity of Products\s*:\s*([\d.,]+)')
    p.pieces = int(v.replace('.','').replace(',','')) if v else 0
    return p

# ---------- пакинг «факт» / заказ поставщику (XLSX) ----------
def read_xlsx_pairs(path: str, code_hdr=('артикул','code','арт'), qty_hdr=('факт','кол','qty','quantity')) -> dict:
    """Возвращает {артикул: кол-во} — берёт колонку артикула и первую колонку с количеством."""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True); out = {}
    for ws in wb.worksheets:
        hdr_row = None
        for r in ws.iter_rows(min_row=1, max_row=15):
            vals = [str(c.value).strip().lower() if c.value is not None else '' for c in r]
            if any(any(h in v for h in code_hdr) for v in vals):
                hdr_row = r[0].row; hdr = vals; break
        if not hdr_row: continue
        ci = next(i for i,v in enumerate(hdr) if any(h in v for h in code_hdr))
        qi = next((i for i,v in enumerate(hdr) if any(h in v for h in qty_hdr) and i != ci), None)
        if qi is None: continue
        for r in ws.iter_rows(min_row=hdr_row+1, values_only=True):
            code = r[ci]; q = r[qi]
            if code and isinstance(q,(int,float)):
                out[str(code).strip()] = out.get(str(code).strip(), 0) + float(q)
        if out: break
    return out

def xlsx_kind(path: str) -> str:
    """'fact' если есть колонка «Факт», 'order' если «Заказ»/«приобретение», иначе ''."""
    from openpyxl import load_workbook
    low = os.path.basename(path).lower()
    if 'приобрет' in low: return 'receipt'
    if 'заказ' in low or 'order' in low: return 'order'
    if 'пакинг' in low or 'packing' in low or 'факт' in low: return 'fact'
    wb = load_workbook(path, read_only=True, data_only=True)
    for ws in wb.worksheets:
        for r in ws.iter_rows(min_row=1, max_row=20, values_only=True):
            vals = ' '.join(str(v).lower() for v in r if v is not None)
            if 'приобретение товаров' in vals: return 'receipt'
            if 'факт' in vals: return 'fact'
            if 'заказ' in vals: return 'order'
    return ''

def read_1c_receipt(path: str) -> dict:
    """«Приобретение товаров» из 1С → {артикул: {'qty', 'price', 'doc'}} (строки одного артикула суммируются)."""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True); ws = wb.worksheets[0]; out = {}; doc = ''
    hdr = None
    for r in ws.iter_rows(min_row=1, max_row=25):
        vals = {c.column: str(c.value).strip().lower() for c in r if c.value is not None}
        joined = ' '.join(vals.values())
        if 'приобретение товаров' in joined: doc = ' '.join(str(c.value) for c in r if c.value)
        if 'артикул' in joined and ('количество' in joined or 'кол-во' in joined):
            hdr = {k: v for k, v in vals.items()}; hrow = r[0].row; break
    if not hdr: return {}
    col = lambda name: next((c for c, v in hdr.items() if name in v), None)
    ci, qi, pi, si = col('артикул'), (col('количество') or col('кол')), col('цена'), col('сумма')
    anomalies = []
    for r in ws.iter_rows(min_row=hrow+1, values_only=True):
        code = r[ci-1] if ci else None; q = r[qi-1] if qi else None; pr = r[pi-1] if pi else None
        sm = r[si-1] if si else None
        if code and isinstance(q, (int, float)):
            k = norm(code); e = out.setdefault(k, {'qty': 0.0, 'price': float(pr or 0), 'doc': doc, 'sum': 0.0})
            e['qty'] += float(q); e['sum'] += float(sm or 0)
            if isinstance(sm, (int, float)) and pr is not None:
                calc = round(float(q) * float(pr), 2)
                if abs(float(sm) - calc) > 0.01:
                    anomalies.append({'code': str(code).strip(), 'qty': float(q), 'price': float(pr),
                                      'sum_1c': round(float(sm), 2), 'sum_calc': calc, 'diff': round(float(sm) - calc, 2)})
    if out:
        next(iter(out.values()))['_anomalies'] = anomalies
    return out

# ---------- курсы ЦБ ----------
def cbr_rates(date: dt.date) -> dict:
    """{'USD': x, 'EUR': y} на дату (ЦБ РФ). При недоступности сети — {}."""
    import urllib.request, xml.etree.ElementTree as ET
    url = f"https://www.cbr.ru/scripts/XML_daily.asp?date_req={date:%d/%m/%Y}"
    try:
        xml = urllib.request.urlopen(url, timeout=15).read()
        root = ET.fromstring(xml); out = {}
        for v in root.findall('Valute'):
            code = v.find('CharCode').text
            if code in ('USD','EUR'):
                out[code] = float(v.find('VunitRate').text.replace(',','.'))
        return out
    except Exception:
        return {}

# ---------- заполнение шаблона ----------
def fill_template(template: str, out: str, sup: SupplierInvoice, kvt: list, gtd: Optional[Gtd],
                  pack: Optional[Packing], fact: dict, order: dict, params: dict, rates: dict, receipt: dict = None) -> dict:
    from openpyxl import load_workbook
    from copy import copy
    wb = load_workbook(template); ws = wb.worksheets[0]; ws2 = wb.worksheets[1]
    label = params.get('label', f"Отгрузка {sup.supplier or 'поставщик'} {params.get('shipment','1')} в {params.get('year', dt.date.today().year)}")
    old = ws.title; ws.title = label[:31]
    # ссылки второго листа на первый
    for row in ws2.iter_rows():
        for c in row:
            if isinstance(c.value, str) and old in c.value: c.value = c.value.replace(old, ws.title)
    ws['A1'].value = ws['A1'].value  # no-op
    act_no = str(params.get('act_no', '1')); act_date = params.get('act_date')
    ws['B7'] = f'Акт № {act_no}'
    ad = ru_date(act_date) if isinstance(act_date, str) else act_date
    ws['B9'] = f"от {ad:%d.%m.%Y} г." if ad else 'от '
    if ad:
        for c in ('F76','F79','F82'): ws[c] = f'"{ad:%d}" {RU_MONTHS_GEN[ad.month]} {ad.year}г.'
    inv_str = f"Инвойс {sup.number} от {sup.date:%d.%m.%Y}" if sup.date else f"Инвойс {sup.number}"
    ws['B11'] = inv_str
    if pack:
        ru = lambda x: (f"{x:,.2f}".rstrip('0').rstrip('.') if isinstance(x, float) and not float(x).is_integer() else f"{x:,.0f}").replace(',', ' ').replace('.', ',')
        places = (f"{pack.boxes} коробок, " if pack.boxes else '') + f"{pack.pallets} паллет"
        ws['B12'] = (f"Упаковочный лист (количество мест,  вес, объем) {places}, "
                     f"{ru(pack.volume)} м³, вес брутто - {ru(pack.gross)} кг, вес нетто - {ru(pack.net)} кг.")
    for key, cell in [('pickup_date','F14'), ('depart_date','G15'), ('to_date','F16'), ('arrival_date','G17')]:
        v = params.get(key) or (gtd.date if key=='to_date' and gtd else None)
        if v:
            if isinstance(v, str): v = ru_date(v)
            ws[cell] = v; ws[cell].number_format = 'dd.mm.yyyy'
    ws['D19'] = f"{sup.supplier} инвойс"; ws['F19'] = round(sup.total, 2)
    ws['C73'] = sup.supplier or 'EMAS'
    if params.get('responsible'): ws['T27'] = params['responsible']
    # этап 2 — расхождения факт/инвойс
    r = 28; inv_map = {}; disp = {}
    for c, _, q, p, _ in sup.rows:
        k = norm(c); disp[k] = c
        if k in inv_map: inv_map[k] = (inv_map[k][0] + q, p)
        else: inv_map[k] = (q, p)
    fact = {norm(k): v for k, v in fact.items()}; order = {norm(k): v for k, v in order.items()}
    diffs = []
    for code, q_fact in sorted(fact.items()):
        q_inv, price = inv_map.get(code, (0, 0.0))
        if q_fact != q_inv: diffs.append((disp.get(code, code), q_inv, q_fact, price))
    for code in inv_map:
        if fact and code not in fact: diffs.append((disp[code], inv_map[code][0], 0, inv_map[code][1]))
    # этап 3 — входные цены 1С vs инвойс
    price_diffs = []; uom_notes = []
    if receipt:
        for code, e in receipt.items():
            if code not in inv_map: continue
            q_inv, p_inv = inv_map[code]; line_inv = round(q_inv * p_inv, 2); line_1c = round(e['qty'] * e['price'], 2)
            if abs(line_1c - line_inv) > 0.01:
                price_diffs.append((disp.get(code, code), p_inv, e['price'], line_inv, line_1c))
            elif abs(e['price'] - p_inv) > 0.005:
                k = round(e['price'] / p_inv, 2) if p_inv else 0
                uom_notes.append((disp.get(code, code), k))
        doc = next(iter(receipt.values()))['doc']
        if price_diffs:
            ws['E41'] = f'Есть: {len(price_diffs)} позиций — ' + '; '.join(f'{c}: инвойс {a:.2f}, 1С {b:.2f}' for c, a, b, *_ in price_diffs[:6])
        else:
            ws['E41'] = 'Нет'
        note = f'Сверено с документом 1С «{doc}»' if doc else ''
        anomalies = next(iter(receipt.values())).get('_anomalies', [])
        if anomalies:
            tot = round(sum(a['diff'] for a in anomalies), 2)
            note += (f'. ВНИМАНИЕ: в 1С колонка «Сумма» ≠ кол-во×цена по {len(anomalies)} поз. '
                     f'({", ".join(a["code"] for a in anomalies[:5])}) — итого {tot:+,.2f} EUR; итог документа завышен')
        if uom_notes:
            ks = sorted({k for _, k in uom_notes}); pref = sorted({c.split()[0] for c, _ in uom_notes})
            note += f'. Разная ед. изм. без расхождения по сумме: {len(uom_notes)} поз. ({", ".join(pref)}) — цена в 1С ×{"/".join(str(k) for k in ks)}, кол-во соответственно меньше'
        ws['P41'] = note or None
    for code, qi, qf, price in diffs[:12]:
        ws[f'E{r}'] = code; ws[f'G{r}'] = qi; ws[f'H{r}'] = qf; ws[f'I{r}'] = f'=H{r}-G{r}'
        ws[f'J{r}'] = price; ws[f'K{r}'] = f'=J{r}*I{r}'
        ws[f'P{r}'] = 'Излишек' if qf > qi else '+30% от стоимости затраты НДС, пошлины'
        r += 1
    if not diffs and fact: ws['E28'] = 'Нет'
    # этап 4 — заказ поставщику (справочно)
    r = 42; od = []
    for code, q_ord in sorted(order.items()):
        q_inv = inv_map.get(code, (0, 0))[0]
        if q_ord != q_inv: od.append((disp.get(code, code), q_inv, q_ord, inv_map.get(code,(0,0.0))[1]))
    if od:
        for rng in [str(m) for m in ws.merged_cells.ranges if 42 <= m.min_row <= 64 and m.min_col >= 5 and m.max_col <= 11]:
            ws.unmerge_cells(rng)
        ws['E42'] = None
        for code, qi, qo, price in od[:23]:
            ws[f'E{r}'] = code; ws[f'G{r}'] = qi; ws[f'H{r}'] = qo; ws[f'I{r}'] = f'=H{r}-G{r}'
            ws[f'J{r}'] = price; ws[f'K{r}'] = f'=J{r}*I{r}'; r += 1
    # раздел 6 — затраты (рубли, строка 72)
    usd = rates.get('USD'); eur = rates.get('EUR') or (gtd.rate if gtd and gtd.currency=='EUR' else None)
    cat_sum = {'border':0.0,'rf_broker':0.0,'prr':0.0,'other':0.0}; conv_notes = []
    for k in kvt:
        amt = k.total
        if k.currency == 'USD':
            if usd: amt = round(k.total * usd, 2); conv_notes.append(f"счёт {k.number}: {k.total:,.2f} USD × {usd} = {amt:,.2f} ₽")
            else: conv_notes.append(f"счёт {k.number}: {k.total:,.2f} USD — курс USD неизвестен, в рубли не переведён"); amt = 0.0
        elif k.currency == 'EUR' and eur:
            amt = round(k.total * eur, 2)
        cat_sum[k.category] += amt
    cat_sum['rf_broker'] += cat_sum.pop('other')
    ws['G72'] = round(cat_sum['border'],2); ws['I72'] = round(cat_sum['rf_broker'],2); ws['K72'] = round(cat_sum['prr'],2)
    if gtd:
        ws['M72'] = gtd.fee; ws['O72'] = gtd.duty; ws['Q72'] = gtd.vat
    if usd: ws['U78'] = usd
    if eur: ws['U79'] = eur
    # скрыть неиспользованные строки этапов 2 и 4 — печать на одном листе, как в образце
    filled = lambda lo, hi: max((rr for rr in range(lo, hi) if ws[f'E{rr}'].value not in (None, '')), default=lo) + 1
    used2 = filled(28, 40); used4 = filled(42, 65)
    for rr in range(28, 40): ws.row_dimensions[rr].hidden = rr >= used2   # раскрыть заполненные, скрыть пустые
    for rr in range(42, 65): ws.row_dimensions[rr].hidden = rr >= used4
    ws['U80'].number_format = '0.0000'
    ws.page_setup.orientation = 'landscape'; ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 1
    wb.save(out)
    return {'label': label, 'invoice': asdict(sup) | {'rows': len(sup.rows)}, 'kvt': [asdict(k) for k in kvt],
            'gtd': asdict(gtd) if gtd else None, 'packing': asdict(pack) if pack else None,
            'rates': {'USD': usd, 'EUR': eur}, 'conversions': conv_notes,
            'section6_rub': {'border': cat_sum['border'], 'rf_broker': cat_sum['rf_broker'], 'prr': cat_sum['prr'],
                             'fee': gtd.fee if gtd else None, 'duty': gtd.duty if gtd else None, 'vat': gtd.vat if gtd else None},
            'stage2_diffs': diffs, 'stage4_diffs': od, 'stage3_price_diffs': price_diffs, 'stage3_uom_notes': uom_notes,
            'receipt_sum_anomalies': (next(iter(receipt.values())).get('_anomalies', []) if receipt else []),
            'receipt_rows': len(receipt) if receipt else 0}

# ---------- главный сценарий ----------
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('folder'); ap.add_argument('--template', default=None)
    ap.add_argument('--out', default=None); a = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    template = a.template or os.path.join(here, 'template.xlsx')
    params = {}
    pj = os.path.join(a.folder, 'params.json')
    if os.path.exists(pj): params = json.load(open(pj, encoding='utf-8'))
    sup = None; kvt = []; gtd = None; pack = None; fact = {}; order = {}; receipt = {}
    import hashlib; seen = set()
    for f in sorted(glob.glob(os.path.join(a.folder, '*'))):
        low = os.path.basename(f).lower()
        h = hashlib.md5(open(f,'rb').read()).hexdigest()
        if h in seen: continue
        seen.add(h)
        if low.endswith('.pdf'):
            k = parse_kvt(f)
            if k: kvt.append(k); continue
            g = parse_gtd(f)
            if g: gtd = g; continue
            p = parse_packing_pdf(f)
            if p: pack = p; continue
            s = parse_supplier_invoice(f)
            if s: sup = s; continue
        elif low.endswith('.xlsx'):
            kind = xlsx_kind(f)
            if kind == 'fact': fact = read_xlsx_pairs(f)
            elif kind == 'order': order = read_xlsx_pairs(f, qty_hdr=('кол','qty','заказ'))
            elif kind == 'receipt': receipt = read_1c_receipt(f)
    if not sup: sys.exit('Не найден инвойс поставщика (PDF со словом INVOICE).')
    # --- ручные добавки из params.json (для документов, которых нет в папке) ---
    for e in params.get('extra_costs', []):   # {"number":"1043","currency":"USD","total":2050,"category":"border","note":"..."}
        kvt.append(KvtInvoice(str(e['number']), ru_date(e.get('date','')) if e.get('date') else None,
                              e.get('currency','RUB'), float(e['total']), float(e.get('vat',0)),
                              [e.get('note','вручную из params.json')], e.get('category','rf_broker'), 'params.json'))
    if params.get('customs') and not gtd:      # {"number":"...","date":"24.08.2026","fee":..,"duty":..,"vat":..,"eur_rate":..}
        c = params['customs']; gtd = Gtd(number=c.get('number',''), date=ru_date(c.get('date','')) if c.get('date') else None,
                                         currency='EUR', rate=float(c.get('eur_rate',0)), fee=float(c.get('fee',0)),
                                         duty=float(c.get('duty',0)), vat=float(c.get('vat',0)), file='params.json')
        gtd.total = round(gtd.fee+gtd.duty+gtd.vat,2)
    if params.get('fact_overrides'):           # {"CP1043Y": 12, ...} — факт только по расхождениям; остальное = инвойсу
        base = {c: q for c, _, q, _, _ in sup.rows}; base.update({k: float(v) for k, v in params['fact_overrides'].items()}); fact = base
    rates = {}
    rate_date = params.get('to_date') and ru_date(params['to_date']) or (gtd.date if gtd else None)
    if rate_date: rates = cbr_rates(rate_date)
    if 'usd_rate' in params: rates['USD'] = float(params['usd_rate'])
    if 'eur_rate' in params: rates['EUR'] = float(params['eur_rate'])
    if gtd and gtd.currency == 'EUR' and gtd.rate and 'EUR' not in rates: rates['EUR'] = gtd.rate
    label = params.get('label') or f"Отгрузка {'СР' if (sup.supplier or '').startswith('Cet') else sup.supplier} {params.get('shipment','1')} в {dt.date.today().year}"
    params.setdefault('label', label)
    out = a.out or os.path.join(a.folder, f"Акт приёмки №{params.get('act_no','1')} ({label}).xlsx")
    summary = fill_template(template, out, sup, kvt, gtd, pack, fact, order, params, rates, receipt)
    summary['output'] = out
    for a_ in summary.get('receipt_sum_anomalies', []):
        print(f"⚠ 1С: {a_['code']} — Сумма {a_['sum_1c']:.2f} ≠ {a_['qty']:g}×{a_['price']:.2f}={a_['sum_calc']:.2f} (разница {a_['diff']:+.2f} EUR)", file=sys.stderr)
    json.dump(summary, open(os.path.join(a.folder, 'summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=str)
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))

if __name__ == '__main__':
    main()
