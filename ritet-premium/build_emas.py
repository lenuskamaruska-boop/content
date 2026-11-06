#!/usr/bin/env python3
"""Генерирует ritet-premium/emas.html — прототип раздела «Продукция EMAS» из series.json
(описания + фото из архивов Диска) и базы «Описание EMAS.xlsx» (характеристики)."""
import json, re, html, sys
SRC = sys.argv[1]  # series.json
S = json.load(open(SRC, encoding='utf-8'))

# подписи групп для сайта и порядок
GROUPS = [
    ('Двуручные пульты управления', 'Безопасное управление прессами и станками: оборудование включается только двумя руками одновременно.'),
    ('Джойстики', 'Кнопки-джойстики серии CM на 2 и 4 положения, с фиксацией и без, Ø22 мм, IP65.'),
    ('Перекрестные концевые выключатели', 'Крестовые концевые выключатели серии CSM для контроля положения механизмов.'),
    ('Термостаты', 'Термостаты и гигростаты для контроля климата в шкафах управления.'),
    ('Гибкие кабель каналы', 'Кабельные цепи серии HKP из огнестойкого нейлона для подвижных частей оборудования.'),
]
esc = html.escape
slug = lambda s: re.sub(r'[^a-z0-9]+', '-', s.lower().translate(str.maketrans('абвгдеёжзийклмнопрстуфхцчшщъыьэюя', 'abvgdeejzijklmnoprstufhccss_y_eua'))).strip('-')

def parse_text(paras):
    """абзацы из Word → (краткое описание, список преимуществ, таблица характеристик)"""
    desc, adv, table = [], [], []
    mode = None
    for p in paras[1:]:  # первая строка — название, его берём из базы
        t = p.strip()
        if not t: continue
        if re.match(r'^(ТЕХНИЧЕСК\w+ (ИНФОРМАЦИЯ|ХАРАКТЕРИСТИКИ)|Преимущества)', t, re.I):
            mode = 'adv' if 'реимущества' in t else mode; continue
        if ' | ' in t:
            k, _, v = t.partition(' | ')
            if re.match(r'^(характеристик|параметр|наименование)', k.strip(), re.I): continue  # строка-заголовок таблицы из Word
            table.append((k.strip(), v.strip())); continue
        m = re.match(r'^([^:–\-—]{3,45})\s*[:–\-—]\s*(.{1,60})$', t)
        if m and not t.endswith('.') and len(t) < 90:
            table.append((m.group(1).strip(), m.group(2).strip())); continue
        if mode == 'adv' and len(t) < 90: adv.append(t); continue
        if len(t) > 60: desc.append(t)
        elif len(t) < 60: adv.append(t)
    return ' '.join(desc), adv, table

cards = {}
for g, _ in GROUPS:
    items = []
    for art, v in S.get(g, {}).items():
        db = v.get('db', {})
        name = db.get('Наименование товара') or (v['text'][0] if v['text'] else art)
        desc, adv, table = parse_text(v['text'])
        # ключевые параметры из базы в начало таблицы
        key = [(k, db[k]) for k in ('Степень защиты (IP) в сборе', 'Номинальное напряжение', 'Номинальная сила тока', 'Контактная группа', 'Материал корпуса', 'Диапазон рабочих температур') if db.get(k)]
        seen = set(); merged = []
        for k, val in key + table:
            kk = k.lower()[:12]
            if kk in seen: continue
            seen.add(kk); merged.append((k.replace('Степень защиты (IP) в сборе', 'Степень защиты').replace('Диапазон рабочих температур', 'Рабочая температура'), val))
        items.append(dict(art=art, name=name, desc=desc, adv=adv[:5], table=merged[:7], img=v.get('img'), series=db.get('Cерия', ''), cert=db.get('Сертификат', '')))
    cards[g] = items

def card(it):
    tbl = ''.join(f'<tr><th>{esc(k)}</th><td>{esc(v)}</td></tr>' for k, v in it['table'])
    adv = ''.join(f'<li>{esc(a)}</li>' for a in it['adv'])
    img = f'<img src="{it["img"]}" alt="{esc(it["art"])}" loading="lazy">' if it['img'] else '<div class="noimg">фото</div>'
    return f'''<article class="pcard" id="{esc(it['art'])}">
  <div class="pcard-media">{img}</div>
  <div class="pcard-body">
    <div class="art">{esc(it['art'])}{f' <span class="ser">серия {esc(it["series"])}</span>' if it['series'] else ''}</div>
    <h3>{esc(it['name'])}</h3>
    {f'<p class="desc">{esc(it["desc"])}</p>' if it['desc'] else ''}
    {f'<table class="specs">{tbl}</table>' if tbl else ''}
    {f'<ul class="adv">{adv}</ul>' if adv else ''}
    <div class="pcard-foot">{f'<span class="cert" title="{esc(it["cert"])}">Сертификат ЕАЭС</span>' if it['cert'] else ''}<a class="ask" href="index.html#contact">Запросить цену</a></div>
  </div>
</article>'''

