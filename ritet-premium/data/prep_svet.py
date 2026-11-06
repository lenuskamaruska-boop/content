#!/usr/bin/env python3
"""Готовит data/emas-svet.json для группы «Светосигнальная арматура» (317 артикулов → 64 модели).
Вход: svet_db.json (строки базы «Описание EMAS.xlsx» по группе), svet_models.json (модели и фото),
папка с фото. Тексты серий — из Word-карточек EMAS (папка «Описание светосигнальная арматура» на Диске).
Запуск: python3 prep_svet.py <scratch_dir>  (в scratch_dir лежат svet_db.json, svet_models.json, svet_photos/)
"""
import json, re, sys, os
from PIL import Image

SC = sys.argv[1]
OUT = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(OUT, '..', 'img', 'products')
db = json.load(open(os.path.join(SC, 'svet_db.json'), encoding='utf-8'))
models = json.load(open(os.path.join(SC, 'svet_models.json'), encoding='utf-8'))

# ---- тексты серий (сокращённо из Word-карточек EMAS)
SERIES = {
 'S': dict(title='Серия S — компактная арматура Ø6–22 мм',
   lead='Неоновые и светодиодные лампы в пластиковом корпусе IP40. Подключение кабелем 12 см, клеммами 6,3×0,8 или винтом; монтаж гайкой или на защёлках.',
   adv=['Полная устойчивость к нагреву и ударам благодаря линзе из поликарбоната', 'Простота подключения к различным типам клемм', 'Различные варианты напряжения', 'Быстрая сборка: гайка или защёлки']),
 'MB': dict(title='Серия MB — моноблочная Ø22 мм',
   lead='Светодиодная арматура в едином корпусе: плоская или ячеистая линза, винтовое подключение, контакты AgNi, IP50. Напряжения от 12 до 230 В.',
   adv=['Устойчивость к нагреву и механическим ударам (линза ПК)', 'Различные варианты напряжения', 'Контакты AgNi, кабель 1,5–2,5 мм²']),
 'MD': dict(title='Серия MD — моноблочная Ø16 мм',
   lead='Компактная светодиодная арматура в едином корпусе под отверстие Ø16 мм: плоская или ячеистая линза, винтовое подключение, IP50.',
   adv=['Устойчивость к нагреву и механическим ударам (линза ПК)', 'Различные варианты напряжения', 'Винтовое подключение, кабель 1,5–2,5 мм²']),
 'D': dict(title='Серия D — модульная Ø16 мм',
   lead='Сигнальная арматура EMAS для индикации состояния электрических цепей в щитовом оборудовании. Светодиодный блок 12–30 В AC/DC, клеммы 2,8×0,5; линза круглая, квадратная или прямоугольная.',
   adv=['Круглые, квадратные и прямоугольные формы', 'Широкая гамма способов соединения', 'Корпус устойчив к механическим воздействиям', 'Быстрый и удобный монтаж', 'Термоустойчивые линзы']),
 'B': dict(title='Серия B — модульная Ø22 мм, пластик',
   lead='Базовая модульная арматура: адаптер + светодиодный блок на нужное напряжение или патрон BA9s под свою лампу. Корпус из пластика, IP50.',
   adv=['Защита пальцев для максимальной безопасности', 'Ударопрочная линза из поликарбоната', 'Неплавящиеся контактные блоки V0 PA6.6', 'Установка блоков на адаптер без инструмента', 'До 2 контактных блоков подряд']),
 'CP': dict(title='Серия CP — модульная Ø22 мм, пластик IP65',
   lead='Пластиковая арматура с силиконовыми уплотнениями, IP65. Светодиодные блоки 12–30, 48, 110, 100–230 В AC и 220 В DC.',
   adv=['Защита IP65 — силиконовые уплотнения', 'Ударопрочная линза из поликарбоната', 'Неплавящиеся контактные блоки V0 PA6.6', 'Установка блоков на адаптер без инструмента', 'До 2 контактных блоков подряд']),
 'CM': dict(title='Серия CM — модульная Ø22 мм, металл IP65',
   lead='Арматура в хромированном металлическом корпусе для тяжёлых условий эксплуатации, IP65. Те же светодиодные блоки, что и в серии CP.',
   adv=['Металлическая конструкция, устойчивая к суровым условиям', 'Хромирование против коррозии', 'Защита IP65 — силиконовые уплотнения', 'Адаптер легко снимается одной рукой', 'До 2 контактных блоков подряд']),
 'H': dict(title='Серия H — увеличенная линза Ø30 мм',
   lead='Модульная арматура с линзой Ø30 мм под стандартное отверстие Ø22 мм. Пластик, IP50; светодиодные блоки или патрон BA9s.',
   adv=['Крупная линза Ø30 мм — хорошо видна издалека', 'Защита пальцев для максимальной безопасности', 'Неплавящиеся контактные блоки V0 PA6.6', 'Установка блоков на адаптер без инструмента']),
}
ORDER = ['S', 'MB', 'MD', 'D', 'B', 'CP', 'CM', 'H']
COLORS = {'Белый': '#f4f5f7', 'Красный': '#e11d48', 'Синий': '#2563eb', 'Желтый': '#facc15', 'Зеленый': '#16a34a'}

