/* ============================================================
   Avenue Fashion Boutique — каталог, заказ и языки (kk/ru/en)
   Чистый JS, без зависимостей.
   ============================================================ */

/* --- НАСТРОЙКИ (легко менять) --- */
const CONFIG = {
  telegram: "avenueaktau",                      // ник в Telegram (без @)
  instagram: "avenue_fashion_boutique_",        // ник в Instagram (без @)
  whatsapp: "",                                 // напр. "77001234567" (необязательно)
  currency: { kk: "₸", ru: "₸", en: "₸" },
  defaultLang: "ru"
};

/* --- БЕЙДЖИ (переводимые) --- */
const BADGES = {
  new:     { kk: "Жаңа",  ru: "Новинка", en: "New" },
  hit:     { kk: "Хит",   ru: "Хит",     en: "Bestseller" },
  premium: { kk: "Premium", ru: "Premium", en: "Premium" }
};

/* --- ТОВАРЫ (цены тестовые: 50 000) --- */
const PRODUCTS = [
  { price: 50000, badge: "new",     image: "assets/img/product-1.jpg", sizes: ["XS","S","M","L"],
    name: { kk: "Зығыр костюмі «Linen»", ru: "Льняной костюм «Linen»", en: "Linen suit «Linen»" } },
  { price: 50000, badge: "hit",     image: "assets/img/product-2.jpg", sizes: ["S","M","L"],
    name: { kk: "Костюм «Avenue»", ru: "Костюм «Avenue»", en: "Suit «Avenue»" } },
  { price: 50000, badge: "",        image: "assets/img/product-3.jpg", sizes: ["XS","S","M","L"],
    name: { kk: "Зығыр көйлек «Summer»", ru: "Льняное платье «Summer»", en: "Linen dress «Summer»" } },
  { price: 50000, badge: "",        image: "assets/img/product-4.jpg", sizes: ["XS","S","M","L"],
    name: { kk: "Ұзын көйлек «Sunset»", ru: "Платье макси «Sunset»", en: "Maxi dress «Sunset»" } },
  { price: 50000, badge: "premium", image: "assets/img/product-5.jpg", sizes: ["S","M","L"],
    name: { kk: "Зығыр жакет «Classic»", ru: "Льняной жакет «Classic»", en: "Linen blazer «Classic»" } },
  { price: 50000, badge: "new",     image: "assets/img/product-6.jpg", sizes: ["XS","S","M","L"],
    name: { kk: "Спорттық костюм «Active»", ru: "Спортивный костюм «Active»", en: "Tracksuit «Active»" } },
  { price: 50000, badge: "hit",     image: "assets/img/product-7.jpg", sizes: ["XS","S","M","L","XL"],
    name: { kk: "Шілтерлі топ «Lace»", ru: "Топ с кружевом «Lace»", en: "Lace top «Lace»" } },
  { price: 50000, badge: "",        image: "assets/img/product-8.jpg", sizes: ["one size"],
    name: { kk: "Күннен қорғайтын көзілдірік", ru: "Очки солнцезащитные", en: "Sunglasses" } },
  { price: 50000, badge: "hit",     image: "assets/img/product-9.jpg", sizes: ["36","37","38","39","40"],
    name: { kk: "Кроссовкалар «On Cloud»", ru: "Кроссовки «On Cloud»", en: "Sneakers «On Cloud»" } }
];