sections = []
nav = []
for g, lead in GROUPS:
    its = cards[g]
    if not its: continue
    nav.append(f'<a href="#{slug(g)}">{esc(g)}<span>{len(its)}</span></a>')
    sections.append(f'''<section class="pgroup" id="{slug(g)}">
  <div class="pgroup-head"><div class="eyebrow">EMAS · {len(its)} {'позиция' if len(its)%10==1 and len(its)%100!=11 else 'позиций'}</div><h2>{esc(g)}</h2><p>{esc(lead)}</p></div>
  <div class="pgrid">{''.join(card(it) for it in its)}</div>
</section>''')

page = f'''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Продукция EMAS — РИТЕТ</title>
<meta name="description" content="Каталог продукции EMAS: пульты управления, джойстики, концевые выключатели, термостаты, кабель-каналы. РИТЕТ — эксклюзивный поставщик EMAS в России.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23005eb8'/%3E%3Ctext x='16' y='22' font-family='Arial,sans-serif' font-size='16' font-weight='700' fill='white' text-anchor='middle'%3ER%3C/text%3E%3C/svg%3E">
<style>
:root{{--bg:#fff;--bg-2:#f6f8fb;--bg-3:#eef2f7;--line:#e3e8f0;--line-2:#cbd5e3;--fg:#0f1a2e;--fg-dim:#4b5b75;--fg-mute:#7a879c;--blue:#005eb8;--blue-2:#004a94;--navy:#0c2f5e;--radius:16px;--shadow:0 10px 30px -12px rgba(20,50,92,.18);--maxw:1200px;--font:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}}
*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;font-family:var(--font);background:var(--bg);color:var(--fg);line-height:1.55;-webkit-font-smoothing:antialiased}}
img{{max-width:100%;display:block}}a{{color:inherit;text-decoration:none}}
.wrap{{width:100%;max-width:var(--maxw);margin-inline:auto;padding-inline:20px}}
.header{{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.9);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}}
.header .wrap{{display:flex;align-items:center;gap:26px;padding-block:14px}}.brand img{{height:32px;width:auto}}
.nav{{display:flex;gap:4px}}.nav a{{padding:9px 14px;border-radius:9px;color:var(--fg-dim);font-weight:600;font-size:15px}}.nav a:hover,.nav a.act{{color:var(--blue);background:var(--bg-3)}}
.spacer{{flex:1}}.phone{{font-weight:800;font-size:17px;color:var(--navy);white-space:nowrap}}
@media(max-width:860px){{.nav,.phone{{display:none}}}}
.eyebrow{{display:inline-flex;align-items:center;gap:10px;font-size:12.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--blue)}}.eyebrow::before{{content:"";width:26px;height:2px;background:var(--blue);display:inline-block;border-radius:2px}}
.hero{{padding:52px 0 26px;background:linear-gradient(180deg,var(--bg-2),#fff)}}.hero h1{{font-size:clamp(30px,4.2vw,46px);line-height:1.1;margin:12px 0 10px;color:var(--navy);letter-spacing:-.02em}}.hero h1 em{{font-style:normal;color:var(--blue)}}.hero p{{max-width:720px;font-size:17px;color:var(--fg-dim);margin:0}}
.crumbs{{font-size:13.5px;color:var(--fg-mute);margin-bottom:6px}}.crumbs a:hover{{color:var(--blue)}}
.gnav{{position:sticky;top:61px;z-index:40;background:#fff;border-bottom:1px solid var(--line)}}.gnav .wrap{{display:flex;gap:6px;overflow-x:auto;padding-block:10px;scrollbar-width:none}}.gnav a{{flex:none;padding:8px 14px;border-radius:100px;border:1px solid var(--line-2);font-size:14px;font-weight:600;color:var(--fg-dim);display:inline-flex;gap:8px;align-items:center}}.gnav a span{{background:var(--bg-3);color:var(--blue);font-weight:800;font-size:12px;padding:1px 8px;border-radius:100px}}.gnav a:hover{{border-color:var(--blue);color:var(--blue)}}
.pgroup{{padding:46px 0 10px}}.pgroup-head{{max-width:760px;margin-bottom:22px}}.pgroup-head h2{{font-size:clamp(24px,3vw,32px);margin:8px 0 8px;color:var(--navy);letter-spacing:-.01em}}.pgroup-head p{{margin:0;color:var(--fg-dim);font-size:16px}}
.pgrid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:20px}}
.pcard{{display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;transition:box-shadow .25s,transform .25s,border-color .25s}}.pcard:hover{{box-shadow:var(--shadow);transform:translateY(-3px);border-color:var(--line-2)}}
.pcard-media{{background:#fff;border-bottom:1px solid var(--line);aspect-ratio:4/3;display:grid;place-items:center;padding:14px}}.pcard-media img{{max-height:100%;width:auto;object-fit:contain;mix-blend-mode:multiply}}.noimg{{color:var(--fg-mute);font-size:13px}}
.pcard-body{{padding:18px 20px 20px;display:flex;flex-direction:column;gap:10px;flex:1}}
.art{{font-size:12.5px;font-weight:800;letter-spacing:.08em;color:var(--blue)}}.art .ser{{font-weight:600;letter-spacing:0;color:var(--fg-mute);margin-left:8px}}
.pcard h3{{margin:0;font-size:16.5px;line-height:1.35;color:var(--fg)}}.desc{{margin:0;font-size:14px;color:var(--fg-dim);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}}
.specs{{border-collapse:collapse;width:100%;font-size:13.5px}}.specs th{{text-align:left;font-weight:600;color:var(--fg-mute);padding:5px 10px 5px 0;width:48%;vertical-align:top;border-bottom:1px solid var(--line)}}.specs td{{padding:5px 0;border-bottom:1px solid var(--line);color:var(--fg)}}
.adv{{margin:0;padding-left:18px;font-size:13.5px;color:var(--fg-dim)}}.adv li{{margin:2px 0}}
.pcard-foot{{margin-top:auto;padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}}
.cert{{font-size:12px;font-weight:700;color:#15803d;background:#e8f4ea;padding:4px 10px;border-radius:100px}}.ask{{font-weight:700;color:var(--blue);font-size:14px}}.ask:hover{{color:var(--blue-2)}}
.foot{{margin-top:60px;border-top:1px solid var(--line);padding:26px 0;color:var(--fg-mute);font-size:13.5px}}
.note{{background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;border-radius:12px;padding:12px 16px;font-size:14px;margin-top:18px;max-width:760px}}
</style>
</head>
<body>
<header class="header"><div class="wrap">
  <a href="index.html" class="brand"><img src="img/logo-ritet-2-web.png" alt="RITET"></a>
  <nav class="nav"><a href="emas.html" class="act">Продукция</a><a href="index.html#brands">Бренды</a><a href="index.html#advantages">О компании</a><a href="index.html#contact">Контакты</a></nav>
  <div class="spacer"></div><a class="phone" href="tel:+78007757391">8 (800) 775-73-91</a>
</div></header>
<section class="hero"><div class="wrap">
  <div class="crumbs"><a href="index.html">Главная</a> · <a href="#">Продукция</a> · EMAS</div>
  <div class="eyebrow">Эксклюзивный поставщик в России</div>
  <h1>Продукция <em>EMAS</em></h1>
  <p>Коммутационная аппаратура и устройства управления турецкого завода EMAS: кнопки, пульты, концевые выключатели, реле, датчики, разъёмы. Вся продукция сертифицирована в ЕАЭС, поставляется со склада в Москве.</p>
  <div class="note">Прототип: показаны 5 групп из 25 — чтобы согласовать подачу. Остальные группы добавляются тем же способом.</div>
</div></section>
<nav class="gnav"><div class="wrap">{''.join(nav)}</div></nav>
<main class="wrap">{''.join(sections)}</main>
<footer class="foot"><div class="wrap">ООО «РИТЕТ» · Москва, 2-й Магистральный туп., 7А, стр. 2 · 8 (800) 775-73-91</div></footer>
</body></html>'''
open('/home/user/content/ritet-premium/emas.html', 'w', encoding='utf-8').write(page)
print('emas.html:', len(page)//1024, 'KB; cards:', sum(len(v) for v in cards.values()))