def u(s):
    """единицы по-русски: 12-30В → 12–30 В, 22мм → 22 мм"""
    s = str(s)
    s = re.sub(r'(\d)\s*-\s*(\d)', r'\1–\2', s)
    s = re.sub(r'(\d)(В|V)\b', r'\1 В', s); s = re.sub(r'(\d)V\b', r'\1 В', s)
    s = re.sub(r'(\d)(мм|см|мА|mA|Вт)\b', r'\1 \2', s).replace('mA', 'мА').replace('мм кв', 'мм²')
    s = re.sub(r'\s{2,}', ' ', s)
    return s.strip()

def title_of(key, first):
    ser, sub = key
    name = db[first]['Наименование товара']
    if ser in ('B', 'CP', 'CM', 'H'):
        return ('Под лампу с цоколем BA9s (без лампы)' if 'без лампы' in sub else u(f'Светодиодный блок {sub}'))
    if ser == 'D':
        return f'Светодиод 12–30 В AC/DC, {sub}'
    if ser in ('MB', 'MD'):
        lens = 'ячеистая' if 'SP' in sub else 'плоская'
        volt = u(db[first].get('Номинальное напряжение', '')); rod = {'Переменный ток': 'AC', 'Постоянный ток': 'DC'}.get(db[first].get('Род тока', ''), 'AC/DC')
        return f'{"Ø22" if ser == "MB" else "Ø16"} мм, {lens} линза, {volt} {rod}'
    n = re.sub(r',?\s*(бел|красн|син|жёлт|желт|зелён|зелен)\w*\s*цвет\w*', '', name)
    n = re.sub(r'^Сигнальная арматура\s*(моноблочная)?,?\s*', '', n)
    n = re.sub(r',\s*серия \w+', '', n); n = re.sub(r',\s*IP\d+', '', n)
    n = n.replace('ка<цвет>', 'кабель').replace('под патрон с резьбой Ba9 (без лампы)S', 'под патрон с резьбой Ba9S (без лампы)')
    n = re.sub(r'\s*,\s*', ', ', n).strip(' ,')
    if ser == 'S' and sub == 'S22RGB024': n = 'RGB-светодиод (красный, синий, зелёный), 24 В DC, Ø22 мм'
    n = u(n[0].upper() + n[1:])
    return re.sub(r'^(\d+ мм)', r'Ø\1', n)

def specs_of(key, first):
    d = db[first]; ser = key[0]
    ip = d.get('Степень защиты (IP) в сборе', '')
    if ser in ('CP', 'CM'): ip = 'IP65'
    lamp = {'Светодиод': 'светодиод', 'Лампа накаливания': 'лампа накаливания (неон)', 'BA9s': 'патрон BA9s, без лампы'}.get(d.get('Исполнение лампового патрона'), d.get('Исполнение лампового патрона', ''))
    volt = d.get('Номинальное напряжение', '')
    rod = {'Переменный ток': 'AC', 'Постоянный ток': 'DC', 'Переменный/постоянный ток': 'AC/DC'}.get(d.get('Род тока', ''), '')
    if volt and rod and rod not in volt and 'AC' not in volt: volt = f'{volt} {rod}'
    lens = ' '.join(x for x in (d.get('Конструкция линзы', ''), d.get('Исполнение линзы', '').lower()) if x)
    hole = 'Ø22 (линза Ø30)' if ser == 'H' else d.get('Рамер монтажного отверстия, мм', '')
    rows = [('Степень защиты', ip), ('Монтажное отверстие', hole), ('Источник света', lamp),
            ('Напряжение', volt), ('Ток', d.get('Номинальная сила тока', '')), ('Мощность', d.get('Потребляемая мощность', '')),
            ('Подключение', d.get('Тип подключения', '')), ('Линза', lens), ('Рабочая температура', d.get('Диапазон рабочих температур', '')),
            ('Ресурс', d.get('Минимальный электрический ресурс', ''))]
    return [(k, u(v)) for k, v in rows if v and str(v) not in ('#N/A', 'nan')][:7]

def square(src, dst, size=640):
    im = Image.open(src).convert('RGB')
    im.thumbnail((size - 40, size - 40))
    bg = Image.new('RGB', (size, size), (255, 255, 255))
    bg.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
    bg.save(dst, 'JPEG', quality=84, optimize=True)

out = {'group': 'Светосигнальная арматура', 'lead': 'Индикаторные лампы EMAS для щитов и пультов: от компактных неоновых Ø6 мм до модульных Ø22 мм в металлическом корпусе IP65. Пять цветов линзы, светодиодные и ламповые блоки на все стандартные напряжения.',
       'articles': len(db), 'series': []}