/* --- ПЕРЕВОДЫ ИНТЕРФЕЙСА --- */
const I18N = {
  kk: {
    topbar_delivery: "Бүкіл әлемге жеткізу",
    topbar_hours: "Ақтау · 10:00–22:00",
    nav_about: "Біз туралы", nav_founder: "Галина", nav_catalog: "Каталог", nav_contact: "Байланыс",
    hero_eyebrow: "Әйелдер киімі · Ақтау",
    hero_tagline: "Жинақы бейнелер және табиғи маталар. Күн сайын киюге жарасатын талғампаздық.",
    hero_btn: "Каталогты қарау",
    about_eyebrow: "Бутик туралы",
    about_title: "Біздің <em>тарихымыз</em>",
    about_text: "Avenue Fashion Boutique — таза минимализм мен сапаны бағалайтындарға арналған Ақтаудағы әйелдер киімі. Біз табиғи маталар мен мәңгілік сәнді заттарды таңдаймыз — жинақы, әйелдік әрі ыңғайлы. Әр бейне сізді сенімді әрі әдемі сезінуіңіз үшін жасалған.",
    founder_eyebrow: "Негізін қалаушы",
    founder_title: "Галина",
    founder_lead: "Мен Галинамын — Avenue Fashion Boutique-тің негізін қалаушысы. 15 жылдан астам осы кеңістікті сіздер үшін жасап келемін.",
    founder_body: "Дүкенімізге 15 жылдан асты. Бұл ұзақ, оңай болмаған, бірақ керемет қызықты жол болды — мен оны сүйіспеншілікпен өткіздім. Бүгінде Avenue — тек киіну үшін ғана емес, әңгімелесу, жаңалықтарды білу және бірден дайын капсула жинау үшін келетін орын. Әр бейнені өзім таңдап, стилист ретіндегі бар талғамым мен тәжірибемді саламын — сіз шынайы әдемі сезінуіңіз үшін.",
    founder_sign: "Сүйіспеншілікпен, Галина ♡",
    catalog_eyebrow: "Коллекция",
    catalog_title: "Маусым <em>каталогы</em>",
    catalog_subtitle: "Өлшемді таңдап, бір рет басып тапсырыс беріңіз.",
    size_label: "Өлшемі", order_btn: "Тапсырыс беру",
    info_eyebrow: "Шарттар",
    info_title: "Жеткізу және <em>төлем</em>",
    info_delivery_h: "Жеткізу",
    info_delivery_p: "Бүкіл әлемге. Тапсырысты Telegram немесе Instagram арқылы растағаннан кейін жөнелтеміз.",
    info_pay_h: "Төлем",
    info_pay_p: "Kaspi RED · 0-0-12 бөліп төлеу. Ыңғайлы тәсілді тапсырыс кезінде келісеміз.",
    info_shop_h: "Ақтаудағы бутик",
    info_shop_p: "Green plaza ТК, 17 ы.а.<br>Күн сайын 10:00–22:00.",
    contact_eyebrow: "Бізбен байланыс",
    contact_title: "Тапсырыс <em>беру</em>",
    contact_text: "Бізге Telegram немесе Instagram арқылы жазыңыз — өлшемді таңдауға көмектесіп, бар-жоғын айтамыз. Әр хабарламаға қуаныштымыз ♡",
    footer_tag: "Әйелдер киімі · Ақтау",
    footer_copy: "© {year} Avenue Fashion Boutique. Сүйіспеншілікпен жасалған.",
    order_text: "Сәлеметсіз бе! Тапсырыс бергім келеді: {name}, өлшемі: {size}",
    toast_copied: "Тапсырыс мәтіні көшірілді — оны {channel} чатына қойыңыз ♡"
  },
  ru: {
    topbar_delivery: "Доставка по всему миру",
    topbar_hours: "Актау · 10:00–22:00",
    nav_about: "О нас", nav_founder: "Галина", nav_catalog: "Каталог", nav_contact: "Контакты",
    hero_eyebrow: "Женская одежда · Актау",
    hero_tagline: "Лаконичные образы и натуральные ткани. Элегантность, в которой хочется жить каждый день.",
    hero_btn: "Смотреть каталог",
    about_eyebrow: "О бутике",
    about_title: "Наша <em>история</em>",
    about_text: "Avenue Fashion Boutique — это женская одежда из Актау для тех, кто ценит чистый минимализм и качество. Мы выбираем натуральные ткани и вещи вне времени — лаконичные, женственные и комфортные. Каждый образ создан, чтобы вы чувствовали себя уверенно и красиво.",
    founder_eyebrow: "Основательница",
    founder_title: "Галина",
    founder_lead: "Я Галина — основательница Avenue Fashion Boutique. Более 15 лет создаю это пространство для вас.",
    founder_body: "Нашему магазину больше 15 лет. Это был долгий, непростой, но невероятно интересный путь — и я прошла его с любовью. Сегодня Avenue — это место, куда приходят не только одеться, но и пообщаться, узнать о новинках и сразу собрать готовую капсулу. Я лично подбираю каждый образ и вкладываю в него весь свой вкус и опыт стилиста, чтобы вы чувствовали себя по-настоящему красивой.",
    founder_sign: "С любовью, Галина ♡",
    catalog_eyebrow: "Коллекция",
    catalog_title: "Каталог <em>сезона</em>",
    catalog_subtitle: "Выберите размер и оформите заказ в один клик.",
    size_label: "Размер", order_btn: "Заказать",
    info_eyebrow: "Условия",
    info_title: "Доставка и <em>оплата</em>",
    info_delivery_h: "Доставка",
    info_delivery_p: "По всему миру. Отправляем после подтверждения заказа в Telegram или Instagram.",
    info_pay_h: "Оплата",
    info_pay_p: "Kaspi RED · рассрочка 0-0-12. Удобный способ согласуем при оформлении.",
    info_shop_h: "Бутик в Актау",
    info_shop_p: "ЖК Green plaza, 17 мкр.<br>Ежедневно 10:00–22:00.",
    contact_eyebrow: "Связь с нами",
    contact_title: "Оформить <em>заказ</em>",
    contact_text: "Напишите нам в Telegram или Instagram — поможем с выбором размера и расскажем о наличии. Будем рады каждому сообщению ♡",
    footer_tag: "Женская одежда · Актау",
    footer_copy: "© {year} Avenue Fashion Boutique. Сделано с любовью.",
    order_text: "Привет! Хочу заказать: {name}, размер: {size}",
    toast_copied: "Текст заказа скопирован — вставьте его в чат {channel} ♡"
  },
  en: {
    topbar_delivery: "Worldwide delivery",
    topbar_hours: "Aktau · 10:00–22:00",
    nav_about: "About", nav_founder: "Galina", nav_catalog: "Catalog", nav_contact: "Contact",
    hero_eyebrow: "Women's clothing · Aktau",
    hero_tagline: "Refined looks in natural fabrics. Elegance you'll want to live in every day.",
    hero_btn: "View catalog",
    about_eyebrow: "About",
    about_title: "Our <em>story</em>",
    about_text: "Avenue Fashion Boutique is women's clothing from Aktau for those who value clean minimalism and quality. We choose natural fabrics and timeless pieces — refined, feminine and comfortable. Every look is created to make you feel confident and beautiful.",
    founder_eyebrow: "Founder",
    founder_title: "Galina",
    founder_lead: "I'm Galina — the founder of Avenue Fashion Boutique. I've been creating this space for you for over 15 years.",
    founder_body: "Our boutique is over 15 years old. It's been a long, challenging, yet truly fascinating journey — and I've walked it with love. Today Avenue is a place where you come not just to dress, but to chat, discover new arrivals and put together a complete capsule on the spot. I personally curate every look, putting all my taste and stylist's experience into it, so that you feel truly beautiful.",
    founder_sign: "With love, Galina ♡",
    catalog_eyebrow: "Collection",
    catalog_title: "Season <em>catalog</em>",
    catalog_subtitle: "Choose your size and order in one click.",
    size_label: "Size", order_btn: "Order",
    info_eyebrow: "Details",
    info_title: "Delivery & <em>payment</em>",
    info_delivery_h: "Delivery",
    info_delivery_p: "Worldwide. We ship after the order is confirmed via Telegram or Instagram.",
    info_pay_h: "Payment",
    info_pay_p: "Kaspi RED · 0-0-12 installments. We'll agree on a convenient method when ordering.",
    info_shop_h: "Boutique in Aktau",
    info_shop_p: "Green plaza, 17th district.<br>Daily 10:00–22:00.",
    contact_eyebrow: "Get in touch",
    contact_title: "Place an <em>order</em>",
    contact_text: "Message us on Telegram or Instagram — we'll help with sizing and availability. We're happy to hear from you ♡",
    footer_tag: "Women's clothing · Aktau",
    footer_copy: "© {year} Avenue Fashion Boutique. Made with love.",
    order_text: "Hello! I'd like to order: {name}, size: {size}",
    toast_copied: "Order text copied — paste it into the {channel} chat ♡"
  }
};

