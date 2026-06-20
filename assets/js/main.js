/* ============================================================
   Avenue Fashion Boutique — каталог и оформление заказа
   Чистый JS, без зависимостей.
   ============================================================ */

/* --- НАСТРОЙКИ (легко менять) --- */
const CONFIG = {
  telegram: "avenueaktau",                      // ник в Telegram (без @), основной канал заказов
  instagram: "avenue_fashion_boutique_",        // ник в Instagram (без @)
  // Номер WhatsApp в международном формате, только цифры (необязательно).
  // Если указан — WhatsApp подставит текст заказа автоматически.
  whatsapp: "",                                 // например: "77001234567"
  currency: "₸"
};

/* --- ТОВАРЫ (замените фото/названия/цены) --- */
const PRODUCTS = [
  {
    name: "Льняной костюм «Linen»",
    price: 50000,
    badge: "Новинка",
    image: "assets/img/product-1.jpg",
    sizes: ["XS", "S", "M", "L"]
  },
  {
    name: "Костюм «Avenue»",
    price: 50000,
    badge: "Хит",
    image: "assets/img/product-2.jpg",
    sizes: ["S", "M", "L"]
  },
  {
    name: "Льняное платье «Summer»",
    price: 50000,
    badge: "",
    image: "assets/img/product-3.jpg",
    sizes: ["XS", "S", "M", "L"]
  },
  {
    name: "Платье макси «Sunset»",
    price: 50000,
    badge: "",
    image: "assets/img/product-4.jpg",
    sizes: ["XS", "S", "M", "L"]
  },
  {
    name: "Льняной жакет «Classic»",
    price: 50000,
    badge: "Premium",
    image: "assets/img/product-5.jpg",
    sizes: ["S", "M", "L"]
  },
  {
    name: "Спортивный костюм «Active»",
    price: 50000,
    badge: "Новинка",
    image: "assets/img/product-6.jpg",
    sizes: ["XS", "S", "M", "L"]
  },
  {
    name: "Топ с кружевом «Lace»",
    price: 50000,
    badge: "Хит",
    image: "assets/img/product-7.jpg",
    sizes: ["XS", "S", "M", "L", "XL"]
  },
  {
    name: "Очки солнцезащитные",
    price: 50000,
    badge: "",
    image: "assets/img/product-8.jpg",
    sizes: ["one size"]
  },
  {
    name: "Кроссовки «On Cloud»",
    price: 50000,
    badge: "Хит",
    image: "assets/img/product-9.jpg",
    sizes: ["36", "37", "38", "39", "40"]
  }
];

/* --- Утилиты --- */
const formatPrice = (value) =>
  value.toLocaleString("ru-RU") + " " + CONFIG.currency;

// Возвращает данные заказа: ссылку, текст и флаг — нужно ли копировать текст.
// WhatsApp подставляет текст автоматически (?text=). Telegram и Instagram
// этого не умеют, поэтому текст копируем в буфер обмена (см. обработчик клика).
function buildOrder(productName, size) {
  const text = `Привет! Хочу заказать: ${productName}, размер: ${size}`;
  // Заказ оформляется через Instagram Direct.
  // (WhatsApp — необязательный вариант: подставляет текст автоматически.)
  if (CONFIG.whatsapp) {
    return {
      url: `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(text)}`,
      needsCopy: false,
      channel: "WhatsApp",
      text
    };
  }
  return {
    url: `https://ig.me/m/${CONFIG.instagram}`,
    needsCopy: true,
    channel: "Instagram",
    text
  };
}

// Маленькое всплывающее уведомление
function showToast(message) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("toast--show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("toast--show"), 3500);
}

// Копирование текста в буфер (с запасным вариантом для старых браузеров)
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) { /* игнорируем */ }
  document.body.removeChild(ta);
}

/* --- Рендер карточек --- */
function renderProducts() {
  const grid = document.getElementById("products");
  if (!grid) return;

  PRODUCTS.forEach((product, index) => {
    const card = document.createElement("article");
    card.className = "card";

    const groupName = `size-${index}`;
    const sizesHtml = product.sizes
      .map((size, i) => {
        const id = `${groupName}-${i}`;
        return `
          <input type="radio" name="${groupName}" id="${id}" value="${size}" ${i === 0 ? "checked" : ""}>
          <label for="${id}">${size}</label>`;
      })
      .join("");

    card.innerHTML = `
      <div class="card-media">
        ${product.badge ? `<span class="card-badge">${product.badge}</span>` : ""}
        <img src="${product.image}" alt="${product.name}" loading="lazy" width="400" height="500">
      </div>
      <div class="card-body">
        <h3 class="card-name">${product.name}</h3>
        <p class="card-price">${formatPrice(product.price)}</p>
        <div class="size-field">
          <span class="size-label">Размер</span>
          <div class="size-options">${sizesHtml}</div>
        </div>
        <a class="btn btn-primary order-btn" target="_blank" rel="noopener">Заказать</a>
      </div>
    `;

    const orderBtn = card.querySelector(".order-btn");

    // Держим ссылку заказа всегда актуальной: при загрузке и при смене размера.
    const currentSize = () => {
      const checked = card.querySelector(`input[name="${groupName}"]:checked`);
      return checked ? checked.value : product.sizes[0];
    };
    const refreshOrder = () => {
      orderBtn.href = buildOrder(product.name, currentSize()).url;
    };
    refreshOrder();
    card.querySelectorAll(`input[name="${groupName}"]`)
      .forEach((input) => input.addEventListener("change", refreshOrder));

    // Telegram/Instagram не подставляют текст автоматически — копируем в буфер.
    orderBtn.addEventListener("click", () => {
      const order = buildOrder(product.name, currentSize());
      if (order.needsCopy) {
        copyText(order.text);
        showToast(`Текст заказа скопирован — вставьте его в чат ${order.channel} ♡`);
      }
    });

    grid.appendChild(card);
  });
}

/* --- Ссылки в секции контактов --- */
function setupContactLinks() {
  const tg = document.getElementById("contact-telegram");
  if (tg) tg.href = `https://t.me/${CONFIG.telegram}`;

  const ig = document.getElementById("contact-instagram");
  if (ig) ig.href = `https://www.instagram.com/${CONFIG.instagram}`;
}

/* --- Год в подвале --- */
function setYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = new Date().getFullYear();
}

document.addEventListener("DOMContentLoaded", () => {
  renderProducts();
  setupContactLinks();
  setYear();
});
