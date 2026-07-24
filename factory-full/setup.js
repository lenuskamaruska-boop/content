#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// МАСТЕР НАСТРОЙКИ КОНТЕНТ-ЗАВОДА
// Ведёт по шагам, проверяет каждый доступ вживую и сам пишет .env.
// Запуск: node setup.js   (работает без npm install — только Node 20+)
// ─────────────────────────────────────────────────────────────
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, ".env");
const rl = createInterface({ input, output });

// Свой ввод с буфером: readline при вводе из файла/пайпа выдаёт все строки разом,
// и обычный question() их теряет. Копим строки сами — работает и в терминале, и в тестах.
const _lines = [];
const _waiters = [];
let _closed = false;
rl.on("line", (l) => { const w = _waiters.shift(); if (w) w(l); else _lines.push(l); });
rl.on("close", () => { _closed = true; while (_waiters.length) _waiters.shift()(null); });

// Возвращает строку или null, если ввод закончился
function question(prompt) {
  output.write(prompt);
  if (_lines.length) return Promise.resolve(_lines.shift());
  if (_closed) return Promise.resolve(null);
  return new Promise((res) => _waiters.push(res));
}

const L = (n = 60) => "─".repeat(n);
const say = (s = "") => console.log(s);
const ok = (s) => console.log(`   ✅ ${s}`);
const bad = (s) => console.log(`   ❌ ${s}`);
const hmm = (s) => console.log(`   ⚠️  ${s}`);

// ── Чтение уже существующего .env, чтобы не спрашивать заново ──
function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

function writeEnv(env) {
  const lines = ["# Настройки контент-завода. Создано мастером (node setup.js).",
                 "# Ключи — как пароли: никому не показывай и не выкладывай в интернет.", ""];
  for (const [k, v] of Object.entries(env)) if (v) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

// ── Живые проверки ────────────────────────────────────────────
async function checkAnthropic(key) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
    });
    if (r.ok) return { ok: true };
    const body = await r.text();
    if (r.status === 401) return { ok: false, why: "Ключ недействителен — проверь, что скопировал целиком, и что его не удалили в консоли." };
    if (/credit balance/i.test(body)) {
      return { ok: false, why:
        "Ключ рабочий, НО на счету нет денег.\n" +
        "      Это самая частая засада: аккаунт создан, а баланс нулевой.\n" +
        "      Зайди на console.anthropic.com → Plans & Billing и пополни счёт.\n" +
        "      Важно: деньги и ключ должны быть на ОДНОЙ почте." };
    }
    return { ok: false, why: `Ответ сервера ${r.status}: ${body.slice(0, 160)}` };
  } catch (e) { return { ok: false, why: `Сеть недоступна: ${e.message}` }; }
}

async function checkTelegramBot(token) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = await r.json();
    if (j.ok) return { ok: true, name: `@${j.result.username}` };
    return { ok: false, why: "Токен не подошёл. Проверь, что скопировал его целиком из @BotFather." };
  } catch (e) { return { ok: false, why: `Сеть недоступна: ${e.message}` }; }
}

async function checkTelegramChat(token, chatId, topicId) {
  try {
    const body = { chat_id: chatId, text: "✅ Связь есть. Это сообщение от мастера настройки завода." };
    if (topicId) body.message_thread_id = Number(topicId);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) return { ok: true };
    if (/chat not found/i.test(j.description || ""))
      return { ok: false, why: "Чат не найден. Добавь бота в чат и дай ему право писать." };
    if (/not enough rights|not a member/i.test(j.description || ""))
      return { ok: false, why: "Бот в чате есть, но писать не может — выдай ему права администратора." };
    return { ok: false, why: j.description || "Telegram отказал" };
  } catch (e) { return { ok: false, why: `Сеть недоступна: ${e.message}` }; }
}

async function checkGroq(key) {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) return { ok: true };
    return { ok: false, why: r.status === 401 ? "Ключ не подошёл — возьми новый на console.groq.com/keys" : `Ответ ${r.status}` };
  } catch (e) { return { ok: false, why: `Сеть недоступна: ${e.message}` }; }
}