/* --- Текущий язык --- */
let LANG = localStorage.getItem("avenue_lang") || CONFIG.defaultLang;
if (!I18N[LANG]) LANG = CONFIG.defaultLang;
const t = (key) => (I18N[LANG] && I18N[LANG][key]) || key;

/* --- Утилиты --- */
const formatPrice = (value) =>
  value.toLocaleString("ru-RU") + " " + (CONFIG.currency[LANG] || "₸");

function buildOrder(productName, size) {
  const text = t("order_text").replace("{name}", productName).replace("{size}", size);
  if (CONFIG.whatsapp) {
    return { url: `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(text)}`,
             needsCopy: false, channel: "WhatsApp", text };
  }
  return { url: `https://ig.me/m/${CONFIG.instagram}`, needsCopy: true, channel: "Instagram", text };
}

function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast"; toast.className = "toast"; toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("toast--show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("toast--show"), 3500);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) { /* игнорируем */ }
  document.body.removeChild(ta);
}

/* --- Рендер карточек (учитывает язык) --- */
function renderProducts() {
  const grid = document.getElementById("products");
  if (!grid) return;
  grid.innerHTML = "";

  PRODUCTS.forEach((product, index) => {
    const card = document.createElement("article");
    card.className = "card";
    const name = product.name[LANG] || product.name.ru;
    const badge = product.badge ? (BADGES[product.badge][LANG] || "") : "";
    const groupName = `size-${index}`;
    const sizesHtml = product.sizes.map((size, i) => {
      const id = `${groupName}-${i}`;
      return `<input type="radio" name="${groupName}" id="${id}" value="${size}" ${i === 0 ? "checked" : ""}>
              <label for="${id}">${size}</label>`;
    }).join("");

    card.innerHTML = `
      <div class="card-media">
        ${badge ? `<span class="card-badge">${badge}</span>` : ""}
        <img src="${product.image}" alt="${name}" loading="lazy" width="400" height="500">
      </div>
      <div class="card-body">
        <h3 class="card-name">${name}</h3>
        <p class="card-price">${formatPrice(product.price)}</p>
        <div class="size-field">
          <span class="size-label">${t("size_label")}</span>
          <div class="size-options">${sizesHtml}</div>
        </div>
        <a class="btn btn-primary order-btn" target="_blank" rel="noopener">${t("order_btn")}</a>
      </div>`;

    const orderBtn = card.querySelector(".order-btn");
    const currentSize = () => {
      const checked = card.querySelector(`input[name="${groupName}"]:checked`);
      return checked ? checked.value : product.sizes[0];
    };
    const refreshOrder = () => { orderBtn.href = buildOrder(name, currentSize()).url; };
    refreshOrder();
    card.querySelectorAll(`input[name="${groupName}"]`)
      .forEach((input) => input.addEventListener("change", refreshOrder));
    orderBtn.addEventListener("click", () => {
      const order = buildOrder(name, currentSize());
      if (order.needsCopy) {
        copyText(order.text);
        showToast(t("toast_copied").replace("{channel}", order.channel));
      }
    });

    grid.appendChild(card);
  });
}

/* --- Применить переводы к статичным элементам --- */
function applyTranslations() {
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.getAttribute("data-i18n-html"));
  });
  const year = new Date().getFullYear();
  const fc = document.getElementById("footer-copy");
  if (fc) fc.textContent = t("footer_copy").replace("{year}", year);
  document.querySelectorAll(".lang-switch button").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-lang") === LANG);
  });
}

/* --- Смена языка --- */
function setLang(lang) {
  if (!I18N[lang]) return;
  LANG = lang;
  localStorage.setItem("avenue_lang", lang);
  applyTranslations();
  renderProducts();
}

/* --- Ссылки контактов --- */
function setupContactLinks() {
  const tg = document.getElementById("contact-telegram");
  if (tg) tg.href = `https://t.me/${CONFIG.telegram}`;
  const ig = document.getElementById("contact-instagram");
  if (ig) ig.href = `https://www.instagram.com/${CONFIG.instagram}`;
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".lang-switch button").forEach((b) => {
    b.addEventListener("click", () => setLang(b.getAttribute("data-lang")));
  });
  applyTranslations();
  renderProducts();
  setupContactLinks();
});