photo_cache = {}
# фото модели: без суффикса — снимок изделия, с суффиксом _1 — чертёж; для серии S часть моделей показана фото соседней модели того же типоразмера
PHOTO = {('B','без лампы (цоколь BA9s)'):'B0D0XK.jpg', ('B','12-30 В AC/DC'):'B080XS.jpg', ('B','100-230 В AC'):'B0Z0XY.jpeg', ('B','110 В AC/DC'):'B0D0XK.jpg', ('B','48 В AC/DC'):'B0Z0XY.jpeg',
 ('CM','12-30 В AC/DC'):'CM090XY.jpg', ('CM','100-230 В AC'):'CM0M0XM.jpg', ('CM','110 В AC/DC'):'CM0F0XS.jpg', ('CM','220 В DC'):'CM0O0XK.jpg', ('CM','48 В AC/DC'):'CM090XY.jpg',
 ('CP','12-30 В AC/DC'):'CP080XS.jpg', ('CP','100-230 В AC'):'CP0S0XS.jpg', ('CP','110 В AC/DC'):'CP0V0XM.jpg', ('CP','220 В DC'):'CP0S0XS.jpg', ('CP','48 В AC/DC'):'CP0V0XM.jpg',
 ('D','прямоугольная линза'):'D090DXY.jpg', ('D','квадратная линза'):'D060KXK.jpg', ('D','круглая линза'):'D090YXY.jpg',
 ('H','без лампы (цоколь BA9s)'):'H030XY.jpg', ('H','12-30 В AC/DC'):'H070XM.jpeg', ('H','100-230 В AC'):'H070XM.jpeg', ('H','110 В AC/DC'):'H070XM.jpeg', ('H','48 В AC/DC'):'H070XM.jpeg',
 ('MB','MBSP012'):'MBSP012S.jpg', ('MB','MBSP024'):'MBSP024Y.jpg', ('MB','MBSP110'):'MBSP024Y.jpg', ('MB','MBSP220'):'MBSP220S.jpg',
 ('S','S060N'):'S060NY_1.jpeg', ('S','S100L'):'S106NY.jpeg', ('S','S100L1'):'S106NY.jpeg', ('S','S100L2'):'S106NY.jpeg', ('S','S100N'):'S106NY.jpeg', ('S','S100N5SP0'):'S106NY.jpeg',
 ('S','S102N'):'S102NY_1.jpeg', ('S','S105N'):'S105NY_1.jpeg', ('S','S106N'):'S106NY.jpeg', ('S','S140N'):'S145NB.jpeg', ('S','S140N1'):'S145NB.jpeg', ('S','S140N2'):'S145NB.jpeg', ('S','S145N'):'S145NB.jpeg',
 ('S','S220N'):'S220NY_1.jpeg', ('S','S220N6'):'S220NY_1.jpeg', ('S','S222L'):'S222LY.jpeg', ('S','S222L1'):'S222LY.jpeg', ('S','S222L2'):'S222LY.jpeg', ('S','S222N'):'S222LY.jpeg', ('S','S224N'):'S222LY.jpeg', ('S','S224N7'):'S222LY.jpeg', ('S','S22RGB024'):'S22RGB024PC.jpeg'}
for k in list(PHOTO): pass
for s in ORDER:
    sec = dict(code=s, **SERIES[s], models=[])
    for m in models:
        ser, sub = m['key']
        if ser != s: continue
        first = m['articles'][0]
        fn0 = PHOTO.get(tuple(m['key'])) or ('MBSD012M.jpg' if ser == 'MB' else 'MDSD012K.jpeg' if sub.startswith('MDSD') else 'MDSP012S.jpeg' if sub.startswith('MDSP') else None) or (m['photo'] or [None, None])[1]
        photo = [None, fn0] if fn0 else None
        img = None
        if photo:
            src = os.path.join(SC, 'svet_photos', photo[1])
            if os.path.exists(src):
                fn = 'svet-' + re.sub(r'(_\d+)?\.jpe?g$', '', photo[1]) + '.jpg'
                if fn not in photo_cache:
                    square(src, os.path.join(IMG, fn)); photo_cache[fn] = 1
                img = 'img/products/' + fn
        variants = []
        for a in m['articles']:
            d = db[a]
            if sub == 'S22RGB024':
                variants.append(dict(art=a, label=d.get('Тип подключения', ''), color=None))
            else:
                c = d.get('Цвет линзы', ''); variants.append(dict(art=a, label=c, color=COLORS.get(c)))
        code = sub if ser in ('S', 'MB', 'MD') else first[:-1] + '•'
        if ser == 'S' and sub != 'S22RGB024': code = re.sub(r'^(S\d{3}[NL])(\d?)(5SP0)?$', lambda mm: mm.group(1) + '•' + mm.group(2) + (mm.group(3) or ''), sub)
        if ser in ('MB', 'MD'): code = sub + '•'
        sec['models'].append(dict(code=code, title=title_of(m['key'], first), specs=specs_of(m['key'], first), img=img, variants=variants, cert=db[first].get('Сертификат', '')))
    out['series'].append(sec)
json.dump(out, open(os.path.join(OUT, 'emas-svet.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('models:', sum(len(s['models']) for s in out['series']), 'photos:', len(photo_cache))
for s in out['series']:
    for m in s['models'][:3]: print(s['code'], m['code'], '|', m['title'], '|', m['specs'][:4])