async function checkTavily(key) {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, query: "тест", max_results: 1 }),
    });
    if (r.ok) return { ok: true };
    return { ok: false, why: r.status === 401 ? "Ключ не подошёл — проверь на app.tavily.com" : `Ответ ${r.status}` };
  } catch (e) { return { ok: false, why: `Сеть недоступна: ${e.message}` }; }
}

async function checkYouTube(key) {
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=test&maxResults=1&key=${key}`);
    if (r.ok) return { ok: true };
    return { ok: false, why: "Ключ не подошёл или для проекта не включён YouTube Data API v3." };
  } catch (e) { return { ok: false, why: `Сеть недоступна: ${e.message}` }; }
}

function checkGoogleJson(raw) {
  try {
    const j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) return { ok: false, why: "Это не файл сервисного аккаунта — нет client_email или private_key." };
    return { ok: true, name: j.client_email };
  } catch { return { ok: false, why: "Не похоже на JSON. Вставь содержимое файла целиком, одной строкой." }; }
}

// ── Шаги мастера ──────────────────────────────────────────────
// need: "must" — без него завод не поедет; "nice" — можно пропустить и настроить позже
const STEPS = [
  {
    key: "ANTHROPIC_API_KEY", need: "must", title: "Мозг завода — Claude",
    what: "Через него думают все 8 агентов. Без него завод не работает совсем.",
    where: "console.anthropic.com → API Keys → Create Key",
    money: "Платно по факту использования. Заложи 10-20$ в месяц на старте.",
    warn: "Сразу пополни счёт в разделе Plans & Billing — на пустом балансе ключ не работает.",
    check: checkAnthropic,
  },
  {
    key: "TELEGRAM_BOT_TOKEN_6", alt: "TELEGRAM_BOT_TOKEN", need: "must", title: "Главный бот — присылает тебе черновики",
    what: "Через него завод показывает готовые посты и ждёт твоего «ок».",
    where: "В Telegram найди @BotFather → /newbot → придумай имя → он выдаст токен",
    money: "Бесплатно.",
    check: checkTelegramBot,
  },
  {
    key: "TELEGRAM_APPROVAL_CHAT_ID", alt: "TELEGRAM_CHAT_ID", need: "must", title: "Чат, куда падают черновики",
    what: "Создай группу, добавь туда бота администратором. Сюда придут посты на утверждение.",
    where: "Узнать id: напиши в группе что угодно, потом открой\n      api.telegram.org/bot<ТВОЙ_ТОКЕН>/getUpdates — id группы будет в поле chat.id (с минусом)",
    money: "Бесплатно.",
    custom: async (val, env) => checkTelegramChat(env.TELEGRAM_BOT_TOKEN_6 || env.TELEGRAM_BOT_TOKEN, val, env.TELEGRAM_APPROVAL_TOPIC_ID),
  },
  {
    key: "TELEGRAM_APPROVAL_TOPIC_ID", need: "nice", title: "Тема внутри группы (если включены темы)",
    what: "Если в группе включены «Темы» — id нужной темы. Если тем нет, просто пропусти.",
    where: "Открой тему, скопируй последнее число из ссылки на сообщение",
    money: "Бесплатно.",
  },
  {
    key: "GROQ_API_KEY", need: "nice", title: "Расшифровка голосовых",
    what: "Чтобы можно было надиктовать задание голосом, а не печатать.",
    where: "console.groq.com/keys → Create API Key",
    money: "Есть бесплатный лимит, на старте хватает.",
    check: checkGroq,
  },
  {
    key: "INSTAGRAM_USERNAME", need: "nice", title: "Твой ник в Instagram",
    what: "Подставляется на слайды каруселей, обложки рилсов и в подвалы гайдов.",
    where: "Просто ник, без собачки. Например: marina.nutrition",
    money: "Бесплатно.",
  },
  {
    key: "TAVILY_API_KEY", need: "nice", title: "Поиск новостей по твоей нише",
    what: "Аналитик ищет свежие события, чтобы предлагать актуальные темы. Без него он работает по статистике и каналу.",
    where: "app.tavily.com → Sign up → API Keys",
    money: "Бесплатный тариф — 1000 запросов в месяц, этого много.",
    check: checkTavily,
  },
  {
    key: "GOOGLE_SERVICE_ACCOUNT_JSON", need: "nice", title: "Доступ к Google (для фото в каруселях)",
    what: "Завод берёт твои фото из папки на Google Диске и ставит их на обложки каруселей.",
    where: "console.cloud.google.com → создай проект → Service Accounts → создай ключ JSON.\n      Потом открой доступ к папке на Диске для почты из этого файла (client_email).\n      ⚠️ Шаг самый муторный. Можно пропустить — карусели будут без фото.",
    money: "Бесплатно.",
    custom: async (v) => checkGoogleJson(v),
    oneline: true,
  },
  {
    key: "GOOGLE_PHOTOS_FOLDER_ID", need: "nice", title: "Папка с твоими фото на Google Диске",
    what: "Оттуда берутся фото для каруселей и обложек.",
    where: "Открой папку на диске — id это последняя часть адреса после /folders/",
    money: "Бесплатно.",
  },
  {
    key: "POSTMYPOST_API_TOKEN", need: "nice", title: "Автопостинг (PostMyPost)",
    what: "Ставит готовые посты в очередь публикации. Без него ты публикуешь руками.",
    where: "postmypost.ru → подключи аккаунты → в настройках возьми API-токен",
    money: "Платный сервис, есть пробный период.",
  },
  {
    key: "POSTMYPOST_PROJECT_ID", need: "nice", title: "Номер проекта в PostMyPost",
    what: "Нужен вместе с токеном выше.",
    where: "Виден в адресе страницы проекта",
    money: "—",
  },
  {
    key: "TELEGRAM_CHANNEL_USERNAME", need: "nice", title: "Твой Telegram-канал",
    what: "Завод читает, что уже выходило, чтобы не повторять темы.",
    where: "Ник канала без собачки. Канал должен быть публичным.",
    money: "Бесплатно.",
  },
  {
    key: "YOUTUBE_API_KEY", need: "nice", title: "Тренды с YouTube",
    what: "Аналитик смотрит, какие ролики залетают в твоей нише. Полезно не всем.",
    where: "console.cloud.google.com → APIs → включи YouTube Data API v3 → создай ключ",
    money: "Бесплатно в пределах квоты.",
    check: checkYouTube,
  },
];

// ── Режим проверки: node setup.js --verify ────────────────────
// Ничего не спрашивает. Читает .env и persona.md, прогоняет живые проверки
// и печатает отчёт. Этим пользуется Claude Code, когда ведёт тебя по настройке.
async function verifyAll() {
  const env = readEnv();
  say();
  say("ПРОВЕРКА НАСТРОЙКИ");
  say(L());

  let musts = 0, mustsOk = 0, problems = [];

  for (const step of STEPS) {
    // Имя из лайт-версии тоже считается заполненным
    const val = env[step.key] || (step.alt ? env[step.alt] : "");
    const required = step.need === "must";
    if (required) musts++;

    if (!val) {
      if (required) { say(`❌ ${step.key} — не заполнено (обязательно)`); problems.push(`${step.key}: не заполнено. ${step.where}`); }
      else say(`➖ ${step.key} — пропущено (не обязательно)`);
      continue;
    }

    const checker = step.custom || step.check;
    if (!checker) { say(`✅ ${step.key} — заполнено`); if (required) mustsOk++; continue; }

    const res = await checker(val, env);
    if (res.ok) { say(`✅ ${step.key} — работает${res.name ? " (" + res.name + ")" : ""}`); if (required) mustsOk++; }
    else {
      say(`❌ ${step.key} — ${String(res.why).split("\n")[0]}`);
      problems.push(`${step.key}: ${String(res.why).replace(/\s+/g, " ").trim()}`);
    }
  }

  // persona.md
  const personaFile = path.join(__dirname, "persona.md");
  const raw = fs.existsSync(personaFile) ? fs.readFileSync(personaFile, "utf8") : "";
  const filled = raw.replace(/<!--[\s\S]*?-->/g, "").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l !== "-").join("");
  const personaOk = filled.length >= 80;
  say(personaOk ? "✅ persona.md — заполнен" : "❌ persona.md — не заполнен (без него завод не запустится)");
  if (!personaOk) problems.push("persona.md: не заполнен. Образец — persona.example.md");

  // ── Инвариант автопилота ──────────────────────────────────────
  // Утренний авто-прогон (7:30) и автопостинг — это крон внутри постоянного процесса.
  // Он живёт ТОЛЬКО на сервере 24/7. Локально (без Railway) он молчит. Не даём отчёту
  // сказать «всё готово» без этой оговорки — иначе агент повторит ложное «работает само».
  const cron = (env.DAILY_CRON_EXPR || "30 7 * * *").trim();
  const autopilotOn = !/^(off|none|disabled|-)$/i.test(cron) || !!env.POSTMYPOST_API_TOKEN;
  const onServer = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  const autopilotNeedsServer = autopilotOn && !onServer;

  say(L());
  if (problems.length === 0) {
    say("ИТОГ: для ручной работы всё готово. Можно запускать: npm run copywriter");
    if (autopilotNeedsServer) {
      say();
      hmm("Автопилот настроен, но завод запущен локально.");
      say("      Утренний авто-прогон (7:30) и автопостинг сработают ТОЛЬКО на сервере 24/7.");
      say("      На ноутбуке они молчат: нужно, чтобы завод крутился всегда, а не пока открыт терминал.");
      say("      Поставить на сервер — Шаг 7 в CLAUDE.md. До этого «само по утрам» НЕ работает.");
    }
  } else {
    say(`ИТОГ: не готово, проблем — ${problems.length}`);
    say(`Обязательных доступов рабочих: ${mustsOk} из ${musts}`);
    say();
    say("ЧТО ПОЧИНИТЬ:");
    for (const p of problems) say("• " + p);
  }
  say();
  rl.close();
  process.exit(problems.length ? 1 : 0);
}

// ── Ход мастера ───────────────────────────────────────────────
const FAILED = []; // доступы, которые записали, но они не прошли живую проверку

async function ask(step, env, idx, total) {
  say();
  say(L());
  say(`Шаг ${idx} из ${total} · ${step.title}` + (step.need === "must" ? "   [обязательно]" : "   [можно пропустить]"));
  say(L());
  say(step.what);
  say();
  say(`   Где взять: ${step.where}`);
  say(`   Деньги:    ${step.money}`);
  if (step.warn) say(`   ⚠️  ${step.warn}`);
  if (step.oneline) say("   (вставляй одной строкой, без переносов)");

  const existing = env[step.key] || (step.alt ? env[step.alt] : "");
  if (existing) say(`\n   Сейчас записано: ${String(existing).slice(0, 14)}…`);

  let emptyTries = 0;
  while (true) {
    const hint = step.need === "must" ? "вставь значение" : "вставь значение или нажми Enter, чтобы пропустить";
    const raw = await question(`\n   ${hint}: `);
    if (raw === null) { hmm("ввод закончился — остальное настроишь позже в .env"); return existing || ""; }
    const val = String(raw).trim();

    if (!val) {
      if (existing) { ok("оставляю как было"); return existing; }
      if (step.need === "must") {
        // Три пустых подряд — значит человек не готов (или ввода нет вообще). Не зацикливаемся.
        if (++emptyTries >= 3) {
          hmm("пропускаю этот шаг — вернёшься к нему позже: node setup.js");
          return "";
        }
        bad("без этого завод не запустится, давай заполним");
        continue;
      }
      hmm("пропущено — настроишь позже, просто впиши в файл .env");
      return "";
    }
    emptyTries = 0;

    const checker = step.custom || step.check;
    if (!checker) { ok("записал"); return val; }

    say("   ⏳ проверяю…");
    const res = await checker(val, env);
    if (res.ok) { ok(`работает${res.name ? " — " + res.name : ""}`); return val; }

    bad(res.why);
    const again = String((await question("   Попробовать ещё раз? (да / пропустить): ")) ?? "").trim().toLowerCase();
    if (again.startsWith("п") || again.startsWith("н")) {
      // Сохраняем как есть, чтобы человек поправил вручную, но помним: проверку не прошло
      FAILED.push(step);
      hmm(step.need === "must"
        ? "записал, но это обязательный доступ — пока он не заработает, завод не поедет"
        : "записал, но проверку он не прошёл — вернись к нему позже");
      return val;
    }
  }
}

async function main() {
  // Проверка без вопросов — этим режимом пользуется Claude Code
  if (process.argv.includes("--verify")) return verifyAll();

  say();
  say("╔" + "═".repeat(58) + "╗");
  say("║" + "  МАСТЕР НАСТРОЙКИ КОНТЕНТ-ЗАВОДА".padEnd(58) + "║");
  say("╚" + "═".repeat(58) + "╝");
  say();
  say("Проведу по всем доступам и проверю каждый прямо здесь.");
  say("Обязательных — три, остальное можно пропустить и добавить позже.");
  say("Ничего никуда не отправляется: всё пишется в файл .env рядом.");
  say();
  await question("Нажми Enter, чтобы начать: ");

  const env = readEnv();
  let i = 0;
  for (const step of STEPS) {
    i++;
    env[step.key] = await ask(step, env, i, STEPS.length);
    writeEnv(env); // сохраняем после каждого шага — прервёшься, ничего не потеряешь
  }

  // Значения по умолчанию, о которых спрашивать незачем
  env.TZ ||= "Europe/Moscow";
  env.DAILY_CRON_EXPR ||= "30 7 * * *";
  writeEnv(env);

  // ── Проверка persona.md ──
  say();
  say(L());
  say("Последнее: голос автора");
  say(L());
  const personaFile = path.join(__dirname, "persona.md");
  const raw = fs.existsSync(personaFile) ? fs.readFileSync(personaFile, "utf8") : "";
  const filled = raw.replace(/<!--[\s\S]*?-->/g, "").split("\n")
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l !== "-").join("");
  if (filled.length < 80) {
    hmm("Файл persona.md ещё не заполнен.");
    say("      Без него агенты не знают, от чьего лица писать, и завод не стартует.");
    say("      Открой persona.md и расскажи о себе: кто ты, для кого пишешь, как звучишь.");
    say("      Рядом лежит заполненный образец — persona.example.md");
  } else {
    ok("persona.md заполнен");
  }

  say();
  say(L());
  say("Готово. Настройки сохранены в файл .env");
  say(L());
  const musts = STEPS.filter((s) => s.need === "must" && !env[s.key]);
  if (musts.length) {
    hmm(`Не заполнено обязательное: ${musts.map((s) => s.title).join(", ")}`);
  }
  if (FAILED.length) {
    say();
    hmm("Записаны, но проверку НЕ прошли:");
    for (const s of FAILED) {
      say(`      • ${s.title}${s.need === "must" ? "  ← без него завод не запустится" : ""}`);
      say(`        где взять: ${String(s.where).split("\n")[0]}`);
    }
  }
  if (musts.length || FAILED.length) {
    say();
    say("   Когда разберёшься с этим — запусти мастер ещё раз: node setup.js");
    say("   Он не спросит заново то, что уже работает.");
  }
  say();
  say("Что дальше:");
  say("   1. npm install            — поставить всё нужное (один раз)");
  say("   2. npm run review-test    — быстрая проверка, что всё живое");
  say("   3. npm run copywriter     — первый пост, придёт тебе в Telegram");
  say();
  say("Подробности — в файле README.md. Если застрял — ДОСТУПЫ.md");
  say();
  rl.close();
}

main().catch((e) => { console.error("\nМастер упал:", e.message); rl.close(); process.exit(1); });
