# Промо-баннер «Цены тают на DIN-рейки — скидки до -60%»

Баннер для сайта **ritet.net**.

## Файлы

| Файл | Назначение |
|------|------------|
| `din-reyki-sale-60.png` | Само изображение баннера (1672×941) |
| `banner-snippet.html` | Готовый блок HTML+CSS для вставки на сайт |
| `preview.html` | Локальное превью (открыть в браузере) |

## Как вставить на сайт

1. Загрузите `din-reyki-sale-60.png` на сервер в папку `/upload/banner/`.
2. Вставьте разметку из `banner-snippet.html` в нужное место шаблона
   (главная страница, шапка раздела и т.п.).

Минимальный вариант (как вы и присылали):

```html
<a href="/catalog/din-reyki/" class="promo-banner">
  <img
    src="/upload/banner/din-reyki-sale-60.png"
    alt="Цены тают на DIN-рейки — скидки до -60%"
    width="1672" height="941"
    loading="lazy" decoding="async"
  >
</a>
```

```css
.promo-banner { display: block; width: 100%; max-width: 100%; overflow: hidden; }
.promo-banner img { display: block; width: 100%; height: auto; }
```

### Что добавлено к исходному сниппету и зачем
- `width`/`height` на `<img>` — резервируют место под картинку, чтобы при
  загрузке страница не «прыгала» (убирает layout shift, важно для Core Web Vitals).
- `loading="lazy"` `decoding="async"` — баннер не тормозит загрузку страницы.
- `alt` / `aria-label` — доступность и SEO.

## Рекомендация по весу картинки
Текущий PNG ~1.5 МБ — для веб-баннера тяжеловато. Перед заливкой стоит
сжать/конвертировать в WebP, например:

```bash
cwebp -q 82 din-reyki-sale-60.png -o din-reyki-sale-60.webp
```

и отдавать через `<picture>` с PNG-фолбэком:

```html
<picture>
  <source srcset="/upload/banner/din-reyki-sale-60.webp" type="image/webp">
  <img src="/upload/banner/din-reyki-sale-60.png" alt="Цены тают на DIN-рейки — скидки до -60%"
       width="1672" height="941" loading="lazy" decoding="async">
</picture>
```
