/* ============================================================
   Avenue Fashion Boutique — каталог и оформление заказа
   Чистый JS, без зависимостей.
   ============================================================ */

/* --- НАСТРОЙКИ (легко менять) --- */
const CONFIG = {
  instagram: "avenue_fashion_boutique_",      // ник в Instagram (без @)
  // Номер WhatsApp в международном формате, только цифры.
  // Пустая строка => кнопки заказа ведут в Instagram Direct.
  whatsapp: "",                                // например: "77001234567"
  currency: "₽"
};

/* --- ТОВАРЫ (замените фото/названия/цены) --- */
const PRODUCTS = [
  {
    name: "Платье «Parisienne»",
    price: 8900,
    badge: "Новинка",
    image: "assets/img/product-1.svg",
    sizes: ["XS", "S", "M", "L"]
  },
  {
    name: "Костюм «Rive Gauche»",
    price: 12400,
    badge: "Хит",
    image: "assets/img/product-2.svg",
    sizes: ["S", "M", "L"]
  },
  {
    name: "Блуза «Champagne»",
    price: 5600,
    badge: "",
    image: "assets/img/product-3.svg",
    sizes: ["XS", "S", "M", "L", "XL"]
  },
  {
    name: "Юбка «Montmartre»",
    price: 6200,
    badge: "",
    image: "assets/img/product-4.svg",
    sizes: ["XS", "S", "M", "L"]
  },
  {
    name: "Пальто «Élégance»",
    price: 15800,
    badge: "Premium",
    image: "assets/img/product-5.svg",
    sizes: ["S", "M", "L"]
  },
  {
    name: "Тренч «Avenue»",
    price: 13900,
    badge: "Новинка",
    image: "assets/img/product-6.svg",
    sizes: ["XS", "S", "M", "L"]
  }
];

/* --- Утилиты --- */
const formatPrice = (value) =>
  value.toLocaleString("ru-RU") + " " + CONFIG.currency;

function orderLink(productName, size) {
  const text = `Привет! Хочу заказать: ${productName}, размер: ${size}`;
  const encoded = encodeURIComponent(text);
  if (CONFIG.whatsapp) {
    return `https://wa.me/${CONFIG.whatsapp}?text=${encoded}`;
  }
  // Запасной вариант — Instagram Direct
  return `https://ig.me/m/${CONFIG.instagram}?text=${encoded}`;
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
        <a class="btn btn-primary order-btn" href="#" target="_blank" rel="noopener">Заказать</a>
      </div>
    `;

    // Обновление ссылки заказа при клике с актуальным размером
    const orderBtn = card.querySelector(".order-btn");
    orderBtn.addEventListener("click", () => {
      const checked = card.querySelector(`input[name="${groupName}"]:checked`);
      const size = checked ? checked.value : product.sizes[0];
      orderBtn.href = orderLink(product.name, size);
    });

    grid.appendChild(card);
  });
}

/* --- Ссылки в секции контактов --- */
function setupContactLinks() {
  const ig = document.getElementById("contact-instagram");
  if (ig) ig.href = `https://www.instagram.com/${CONFIG.instagram}`;

  const wa = document.getElementById("contact-whatsapp");
  if (wa) {
    const hello = encodeURIComponent("Здравствуйте! Пишу из Avenue Fashion Boutique ♡");
    wa.href = CONFIG.whatsapp
      ? `https://wa.me/${CONFIG.whatsapp}?text=${hello}`
      : `https://ig.me/m/${CONFIG.instagram}`;
    // Если нет WhatsApp — переименуем кнопку
    if (!CONFIG.whatsapp) wa.textContent = "Instagram Direct";
  }
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
