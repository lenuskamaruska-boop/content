// =============================================================
// Этот завод не заменяет автора. Агенты генерируют идеи и
// черновики — она добавляет живой контекст, правит голос и
// принимает финальное решение что публиковать. Без её участия
// теряется всё живое.
// =============================================================

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const dotenv = _require("dotenv");
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

import Anthropic from "@anthropic-ai/sdk";
import { OpenAI } from "openai";
import { google } from "googleapis";
import puppeteer from "puppeteer";
import cron from "node-cron";
import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";

const STATE_DIR = path.join(__dirname, "state");

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

// Агенты работают без диалога одобрения: генерируют и сразу отправляют.
// Ок/переделай/стоп больше не нужны — команды управления идут через голосовой.
const AUTONOMOUS = true;

const MUTED = false;

// Система одобрения
// Старые имена из лайт-версии тоже понимаем — чтобы .env переехал без правок
const APPROVAL_TOKEN    = process.env.TELEGRAM_BOT_TOKEN_6 || process.env.TELEGRAM_BOT_TOKEN;
const APPROVAL_CHAT_ID  = process.env.TELEGRAM_APPROVAL_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const APPROVAL_TOPIC_ID = process.env.TELEGRAM_APPROVAL_TOPIC_ID
  ? Number(process.env.TELEGRAM_APPROVAL_TOPIC_ID)
  : null;
// Тема "рассуждений": свободный диалог с Аналитиком по статистике, с памятью.
const BRAINSTORM_TOPIC_ID = process.env.TELEGRAM_BRAINSTORM_TOPIC_ID
  ? Number(process.env.TELEGRAM_BRAINSTORM_TOPIC_ID)
  : null;
const MAIN_CHANNEL_ID   = process.env.TELEGRAM_MAIN_CHANNEL_ID;
const MAX_RETRIES       = 3;
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Общий стоп-лист для ВСЕХ агентов: девизы из старых постов и нейронный пафос.
// Вшивается в VOICE, копирайтера и хуманайзер — голос один на весь завод.
const BANNED_MOTTOS = `ЗАПРЕЩЕНО — девизы и мотивационные афоризмы дословно и в перефразе. От повторения они звучат как робот. Свои стоп-фразы добавь в persona.md, раздел «Запрещённые фразы».
Также запрещён нейронный пафос: «это меняет правила игры», «будущее уже здесь», «в эпоху ИИ», «представьте себе мир», «настоящий прорыв», «пока все спят», «99% людей не знают».
Вместо девиза или пафоса — конкретный пример, цифра или честное наблюдение.`;

// Фактчек для ВСЕХ агентов: никакой выдуманной жизни автора и постановочных сценок.
const FACT_GUARD = `ФАКТЫ — ЖЕЛЕЗНОЕ ПРАВИЛО. Личный опыт от первого лица бери ТОЛЬКО из данных в контексте: реальные посты автора, статистика, задание, копилка идей. НИКОГДА не выдумывай события его жизни: верификации, документы, оплаты, покупки, клиентов, сделки, поездки, разговоры, «сегодня проверил/попробовал». Этого НЕ БЫЛО, если этого нет в контексте. Нет фактуры — пиши наблюдение, мнение или вопрос, без личной истории.
БЕЗ ПОСТАНОВОЧНЫХ СЦЕНОК внутреннего монолога: «первая мысль была», «ну вот, опять», «когда я это увидел», «поймал себя на мысли», «и тут я понял». Суть вместо изображённой реакции.`;

// Голос автора — из persona.md. Это единственный файл, который надо заполнить
// про себя: кто ты, ниша, как звучишь. Пример заполнения — persona.example.md.
const PERSONA_FILE = path.join(__dirname, "persona.md");
function loadPersona() {
  let raw = "";
  try { raw = readFileSync(PERSONA_FILE, "utf8"); } catch {}
  // Подсказки в <!-- --> — для человека, в промпт они попасть не должны
  const clean = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  // Заполнен ли файл: считаем только строки, которые не заголовки и не пустые пункты
  const filled = clean.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l !== "-")
    .join("\n");
  if (filled.length < 80) {
    // Без стектрейса: человек, который это увидит, не программист
    console.error("\n" + "─".repeat(58));
    console.error("⚠️  Не заполнен persona.md");
    console.error("─".repeat(58));
    console.error("Агенты не знают, от чьего лица писать.\n");
    console.error("Что сделать: открой файл persona.md и расскажи о себе —");
    console.error("кто ты, для кого пишешь, как звучишь.\n");
    console.error("Рядом лежит готовый образец: persona.example.md");
    console.error("Открой его и заполни свой по тому же принципу.");
    console.error("─".repeat(58) + "\n");
    process.exit(1);
  }
  return clean;
}

const VOICE = `${loadPersona()}

${BANNED_MOTTOS}

${FACT_GUARD}`;

// Промпты агентов лежат в prompts/*.md — правь их под свою нишу, код не трогай.
// {{ГОЛОС}} подставится из persona.md, {{ЗАПРЕТЫ}} и {{ФАКТЫ}} — общие правила.
function loadPrompt(name) {
  const file = path.join(__dirname, "prompts", name + ".md");
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch { throw new Error(`Нет файла промпта prompts/${name}.md — восстанови его из архива.`); }
  return text
    .replaceAll("{{ГОЛОС}}", VOICE)
    .replaceAll("{{ЗАПРЕТЫ}}", BANNED_MOTTOS)
    .replaceAll("{{ФАКТЫ}}", FACT_GUARD);
}

// Сколько слайдов просила автор — из прямого задания: "карусель из 3 слайдов",
// "3х слайдов", "трёх слайдов". Считаем только для прямых заданий (не для планов
// из таблицы/аналитики), null = число не задано.
const SLIDE_COUNT_WORDS = {
  один: 1, одного: 1, два: 2, двух: 2, три: 3, трёх: 3, трех: 3,
  четыре: 4, четырёх: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6, шести: 6,
  семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10,
};
function requestedSlideCount(brief) {
  const raw = String(brief || "");
  if (!/ИДЕЯ ОТ АВТОРА|ГОЛОСОВАЯ ИДЕЯ/i.test(raw)) return null;
  const t = raw.toLowerCase();
  // «1 слайд: текст» / «слайд 1: текст» — разметка готовых текстов, не запрос
  // числа. Маркер бывает и БЕЗ двоеточия, отдельной строкой («1 слайд⏎Настрой
  // Claude...») — иначе валидатор требовал «ровно 1 слайд» и резал карусель.
  // Несколько номеров = карусель до максимального; один номер (обычно
  // обложка) = число не фиксируем, мейкер достроит остальное по каркасу.
  const labelRe = /(?:(\d{1,2})\s*-?\s*й?\s*слайд|слайд\s*(\d{1,2}))\s*:|(?:^|\n)[ \t]*(?:(\d{1,2})[ \t]*-?[ \t]*й?[ \t]*слайд|слайд[ \t]*(\d{1,2}))[ \t]*\.?[ \t]*(?=\r?\n|$)/g;
  const labels = [...t.matchAll(labelRe)]
    .map((m) => parseInt(m[1] || m[2] || m[3] || m[4], 10))
    .filter((n) => n >= 1 && n <= 10);
  const stripped = t.replace(labelRe, " ");
  const digits = stripped.match(/(\d{1,2})\s*-?\s*х?\s*слайд/);
  if (digits) {
    const n = parseInt(digits[1], 10);
    if (n >= 1 && n <= 10) return n;
  }
  const words = stripped.match(new RegExp(`(${Object.keys(SLIDE_COUNT_WORDS).join("|")})\\s+слайд`));
  if (words) return SLIDE_COUNT_WORDS[words[1]];
  return labels.length > 1 ? Math.max(...labels) : null;
}

const AGENTS = {
  analyst: {
    name: "Аналитик",
    token: process.env.TELEGRAM_BOT_TOKEN_1,
    dialogue: true,   // диалоговый режим одобрения
    system: loadPrompt("аналитик"),
    userPrompt: async () => {
      console.log("  [Аналитик] собираю данные: Anthropic + Tavily + YouTube + план + статистика + канал + идеи + копилка + PostMyPost + аналитика постов PMP...");
      const [anthropicNews, trendContext, ytContext, accountStats, upcomingPlan, channelData, strategyIdeas, ideaBank, planOverview, todayScheduled, pmpAnalytics] = await Promise.all([
        fetchAnthropicNews().catch((e) => { console.warn("  [Anthropic] ошибка:", e.message); return ""; }),
        fetchTrendContext().catch((e) => { console.warn("  [Tavily] ошибка:", e.message); return ""; }),
        fetchYouTubeTrends().catch((e) => { console.warn("  [YouTube] ошибка:", e.message); return ""; }),
        readAccountAnalysis().catch((e) => { console.warn("  [Статистика-аккаунта] ошибка:", e.message); return ""; }),
        readContentPlan("upcoming").catch((e) => { console.warn("  [Sheets] ошибка:", e.message); return []; }),
        readChannelData().catch((e) => { console.warn("  [Channel] ошибка:", e.message); return ""; }),
        readStrategyIdeas().catch((e) => { console.warn("  [Идеи] ошибка:", e.message); return ""; }),
        readIdeaBank().catch((e) => { console.warn("  [Копилка] ошибка:", e.message); return ""; }),
        readContentPlanOverview().catch((e) => { console.warn("  [План-обзор] ошибка:", e.message); return ""; }),
        fetchTodayScheduled().catch((e) => { console.warn("  [PMP-today] ошибка:", e.message); return ""; }),
        fetchPostMyPostAnalytics(30).catch((e) => { console.warn("  [PMP-analytics] ошибка:", e.message); return ""; }),
      ]);
      const recent = await loadRecentAnalyst().catch(() => []);
      console.log("  [Аналитик] данные собраны, генерирую...");

      const recentBlock = recent.length
        ? `\n\nТЫ УЖЕ ПРЕДЛАГАЛ ЭТИ ТЕМЫ ЗА ПОСЛЕДНИЕ ДНИ — НЕ ПОВТОРЯЙ ИХ, дай ДРУГИЕ темы или принципиально новый угол:\n` +
          recent.map((r) => `[${r.date}]\n${r.text}`).join("\n\n")
        : "";

      const ytBlock = ytContext
        ? `\n\nЧто залетает на YouTube по нише (свежее за 3 дня — то что взлетело там, скоро заберут в рилсы):\n\n${ytContext}`
        : "";
      const accountStatsBlock = accountStats ? `\n\n${accountStats}` : "";
      const planBlock = upcomingPlan.length > 0
        ? `\n\nКонтент-план автора на ближайшие дни (из Google Sheets — не дублируй эти темы):\n\n` +
          upcomingPlan.map((r) => `— ${r.date} | ${r.platform} | ${r.format} | ${r.topic}`).join("\n")
        : "\n\nКонтент-план из Google Sheets: на ближайшие дни записей нет.";
      const channelBlock = channelData
        ? `\n\nДанные из Telegram-канала автора (не повторяй темы которые уже выходили, учитывай вопросы подписчиков):\n\n${channelData}`
        : "";
      const ideasBlock = strategyIdeas
        ? `\n\nСтратегия и банк из 100 идей автора (готовые темы по пилларам — можешь брать отсюда то что ещё не выходило, адаптируя под свежий новостной повод):\n\n${strategyIdeas.slice(0, 26000)}`
        : "";
      const bankBlock = ideaBank
        ? `\n\n${ideaBank}`
        : "";
      const planOverviewBlock = planOverview
        ? `\n\nКонтент-план на период (уже расписано по дням — НЕ предлагай темы которые тут есть, дополняй свежими новостными поводами):\n\n${planOverview}`
        : "";
      const anthropicBlock = anthropicNews
        ? `\n\nОфициальные новости Anthropic (anthropic.com/news — свежие анонсы Claude, фичи, релизы; отличный повод для контента в нише автора):\n${anthropicNews}`
        : "";
      const scheduledBlock = todayScheduled
        ? `\n\n${todayScheduled} (эти темы уже в очереди — не дублируй)`
        : "";
      const pmpAnalyticsBlock = pmpAnalytics ? `\n\n${pmpAnalytics}` : "";

      const d = new Date();
      const dateStr = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", weekday: "long" });

      return `Сегодня ${dateStr}.

Свежие данные из поиска по нише ИИ/нейросетей:

${pmpAnalyticsBlock}${trendContext}${anthropicBlock}${ytBlock}${accountStatsBlock}${planBlock}${planOverviewBlock}${scheduledBlock}${channelBlock}${ideasBlock}${bankBlock}${recentBlock}

На основе этих данных сформируй топ-3 темы в указанном формате. ГЛАВНАЯ ОПОРА — СВЕЖАЯ АНАЛИТИКА ПОСТОВ ИЗ POSTMYPOST (реальные просмотры, охваты и ER вышедших постов за последние дни) и статистика аккаунта: отталкивайся от того, что реально зашло аудитории по цифрам, и развивай это свежим углом.

ВАЖНО ПРО РАЗНООБРАЗИЕ: НЕ предлагай темы, которые уже были за последние дни (см. блок «ТЫ УЖЕ ПРЕДЛАГАЛ»). Каждый день — свежие темы или принципиально новый угол. Темы должны идти из РАЗНЫХ источников, из разных мест: что зашло по цифрам, частые вопросы подписчиков канале автора, что взлетает на YouTube в твоей нише, события из поиска, кейсы и связки инструментов. Официальные новости сервисов — ОДИН из источников, а не главный каждый день; бери оттуда повод, только если он реально свежий и сильный, не повторяй один и тот же анонс изо дня в день.

Частые вопросы из комментариев канале автора — готовые темы, закрывай их. Свежие идеи из копилки автора можешь учесть, но копилка идей и стратегия — только справка, не вытаскивай темы оттуда механически. НЕ предлагай то что уже выходило — либо новый угол (адаптация), либо смежная тема. Не предлагай готовые посты. Не задавай вопросов.`;
    },
    inputs: [],
  },
  manager: {
    name: "Контент-менеджер",
    token: process.env.TELEGRAM_BOT_TOKEN_2,
    system: loadPrompt("контент-менеджер"),
    userPrompt: async (state) => {
      console.log("  [Контент-менеджер] читаю Google Sheets + историю канала...");
      const [plan, channelData] = await Promise.all([
        readContentPlan(),
        readChannelData().catch(() => ""),
      ]);

      // Что уже выходило — для проверки на повтор
      const publishedBlock = channelData
        ? `\n\nУЖЕ ВЫХОДИЛО в канале автора (сверься, не повторяй один в один — адаптируй или бери свежий угол):\n\n${channelData}\n`
        : "";

      // Прямой запрос автора ПЕРЕБИВАЕТ таблицу: работаем строго по нему.
      const isDirectRequest = /ИДЕЯ ОТ АВТОРА|ГОЛОСОВАЯ ИДЕЯ/i.test(state.analyst || "");
      if (isDirectRequest) {
        console.log("  [Контент-менеджер] прямой запрос автора — игнорирую таблицу, работаю по нему");
        return (
          `Прямое задание от автора — работай СТРОГО по нему:\n\n${state.analyst}\n` +
          publishedBlock +
          `\nНЕ бери темы из Google Sheets. Это конкретный запрос автора. ` +
          `Сделай план ТОЛЬКО под то что она просит: те платформы и форматы которые она назвала, ничего лишнего. ` +
          `Если она просит только карусель — только карусель, один план, без других платформ. ` +
          `Если тема пересекается с уже вышедшим — пометь АДАПТАЦИЯ и дай свежий угол. ` +
          `Чистый текст, голос автора.`
        );
      }

      if (plan.length > 0) {
        // Таблица задаёт план — агент работает по нему
        const planLines = plan.map((r) => `— ${r.platform} | ${r.format} | ${r.topic}`).join("\n");
        console.log(`  [Sheets] план на сегодня:\n${planLines}`);
        return (
          `Вот план на сегодня из Google Sheets (это задание от автора — использовать именно эти темы):\n\n` +
          planLines +
          `\n\nВот аналитика трендов для контекста:\n\n${state.analyst}\n` +
          publishedBlock +
          `\nДля каждой темы из таблицы составь задание: угол подачи, хук, ключевая мысль. ` +
          `Не придумывай новые темы — работай с теми что в таблице. ` +
          `Если тема пересекается с уже вышедшим постом — пометь АДАПТАЦИЯ и дай свежий угол. ` +
          `Никаких отсылок между платформами. Чистый текст, голос автора.`
        );
      }

      // Таблица пустая — план из аналитики
      console.log("  [Sheets] записей на сегодня нет — план из аналитики");
      return (
        `Вот горячие темы от аналитика:\n\n${state.analyst}\n` +
        publishedBlock +
        `\n(Таблица контент-плана пуста на сегодня — составь план из аналитики.)\n\n` +
        `Составь контент-план: 1 пост в Telegram, 1 карусель в Instagram, 1 Reels в Instagram, 1 пост в Threads. ` +
        `Для каждого — тема, угол подачи, почему эта платформа, и пометка НОВАЯ или АДАПТАЦИЯ. ` +
        `Если тема уже выходила — не повторяй, дай свежий угол или замени смежной. ` +
        `Никаких отсылок между платформами. Чистый текст, голос автора.`
      );
    },
    inputs: ["analyst"],
  },
  copywriter: {
    name: "Копирайтер",
    token: process.env.TELEGRAM_BOT_TOKEN_3,
    humanize: true,
    system: loadPrompt("копирайтер"),
    userPrompt: async (state) => {
      const [samples, hooks, recent] = await Promise.all([
        readVoiceSamples().catch(() => ""),
        topHooksBlock().catch(() => ""),
        loadRecentCopy().catch(() => []),
      ]);
      const samplesBlock = samples
        ? `\n\nЭталонные посты автора — пиши ТАК ЖЕ по тону, ритму, подаче (не копируй темы, копируй голос):\n\n${samples}`
        : "";
      const recentBlock = recent.length
        ? `\n\nТВОИ ПОСЛЕДНИЕ ПОСТЫ — не повторяй ни их тему, ни их форму (если вчера был мини-гайд, сегодня возьми другую форму):\n\n` +
          recent.map((r) => `[${r.date}]\n${r.text}`).join("\n\n---\n\n")
        : "";
      return `Контент-план:\n\n${state.manager}${samplesBlock}${hooks}${recentBlock}\n\nНапиши пост для Telegram по теме поста из плана. Сначала выбери ФОРМУ поста под тему (из шести в правилах), не соскальзывай в вечное «хук + мысль + вопрос». Голос автора как в образцах: живой, разговорный, с личными деталями. Хук в первой строке — не "Привет" и не "Сегодня я расскажу". Первое слово не "я". Чистый текст без markdown.`;
    },
    inputs: ["manager"],
  },
  carousel: {
    name: "Карусель-мейкер",
    token: process.env.TELEGRAM_BOT_TOKEN_4,
    generateImages: true,
    system: loadPrompt("карусель-мейкер"),
    userPrompt: async (state) => {
      // Прямое задание автора идёт мейкеру целиком: число слайдов и готовые
      // тексты нельзя терять, даже если менеджер не перенёс их в план.
      const direct = /ИДЕЯ ОТ АВТОРА|ГОЛОСОВАЯ ИДЕЯ/i.test(state.analyst || "")
        ? `\n\nИсходное задание автора — его параметры ВАЖНЕЕ плана (число слайдов, готовые тексты, кодовое слово):\n${state.analyst}`
        : "";
      const hooks = await topHooksBlock().catch(() => "");
      const want = requestedSlideCount(state.analyst);
      const countLine = want
        ? `автор просила РОВНО ${want} слайдов — сделай ровно ${want}, ни больше ни меньше.`
        : `Разметка «N слайд: текст» в задании — это готовый текст конкретного слайда (переноси дословно), НЕ число слайдов. Если явно указано число («карусель из 5 слайдов») — ровно столько; если нет — выбери каркас (А/Б/В/Г) под тему и следуй ему.`;
      return `Контент-план:\n\n${state.manager}${direct}${hooks}\n\nСделай карусель для Instagram по теме карусели из плана. Если автор дала готовые тексты слайдов — переноси ДОСЛОВНО. ${countLine} Выдай СТРОГО в формате: СЛАЙД N / Тип / Лейбл / Заголовок / Выделить / Подзаголовок. Голос автора. После слайдов — блок INSTAGRAM CAPTION: как указано выше.`;
    },
    inputs: ["manager", "analyst"],
    // Проверка после генерации: число слайдов сошлось с заданием? Нет — авторетрай.
    validate: (output, state) => {
      const want = requestedSlideCount(state.analyst);
      if (!want) return null;
      const got = parseCarouselSlides(extractCarouselCaption(output).slides).length;
      if (got === want) return null;
      return `Ты сделал ${got} слайдов, а автор просила РОВНО ${want}. Переделай: ровно ${want} слайдов` +
        (want >= 2 ? `, первый — обложка с хуком, последний — CTA с кодовым словом, в середине только самое важное.` : ` (только обложка).`);
    },
  },
  reels: {
    name: "Рилс-мейкер",
    token: process.env.TELEGRAM_BOT_TOKEN_5,
    system: loadPrompt("рилс-мейкер"),
    userPrompt: (state) =>
      `Контент-план:\n\n${state.manager}\n\nНапиши скрипт Reels до 30 секунд по теме Reels из плана. Структура: ХУК 0-3с / ПРОБЛЕМА 3-7с / РЕШЕНИЕ 7-25с / CTA 25-30с. После скрипта — субтитры и caption с хэштегами. Голос автора, никакого markdown.`,
    inputs: ["manager"],
  },
};

async function ensureStateDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function readState(key) {
  const file = path.join(STATE_DIR, `${key}.txt`);
  return fs.readFile(file, "utf8").catch(() => "");
}

async function writeState(key, value) {
  // Папка создаётся здесь же — на свежем сервере её может не быть,
  // а writeState вызывается и до первого runAgent (prepare-хук очереди)
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(path.join(STATE_DIR, `${key}.txt`), value, "utf8");
}

// История тем аналитика (последние 7 прогонов) — чтобы не повторял одно и то же.
const RECENT_ANALYST_FILE = path.join(STATE_DIR, "recent_analyst.json");
async function loadRecentAnalyst() {
  try { return JSON.parse(await fs.readFile(RECENT_ANALYST_FILE, "utf8")); } catch { return []; }
}
async function pushRecentAnalyst(text) {
  const arr = await loadRecentAnalyst();
  const today = new Date().toISOString().slice(0, 10);
  arr.push({ date: today, text: String(text || "").slice(0, 1400) });
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(RECENT_ANALYST_FILE, JSON.stringify(arr.slice(-7)), "utf8");
}

// Последняя сводка аналитика — чтобы «раскрой тему 2» после утренней сводки
// понимала о какой теме речь. Отдельный файл: state/analyst.txt перезаписывается
// каждым новым заданием, а сводка должна жить до следующего прогона аналитика.
const ANALYST_SUMMARY_FILE = path.join(STATE_DIR, "analyst_summary.json");
async function saveAnalystSummary(text) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(ANALYST_SUMMARY_FILE,
    JSON.stringify({ ts: Date.now(), text: String(text || "") }), "utf8");
}
async function loadAnalystSummary() {
  try { return JSON.parse(await fs.readFile(ANALYST_SUMMARY_FILE, "utf8")); } catch { return null; }
}

// Память копирайтера: последние 7 его постов — чтобы не повторял ни тему, ни форму.
const RECENT_COPY_FILE = path.join(STATE_DIR, "recent_copywriter.json");
async function loadRecentCopy() {
  try { return JSON.parse(await fs.readFile(RECENT_COPY_FILE, "utf8")); } catch { return []; }
}
async function pushRecentCopy(text) {
  const arr = await loadRecentCopy();
  arr.push({ date: new Date().toISOString().slice(0, 10), text: String(text || "").slice(0, 600) });
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(RECENT_COPY_FILE, JSON.stringify(arr.slice(-7)), "utf8");
}

// Реальные заголовки топ-постов из свежей выгрузки — эталон хуков для агентов.
async function topHooksBlock() {
  try {
    const s = JSON.parse(await fs.readFile(path.join(__dirname, "account-analysis", "_summary.json"), "utf8"));
    const hooks = (s.top10 || []).slice(0, 6)
      .map((t) => `«${t[0]}» (${Math.round(Number(t[2]) / 1000)}k просм.)`).join(", ");
    return hooks
      ? `\n\nЭталонные хуки — реальные заголовки её топ-постов, по ним видно что цепляет её аудиторию: ${hooks}. Пиши хук такой же прямоты и конкретики, не выпендривайся абстракциями.`
      : "";
  } catch { return ""; }
}

// Убирает «битые» одиночные суррогаты (остаются когда .slice() режет эмодзи
// посередине суррогатной пары) — иначе Anthropic API ругается на невалидный JSON.
function cleanText(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "") // high без low
    .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "$1"); // low без high
}

async function callClaude(system, user, maxTokens = MAX_TOKENS) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: cleanText(system),
    messages: [{ role: "user", content: cleanText(user) }],
  });
  if (res.stop_reason === "max_tokens") {
    console.warn(`  [Claude] ответ ОБРЕЗАН по лимиту ${maxTokens} токенов — конец потерян!`);
  }
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// Разбирает ВИЗУАЛ присланного референса (фото) через зрение Claude —
// возвращает описание оформления, чтобы повторить его в слайде.
const REFERENCE_STYLE_PROMPT = `Перед тобой картинка-референс слайда. Опиши ТОЛЬКО оформление (не содержание текста), чтобы дизайнер мог повторить визуал в HTML:
— композиция и выравнивание (где заголовок, текст; слева/центр/низ; заполняет ли весь слайд)
— иерархия: что крупное, что мелкое, соотношение размеров
— как выделен акцент (плашка, цвет, жирность, подчёркивание)
— фон светлый или тёмный, есть ли фото/изображение и где
— отступы, плотность, нумерация, разделители, подзаголовки
Кратко, по пунктам, конкретно про вёрстку. Без воды.`;

async function describeReferenceStyle(base64, mime) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
        { type: "text", text: REFERENCE_STYLE_PROMPT },
      ],
    }],
  });
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// ─────────────────────────────────────────────────────────────
// ГОЛОСОВОЙ ЧАТ — расшифровка через OpenAI Whisper
// ─────────────────────────────────────────────────────────────

// Все запросы к Telegram — только через tgFetch. У голого fetch нет таймаута:
// повисшее соединение Railway→Telegram 17 июля заморозило отправку карусели,
// CHAIN_BUSY не снялся и завод молчал на все сообщения. 45с хватает на любой
// обычный вызов; аплоады и long-poll передают свой timeoutMs.
function tgFetch(url, options = {}, timeoutMs = 45_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

// Скачивает файл из Telegram, сохраняет во временный файл
async function downloadTelegramFile(fileId) {
  const infoRes = await tgFetch(
    `https://api.telegram.org/bot${APPROVAL_TOKEN}/getFile?file_id=${fileId}`
  );
  const info = await infoRes.json();
  const filePath = info.result?.file_path;
  if (!filePath) throw new Error(`Не могу получить путь к файлу ${fileId}`);

  console.log(`  [Voice] скачиваю: ${filePath}`);
  const fileRes = await tgFetch(
    `https://api.telegram.org/file/bot${APPROVAL_TOKEN}/${filePath}`,
    {}, 180_000 // видео до 20 МБ качается дольше обычного вызова
  );
  const buf = Buffer.from(await fileRes.arrayBuffer());

  // Telegram голосовые приходят как .oga (OGG Opus) — Whisper принимает его как .ogg
  const ext = filePath.split(".").pop()?.replace("oga", "ogg") || "ogg";
  const tmpPath = path.join(__dirname, "state", `voice_tmp.${ext}`);
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  await fs.writeFile(tmpPath, buf);
  console.log(`  [Voice] сохранено: ${tmpPath} (${buf.length} байт)`);

  return { tmpPath, extension: ext };
}

// Расшифровывает аудио через OpenAI Whisper
async function transcribeAudio(tmpPath, extension = "ogg") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY не задан — голос не расшифровать. Возьми ключ на console.groq.com/keys");

  // Groq говорит на языке OpenAI SDK — меняется только baseURL и модель.
  const groq = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  const { createReadStream } = await import("node:fs");
  const stream = createReadStream(tmpPath);

  console.log(`  [Voice] отправляю в Whisper через Groq (${extension})...`);
  const result = await groq.audio.transcriptions.create({
    file:     stream,
    model:    "whisper-large-v3",
    language: "ru",
  });

  // Удаляем временный файл
  await fs.unlink(tmpPath).catch(() => {});
  return result.text.trim();
}

// Многоходовой диалог — принимает полный массив messages
async function callClaudeMessages(system, messages) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: cleanText(system),
    messages: messages.map((m) => ({
      ...m,
      content: typeof m.content === "string" ? cleanText(m.content) : m.content,
    })),
  });
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

const HUMANIZER_SYSTEM = `Ты редактор. Получаешь черновик поста от лица автора и убираешь признаки AI-генерации, сохраняя её голос.

Убирай:
- "вот честно", "клянусь", "буквально" — не её слова
- Корпоративный язык: "реализовать", "в рамках", "данный", "осуществлять", "ключевой", "важно отметить"
- Длинные вводные конструкции перед главной мыслью
- Правило трёх — перечисления ради красоты без смысла
- Пассивный залог там где можно сказать активно
- Пафосные выводы без конкретики
- Слова-паразиты AI: "важно", "уникальный", "невероятный", "трансформирует", "подчёркивает"
- Сервильные концовки ("надеюсь помогло", "если есть вопросы")
- Девизы-афоризмы из её старых постов, дословно и в перефразе: "нет чуда — только действия", "начать не страшно, страшно не попробовать", "секрет в дисциплине", "переступая через себя". Замени на конкретный пример или цифру, либо просто убери
- Постановочные сценки: "первая мысль была", "ну вот, опять", "когда я это проверила", "поймала себя на мысли" — убирай, оставляй суть
- Выдуманные личные факты: если пост утверждает верификации, документы, оплаты, клиентов, аутсорс или "сегодня попробовала" с конкретикой, которой нет в черновике-источнике — перепиши в наблюдение или мнение без личной истории

Сохраняй:
- Тире для пауз — это стиль автора, не трогай
- Скобки для иронии)
- Эмодзи в конце абзаца
- Личный опыт и конкретные детали
- Короткие предложения. Иногда совсем короткие.
- Нумерованные списки когда нужны
- Вопрос или тихий вывод в конце

Верни только финальный текст поста. Без комментариев, без объяснений, без markdown.`;

async function callHumanizer(text) {
  return callClaude(HUMANIZER_SYSTEM, `Сделай этот пост живее, убери AI-клише:\n\n${text}`);
}

// ─────────────────────────────────────────────────────────────
// Google Sheets — читает контент-план
// Колонки ищутся по заголовкам: Дата | Тема | Формат | Платформа | Статус
// mode "today"    — строки на сегодня (для контент-менеджера)
// mode "upcoming" — сегодня и будущее (контекст для аналитика)
// ─────────────────────────────────────────────────────────────
async function readContentPlan(mode = "today") {
  const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetsId          = process.env.GOOGLE_SHEETS_ID;

  if (!serviceAccountRaw || !sheetsId) {
    console.log("  [Sheets] переменные не заданы — пропускаю чтение таблицы");
    return [];
  }

  let credentials;
  try {
    credentials = JSON.parse(serviceAccountRaw);
  } catch (e) {
    console.error("  [Sheets] GOOGLE_SERVICE_ACCOUNT_JSON: невалидный JSON —", e.message);
    return [];
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetsId,
      range: "A:J",
    });
    rows = res.data.values || [];
  } catch (e) {
    console.error("  [Sheets] ошибка чтения таблицы:", e.message);
    return [];
  }

  if (rows.length < 2) {
    console.warn("  [Sheets] таблица пустая или только заголовок");
    return [];
  }

  // Парсим заголовки гибко — регистр и пробелы не важны
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => headers.indexOf(name.toLowerCase());
  const idx = {
    date:     col("Дата"),
    topic:    col("Тема"),
    format:   col("Формат"),
    platform: col("Платформа"),
    status:   col("Статус"),
  };
  console.log(`  [Sheets] заголовки: [${rows[0].join(", ")}]`);

  const missing = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length) console.warn(`  [Sheets] колонки не найдены: ${missing.join(", ")}`);

  // Парсер дат: DD.MM.YYYY | YYYY-MM-DD | "2 июн." | "3 июня" | "31 мая"
  const RU_MONTHS = {
    янв: 1, фев: 2, мар: 3, апр: 4,
    май: 5, мая: 5,
    июн: 6, июня: 6,
    июл: 7, июля: 7,
    авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
  };

  function parseSheetDate(str) {
    if (!str) return null;
    str = str.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(str + "T00:00:00");
    const dmy = str.match(/^(\d{1,2})\.(\d{2})\.(\d{4})$/);
    if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
    const ru = str.match(/^(\d{1,2})\s+([а-яёА-ЯЁ]+)\.?$/);
    if (ru) {
      const month = RU_MONTHS[ru[2].toLowerCase()];
      if (month) return new Date(new Date().getFullYear(), month - 1, +ru[1]);
    }
    return null;
  }

  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const dataRows  = rows.slice(1);
  const hasStatus = idx.status !== -1;

  const matched = dataRows.filter((row) => {
    const parsed = parseSheetDate((row[idx.date] || "").trim());
    if (!parsed) return false;
    const dateOk = mode === "upcoming"
      ? parsed.getTime() >= today.getTime()
      : parsed.getTime() === today.getTime();
    if (!dateOk) return false;
    if (!hasStatus || mode === "upcoming") return true;
    // Показываем все строки на нужную дату — фильтр по статусу убран,
    // иначе строки без "готово" не видны менеджеру и аналитику.
    return true;
  });

  const filterNote = mode === "upcoming"
    ? "сегодня и позже"
    : hasStatus ? "сегодня + готово" : "сегодня (статус не задан)";
  console.log(`  [Sheets] строк в таблице: ${dataRows.length} | подходят (${filterNote}): ${matched.length}`);

  return matched.map((row) => ({
    date:     row[idx.date]     || "",
    topic:    row[idx.topic]    || "",
    format:   row[idx.format]   || "",
    platform: row[idx.platform] || "",
    status:   hasStatus ? (row[idx.status] || "") : "—",
  }));
}

// ─────────────────────────────────────────────────────────────
// Tavily Search — один запрос, возвращает { answer, results[] } или null при ошибке
async function searchTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY не задан в .env");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // Подробный лог каждого запроса
  const resultCount = data.results?.length ?? 0;
  const hasAnswer   = !!data.answer;
  console.log(
    `  [Tavily] "${query}" → ${res.status} | results: ${resultCount} | answer: ${hasAnswer}`
  );
  if (resultCount === 0) {
    console.warn(`  [Tavily] ПУСТОЙ ОТВЕТ для запроса: "${query}"`);
    console.warn(`  [Tavily] raw:`, JSON.stringify(data).slice(0, 400));
  }

  return data;
}

// ─────────────────────────────────────────────────────────────
// СТАТИСТИКА АККАУНТА — выгрузка Instagram, пересобранная build_analysis.py.
// account-analysis/_summary.json: топ-посты, темы с ER, недельный срез.
// Аналитик придумывает контент из этих цифр (без контент-плана в Sheets).
// ─────────────────────────────────────────────────────────────
async function readAccountAnalysis() {
  const p = path.join(__dirname, "account-analysis", "_summary.json");
  let s;
  try {
    s = JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    console.log("  [Статистика-аккаунта] _summary.json не найден — пропускаю");
    return "";
  }
  const num = (n) => Number(n || 0).toLocaleString("ru-RU");
  const postLine = (t) => `— ${num(t[2])} просм · ${t[1]} · сохр ${num(t[3])} · подп ${t[4]} · ER ${t[5]}% · ${t[0]}`;

  const wk = s.week_range && s.week_range[0]
    ? `Неделя ${s.week_range[0]} – ${s.week_range[1]}: просмотры ${num(s.week_views)} (пред. неделя ${num(s.prev_week_views)}), ` +
      `подписки +${num(s.week_follows)} (пред. +${num(s.prev_week_follows)}), охват ${num(s.week_reach)}, взаимодействий ${num(s.week_interactions)}.`
    : "";

  const topicLines = Object.entries(s.topics || {})
    .map(([k, v]) => `— ${k}: ${v[0]} постов, ср. ${num(v[1])} просм, охват ${num(v[2])}, сохр ${num(v[3])}, ER ${v[4]}, подписок ${v[5]}`)
    .join("\n");

  const weekPosts = (s.week_posts || []).length
    ? (s.week_posts || []).map(postLine).join("\n")
    : "за неделю свежих постов в выгрузке нет";
  const top10 = (s.top10 || []).map(postLine).join("\n");

  // Свежесть выгрузки: аналитик должен видеть возраст данных и не выдавать
  // старые цифры за текущие, а просить новую выгрузку.
  const lastDate = s.week_range?.[1] || "";
  const ageDays = lastDate ? Math.floor((Date.now() - new Date(lastDate + "T00:00:00").getTime()) / 864e5) : null;
  const freshness = lastDate
    ? (ageDays > 7
      ? `⚠️ ВЫГРУЗКА УСТАРЕЛА: данные по ${lastDate}, это ${ageDays} дн. назад. НЕ называй эти цифры текущими. Если автор спросит про статистику — сначала скажи, что выгрузку пора обновить (прислать свежий CSV из Instagram).\n\n`
      : `Данные по ${lastDate} (${ageDays} дн. назад).\n\n`)
    : "";

  console.log(`  [Статистика-аккаунта] загружено: ${s.n_posts} постов, неделя ${s.week_range?.[0] || "?"}`);
  return (
    `СТАТИСТИКА АККАУНТА ${AUTHOR_TAG} (реальные цифры из выгрузки Instagram — на их основе придумывай что постить):\n${freshness}` +
    (wk ? `${wk}\n\n` : "") +
    `Всего в выгрузке: ${s.n_posts} публикаций (рилсы ${s.n_reels}, карусели ${s.n_cars}). ` +
    `Рилсы в среднем ${num(s.reel_avg_views)} просм (ER ${s.reel_avg_er}), карусели ${num(s.car_avg_views)} просм (ER ${s.car_avg_er}) — рилсы кратно сильнее.\n\n` +
    `Залетевшие посты за последнюю неделю:\n${weekPosts}\n\n` +
    `Топ-10 постов за весь период:\n${top10}\n\n` +
    `Темы по эффективности (что заходит аудитории, что слабее):\n${topicLines}`
  );
}

// INSTAGRAM-СТАТИСТИКА — вкладка "Статистика" в той же таблице.
// автор вставляет цифры по постам, аналитик читает как есть.
// Колонки свободные, первая строка — заголовки.
// ─────────────────────────────────────────────────────────────
async function readInstagramStats() {
  const serviceAccountRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetsId          = process.env.GOOGLE_SHEETS_ID;
  if (!serviceAccountRaw || !sheetsId) return "";

  let credentials;
  try { credentials = JSON.parse(serviceAccountRaw); } catch { return ""; }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetsId,
      range: "Статистика!A:H",
    });
    rows = res.data.values || [];
  } catch (e) {
    console.log("  [Статистика] вкладка не найдена или недоступна — пропускаю");
    return "";
  }

  if (rows.length < 2) {
    console.log("  [Статистика] вкладка пустая — пропускаю");
    return "";
  }

  // Последние 30 строк, чтобы не раздувать промпт
  const headers = rows[0].join(" | ");
  const lines = rows.slice(1).slice(-30).map((r) => r.join(" | "));
  console.log(`  [Статистика] строк: ${lines.length}`);
  return `${headers}\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────
// YOUTUBE — свежие залетевшие ролики по нише за последние 3 дня.
// Нужен YOUTUBE_API_KEY (Google Cloud, YouTube Data API v3).
// ─────────────────────────────────────────────────────────────
const YOUTUBE_QUERIES = [
  "Claude AI как пользоваться 2026",
  "Claude Code обучение примеры",
  "Claude AI фишки новые возможности",
  "нейросети для начинающих 2026",
  "AI инструменты для бизнеса 2026",
  "заработок на нейросетях 2026",
];

// ─────────────────────────────────────────────────────────────
// ANTHROPIC NEWS — официальные новости с anthropic.com/news.
// Парсим публичную страницу (обычный fetch, без API).
// ─────────────────────────────────────────────────────────────
async function fetchAnthropicNews() {
  try {
    const res = await fetch("https://www.anthropic.com/news", { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) { console.warn(`  [Anthropic] HTTP ${res.status}`); return ""; }
    const html = await res.text();
    const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
    const items = [...html.matchAll(/<a href="\/news\/([a-z0-9-]+)"[^>]*listItem[^>]*>([\s\S]*?)<\/a>/g)];
    const lines = [];
    for (const m of items.slice(0, 8)) {
      const slug = m[1], chunk = m[2];
      const date = (chunk.match(/<time[^>]*>([^<]+)<\/time>/) || [])[1] || "";
      const spans = [...chunk.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(s => strip(s[1])).filter(Boolean);
      const title = spans[spans.length - 1] || slug.replace(/-/g, " ");
      lines.push(`— ${date}: ${title}`);
    }
    if (lines.length === 0) { console.warn("  [Anthropic] не нашла новостей в HTML"); return ""; }
    console.log(`  [Anthropic] новостей: ${lines.length}`);
    return lines.join("\n");
  } catch (e) {
    console.warn("  [Anthropic] ошибка:", e.message);
    return "";
  }
}

async function fetchYouTubeTrends() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.log("  [YouTube] YOUTUBE_API_KEY не задан — пропускаю");
    return "";
  }

  // Окно 45 дней: за 3 дня ролики не успевают набрать просмотры (все мелкие).
  // За полтора месяца сильные ролики уже видны, но тема ещё актуальна.
  const publishedAfter = new Date(Date.now() - 45 * 86400e3).toISOString();
  const sections = [];

  for (const q of YOUTUBE_QUERIES) {
    try {
      const searchUrl =
        `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
        `&q=${encodeURIComponent(q)}&order=viewCount&publishedAfter=${publishedAfter}` +
        `&relevanceLanguage=ru&maxResults=10&key=${key}`;
      const sRes = await fetch(searchUrl);
      if (!sRes.ok) throw new Error(`search HTTP ${sRes.status}`);
      const sData = await sRes.json();
      const ids = (sData.items || []).map((i) => i.id?.videoId).filter(Boolean);
      if (ids.length === 0) { sections.push(`Запрос "${q}": ничего свежего.`); continue; }

      const vRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids.join(",")}&key=${key}`
      );
      if (!vRes.ok) throw new Error(`videos HTTP ${vRes.status}`);
      const vData = await vRes.json();

      const vids = (vData.items || [])
        .map((v) => ({
          title: v.snippet?.title, channel: v.snippet?.channelTitle,
          views: Number(v.statistics?.viewCount || 0),
        }))
        .sort((a, b) => b.views - a.views);
      // Берём только ролики с сильными охватами (>10к). Если таких нет — топ-3 как есть.
      const strong = vids.filter((v) => v.views >= 10000);
      const pick = (strong.length ? strong : vids).slice(0, 4);
      const lines = pick.map((v) =>
        `— "${v.title}" | канал: ${v.channel} | ${v.views.toLocaleString("ru-RU")} просм.`);
      sections.push(`Запрос "${q}" (сильные ролики по просмотрам за 45 дн):\n${lines.join("\n")}`);
      console.log(`  [YouTube] "${q}" → ${pick.length} роликов (из ${vids.length}, сильных ${strong.length})`);
    } catch (err) {
      console.warn(`  [YouTube] ошибка запроса "${q}": ${err.message}`);
      sections.push(`Запрос "${q}": ошибка получения.`);
    }
  }

  return sections.join("\n\n");
}

// Запускает запросы параллельно, собирает результаты в текстовый контекст
function getTavilyQueries() {
  const d = new Date();
  const day = d.getDate();
  const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  const monthName = months[d.getMonth()];
  const year = d.getFullYear();
  return [
    `нейросети ИИ новости ${day} ${monthName} ${year}`,
    `Claude Anthropic новости ${monthName} ${year}`,
    `искусственный интеллект тренды обучение ${year}`,
    `вирусный контент нейросети Instagram Reels ${year}`,
    `ChatGPT Gemini AI инструменты новинки ${monthName} ${year}`,
  ];
}

async function fetchTrendContext() {
  const TAVILY_QUERIES = getTavilyQueries();
  console.log(`  [Tavily] запускаю ${TAVILY_QUERIES.length} запроса параллельно...`);

  const results = await Promise.all(
    TAVILY_QUERIES.map((q) =>
      searchTavily(q).catch((err) => {
        console.warn(`  [Tavily] ОШИБКА запроса "${q}": ${err.message}`);
        return null;
      })
    )
  );

  const nullCount = results.filter((r) => r === null).length;
  if (nullCount === TAVILY_QUERIES.length) {
    console.error("  [Tavily] ВСЕ запросы вернули ошибку — контекст пустой!");
  } else if (nullCount > 0) {
    console.warn(`  [Tavily] ${nullCount}/${TAVILY_QUERIES.length} запросов не выполнено`);
  }

  const sections = results
    .map((data, i) => {
      if (!data) return `Запрос "${TAVILY_QUERIES[i]}": нет данных.`;
      const answer = data.answer ? `Краткий ответ: ${data.answer}\n` : "";
      const items = (data.results || [])
        .slice(0, 4)
        .map((r) => `— ${r.title}: ${(r.content || "").slice(0, 250)}`)
        .join("\n");
      return `Запрос: "${TAVILY_QUERIES[i]}"\n${answer}${items}`;
    })
    .join("\n\n---\n\n");

  console.log(`  [Tavily] контекст собран: ${sections.length} симв.`);
  return sections;
}

// Отправляет текст в чат, опционально в топик (threadId)
async function sendToChat(token, chatId, text, threadId = null) {
  const chunks = splitForTelegram(stripMarkdown(text), 4000);
  for (const chunk of chunks) {
    const payload = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
    if (threadId) payload.message_thread_id = threadId;
    // До 3 попыток как в sendPhotoAlbum: сетевые осечки и 5xx/429 повторяем,
    // прочие 4xx лечить нечем — бросаем сразу
    let sent = false, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      let res = null;
      try {
        res = await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        lastErr = err;
      }
      if (res) {
        if (res.ok) { sent = true; break; }
        const body = await res.text();
        lastErr = new Error(`Telegram send failed [${chatId}]: ${res.status} ${body.slice(0, 200)}`);
        if (res.status < 500 && res.status !== 429) throw lastErr;
      }
      if (attempt < 3) {
        console.warn(`  [Send] попытка ${attempt} не прошла (${lastErr.message}) — повторяю`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
    if (!sent) throw lastErr;
  }
}

// Возвращает offset следующего непрочитанного update
async function getUpdateOffset() {
  const res = await tgFetch(
    `https://api.telegram.org/bot${APPROVAL_TOKEN}/getUpdates?limit=1&offset=-1`
  );
  const data = await res.json();
  const updates = data.result || [];
  return updates.length > 0 ? updates[updates.length - 1].update_id + 1 : 0;
}

// Проверяет что сообщение пришло из чата одобрения и нужного топика
function isFromApprovalChat(msg) {
  if (!msg || !msg.chat) return false;
  const chat = msg.chat;
  const id = String(APPROVAL_CHAT_ID || "");
  const chatMatch = id.startsWith("@")
    ? chat.username === id.slice(1)
    : String(chat.id) === id;
  if (!chatMatch) return false;
  // Если задан топик — проверяем thread_id
  if (APPROVAL_TOPIC_ID) {
    return msg.message_thread_id === APPROVAL_TOPIC_ID;
  }
  return true;
}

// Диалоговый режим одобрения — аналитик отвечает на вопросы в чате.
// Returns { decision: "ok"|"redo"|"stop"|"timeout", output: string }
async function waitForApprovalDialogue(agentName, system, initialMessages, startOffset) {
  const deadline    = Date.now() + APPROVAL_TIMEOUT_MS;
  let   offset      = startOffset;
  const deadlineStr = new Date(deadline).toTimeString().slice(0, 5);
  console.log(`  [${agentName}] диалог открыт (до ${deadlineStr} МСК) — пиши вопросы или "ок"`);

  // История переписки для Claude
  const messages     = [...initialMessages];
  // Последний сгенерированный анализ (обновляется если в ответе появляется новый)
  let   currentOutput = initialMessages.at(-1)?.content ?? "";

  while (Date.now() < deadline) {
    const remaining   = Math.ceil((deadline - Date.now()) / 1000);
    const pollTimeout = Math.min(55, remaining);
    if (pollTimeout <= 0) break;

    let data;
    try {
      const res = await tgFetch(
        `https://api.telegram.org/bot${APPROVAL_TOKEN}/getUpdates` +
          `?offset=${offset}&timeout=${pollTimeout}&limit=20`,
        {}, (pollTimeout + 15) * 1000 // запас поверх long-poll, чтобы не рубить опрос
      );
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!isFromApprovalChat(msg)) continue;

      // Текст или голосовое сообщение
      let text = msg?.text?.trim() || null;
      if (!text && msg?.voice) {
        try {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            "🎤 Слышу, расшифровываю...", APPROVAL_TOPIC_ID);
          const { tmpPath, extension } = await downloadTelegramFile(msg.voice.file_id);
          text = await transcribeAudio(tmpPath, extension);
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            `📝 Расшифровала: "${text}"`, APPROVAL_TOPIC_ID);
          console.log(`  [${agentName}] голосовое → "${text.slice(0, 80)}"`);
        } catch (err) {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            `❌ Не смогла расшифровать: ${err.message}`, APPROVAL_TOPIC_ID);
          continue;
        }
      }
      if (!text) continue;

      const cmd = text.toLowerCase();

      if (cmd === "ок" || cmd === "ok") {
        console.log(`  [${agentName}] одобрено ✓`);
        return { decision: "ok", output: currentOutput };
      }
      if (cmd === "переделай" || cmd === "redo") {
        console.log(`  [${agentName}] запрошена полная переделка`);
        return { decision: "redo", output: currentOutput };
      }
      if (cmd === "стоп" || cmd === "stop") {
        console.log(`  [${agentName}] остановлен`);
        return { decision: "stop", output: currentOutput };
      }

      // Вопрос или комментарий → отвечаем через Claude
      console.log(`  [${agentName}] вопрос: "${text.slice(0, 80)}"`);
      messages.push({ role: "user", content: text });

      const reply = await callClaudeMessages(system, messages);
      messages.push({ role: "assistant", content: reply });

      if (reply.includes("ТЕМА 1") && reply.includes("ТЕМА 2")) {
        currentOutput = reply;
        console.log(`  [${agentName}] анализ обновлён (${reply.length} симв.)`);
      }

      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, stripMarkdown(reply), APPROVAL_TOPIC_ID);
      console.log(`  [${agentName}] ответил в чат`);
    }
  }

  console.warn(`  [${agentName}] таймаут диалога — пропускаю`);
  return { decision: "timeout", output: currentOutput };
}

// Ждёт ответа автора:
//   "ok"      — одобрено
//   "redo"    — переделать без уточнений
//   "stop"    — пропустить
//   "timeout" — истекло время
//   <строка>  — творческое направление (любое другое сообщение)
async function waitForApproval(agentName, startOffset) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  let offset = startOffset;
  const deadlineStr = new Date(deadline).toTimeString().slice(0, 5);
  console.log(`  [${agentName}] жду ответа (до ${deadlineStr} МСК)...`);

  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const pollTimeout = Math.min(55, remaining);
    if (pollTimeout <= 0) break;

    let data;
    try {
      const res = await tgFetch(
        `https://api.telegram.org/bot${APPROVAL_TOKEN}/getUpdates` +
          `?offset=${offset}&timeout=${pollTimeout}&limit=20`,
        {}, (pollTimeout + 15) * 1000
      );
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!isFromApprovalChat(msg)) continue;

      let text = msg?.text?.trim() || null;
      if (!text && msg?.voice) {
        try {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            "🎤 Слышу, расшифровываю...", APPROVAL_TOPIC_ID);
          const { tmpPath, extension } = await downloadTelegramFile(msg.voice.file_id);
          text = await transcribeAudio(tmpPath, extension);
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            `📝 Расшифровала: "${text}"`, APPROVAL_TOPIC_ID);
          console.log(`  [${agentName}] голосовое → "${text.slice(0, 80)}"`);
        } catch (err) {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            `❌ Не смогла расшифровать: ${err.message}`, APPROVAL_TOPIC_ID);
          continue;
        }
      }
      if (!text) continue;

      const cmd = text.toLowerCase();
      if (cmd === "ок" || cmd === "ok")          return "ok";
      if (cmd === "переделай" || cmd === "redo") return "redo";
      if (cmd === "стоп" || cmd === "stop")      return "stop";
      if (cmd === "перерисуй" || cmd === "redesign") return "redesign";

      console.log(`  [${agentName}] получено направление: "${text}"`);
      return text;
    }
  }

  console.warn(`  [${agentName}] таймаут — пропускаю`);
  return "timeout";
}

function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")            // # Заголовки любого уровня
    .replace(/\*\*(.+?)\*\*/gs, "$1")        // **жирный**
    .replace(/\*(.+?)\*/gs, "$1")            // *курсив*
    .replace(/^[ \t]*[-*+]\s+/gm, "")        // * / - / + маркеры списков
    .replace(/^\d+\.\s+/gm, "")              // 1. нумерованные списки
    .replace(/^-{3,}\s*$/gm, "")             // --- горизонтальный разделитель
    .replace(/```[\s\S]*?```/g, (m) =>       // ```блок кода``` — оставляем текст
      m.replace(/```(?:\w+)?/g, "").trim()
    )
    .replace(/`(.+?)`/g, "$1")               // `инлайн-код`
    .replace(/\n{3,}/g, "\n\n")              // схлопываем тройные пустые строки
    .trim();
}

function splitForTelegram(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + limit / 2) end = nl;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────
// CAROUSEL PNG PIPELINE
// 1. Claude генерирует HTML для каждого слайда
// 2. Puppeteer рендерит HTML → PNG 1080×1350
// 3. PNG отправляются в Telegram как альбом
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// GOOGLE DRIVE — случайное фото из папки автора
// ─────────────────────────────────────────────────────────────
async function getRandomDrivePhoto() {
  const folderId = process.env.GOOGLE_PHOTOS_FOLDER_ID;
  if (!folderId) return null;

  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { return null; }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  // Список фото в папке
  // Только форматы, которые рендерит Chrome: HEIF/HEIC с айфона в <img>
  // не отображается — слайд выходил с иконкой битой картинки вместо фото.
  const list = await drive.files.list({
    q: `'${folderId}' in parents and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/webp') and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 100,
  });

  const files = list.data.files || [];
  if (files.length === 0) {
    console.warn("  [Drive] папка пуста — слайд без фото");
    return null;
  }

  // Берём случайный файл
  const file = files[Math.floor(Math.random() * files.length)];
  console.log(`  [Drive] фото: ${file.name} (${files.length} всего)`);

  // Скачиваем как buffer → base64 data URI
  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const mime   = file.mimeType || "image/jpeg";
  const b64    = Buffer.from(res.data).toString("base64");
  return `data:${mime};base64,${b64}`;
}

// ─────────────────────────────────────────────────────────────
// КАРУСЕЛЬ — ЖЁСТКИЙ ШАБЛОН ПО СЕТКЕ (спек автора 2026).
// Карусель-мейкер выдаёт структуру (Тип/Лейбл/Заголовок/Подзаголовок/
// Выделить). Вёрстку строит КОД по фиксированным числам — одинаковая
// сетка на каждом слайде. Поля 88/88/96/96, текст-колонка 820px,
// заголовок старт ~580px, Inter 72-92px, line-height 0.92,
// текст не ниже 80% высоты, низ — зона воздуха + прогресс-бар.
// ─────────────────────────────────────────────────────────────

// Inter вшит как base64 @font-face (вставляется при рендере PNG, не в state).
const CAROUSEL_FONT_CSS = (() => {
  const weights = [
    ["Inter-Regular.ttf", 400],
    ["Inter-Medium.ttf", 500],
    ["Inter-Bold.ttf", 700],
    ["Inter-Black.ttf", 900],
  ];
  try {
    return weights.map(([file, w]) => {
      const b64 = readFileSync(path.join(__dirname, "assets", "fonts", file)).toString("base64");
      return `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:block;src:url(data:font/ttf;base64,${b64}) format('truetype')}`;
    }).join("");
  } catch (e) {
    console.warn("  [Карусель] локальный Inter не загрузился, fallback Google Fonts:", e.message);
    return "";
  }
})();

// Шрифты эдиториал-шаблона: Playfair Display Italic (серифный курсив, кириллица)
// и Caveat (рукописный, кириллица). Вшиваются base64 при рендере, как Inter.
const EDITORIAL_FONT_CSS = (() => {
  const faces = [
    ["PlayfairDisplay-Italic.ttf", "Playfair Display", "italic", "400 900"],
    ["Caveat.ttf", "Caveat", "normal", "400 700"],
  ];
  try {
    return faces.map(([file, family, style, weight]) => {
      const b64 = readFileSync(path.join(__dirname, "assets", "fonts", file)).toString("base64");
      return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/ttf;base64,${b64}) format('truetype')}`;
    }).join("");
  } catch (e) {
    console.warn("  [Карусель] шрифты эдиториала не загрузились:", e.message);
    return "";
  }
})();

// Висячие предлоги → неразрывный пробел (не висят в конце строки).
const HANGING_RE = /(^|\s)(в|во|на|с|со|у|к|ко|о|об|обо|и|а|но|не|ни|за|по|до|из|изо|от|ото|под|при|для|без|над|про|же|бы|ли|то|как|что|или) +(?=\S)/gi;
function fixHanging(text) {
  let out = String(text || "");
  for (let pass = 0; pass < 2; pass++) out = out.replace(HANGING_RE, (m, pre, w) => `${pre}${w} `);
  // Число не отрывается от следующего слова: "3 часа", "5 шагов".
  out = out.replace(/(^|\s)(\d+)\s+(?=\S)/g, (m, pre, num) => `${pre}${num} `);
  return out;
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escCarouselText(s) { return fixHanging(escapeHtml(stripEmoji(String(s || "")))); }
function prepCarouselText(s) { return escCarouselText(String(s || "").trim()); }

// Размер заголовка по длине — внутри спека 72-92px, биас в крупный.
function headlineFontSize(text) {
  const len = String(text || "").trim().length;
  if (len <= 22) return 92;
  if (len <= 44) return 84;
  if (len <= 70) return 76;
  return 72;
}

// Размер текста промпта по длине — мелкий, помещается в рамку.
function promptFontSize(text) {
  const len = String(text || "").trim().length;
  if (len <= 110) return 46;
  if (len <= 180) return 40;
  if (len <= 260) return 34;
  if (len <= 360) return 29;
  if (len <= 480) return 25;
  return 22;
}

function slideIsDark(slide) {
  if (slide.theme === "dark") return true;
  if (slide.theme === "light") return false;
  return slide.type === "cover" || slide.type === "cta";
}

// Текст промпта: [заполнители-в-скобках] подсвечиваем золотым (что подставлять).
// Регекс после escape — безопасно, скобки escapeHtml не трогает.
function renderPromptHtml(text, dark) {
  const c = dark ? "#FBE896" : "#9A6B00";
  return escCarouselText(text).replace(/\[[^\]]*\]/g,
    m => `<span style="color:${c};font-weight:500">${m}</span>`);
}

// Кодовое слово CTA: ВЕРХНИЙ регистр, 3+ буквы (СПИСОК, СТАРТ, ЗАВОД, CLAUDE).
function codeWord(text) {
  const m = String(text || "").match(/\b[A-ZА-ЯЁ]{3,}\b/);
  return m ? m[0] : "";
}

// Заголовок с акцентом.
// usePill (контент-слайды) → тихая жёлтая плашка: палитра прежняя, но без
//   шумного крупного скругления, плотно по тексту.
// иначе (обложка, CTA) → акцент просто другим цветом текста (dark → жёлтый).
function renderHeadlineHtml(headline, accent, dark, usePill) {
  const h = String(headline || "").trim();
  const accStyle = usePill
    ? "background:#FBE896;color:#1E110A;padding:0 12px;border-radius:6px;font-style:normal;-webkit-box-decoration-break:clone;box-decoration-break:clone"
    : `color:${dark ? "#FBE896" : "#9A6B00"};font-style:normal`;
  const a = String(accent || "").trim();
  let before = h, mid = "", after = "";
  if (a) {
    const i = h.toLowerCase().indexOf(a.toLowerCase());
    if (i >= 0) { before = h.slice(0, i); mid = h.slice(i, i + a.length); after = h.slice(i + a.length); }
  }
  const acc = mid ? `<em style="${accStyle}">${escCarouselText(mid)}</em>` : "";
  return `${escCarouselText(before)}${acc}${escCarouselText(after)}`;
}

// ЕДИНЫЙ рендер слайда по фиксированной сетке. index 0-based, photo dataURI|null.
function renderCarouselSlide(slide, index, total, photo) {
  const n = index + 1;
  const dark = slideIsDark(slide);
  const isCta = slide.type === "cta";
  const isContent = slide.type === "content";
  const C = dark
    ? { bg:"#1A110A", text:"#F5EDD8", label:"rgba(245,237,216,.55)", sub:"rgba(245,237,216,.74)", dot:"#FBE896", nick:"rgba(245,237,216,.5)", sep:"rgba(245,237,216,.18)", track:"rgba(245,237,216,.15)", fill:"#FBE896", counter:"rgba(245,237,216,.5)" }
    : { bg:"#F5EDD8", text:"#1E110A", label:"#5A4030", sub:"rgba(30,17,10,.65)", dot:"#5A4030", nick:"rgba(30,17,10,.4)", sep:"rgba(90,64,48,.2)", track:"rgba(30,17,10,.10)", fill:"#5A4030", counter:"rgba(30,17,10,.4)" };

  const fillPct = Math.round(n / total * 100);

  const photoLayer = (dark && photo)
    ? `<img src="${photo}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0">` +
      `<div style="position:absolute;inset:0;z-index:1;background:linear-gradient(to top,rgba(26,17,10,.84) 42%,rgba(26,17,10,.24) 100%)"></div>`
    : "";

  const dotHtml = `<div style="width:12px;height:12px;border-radius:50%;background:${C.dot};margin-bottom:22px"></div>`;
  const labelHtml = slide.label
    ? `<div style="font:700 22px Inter;letter-spacing:.18em;text-transform:uppercase;color:${C.label};margin-bottom:18px">${prepCarouselText(slide.label)}</div>`
    : "";

  // Тело: промпт в рамке / список (2+ пункта) / один большой заголовок.
  const items = Array.isArray(slide.items) ? slide.items.filter(it => it && (it.title || it.desc)) : [];
  // Промпт-слайд: готовый текст промпта рисуем МЕЛКИМ в рамке, не гигантским
  // заголовком. Если мейкер по ошибке сунул промпт в Заголовок — длинный
  // заголовок тоже считаем промптом (на всякий случай).
  let promptText = String(slide.prompt || "").trim();
  let headlineText = String(slide.headline || "").trim();
  if (!promptText && isContent && !items.length && headlineText.length > 90) {
    promptText = headlineText; headlineText = "";
  }
  const isPrompt = isContent && !!promptText;

  let bodyHtml;
  if (isPrompt) {
    const pSize = promptFontSize(promptText);
    const boxBg = dark ? "rgba(245,237,216,.05)" : "rgba(90,64,48,.06)";
    const boxBorder = dark ? "rgba(245,237,216,.22)" : "rgba(90,64,48,.28)";
    const headSize = Math.min(headlineFontSize(headlineText), 72);
    const heading = headlineText
      ? `<div style="font:900 ${headSize}px Inter;line-height:1.04;letter-spacing:-.01em;color:${C.text};text-align:left;margin-bottom:32px">${prepCarouselText(headlineText)}</div>`
      : "";
    const box = `<div style="border:1.5px solid ${boxBorder};border-radius:26px;padding:44px 48px;background:${boxBg};font:400 ${pSize}px Inter;line-height:1.5;color:${C.text};text-align:left;white-space:pre-wrap">${renderPromptHtml(promptText, dark)}</div>`;
    bodyHtml = heading + box;
  } else if (isContent && items.length >= 1) {
    const cnt = items.length;
    const tSize = cnt === 1 ? 80 : cnt === 2 ? 70 : cnt === 3 ? 60 : cnt === 4 ? 50 : 44;
    const dSize = cnt === 1 ? 38 : cnt === 2 ? 36 : cnt === 3 ? 33 : cnt === 4 ? 29 : 26;
    const gap   = cnt <= 2 ? 40 : cnt === 3 ? 32 : cnt === 4 ? 26 : 22;
    bodyHtml = items.map((it, i) => {
      const sep = i === 0 ? "" : `border-top:1px solid ${C.sep};margin-top:${gap}px;padding-top:${gap}px;`;
      const title = `<div style="${sep}font:800 ${tSize}px Inter;line-height:1.04;letter-spacing:-.01em;color:${C.text}">${renderHeadlineHtml(it.title, it.accent, dark, true)}</div>`;
      const desc = it.desc ? `<div style="font:400 ${dSize}px Inter;line-height:1.3;color:${C.sub};margin-top:8px">${prepCarouselText(it.desc)}</div>` : "";
      return title + desc;
    }).join("");
  } else {
    const hSize = headlineFontSize(slide.headline);
    const accentWord = isCta ? (slide.accent || codeWord(slide.headline)) : slide.accent;
    const headlineHtml = `<h1 style="font:900 ${hSize}px Inter;line-height:1.05;letter-spacing:-.01em;color:${C.text};margin:0">${renderHeadlineHtml(slide.headline, accentWord, dark, isContent)}</h1>`;
    const subLines = String(slide.description || "").split("\n").map(l => l.trim()).filter(Boolean);
    const subHtml = subLines.length
      ? `<div style="font:400 38px Inter;line-height:1.4;color:${C.sub};margin-top:24px">` +
        subLines.map(l => `<div>${prepCarouselText(l)}</div>`).join("") + `</div>`
      : "";
    bodyHtml = headlineHtml + subHtml;
  }

  // Абсолютная страховка: тело никогда не должно быть пустым. Если все ветки
  // выше дали пустоту (странный вывод мейкера) — рисуем любой доступный текст
  // заголовком, чтобы слайд не ушёл без единого слова.
  const bodyHasText = /[A-Za-zА-Яа-яЁё0-9]/.test(bodyHtml.replace(/<[^>]*>/g, ""));
  if (!bodyHasText) {
    const fallback = String(
      slide.headline || slide.description ||
      (items[0] && (items[0].title || items[0].desc)) ||
      slide.prompt || slide.label || ""
    ).trim();
    if (fallback) {
      bodyHtml = `<h1 style="font:900 ${headlineFontSize(fallback)}px Inter;line-height:1.05;letter-spacing:-.01em;color:${C.text};margin:0">${escCarouselText(fallback)}</h1>`;
    }
  }

  // Промпт-слайд тянется сверху вниз (текст разной длины).
  // Остальной контент и CTA прижаты влево-вниз. Обложка — средняя зона под фото.
  const blockPos = isPrompt
    ? "top:160px;bottom:240px;left:88px;right:88px;display:flex;flex-direction:column;justify-content:flex-end"
    : (isContent || isCta) ? "left:88px;right:88px;bottom:300px"
    : "top:512px;left:88px;width:820px";

  return `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800;900&display=swap" rel="stylesheet">` +
    `<style>*{margin:0;padding:0;box-sizing:border-box}body{margin:0}</style></head>` +
    `<body><div style="position:relative;width:1080px;height:1350px;overflow:hidden;background:${C.bg};font-family:Inter,sans-serif">` +
    photoLayer +
    `<div style="position:absolute;top:96px;left:88px;z-index:3;font:500 24px Inter;letter-spacing:.02em;color:${C.nick}">${AUTHOR_TAG}</div>` +
    `<div style="position:absolute;${blockPos};z-index:2;text-align:left">` +
      dotHtml + labelHtml + bodyHtml +
    `</div>` +
    `<div style="position:absolute;left:88px;right:88px;bottom:56px;z-index:3;display:flex;align-items:center;gap:16px">` +
      `<div style="flex:1;height:4px;border-radius:3px;background:${C.track};overflow:hidden"><div style="height:100%;width:${fillPct}%;background:${C.fill};border-radius:3px"></div></div>` +
      `<div style="font:500 22px Inter;color:${C.counter}">${n}/${total}</div>` +
    `</div>` +
    `</div></body></html>`;
}

// ─────────────────────────────────────────────────────────────
// ЭДИТОРИАЛ-ШАБЛОН (референс MEC): бумажный фон, гигантский гротеск
// + серифный курсив на акценте, стеклянная карточка на фото-обложке,
// рукописные пометки со стрелкой, пилюля «ЛИСТАЙ →», тёмный CTA-слайд
// с кодовым словом на плашке и «P.S. подпишись» внизу.
// Тинты: beige (как референс) и cream (бренд автора).
// ─────────────────────────────────────────────────────────────
function editorialColors(tint) {
  if (tint === "cream") return {
    paper: "#F5EDD8", ink: "#1E110A", muted: "rgba(30,17,10,.62)",
    note: "#7A5A2E",
    card: "#FBF7EC", cardShadow: "0 24px 60px rgba(30,17,10,.14)",
    ctaBg: "#1A110A", ctaPlate: "#FBE896", ctaPlateInk: "#1E110A",
    pillBg: "#FBE896", pillInk: "#1E110A",
  };
  return { // beige — как у референса MEC (тёплая бумага, не серая)
    paper: "#ECE3D3", ink: "#2A1E16", muted: "rgba(42,30,22,.62)",
    note: "#8A6B4F",
    card: "#FAF5EB", cardShadow: "0 24px 60px rgba(42,30,22,.15)",
    ctaBg: "#2A1A14", ctaPlate: "#FBE896", ctaPlateInk: "#1E110A",
    pillBg: "#FBE896", pillInk: "#1E110A",
  };
}

// Заголовок эдиториала: чистый гротеск Inter Black, без серифного курсива
// (автор убрала курсив 7 июля 2026 — «просто обычный гротеск»).
// text-wrap:balance ровняет строки, неразрывный пробел перед последним словом
// не даёт одному слову висеть на отдельной строке.
function renderEditorialHeadline(headline, accent, color, size) {
  let inner = escCarouselText(String(headline || "").trim());
  // Клеим неразрывным только при 3+ словах (у двухсловного заголовка это
  // склеивает всю строку, она не переносится и режется краем слайда) и только
  // если неразрывный хвост после склейки короткий: fixHanging уже мог склеить
  // предлог, и хвост типа «на услуге с Claude» перестаёт влезать в ширину.
  const lastSpace = inner.lastIndexOf(" ");
  if (lastSpace > 0 && inner.indexOf(" ") !== lastSpace) {
    const prevSpace = inner.lastIndexOf(" ", lastSpace - 1);
    if (inner.length - prevSpace - 1 <= 14) inner = inner.slice(0, lastSpace) + " " + inner.slice(lastSpace + 1);
  }
  return `<h1 style="font:900 ${size}px Inter;line-height:1.06;letter-spacing:-.02em;color:${color};margin:0;text-wrap:balance">${inner}</h1>`;
}

// Рукописные пометки (Caveat) убраны 8 июля — автору шрифт «прям отврат».
// Поле «Пометка» из старых текстов молча игнорируется.

// Тонкие монохромные глифы для перечислений в тексте слайда: галочка, крестик,
// стрелка вниз. Просьба автора 8 июля: «только вместо эмодзи разноцветных
// тонкие галочки/крестики/стрелочки». Штрих 2.4, цвет чернил — это разметка
// смысла в тексте, не декор (декор она откатила).
function editorialGlyph(kind, color) {
  const s = `fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`;
  if (kind === "check") return `<svg width="34" height="34" viewBox="0 0 34 34" style="flex:0 0 auto;margin-top:7px"><path d="M6 18.5 L13.5 26 L28 9" ${s}/></svg>`;
  if (kind === "cross") return `<svg width="34" height="34" viewBox="0 0 34 34" style="flex:0 0 auto;margin-top:7px"><path d="M9 9 L25 25 M25 9 L9 25" ${s}/></svg>`;
  if (kind === "dash")  return `<svg width="34" height="34" viewBox="0 0 34 34" style="flex:0 0 auto;margin-top:7px"><path d="M8 17 H26" ${s}/></svg>`;
  return `<svg width="34" height="52" viewBox="0 0 34 52" style="display:block"><path d="M17 4 V44 M7 33 L17 46 L27 33" ${s}/></svg>`; // стрелка вниз
}

// Подзаголовок с перечислением: строки «✓ …» / «✗ …» / «• …» и одиночная «↓»
// рендерятся тонкими глифами. Маркеры разбираем ДО prepCarouselText —
// stripEmoji вырезает ✓/❌/⬇ как эмодзи. Обычные строки остаются абзацами.
function renderEditorialBody(desc, C) {
  const lines = String(desc || "").split("\n").map((l) => l.trim());
  const blocks = [];
  let list = [];
  const flush = () => { if (list.length) { blocks.push(`<div style="display:flex;flex-direction:column;gap:22px">${list.join("")}</div>`); list = []; } };
  for (const line of lines) {
    if (!line) continue;
    if (/^(⬇️?|↓)$/u.test(line)) { flush(); blocks.push(editorialGlyph("down", C.muted)); continue; }
    const m = line.match(/^(✓|✔|✅|✗|✕|×|❌|•|[-–])\s+(.+)$/u);
    if (m) {
      const bad  = /[✗✕×❌]/u.test(m[1]);
      const dash = /^[•\-–]$/.test(m[1]);
      list.push(
        `<div style="display:flex;gap:24px;align-items:flex-start">` +
        editorialGlyph(bad ? "cross" : dash ? "dash" : "check", C.ink) +
        `<div style="font:${bad ? 400 : 500} 34px Inter;line-height:1.4;color:${bad ? C.muted : C.ink};text-wrap:pretty">${prepCarouselText(m[2])}</div></div>`);
      continue;
    }
    flush();
    blocks.push(`<div style="font:400 34px Inter;line-height:1.42;color:${C.muted};max-width:840px;text-wrap:pretty">${prepCarouselText(line)}</div>`);
  }
  flush();
  return blocks.length ? `<div style="margin-top:34px;display:flex;flex-direction:column;gap:32px">${blocks.join("")}</div>` : "";
}

const EDITORIAL_DOC = (body) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{margin:0}</style></head><body>${body}</body></html>`;

function renderEditorialSlide(slide, index, total, photo, tint = "beige") {
  const n = index + 1;
  const C = editorialColors(tint);

  const isCta = slide.type === "cta";
  const isCover = slide.type === "cover";

  const headerOn = (color) =>
    `<div style="position:absolute;top:64px;left:0;right:0;z-index:5;text-align:center;font:700 22px Inter;letter-spacing:.24em;color:${color}">${AUTHOR_TAG.toUpperCase()}</div>`;

  // Нижняя черта перелистывания + номер слайда в нижнем углу (как в классике,
  // просьба автора 8 июля). Номер сверху убран — он теперь у черты.
  const counter = `${String(n).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const footerOn = (track, fill, counterColor) =>
    `<div style="position:absolute;left:88px;right:88px;bottom:52px;z-index:6;display:flex;align-items:center;gap:20px">` +
      `<div style="flex:1;height:3px;border-radius:2px;background:${track};overflow:hidden"><div style="height:100%;width:${Math.round((n / total) * 100)}%;background:${fill};border-radius:2px"></div></div>` +
      `<div style="font:600 22px Inter;letter-spacing:.08em;color:${counterColor}">${counter}</div>` +
    `</div>`;
  const footerPaper = footerOn("rgba(42,30,22,.16)", C.ink, C.muted);
  const footerPhoto = footerOn("rgba(255,255,255,.22)", "rgba(255,255,255,.85)", "rgba(255,255,255,.7)");

  // Пилюлю «ЛИСТАЙ →» и рукописные пометки Caveat убрали 8 июля по фидбеку
  // автора («не к селу не к городу», «прописной — отврат»).
  const pill = "";

  // CTA — фото фоном с шоколадной вуалью (по умолчанию, 8 июля), ровная
  // плашка с кодовым словом (без поворота), P.S. внизу.
  // Режим «на сохранения» (Тип: CTA-сохранение): без кодового слова,
  // плашка «СОХРАНИ», заголовок — финальная фраза автора.
  if (isCta) {
    const saveCta = /сохран/i.test(slide.rawType || "");
    const word = (slide.accent || codeWord(slide.headline) || "СЛОВО").toUpperCase();
    const big = saveCta
      ? (slide.headline || "впереди еще больше практики")
      : (slide.headline && slide.headline.toUpperCase() !== word
        ? slide.headline : "и забирай всё бесплатно");
    // Подзаголовок не должен второй раз командовать «пиши слово в директ» —
    // эту фразу уже говорит плашка выше.
    let descText = String(slide.description || "").trim();
    // Куда слать слово: по умолчанию директ, но если в тексте CTA просят
    // комментарии — пишем «в комментариях».
    const viaComments = /комментар/i.test(descText);
    if (!saveCta) descText = descText.replace(new RegExp(`[^.!?]*пиши\\s+«?${word}»?[^.!?]*[.!?]?\\s*`, "i"), "").trim();
    const desc = descText
      ? `<div style="font:400 32px Inter;line-height:1.45;color:rgba(255,255,255,.72);max-width:800px">${prepCarouselText(descText)}</div>` : "";
    const plateLine = saveCta
      ? `<div style="font:700 44px Inter;color:#FFFFFF">Жми <span style="display:inline-block;background:${C.ctaPlate};color:${C.ctaPlateInk};padding:10px 30px;border-radius:14px;font-weight:900">«СОХРАНИ»</span> и возвращайся</div>`
      : `<div style="font:700 44px Inter;color:#FFFFFF">Пиши <span style="display:inline-block;background:${C.ctaPlate};color:${C.ctaPlateInk};padding:10px 30px;border-radius:14px;font-weight:900">«${escCarouselText(word)}»</span> ${viaComments ? "в комментариях" : "в директ"}</div>`;
    const psLine = saveCta
      ? `P.S. подпишись на ${AUTHOR_TAG}, чтобы не пропустить новые разборы`
      : `P.S. подпишись на ${AUTHOR_TAG} и загляни в запросы в директе`;
    const photoLayer = photo
      ? `<img src="${photo}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` +
        `<div style="position:absolute;inset:0;background:rgba(30,19,12,.8)"></div>`
      : "";
    return EDITORIAL_DOC(
      `<div style="position:relative;width:1080px;height:1350px;overflow:hidden;background:${C.ctaBg};font-family:Inter,sans-serif">` +
      photoLayer +
      headerOn("rgba(255,255,255,.6)") +
      `<div style="position:absolute;left:96px;right:96px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:40px;z-index:3">` +
        plateLine +
        `<div style="font:800 64px Inter;line-height:1.16;color:#FFFFFF;letter-spacing:-.01em;max-width:860px">${prepCarouselText(big)}</div>` +
        desc +
      `</div>` +
      `<div style="position:absolute;left:96px;right:96px;bottom:118px;z-index:3;text-align:center;font:400 27px Inter;line-height:1.4;color:rgba(255,255,255,.6)">${psLine}</div>` +
      footerPhoto +
      `</div>`);
  }

  // Обложка с фото — стеклянная карточка поверх
  if (isCover && photo) {
    const label = slide.label ? `<div style="font:700 24px Inter;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.72);margin-bottom:20px">${prepCarouselText(slide.label)}</div>` : "";
    const sub = slide.description ? `<div style="font:400 32px Inter;line-height:1.35;color:rgba(255,255,255,.82);margin-top:22px">${prepCarouselText(slide.description)}</div>` : "";
    // Длинный заголовок на узкой стеклянной карточке: 76px рвёт его на 5 рваных
    // строк («ДЕЛЕГИРОВАТЬ» занимает строку целиком) — 64px даёт 3 ровные.
    const coverHeadSize = String(slide.headline || "").trim().length > 48
      ? 64 : Math.min(headlineFontSize(slide.headline), 84);
    return EDITORIAL_DOC(
      `<div style="position:relative;width:1080px;height:1350px;overflow:hidden;background:#141009;font-family:Inter,sans-serif">` +
      `<img src="${photo}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` +
      `<div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(20,14,10,.82) 0%,rgba(20,14,10,.28) 45%,rgba(20,14,10,.05) 75%)"></div>` +
      headerOn("rgba(255,255,255,.85)") +
      `<div style="position:absolute;left:64px;right:64px;bottom:150px;z-index:4;background:rgba(22,15,10,.58);border:1px solid rgba(255,255,255,.14);border-radius:26px;padding:52px 56px;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)">` +
        label +
        `<div style="font:900 ${coverHeadSize}px Inter;line-height:1.06;letter-spacing:-.01em;color:#FFFFFF;text-transform:uppercase;text-wrap:balance">${prepCarouselText(slide.headline)}</div>` +
        sub +
      `</div>` + footerPhoto + pill + `</div>`);
  }

  // Бумажные слайды: обложка без фото / контент / список / промпт
  const label = slide.label ? `<div style="font:700 24px Inter;letter-spacing:.2em;text-transform:uppercase;color:${C.muted};margin-bottom:30px">${prepCarouselText(slide.label)}</div>` : "";
  const items = Array.isArray(slide.items) ? slide.items.filter(it => it && (it.title || it.desc)) : [];
  let promptText = String(slide.prompt || "").trim();
  let headlineText = String(slide.headline || "").trim();
  if (!promptText && slide.type === "content" && !items.length && headlineText.length > 90) { promptText = headlineText; headlineText = ""; }

  let inner;
  if (promptText) {
    const pSize = promptFontSize(promptText);
    inner = label +
      (headlineText ? renderEditorialHeadline(headlineText, slide.accent, C.ink, Math.min(headlineFontSize(headlineText), 76)) : "") +
      `<div style="margin-top:40px;border:1.5px solid rgba(0,0,0,.16);border-radius:24px;padding:44px 48px;background:${C.card};box-shadow:${C.cardShadow};font:400 ${pSize}px Inter;line-height:1.5;color:${C.ink};white-space:pre-wrap">${renderPromptHtml(promptText, false)}</div>`;
  } else if (items.length) {
    const cards = items.map((it) =>
      `<div style="background:${C.card};border-radius:22px;padding:36px 42px;box-shadow:${C.cardShadow}">` +
      `<div style="font:800 44px Inter;line-height:1.12;color:${C.ink}">${prepCarouselText(it.title)}</div>` +
      (it.desc ? `<div style="font:400 30px Inter;line-height:1.35;color:${C.muted};margin-top:10px">${prepCarouselText(it.desc)}</div>` : "") +
      `</div>`).join(`<div style="height:26px"></div>`);
    inner = label + (headlineText ? renderEditorialHeadline(headlineText, slide.accent, C.ink, 62) + `<div style="height:40px"></div>` : "") + cards;
  } else if (!isCover && (slide.screenshot || slide.screenshotHint)) {
    // Скрин-слайд: центральная композиция — заголовок сверху, скрин-карточка
    // в середине, подпись-вывод под ней. Пока скрина нет — пунктирный слот
    // с подсказкой, что снять (такой слайд в ленту не уходит, постер проверит).
    const shotCard = slide.screenshot
      ? `<div style="width:100%;background:#FFFFFF;border-radius:24px;padding:16px;box-shadow:${C.cardShadow}"><img src="${slide.screenshot}" style="display:block;width:100%;max-height:620px;object-fit:contain;border-radius:14px"></div>`
      : `<div style="width:100%;min-height:460px;border:3px dashed ${C.muted};border-radius:24px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:18px;padding:44px">` +
          `<div style="font:700 24px Inter;letter-spacing:.22em;color:${C.muted}">СКРИН</div>` +
          `<div style="font:500 36px Inter;line-height:1.3;color:${C.muted};max-width:680px">${prepCarouselText(slide.screenshotHint)}</div>` +
        `</div>`;
    const shotCaption = slide.screenshotCaption
      ? `<div style="font:400 31px Inter;line-height:1.4;color:${C.muted};margin-top:38px;max-width:800px;text-wrap:balance">${prepCarouselText(slide.screenshotCaption)}</div>`
      : "";
    const centered =
      (slide.label ? `<div style="font:700 24px Inter;letter-spacing:.2em;text-transform:uppercase;color:${C.muted};margin-bottom:26px">${prepCarouselText(slide.label)}</div>` : "") +
      renderEditorialHeadline(headlineText, slide.accent, C.ink, Math.min(headlineFontSize(headlineText), 80)) +
      (slide.description ? `<div style="font:400 32px Inter;line-height:1.4;color:${C.muted};margin-top:24px;max-width:820px;text-wrap:balance">${prepCarouselText(slide.description)}</div>` : "") +
      `<div style="width:100%;margin-top:52px">${shotCard}</div>` +
      shotCaption;
    return EDITORIAL_DOC(
      `<div style="position:relative;width:1080px;height:1350px;overflow:hidden;background:${C.paper};font-family:Inter,sans-serif">` +
      headerOn(C.muted) +
      `<div style="position:absolute;left:88px;right:88px;top:170px;bottom:180px;z-index:2;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">${centered}</div>` +
      footerPaper + pill + `</div>`);
  } else {
    const size = isCover ? Math.min(headlineFontSize(headlineText) + 16, 112) : headlineFontSize(headlineText);
    const shot = slide.screenshot
      ? `<div style="margin-top:48px;background:#FFFFFF;border-radius:24px;padding:16px;box-shadow:${C.cardShadow}"><img src="${slide.screenshot}" style="display:block;width:100%;max-height:600px;object-fit:contain;border-radius:14px"></div>`
      : "";
    inner = label +
      renderEditorialHeadline(headlineText, slide.accent, C.ink, size) +
      renderEditorialBody(slide.description, C) +
      shot;
  }

  // Контент по вертикали центрируется — раньше висел у верха и оставлял
  // мёртвую пустоту снизу («шрифт куда-то уезжает»).
  return EDITORIAL_DOC(
    `<div style="position:relative;width:1080px;height:1350px;overflow:hidden;background:${C.paper};font-family:Inter,sans-serif">` +
    headerOn(C.muted) +
    `<div style="position:absolute;left:88px;right:88px;top:170px;bottom:150px;z-index:2;display:flex;flex-direction:column;justify-content:center">${inner}</div>` +
    footerPaper + pill + `</div>`);
}

// Парсер структурированного вывода карусель-мейкера:
// "СЛАЙД N / Тип: / Лейбл: / Заголовок: / Подзаголовок: / Выделить:".
// Есть фоллбэк: если структуры нет — первая строка заголовок, остальное подзаголовок.
function parseCarouselSlides(text) {
  const FIELDS = "Тип|Лейбл|Заголовок|Подзаголовок|Выделить|Пункт|Промпт|Пометка|Скрин|Подпись";
  const parts = String(text || "")
    .split(/(?:^|\n)\s*(?:СЛАЙД|Слайд)\s+\d+\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
  const cleanVal = (v) => String(v || "")
    .split("\n")
    .filter((l) => !/^\s*[-—–]{2,}\s*$/.test(l)) // выкидываем строки-разделители (---)
    .join("\n")
    .trim();
  const field = (chunk, name) => {
    const re = new RegExp(name + "\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:" + FIELDS + ")\\s*:|$)", "i");
    const m = chunk.match(re);
    return m ? cleanVal(m[1]) : "";
  };
  const slides = parts.map(chunk => {
    const rawType = field(chunk, "Тип");
    const label = field(chunk, "Лейбл");
    let headline = field(chunk, "Заголовок");
    let description = field(chunk, "Подзаголовок");
    const accent = field(chunk, "Выделить");
    const prompt = field(chunk, "Промпт");
    const note = field(chunk, "Пометка");
    // Скрин-слот: мейкер планирует место под скриншот («Скрин: что показать»)
    // и вывод под ним («Подпись: ...»). Сам скрин автор пришлёт позже.
    const screenshotHint = field(chunk, "Скрин");
    const screenshotCaption = field(chunk, "Подпись");
    // Пункты списка. Основной формат: "Пункт: заголовок | описание | выделить".
    // Но мейкер часто пишет пункт без разделителя и переносит описание на
    // следующую строку — захватываем весь блок до следующего "Пункт:"/поля,
    // чтобы текст не терялся. С разделителем "|" поведение прежнее.
    const items = [...chunk.matchAll(
      /(?:^|\n)[ \t]*Пункт[ \t]*:[ \t]*([\s\S]*?)(?=\n[ \t]*(?:Пункт|Тип|Лейбл|Заголовок|Подзаголовок|Выделить|Промпт|Пометка|Скрин|Подпись)[ \t]*:|$)/gi
    )].map((m) => {
      const raw = cleanVal(m[1]);
      if (raw.includes("|")) {
        const p = raw.split("|").map((s) => s.trim());
        return { title: p[0] || "", desc: p[1] || "", accent: p[2] || "" };
      }
      const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
      return { title: lines[0] || "", desc: lines.slice(1).join(" "), accent: "" };
    }).filter((it) => it.title || it.desc);
    if (!headline && !items.length) {
      const lines = chunk.split("\n")
        .filter(l => !/^\s*(?:Тип|Лейбл|Заголовок|Подзаголовок|Выделить|Пункт|Промпт|Пометка|Скрин|Подпись|---)\s*:?/i.test(l))
        .map(l => l.trim()).filter(Boolean);
      headline = lines[0] || "";
      if (!description) description = lines.slice(1).join("\n");
    }
    return { rawType, label, headline, description, accent, prompt, note, items, screenshotHint, screenshotCaption };
  }).filter(s => s.headline || s.description || s.prompt || (s.items && s.items.length));

  const total = slides.length;
  slides.forEach((s, i) => {
    if (total === 1) s.type = "cover";
    else if (i === 0) s.type = "cover";
    else if (i === total - 1) s.type = "cta";
    else s.type = "content";
  });
  return slides;
}

// Загружает N случайных фото из Drive (для обложки + контент-слайдов)
async function getMultipleDrivePhotos(n = 2) {
  const folderId = process.env.GOOGLE_PHOTOS_FOLDER_ID;
  if (!folderId) { console.warn("  [Drive] GOOGLE_PHOTOS_FOLDER_ID не задан"); return []; }

  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { console.warn("  [Drive] GOOGLE_SERVICE_ACCOUNT_JSON не парсится"); return []; }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  // Только форматы, которые рендерит Chrome: HEIF/HEIC с айфона в <img>
  // не отображается — слайд выходил с иконкой битой картинки вместо фото.
  const list = await drive.files.list({
    q: `'${folderId}' in parents and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/webp') and trashed = false`,
    fields: "files(id, name, mimeType)",
    pageSize: 100,
  });

  const files = list.data.files || [];
  if (files.length === 0) { console.warn("  [Drive] в папке нет картинок или нет доступа у сервис-аккаунта"); return []; }

  // Выбираем N разных случайных файлов
  const shuffled = [...files].sort(() => Math.random() - 0.5).slice(0, n);
  const photos = [];

  for (const file of shuffled) {
    try {
      const res = await drive.files.get(
        { fileId: file.id, alt: "media" },
        { responseType: "arraybuffer" }
      );
      const mime = file.mimeType || "image/jpeg";
      const b64  = Buffer.from(res.data).toString("base64");
      photos.push(`data:${mime};base64,${b64}`);
    } catch (err) {
      console.warn(`  [Drive] не смог загрузить ${file.name}:`, err.message);
    }
  }
  return photos;
}

// Убирает эмодзи/пиктограммы (шрифт их не рисует → квадраты). Сохраняет
// стрелки (U+2190–21FF) и геом. фигуры (U+25xx: ● маркер дизайна).
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
function stripEmoji(text) {
  return text.replace(EMOJI_RE, "").replace(/[ \t]{2,}/g, " ");
}

// Разделяет текст карусели на слайды и Instagram caption (если есть).
// Возвращает { slides, caption } где caption может быть пустой строкой.
function extractCarouselCaption(output) {
  const marker = /^INSTAGRAM CAPTION:\s*/im;
  const match = output.search(marker);
  if (match === -1) return { slides: output, caption: "" };
  const slides = output.slice(0, match).trim();
  const caption = output.slice(match).replace(marker, "").trim();
  return { slides, caption };
}

// Чеклист скринов: какие слайды ждут скриншот от автора (слот запланирован
// мейкером, картинка ещё не пришла). Пустая строка — ждать нечего.
function screenshotChecklist(data) {
  const waiting = (Array.isArray(data) ? data : [])
    .map((s, i) => s && s.screenshotHint && !s.screenshot ? `слайд ${i + 1} — ${s.screenshotHint}` : null)
    .filter(Boolean);
  if (!waiting.length) return "";
  return `📸 Скрины для карусели (пришли фото с подписью «скрин на слайд N»):\n${waiting.join("\n")}`;
}

// Стиль карусели: "classic" (тёмный, текущий) или "editorial" (+тинт beige/cream).
// Приоритет: слово в текущем задании («в эдиториале», «беж»/«крем») → дефолт из
// state/carousel_style.txt («карусели в эдиториале по умолчанию») → classic.
const CAROUSEL_STYLE_FILE = path.join(STATE_DIR, "carousel_style.txt");
async function getCarouselStyle() {
  const brief = (
    (await readState("analyst").catch(() => "")) + " " + (await readState("manager").catch(() => ""))
  ).toLowerCase();
  let style = null, tint = null;
  if (/эдиториал|editorial/.test(brief)) style = "editorial";
  if (/в классик|классическ\w+ стил|тёмн\w+ стил|темн\w+ стил/.test(brief)) style = "classic";
  // без \b: word boundary в JS не работает с кириллицей
  if (/беж/.test(brief)) tint = "beige";
  if (/крем/.test(brief)) tint = "cream";
  const saved = (await fs.readFile(CAROUSEL_STYLE_FILE, "utf8").catch(() => "")).trim();
  if (!style) style = saved.startsWith("editorial") ? "editorial" : "classic";
  if (!tint) tint = saved.endsWith("cream") ? "cream" : "beige";
  return { style, tint };
}

async function generateCarouselHtml(carouselText, coverOverride = null, screenshots = null) {
  lastEditedSlide = null; // новая карусель — сбрасываем память правок
  console.log("  [Карусель PNG] загружаю фото из Google Drive...");
  const photos = await getMultipleDrivePhotos(coverOverride ? 1 : 2).catch((err) => {
    console.warn("  [Drive] ошибка:", err.message);
    return [];
  });
  if (!photos.length && !coverOverride) console.warn("  [Drive] фото НЕ загрузились (папка пуста, нет переменных или нет доступа) — обложка и CTA выйдут без фото!");
  else console.log(`  [Drive] загружено фото: ${photos.length}${coverOverride ? " + обложка из файла" : ""}`);
  // Конкретное фото на обложку (CLI-аргумент): Drive тогда остаётся только для CTA.
  const coverPhoto = coverOverride || photos[0] || null;
  const ctaPhoto   = coverOverride ? (photos[0] || coverOverride) : (photos[1] || photos[0] || null);

  console.log("  [Карусель PNG] разбираю структуру слайдов...");
  const data = parseCarouselSlides(carouselText);
  if (!data.length) throw new Error("не удалось разобрать слайды из текста карусели");

  // Скрины по номерам слайдов (CLI-аргументы «N=файл»): кладутся в слот сразу,
  // без отдельного шага «скрин на слайд N» через бота.
  if (screenshots) for (const [n, uri] of Object.entries(screenshots)) {
    const i = parseInt(n, 10) - 1;
    if (data[i]) data[i].screenshot = uri;
    else console.warn(`  [Скрин] слайда ${n} нет — пропускаю`);
  }

  const { style, tint } = await getCarouselStyle();

  // Фото по позиции: обложка (первый) + CTA (последний), на средних — нет.
  // С 8 июля CTA в эдиториале тоже с фото по умолчанию (просьба автора).
  const total = data.length;
  data.forEach((slide, i) => {
    if (i === 0) slide.photo = coverPhoto;
    else if (i === total - 1 && total > 1) slide.photo = ctaPhoto;
    else slide.photo = null;
  });

  // Рендер строго по сетке — одинаковые отступы на всех слайдах.
  const slides = data.map((slide, i) => style === "editorial"
    ? renderEditorialSlide(slide, i, total, slide.photo, tint)
    : renderCarouselSlide(slide, i, total, slide.photo));

  // Сохраняем данные (для правок), готовый HTML и стиль (для перерендера слайда).
  await writeState("carousel_data", JSON.stringify(data));
  await writeState("carousel_html", JSON.stringify(slides));
  await writeState("carousel_meta", JSON.stringify({ style, tint }));
  console.log(`  [Карусель PNG] готово: ${slides.length} слайдов, стиль ${style}${style === "editorial" ? "/" + tint : ""}`);
  return slides;
}
// Ищет браузер для Puppeteer:
// 1. PUPPETEER_EXECUTABLE_PATH — если задан и файл существует
// 2. which chromium / chromium-browser / google-chrome — системный браузер (Railway)
// 3. null — Puppeteer использует свой скачанный Chrome (локальная машина)
async function findChromium() {
  const { existsSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    // Puppeteer читает эту переменную сам, даже если executablePath не передан —
    // битый путь (например серверный /usr/bin/chromium при локальном запуске
    // через railway run) надо убрать из env, иначе launch падает.
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
    console.warn(`  [Карусель PNG] PUPPETEER_EXECUTABLE_PATH битый (${envPath}) — убрала, ищу браузер сама`);
  }

  for (const bin of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const found = execSync(`which ${bin}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (found && existsSync(found)) return found;
    } catch { /* нет такого бинарника — пробуем следующий */ }
  }
  return null;
}

// startIndex — с какого слайда нумеровать файлы (правка одного слайда N пишет
// slide_0N.png, а не затирает slide_01). clean — снести старые PNG перед полным
// рендером, иначе хвост от прошлой более длинной карусели уйдёт в публикацию.
async function renderSlidesToPng(htmlSlides, { startIndex = 0, clean = true } = {}) {
  const tmpDir = path.join(__dirname, "state", "carousel_png");
  await fs.mkdir(tmpDir, { recursive: true });

  if (clean) {
    const old = (await fs.readdir(tmpDir).catch(() => [])).filter((f) => f.endsWith(".png"));
    await Promise.all(old.map((f) => fs.unlink(path.join(tmpDir, f)).catch(() => {})));
    if (old.length) console.log(`  [Карусель PNG] очистила ${old.length} старых файлов`);
  }

  console.log("  [Карусель PNG] запускаю Puppeteer...");
  // На сервере используем системный Chromium, локально Puppeteer найдёт свой Chrome.
  // PUPPETEER_EXECUTABLE_PATH проверяем на существование — если путь битый, ищем сами.
  const launchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  };
  const chromiumPath = await findChromium();
  if (chromiumPath) {
    launchOptions.executablePath = chromiumPath;
    console.log(`  [Карусель PNG] браузер: ${chromiumPath}`);
  }
  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });

  const paths = [];
  for (let i = 0; i < htmlSlides.length; i++) {
    // Вшиваем шрифты (base64) прямо перед рендером — в state HTML остаётся лёгким.
    const fontCss = `${CAROUSEL_FONT_CSS || ""}${EDITORIAL_FONT_CSS || ""}`;
    const html = fontCss
      ? htmlSlides[i].replace("<style>", `<style>${fontCss}`)
      : htmlSlides[i];
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10000 });
    await new Promise((r) => setTimeout(r, 800)); // даём время шрифтам отрисоваться
    const filePath = path.join(tmpDir, `slide_${String(startIndex + i + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: filePath, type: "png" });
    paths.push(filePath);
    console.log(`  [Карусель PNG] слайд ${startIndex + i + 1} → ${path.basename(filePath)}`);
  }

  await browser.close();
  console.log(`  [Карусель PNG] готово: ${paths.length} файлов в state/carousel_png/`);
  return paths;
}

async function sendPhotoAlbum(token, chatId, threadId, imagePaths, caption = "") {
  // Telegram sendMediaGroup принимает до 10 фото
  const MAX_PER_GROUP = 10;
  for (let start = 0; start < imagePaths.length; start += MAX_PER_GROUP) {
    const batch = imagePaths.slice(start, start + MAX_PER_GROUP);
    const formData = new FormData();
    const media    = [];

    for (let i = 0; i < batch.length; i++) {
      const buf = await fs.readFile(batch[i]);
      const key = `photo${i}`;
      formData.append(key, new Blob([buf], { type: "image/png" }), `slide_${start + i + 1}.png`);
      media.push({
        type:  "photo",
        media: `attach://${key}`,
        ...(i === 0 && caption ? { caption } : {}),
      });
    }

    formData.append("chat_id",   chatId);
    formData.append("media",     JSON.stringify(media));
    if (threadId) formData.append("message_thread_id", String(threadId));

    // Сеть Railway→Telegram иногда моргает («fetch failed») — из-за одной
    // осечки вся карусель падала в текстовый фолбэк. До 3 попыток на батч,
    // повторяем только сетевые ошибки и 5xx/429; прочие 4xx лечить нечем.
    let sent = false, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
      let res = null;
      try {
        res = await tgFetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
          method: "POST",
          body:   formData,
        }, 90_000); // аплоад до 10 PNG — даём больше обычного вызова
      } catch (err) {
        lastErr = err;
      }
      if (res) {
        if (res.ok) { sent = true; break; }
        const body = await res.text();
        lastErr = new Error(`sendMediaGroup failed: ${res.status} ${body.slice(0, 200)}`);
        if (res.status < 500 && res.status !== 429) throw lastErr;
      }
      if (attempt < 3) {
        console.warn(`  [Album] попытка ${attempt} не прошла (${lastErr.message}) — повторяю`);
        await new Promise((r) => setTimeout(r, attempt * 3000));
      }
    }
    if (!sent) throw lastErr;
  }
}

// ─────────────────────────────────────────────────────────────
// ОЧЕРЕДЬ ЗАПУСКОВ — в каждый момент работает ровно одна цепочка.
// Telegram отдаёт каждое сообщение только одному getUpdates-циклу,
// поэтому параллельные агенты воруют сообщения друг у друга и
// перемешивают контекст. Все запуски (крон, голос, run-all)
// сериализуются через эту очередь.
// ─────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════
// ДАШБОРД АГЕНТОВ — статус, история, правки инструкций/результата,
// запуск/кооперативный стоп. Всё это читает/пишет мини-апп в Telegram
// (HTTP-сервер поднимается в основном режиме, см. startDashboardServer).
// ═════════════════════════════════════════════════════════════

// Агенты, которые показываем и которыми управляем из дашборда. Только
// content-агенты на runAgent. Публикатор сюда НЕ входит намеренно —
// публикация необратима и остаётся ручной (кнопки «опубликовать» нет).
const DASHBOARD_AGENTS = ["analyst", "manager", "copywriter", "carousel", "reels", "threads"]
  .filter((k) => AGENTS[k]);

// Особые карточки: не runAgent-агенты.
// publisher — Публикатор (запуск по кнопке с подтверждением, публикация необратима).
// reviewer  — Ревизор (сам не запускается, показываем его доклады и историю).
// guide — Гайд-мейкер (отдельный поток, не в AGENTS): запускается командой
// «сделай гайд про X», в дашборде — статус, история и правка его инструкции.
const SPECIAL_CARDS = { guide: "Гайд-мейкер", publisher: "Публикатор", reviewer: "Ревизор" };
const DASHBOARD_CARDS = [...DASHBOARD_AGENTS, "guide", "publisher", "reviewer"];
function cardName(key) { return AGENTS[key]?.name || SPECIAL_CARDS[key] || key; }
function cardKind(key) {
  if (key === "publisher") return "publisher";
  if (key === "reviewer") return "reviewer";
  if (key === "guide") return "guide";
  return "content";
}

const AGENT_STATUS_FILE = path.join(STATE_DIR, "agent_status.json");
const AGENT_RUNS_FILE   = path.join(STATE_DIR, "agent_runs.jsonl");
const PROMPT_OVERRIDE_DIR = path.join(STATE_DIR, "prompt_overrides");

// Кооперативная отмена: агент в своём цикле проверяет этот набор на безопасных
// точках. Оборвать запрос к Claude на полуслове нельзя — стоп сработает перед
// следующей итерацией/шагом, а не мгновенно.
const cancelRequested = new Set();
function requestAgentCancel(key) { cancelRequested.add(key); }
function isCancelRequested(key) { return cancelRequested.has(key); }
function clearAgentCancel(key) { cancelRequested.delete(key); }

async function readStatusMap() {
  try { return JSON.parse(await fs.readFile(AGENT_STATUS_FILE, "utf8")); }
  catch { return {}; }
}
async function writeStatusMap(map) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(AGENT_STATUS_FILE, JSON.stringify(map, null, 2), "utf8");
}
async function setAgentStatus(key, patch) {
  const map = await readStatusMap();
  map[key] = { ...(map[key] || {}), ...patch };
  await writeStatusMap(map);
}
function outputPreview(output, n = 400) {
  return String(output || "").trim().slice(0, n);
}

// Лента истории запусков: append-only JSONL, при чтении отдаём последние ~50.
async function appendRunHistory(entry) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  await fs.appendFile(AGENT_RUNS_FILE, line, "utf8").catch(() => {});
}
async function readRunHistory(limit = 50) {
  try {
    const raw = await fs.readFile(AGENT_RUNS_FILE, "utf8");
    const rows = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit).reverse();
  } catch { return []; }
}

// Переопределение системного промпта. Файл есть → берём его, иначе — заводской
// из AGENTS[key].system. Так автор правит характер агента, не трогая код.
// Заводской промпт карточки. Content-агенты — из AGENTS, особые (гайд-мейкер) —
// из своих констант (GUIDE_SYSTEM определён ниже, резолвится в момент вызова).
function defaultPromptFor(key) {
  if (AGENTS[key]) return AGENTS[key].system || "";
  if (key === "guide") return GUIDE_SYSTEM;
  return "";
}
async function getSystemPrompt(key) {
  const file = path.join(PROMPT_OVERRIDE_DIR, `${key}.txt`);
  const override = await fs.readFile(file, "utf8").catch(() => null);
  if (override && override.trim()) return override;
  return defaultPromptFor(key);
}
async function setPromptOverride(key, text) {
  await fs.mkdir(PROMPT_OVERRIDE_DIR, { recursive: true });
  await fs.writeFile(path.join(PROMPT_OVERRIDE_DIR, `${key}.txt`), String(text || ""), "utf8");
}
async function resetPromptOverride(key) {
  await fs.rm(path.join(PROMPT_OVERRIDE_DIR, `${key}.txt`), { force: true });
}
async function hasPromptOverride(key) {
  const file = path.join(PROMPT_OVERRIDE_DIR, `${key}.txt`);
  const t = await fs.readFile(file, "utf8").catch(() => "");
  return !!t.trim();
}

let CHAIN_BUSY = false;     // true пока работает цепочка — голосовой слушатель молчит
let LAST_DECISION = null;   // решение автора по последнему агенту ("ok"/"stop"/...)
let chainQueue = Promise.resolve();

function runChain(keys, label = "цепочка", prepare = null) {
  const task = chainQueue.then(async () => {
    CHAIN_BUSY = true;
    try {
      console.log(`[Queue] старт: ${label} [${keys.join(", ")}]`);
      // prepare выполняется внутри очереди — чтобы два голосовых подряд
      // не перезаписали идеи друг друга до старта своих цепочек
      if (prepare) await prepare();
      for (const key of keys) {
        await runAgentReviewed(key);
        if (LAST_DECISION === "stop") {
          console.log(`[Queue] "стоп" — отменяю оставшихся агентов (${label})`);
          break;
        }
      }
    } finally {
      CHAIN_BUSY = false;
    }
  });
  // Очередь не должна умирать от ошибки одной цепочки
  chainQueue = task.catch(() => {});
  return task;
}

// ─────────────────────────────────────────────────────────────
// РЕВИЗОР — надзиратель за прогонами агентов.
// После каждого прогона проверяет результат на техбрак и на брак в контенте.
// Техбрак чинит обратимо (1 повтор прогона), контент-fail — 1 перегенерация.
// НИКОГДА не публикует и не удаляет: пишет только в чат одобрения, тебе.
// Публичный постинг (runPublisher) он не трогает вообще.
// ─────────────────────────────────────────────────────────────
const REVIEW_MODEL = "claude-haiku-4-5-20251001"; // дешёвая модель для проверки

// Куда Ревизор шлёт свои доклады — тот же чат одобрения, что у агентов.
async function sendReview(text) {
  // Доклад также попадает в дашборд: карточка Ревизора и его лента.
  setAgentStatus("reviewer", { state: "done", finishedAt: Date.now(), outputPreview: outputPreview(text), error: null }).catch(() => {});
  appendRunHistory({ key: "reviewer", name: "Ревизор", ok: true, preview: outputPreview(text, 300) }).catch(() => {});
  const token  = APPROVAL_TOKEN || process.env.TELEGRAM_BOT_TOKEN_1;
  const chatId = APPROVAL_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  const thread = APPROVAL_TOPIC_ID || null;
  console.log(`[Ревизор] ${text}`); // дубль в лог — чтобы доклад был виден и в консоли/Railway
  if (!token || !chatId) return;
  try { await sendToChat(token, chatId, `🔎 Ревизор · ${text}`, thread); }
  catch (e) { console.warn(`[Ревизор] не смог отправить доклад: ${e.message}`); }
}

// Техпроверка: упал ли прогон, пустой ли/обрезанный результат, цела ли структура.
// Возвращает { ok, reason }. reason заполнен только когда ok=false.
function technicalCheck(key, output, error) {
  if (error) return { ok: false, reason: `упал с ошибкой (${String(error.message || error).slice(0, 120)})` };
  const text = String(output || "").trim();
  if (!text)            return { ok: false, reason: "вернул пустой результат" };
  if (text.length < 40) return { ok: false, reason: `подозрительно короткий результат (${text.length} симв.)` };
  // Для агентов с картинками результат обязан разбираться в слайды.
  if (AGENTS[key]?.generateImages) {
    try {
      const slides = parseCarouselSlides(text);
      if (!slides || slides.length < 2)
        return { ok: false, reason: `карусель не разобралась в слайды (${slides ? slides.length : 0})` };
    } catch (e) {
      return { ok: false, reason: `карусель не разобралась: ${e.message}` };
    }
  }
  return { ok: true };
}

// Контент-проверка через дешёвую модель. Возвращает { verdict: ok|warn|fail, reason }.
// Ловит именно брак (мусор, обрыв, нарушение правил автора), а не придирки к стилю.
async function reviewContent(key, output) {
  const agent = AGENTS[key];
  const system = loadPrompt("ревизор");
  const user = `Роль агента: ${agent?.name || key}\n\nВывод агента:\n"""\n${String(output).slice(0, 6000)}\n"""`;
  try {
    const res = await anthropic.messages.create({
      model: REVIEW_MODEL,
      max_tokens: 200,
      system: cleanText(system),
      messages: [{ role: "user", content: cleanText(user) }],
    });
    const raw = res.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const verdict = (raw.match(/VERDICT:\s*(ok|warn|fail)/i)?.[1] || "ok").toLowerCase();
    const reason  = (raw.match(/REASON:\s*(.+)/i)?.[1] || "").trim();
    return { verdict, reason };
  } catch (e) {
    // Проверка недоступна (нет доступа к модели, сбой сети) — не блокируем прогон.
    console.warn(`[Ревизор] контент-проверка недоступна: ${e.message}`);
    return { verdict: "ok", reason: "" };
  }
}

// Обёртка над runAgent: прогоняет агента и ревизует результат.
// Техбрак → 1 повтор прогона. Контент-fail → 1 перегенерация (черновик уходит в чат
// одобрения, не в публичный канал). Здоровый прогон проходит молча.
async function runAgentReviewed(key) {
  const name = AGENTS[key]?.name || key;
  let output = null, error = null;
  try { output = await runAgent(key); }
  catch (e) { error = e; }

  // 1) Техпроверка + обратимый автофикс
  let tech = technicalCheck(key, output, error);
  if (!tech.ok) {
    await sendReview(`🔧 ${name}: ${tech.reason}. Перезапускаю один раз…`);
    error = null;
    try { output = await runAgent(key); }
    catch (e) { error = e; output = null; }
    tech = technicalCheck(key, output, error);
    if (!tech.ok) {
      await sendReview(`⚠️ ${name}: ${tech.reason}. Автофикс не помог — глянь сам.`);
      return output;
    }
    await sendReview(`✅ ${name}: перезапуск помог, теперь ок.`);
  }

  // 2) Контент-проверка
  if (output && String(output).trim()) {
    const v = await reviewContent(key, output);
    if (v.verdict === "fail") {
      await sendReview(`⚠️ ${name}: брак в контенте — ${v.reason || "без деталей"}. Перегенерирую один раз…`);
      let out2 = null;
      try { out2 = await runAgent(key); } catch (e) { out2 = null; }
      if (!out2 || !String(out2).trim()) {
        await sendReview(`⚠️ ${name}: перегенерация не удалась — глянь сам.`);
      } else {
        const v2 = await reviewContent(key, out2);
        output = out2;
        if (v2.verdict === "fail")
          await sendReview(`⚠️ ${name}: и после перегенерации брак — ${v2.reason || "без деталей"}. Глянь сам, публиковать не стал бы.`);
        else
          await sendReview(`✅ ${name}: перегенерация чище, ушла тебе в чат.`);
      }
    } else if (v.verdict === "warn") {
      await sendReview(`🟡 ${name}: мелочь — ${v.reason || "глянь на всякий"}. На твоё усмотрение.`);
    }
    // ok — молчим, не спамим зелёным
  }
  return output;
}

// Обёртка со статусом для дашборда: помечает агента «работает» → «готово»/«ошибка»,
// пишет ленту истории и снимает флаг отмены. Ядро (runAgentCore) не меняется.
async function runAgent(key) {
  clearAgentCancel(key);
  const startedAt = Date.now();
  await setAgentStatus(key, { state: "running", startedAt, finishedAt: null, error: null }).catch(() => {});
  try {
    const output = await runAgentCore(key);
    const finishedAt = Date.now();
    const cancelled = isCancelRequested(key);
    await setAgentStatus(key, {
      state: cancelled ? "idle" : "done",
      finishedAt, durationMs: finishedAt - startedAt,
      outputPreview: outputPreview(output), error: null,
    }).catch(() => {});
    await appendRunHistory({ key, name: AGENTS[key]?.name || key, ok: true, cancelled, durationMs: finishedAt - startedAt, preview: outputPreview(output, 200) });
    clearAgentCancel(key);
    return output;
  } catch (e) {
    const finishedAt = Date.now();
    await setAgentStatus(key, { state: "error", finishedAt, durationMs: finishedAt - startedAt, error: String(e.message || e).slice(0, 300) }).catch(() => {});
    await appendRunHistory({ key, name: AGENTS[key]?.name || key, ok: false, error: String(e.message || e).slice(0, 200) });
    clearAgentCancel(key);
    throw e;
  }
}

async function runAgentCore(key) {
  await ensureStateDir();
  const agent = AGENTS[key];
  if (!agent) throw new Error(`Unknown agent: ${key}`);
  LAST_DECISION = null;

  const state = {};
  for (const dep of agent.inputs) {
    state[dep] = await readState(dep);
    if (!state[dep]) {
      console.warn(`[${agent.name}] нет данных от ${dep}, продолжаю с пустым контекстом`);
    }
  }

  const useApproval = !!(APPROVAL_TOKEN && APPROVAL_CHAT_ID && MAIN_CHANNEL_ID);

  // Базовый промпт вычисляем один раз — Tavily не перезапускается на каждой итерации
  const basePrompt = await agent.userPrompt(state);

  let creativeDirection = null; // творческое задание от автора (любое свободное сообщение)
  let redoCount = 0;            // счётчик команд "переделай" (не включает творческие направления)
  let prevOutput = null;        // предыдущий черновик — нужен чтобы агент понимал контекст правки
  let keepText = false;         // "перерисуй" — оставить текст, перерендерить только дизайн
  let validateRetries = 0;      // авторетраи по agent.validate (число слайдов и т.п.)
  let lastValidateIssue = null; // последняя претензия валидатора — чтобы отличать её от идей автора

  while (true) {
    // Кооперативный стоп из дашборда: сработает перед новой генерацией.
    if (isCancelRequested(key)) {
      console.log(`[${agent.name}] запрошен стоп из дашборда — останавливаюсь`);
      return await readState(key);
    }
    if (redoCount > MAX_RETRIES) {
      console.warn(`[${agent.name}] исчерпаны попытки переделки (${MAX_RETRIES}), пропускаю`);
      return await readState(key);
    }

    const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
    const label = creativeDirection
      ? `идея автора`
      : `попытка ${redoCount + 1}/${MAX_RETRIES}`;
    console.log(`[${ts}] ${agent.name} — генерирую (${label})...`);

    // Если пришло творческое направление — передаём предыдущий контент + правку автора
    // Агент видит что именно она комментирует и сразу генерирует новую версию без вопросов
    const userMsg = creativeDirection
      ? `${basePrompt}\n\n` +
        `Предыдущая версия которую ты сгенерировал:\n\n${prevOutput}\n\n` +
        `Правка от автора: "${creativeDirection}"\n\n` +
        `Сгенерируй новую версию с учётом этой правки. Не задавай вопросов, не проси уточнений — просто сделай новую версию прямо сейчас.`
      : basePrompt;

    let output;
    let skipValidate = false;
    if (keepText && prevOutput) {
      // "перерисуй" — текст одобренной версии не трогаем, заново только дизайн
      output = prevOutput;
      keepText = false;
      skipValidate = true; // текст сохраняем намеренно — не гоняем по валидатору
      console.log(`[${ts}] ${agent.name} — перерисовываю с тем же текстом`);
    } else {
      output = await callClaude(await getSystemPrompt(key), userMsg);
      if (agent.humanize) {
        console.log(`[${ts}] ${agent.name} → humanizer...`);
        output = await callHumanizer(output);
      }
    }

    // Жёсткая проверка результата (например: число слайдов = числу из задания).
    // Не сошлось — автоматически перегенерируем с конкретной претензией, до 2 раз.
    if (agent.validate && !skipValidate) {
      let issue = null;
      try { issue = agent.validate(output, state); } catch (e) { console.warn(`[${agent.name}] validate упал:`, e.message); }
      if (issue && validateRetries < 2) {
        validateRetries++;
        prevOutput = output;
        creativeDirection = issue;
        lastValidateIssue = issue;
        console.warn(`[${ts}] ${agent.name} — не прошёл проверку (${validateRetries}/2): ${issue.slice(0, 100)}`);
        continue;
      }
      if (issue) console.warn(`[${ts}] ${agent.name} — проверка не сошлась после 2 ретраев, отправляю как есть`);
      // Проверка пройдена: претензия валидатора — не «идея автора», убираем из контекста
      if (creativeDirection && creativeDirection === lastValidateIssue) creativeDirection = null;
    }
    await writeState(key, output);
    if (key === "analyst") {
      await pushRecentAnalyst(output).catch(() => {}); // история тем для анти-повтора
      await saveAnalystSummary(output).catch(() => {}); // «раскрой тему N» берёт темы отсюда
    }
    if (key === "copywriter") await pushRecentCopy(output).catch(() => {}); // память форм и тем постов
    prevOutput = output; // запоминаем для следующей итерации

    if (!useApproval || AUTONOMOUS) {
      if (MUTED) {
        console.log(`[${ts}] ${agent.name} → замьючен, сохранено в стейт (${output.length} симв.)`);
        return output;
      }

      // Автономный режим: отправляем контент чисто, без заголовков и кнопок
      const destToken  = APPROVAL_TOKEN  || agent.token;
      const destChat   = APPROVAL_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
      const destThread = APPROVAL_TOPIC_ID || null;

      if (agent.generateImages) {
        try {
          const { slides: slidesText, caption: igCaption } = extractCarouselCaption(output);
          const htmlSlides = await generateCarouselHtml(slidesText);
          const imgs = await renderSlidesToPng(htmlSlides);
          await sendPhotoAlbum(destToken, destChat, destThread, imgs);
          await sendToChat(destToken, destChat, `Текст слайдов:\n\n${slidesText}`, destThread);
          if (igCaption) await sendToChat(destToken, destChat, `Подпись под каруселью:\n\n${igCaption}`, destThread);
          try {
            const checklist = screenshotChecklist(JSON.parse(await readState("carousel_data")));
            if (checklist) await sendToChat(destToken, destChat, checklist, destThread);
          } catch {}
          console.log(`[${ts}] ${agent.name} → ${imgs.length} PNG автономно`);
        } catch (err) {
          console.error(`  [${agent.name}] PNG ошибка: ${err.message} — отправляю текст`);
          await sendToChat(destToken, destChat, output, destThread);
        }
      } else {
        await sendToChat(destToken, destChat, output, destThread);
        console.log(`[${ts}] ${agent.name} → текст автономно (${output.length} симв.)`);
      }
      return output;
    }

    // Фиксируем offset ДО отправки, чтобы не пропустить ответ
    const startOffset = await getUpdateOffset();

    // Формируем сообщение одобрения — показываем идею если была
    const directionLine = creativeDirection ? `Идея: "${creativeDirection}"\n` : "";
    const hint = agent.dialogue
      ? `Задай вопрос, попроси изменить или напиши "ок" чтобы передать дальше`
      : agent.generateImages
        ? `Ответь: ок / переделай (всё заново) / перерисуй (тот же текст, новый дизайн) / стоп — или напиши правку`
        : `Ответь: ок / переделай / стоп — или напиши свою идею`;
    const headerMsg =
      `${agent.name} · ${label} · ${ts}\n` +
      directionLine + hint + "\n" +
      `${"─".repeat(30)}`;

    // Если агент генерирует PNG — рендерим и отправляем альбом
    let imagePaths = [];
    let carouselCaption = "";
    if (agent.generateImages) {
      try {
        const { slides: slidesText, caption: igCaption } = extractCarouselCaption(output);
        carouselCaption = igCaption;
        const htmlSlides = await generateCarouselHtml(slidesText);
        imagePaths = await renderSlidesToPng(htmlSlides);
        await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, headerMsg, APPROVAL_TOPIC_ID);
        await sendPhotoAlbum(APPROVAL_TOKEN, APPROVAL_CHAT_ID, APPROVAL_TOPIC_ID, imagePaths);
        // Исходный текст слайдов — для сверки с картинками и копирования в подпись
        await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
          `Текст слайдов (источник):\n\n${slidesText}`, APPROVAL_TOPIC_ID);
        if (igCaption) await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
          `Подпись под каруселью:\n\n${igCaption}`, APPROVAL_TOPIC_ID);
        try {
          const checklist = screenshotChecklist(JSON.parse(await readState("carousel_data")));
          if (checklist) await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, checklist, APPROVAL_TOPIC_ID);
        } catch {}
        console.log(`[${ts}] ${agent.name} → ${imagePaths.length} PNG в топик одобрения`);
      } catch (err) {
        console.error(`  [${agent.name}] PNG ошибка: ${err.message} — отправляю текст`);
        imagePaths = [];
        await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
          headerMsg + "\n\n" + output, APPROVAL_TOPIC_ID);
      }
    } else {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        headerMsg + "\n\n" + output, APPROVAL_TOPIC_ID);
    }
    console.log(`[${ts}] ${agent.name} → топик одобрения (thread ${APPROVAL_TOPIC_ID ?? "—"})`);

    // Диалоговый режим — агент отвечает на вопросы в чате
    if (agent.dialogue) {
      const initialMessages = [
        { role: "user",      content: userMsg },
        { role: "assistant", content: output  },
      ];
      const { decision, output: dialogueOutput } = await waitForApprovalDialogue(
        agent.name, agent.system, initialMessages, startOffset
      );
      LAST_DECISION = decision;

      if (decision === "ok") {
        await writeState(key, dialogueOutput);
        const pubMsg = `${agent.name} · ${ts}\n\n${dialogueOutput}`;
        await sendToChat(APPROVAL_TOKEN, MAIN_CHANNEL_ID, pubMsg);
        console.log(`[${ts}] ${agent.name} ✓ опубликован в основной канал`);
        return dialogueOutput;
      }
      if (decision === "stop" || decision === "timeout") {
        console.log(`[${ts}] ${agent.name} — пропущен (${decision})`);
        return output;
      }
      if (decision === "redo") {
        redoCount++;
        console.log(`[${ts}] ${agent.name} → переделываю с нуля (${redoCount}/${MAX_RETRIES})...`);
        continue;
      }
    }

    // Стандартный режим одобрения
    const decision = await waitForApproval(agent.name, startOffset);
    LAST_DECISION = ["ok", "redo", "stop", "timeout"].includes(decision) ? decision : "direction";

    if (decision === "ok") {
      if (imagePaths.length > 0) {
        // Отправляем PNG альбом в основной канал
        await sendPhotoAlbum(APPROVAL_TOKEN, MAIN_CHANNEL_ID, null, imagePaths,
          `${agent.name} · ${ts}`);
        // Подпись под каруселью — готова для копирования в Instagram
        if (carouselCaption) await sendToChat(APPROVAL_TOKEN, MAIN_CHANNEL_ID,
          `Подпись под каруселью:\n\n${carouselCaption}`);
        console.log(`[${ts}] ${agent.name} ✓ ${imagePaths.length} PNG опубликованы`);
      } else {
        const pubMsg = `${agent.name} · ${ts}\n\n${output}`;
        await sendToChat(APPROVAL_TOKEN, MAIN_CHANNEL_ID, pubMsg);
        console.log(`[${ts}] ${agent.name} ✓ опубликован в основной канал`);
      }
      return output;
    }

    if (decision === "stop" || decision === "timeout") {
      console.log(`[${ts}] ${agent.name} — пропущен (${decision})`);
      return output;
    }

    if (decision === "redo") {
      redoCount++;
      creativeDirection = null;
      console.log(`[${ts}] ${agent.name} → переделываю (${redoCount}/${MAX_RETRIES})...`);
      continue;
    }

    if (decision === "redesign") {
      if (agent.generateImages) {
        keepText = true;
        creativeDirection = null;
        console.log(`[${ts}] ${agent.name} → перерисовываю дизайн, текст тот же...`);
        continue;
      }
      // У текстовых агентов перерисовывать нечего — считаем как "переделай"
      redoCount++;
      continue;
    }

    // Любой другой текст — творческое направление от автора
    // Не считается как попытка "переделай", не ограничено MAX_RETRIES
    creativeDirection = decision;
    console.log(`[${ts}] ${agent.name} → принял идею, перегенерирую...`);
  }
}

// ─────────────────────────────────────────────────────────────
// POSTMYPOST PUBLISHER
// Env: POSTMYPOST_API_TOKEN, POSTMYPOST_PROJECT_ID
// Project ID виден в URL когда открываешь проект: /projects/12345/...
// ─────────────────────────────────────────────────────────────
const PMP_BASE = "https://api.postmypost.io/v4.1";

async function pmpRequest(method, endpt, body = null, qs = {}) {
  const token = process.env.POSTMYPOST_API_TOKEN;
  if (!token) throw new Error("POSTMYPOST_API_TOKEN не задан в Railway");
  let url = `${PMP_BASE}${endpt}`;
  const keys = Object.keys(qs);
  if (keys.length) url += "?" + keys.map(k => `${k}=${encodeURIComponent(qs[k])}`).join("&");
  const opts = {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PostMyPost ${method} ${endpt}: ${res.status} — ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// chanel_id (опечатка в их API) → код сети
const PMP_CHANEL = { instagram: 1, telegram: 6, threads: 17 };
const PMP_CHANEL_NAME = { 1: "Instagram", 6: "Telegram", 17: "Threads" };

// Загружает список подключённых аккаунтов, группирует по chanel_id
async function pmpGetAccounts() {
  const pid = process.env.POSTMYPOST_PROJECT_ID;
  if (!pid) throw new Error("POSTMYPOST_PROJECT_ID не задан в Railway");
  const data = await pmpRequest("GET", "/accounts", null, { project_id: pid, per_page: 50 });
  const accounts = data.data || data || [];
  console.log(`  [PMP] аккаунтов: ${accounts.length}`);
  return accounts;
}

// Загружает PNG-файл в PostMyPost, возвращает file_id
async function pmpUploadFile(filePath, fileName) {
  const pid = process.env.POSTMYPOST_PROJECT_ID;
  const stat = await fs.stat(filePath);

  // Шаг 1: инициализация загрузки
  const init = await pmpRequest("POST", "/upload/init", {
    project_id: Number(pid),
    name: fileName,
    size: stat.size,
  });
  const uploadId  = init.id  ?? init.data?.id;
  const uploadUrl = init.url ?? init.data?.url;
  if (!uploadId || !uploadUrl) throw new Error("PMP upload/init: не получен id или url");

  // Шаг 2: PUT файла на полученный URL
  const buf = await fs.readFile(filePath);
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "Content-Length": String(stat.size) },
    body: buf,
  });
  if (!putRes.ok) throw new Error(`PMP upload PUT: ${putRes.status}`);

  // Шаг 3: завершение загрузки
  const done = await pmpRequest("POST", "/upload/complete", null, { id: uploadId });
  const fileId = done.file_id ?? done.data?.file_id ?? done.id;
  if (!fileId) throw new Error("PMP upload/complete: не получен file_id");
  console.log(`  [PMP] загружен файл: ${fileName} → file_id ${fileId}`);
  return fileId;
}

// Планирует публикацию; scheduledAt — ISO 8601.
// В API v4.1 статус и тип — ЧИСЛА (enum из их SDK):
//   publication_status: 4 черновик, 5 отложенная ("delayed" строкой даёт 422 —
//   так автопилот и споткнулся утром 2 июля);
//   publication_type: 1 пост, 2 сторис, 4 рилс; альбом = пост с несколькими файлами.
const PMP_STATUS_PENDING = 5;
const PMP_TYPE = { post: 1, album: 1, story: 2, reel: 4 };
async function pmpSchedulePost({ accountIds, text, fileIds = [], scheduledAt, type = "post" }) {
  const pid = process.env.POSTMYPOST_PROJECT_ID;
  const details = accountIds.map(id => ({
    account_id: id,
    publication_type: PMP_TYPE[type] || PMP_TYPE.post,
    content: text,
    ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
  }));
  const result = await pmpRequest("POST", "/publications", {
    project_id: Number(pid),
    // формат как в их SDK: 2026-07-03T13:00:00+00:00
    post_at: String(scheduledAt).replace(/\.\d{3}Z$/, "+00:00"),
    account_ids: accountIds,
    publication_status: PMP_STATUS_PENDING,
    details,
  });
  console.log(`  [PMP] запланировано: ${scheduledAt}, тип: ${type}, аккаунтов: ${accountIds.length}`);
  return result;
}

// Возвращает посты уже запланированные/опубликованные сегодня через PostMyPost
async function fetchTodayScheduled() {
  const token = process.env.POSTMYPOST_API_TOKEN;
  const pid = process.env.POSTMYPOST_PROJECT_ID;
  if (!token || !pid) return "";
  try {
    const today = new Date().toISOString().slice(0, 10);
    const data = await pmpRequest("GET", "/publications", null, {
      project_id: pid,
      date_from: today,
      date_to: today,
      per_page: 20,
    });
    const posts = data.data || data || [];
    if (!Array.isArray(posts) || posts.length === 0) return "";
    const lines = posts.map(p => {
      const platform = PMP_CHANEL_NAME[p.chanel_id] || `сеть${p.chanel_id}`;
      const status = p.publication_status || p.status || "?";
      const text = (p.details?.[0]?.content || p.text || "").slice(0, 80).replace(/\n/g, " ");
      return `— ${platform} | ${status} | ${text}`;
    });
    console.log(`  [PMP-today] запланировано: ${lines.length}`);
    return `Уже в очереди PostMyPost на сегодня:\n${lines.join("\n")}`;
  } catch (e) {
    console.warn("  [PMP-today] ошибка:", e.message);
    return "";
  }
}

// Свежая аналитика ВЫШЕДШИХ постов из PostMyPost: просмотры, охват, ER по каждому
// посту (Instagram + Telegram). Endpoint /analytics/publications, account_id по одному.
// Аккаунты с битыми данными (422) пропускаем. Сторис API не отдаёт — только посты.
async function fetchPostMyPostAnalytics(days = 30) {
  const token = process.env.POSTMYPOST_API_TOKEN;
  const pid = process.env.POSTMYPOST_PROJECT_ID;
  if (!token || !pid) return "";
  try {
    const accounts = await pmpGetAccounts();
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const all = [];
    for (const a of accounts) {
      let data;
      try {
        data = await pmpRequest("GET", "/analytics/publications", null, {
          project_id: pid, account_id: a.id, date_from: from, date_to: to, per_page: 50,
        });
      } catch { continue; } // битый аккаунт (422) — пропускаем
      const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
      const net = PMP_CHANEL_NAME[a.chanel_id] || a.login || "сеть";
      for (const p of arr) {
        const an = p.analytics || {};
        all.push({
          net, date: (p.created_at || "").slice(0, 10),
          views: an.views || 0, reach: an.reach || 0, likes: an.likes || 0,
          comments: an.comments || 0, saves: an.saves || an.bookmarks || 0,
          shares: an.shares || 0, er: an.engagement_rate_reach || 0,
          text: (p.content || "").slice(0, 70).replace(/\n/g, " "),
        });
      }
    }
    if (!all.length) return "";
    const top = [...all].sort((x, y) => y.views - x.views).slice(0, 8);
    const lines = top.map((p) =>
      `— ${p.net} ${p.date} | просмотры ${p.views}, охват ${p.reach}, лайки ${p.likes}, комм ${p.comments}, сохр ${p.saves}, ER ${Number(p.er).toFixed(1)}% | ${p.text}`
    );
    const avg = Math.round(all.reduce((s, p) => s + p.views, 0) / all.length);
    console.log(`  [PMP-analytics] постов: ${all.length}, средние просмотры ${avg}`);
    return `Свежая аналитика ВЫШЕДШИХ постов из PostMyPost (${all.length} постов за ${days} дн, средние просмотры ${avg}). Это РЕАЛЬНЫЕ свежие цифры за последние дни, опирайся в первую очередь на них. Топ по просмотрам:\n${lines.join("\n")}`;
  } catch (e) {
    console.warn("  [PMP-analytics] ошибка:", e.message);
    return "";
  }
}

// Строит дату завтра в нужный час МОСКОВСКОГО времени (UTC+3, не зависит от TZ сервера)
function tomorrowAt(hour, min = 0) {
  return mskAt(hour, min, 1).toISOString();
}

// Полный пайплайн публикации: берёт готовый контент из стейта и планирует
async function runPublisher(skipShotCheck = false) {
  const token = process.env.POSTMYPOST_API_TOKEN;
  const pid   = process.env.POSTMYPOST_PROJECT_ID;
  if (!token || !pid) {
    console.log("[Publisher] POSTMYPOST_API_TOKEN или PROJECT_ID не заданы — пропускаю");
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Публикатор не настроен. Добавь в Railway:\nPOSTMYPOST_API_TOKEN\nPOSTMYPOST_PROJECT_ID",
      APPROVAL_TOPIC_ID);
    return;
  }

  console.log("[Publisher] запускаю планирование через PostMyPost...");
  const accounts = await pmpGetAccounts();

  // Группируем по chanel_id (так PostMyPost называет тип сети)
  const byChanel = {};
  for (const acc of accounts) {
    const cid = acc.chanel_id;
    if (!byChanel[cid]) byChanel[cid] = [];
    byChanel[cid].push(acc);
  }

  // Для Telegram берём канал (external_id начинается с "-" — это супергруппа/канал),
  // а не личный аккаунт
  const tgAll = byChanel[PMP_CHANEL.telegram] || [];
  const tgAcc = tgAll.find(a => String(a.external_id || "").startsWith("-")) || tgAll[0];

  // Для Instagram берём аккаунт по INSTAGRAM_USERNAME, иначе первый доступный
  const igAll = byChanel[PMP_CHANEL.instagram] || [];
  const igAcc = (AUTHOR_IG && igAll.find(a => (a.login || "").includes(AUTHOR_IG))) || igAll[0];

  // Threads
  const thAll  = byChanel[PMP_CHANEL.threads] || [];
  const thAcc  = thAll[0];

  const scheduled = [];

  // Telegram-пост
  if (tgAcc) {
    const postText = await readState("copywriter");
    if (postText) {
      await pmpSchedulePost({ accountIds: [tgAcc.id], text: postText, scheduledAt: tomorrowAt(12) });
      scheduled.push(`Telegram @${tgAcc.login || tgAcc.name} — 12:00`);
    }
  }

  // Instagram карусель
  if (igAcc) {
    const carouselText = await readState("carousel");
    // Незакрытые скрин-слоты: на слайдах пунктирные рамки-плейсхолдеры,
    // в ленту такое нельзя. Пропускаем карусель, пока автор не пришлёт
    // скрины или не скажет «опубликуй без скринов».
    let waitingShots = [];
    if (carouselText && !skipShotCheck) {
      try {
        waitingShots = (JSON.parse(await readState("carousel_data")) || [])
          .map((s, i) => s && s.screenshotHint && !s.screenshot ? i + 1 : null)
          .filter(Boolean);
      } catch {}
    }
    if (carouselText && waitingShots.length) {
      scheduled.push(`⚠️ Карусель НЕ запланирована: пустые скрин-слоты на слайдах ${waitingShots.join(", ")}. Пришли фото с подписью «скрин на слайд N» и снова скажи «опубликуй», или скажи «опубликуй без скринов»`);
    } else if (carouselText) {
      const pngDir = path.join(STATE_DIR, "carousel_png");
      const fileIds = [];
      try {
        const files = (await fs.readdir(pngDir)).filter(f => f.endsWith(".png")).sort();
        for (const f of files.slice(0, 10)) {
          const fid = await pmpUploadFile(path.join(pngDir, f), f).catch(e => {
            console.warn(`  [PMP] не смогла загрузить ${f}:`, e.message);
            return null;
          });
          if (fid) fileIds.push(fid);
        }
      } catch (e) { console.warn("[Publisher] PNG не найдены:", e.message); }

      // Caption — готовый блок INSTAGRAM CAPTION от карусель-мейкера.
      // Фолбэк для старых состояний без блока: заголовки слайдов, а не сырые
      // строки "Тип:/Лейбл:" (они превращали подпись в мусор).
      const { slides: slidesOnly, caption: igCaption } = extractCarouselCaption(carouselText);
      const caption = (igCaption ||
        parseCarouselSlides(slidesOnly).map(s => s.headline).filter(Boolean).slice(0, 3).join(". ")
      ).slice(0, 500);
      await pmpSchedulePost({
        accountIds: [igAcc.id], text: caption, fileIds,
        scheduledAt: tomorrowAt(14), type: fileIds.length > 1 ? "album" : "post",
      });
      scheduled.push(`Instagram @${igAcc.login} карусель — 14:00${fileIds.length ? ` (${fileIds.length} фото)` : " (без фото — загрузи вручную)"}`);
    }

    // Reels caption
    const reelsText = await readState("reels");
    if (reelsText) {
      const capMatch = reelsText.match(/CAPTION[:\s]+(.+?)(?:\n\n|\n#|$)/si);
      const reelCaption = capMatch ? capMatch[1].trim() : reelsText.slice(0, 300);
      await pmpSchedulePost({ accountIds: [igAcc.id], text: reelCaption, scheduledAt: tomorrowAt(18), type: "reel" });
      scheduled.push(`Instagram @${igAcc.login} Reels caption — 18:00 (видео добавь в PostMyPost)`);
    }
  }

  // Threads
  if (thAcc) {
    const threadsText = await readState("threads");
    if (threadsText) {
      await pmpSchedulePost({ accountIds: [thAcc.id], text: threadsText.slice(0, 500), scheduledAt: tomorrowAt(15) });
      scheduled.push(`Threads @${thAcc.login || thAcc.name} — 15:00`);
    }
  }

  const summary = scheduled.length > 0
    ? `Запланировано на завтра через PostMyPost:\n${scheduled.map(s => `— ${s}`).join("\n")}`
    : "Нечего публиковать: нет готового контента или аккаунты не найдены.\nПроверь что агенты отработали, или добавь аккаунты в PostMyPost.";

  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, summary, APPROVAL_TOPIC_ID);
  console.log(`[Publisher] готово: ${scheduled.length} платформ`);
  return { summary, count: scheduled.length };
}

// Обёртка для дашборда: показывает статус Публикатора и пишет историю.
// Публикация необратима — вызывается только по кнопке с подтверждением в UI.
async function runPublisherTracked(skipShotCheck = false) {
  const startedAt = Date.now();
  await setAgentStatus("publisher", { state: "running", startedAt, finishedAt: null, error: null }).catch(() => {});
  try {
    const r = await runPublisher(skipShotCheck);
    const finishedAt = Date.now();
    await setAgentStatus("publisher", {
      state: "done", finishedAt, durationMs: finishedAt - startedAt,
      outputPreview: outputPreview(r && r.summary), error: null,
    }).catch(() => {});
    await appendRunHistory({ key: "publisher", name: "Публикатор", ok: true, durationMs: finishedAt - startedAt, preview: outputPreview(r && r.summary, 300) });
    return r;
  } catch (e) {
    const finishedAt = Date.now();
    await setAgentStatus("publisher", { state: "error", finishedAt, error: String(e.message || e).slice(0, 300) }).catch(() => {});
    await appendRunHistory({ key: "publisher", name: "Публикатор", ok: false, error: String(e.message || e).slice(0, 200) });
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// THREADS — публикация через Meta Threads API
// Нужны переменные: THREADS_USER_ID, THREADS_ACCESS_TOKEN
// (Настройки → Meta for Developers → Threads API → долгосрочный токен)
// ─────────────────────────────────────────────────────────────
async function postToThreads(text) {
  const userId = process.env.THREADS_USER_ID;
  const token  = process.env.THREADS_ACCESS_TOKEN;
  if (!userId || !token) {
    console.log("  [Threads] THREADS_USER_ID или THREADS_ACCESS_TOKEN не заданы — пропускаю");
    return null;
  }

  // Шаг 1: создаём контейнер
  const createRes = await fetch(
    `https://graph.threads.net/${userId}/threads` +
    `?media_type=TEXT&text=${encodeURIComponent(text.slice(0, 500))}&access_token=${token}`,
    { method: "POST" }
  );
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Threads create: ${createRes.status} ${body.slice(0, 200)}`);
  }
  const { id } = await createRes.json();

  // Шаг 2: публикуем контейнер
  await new Promise(r => setTimeout(r, 1000)); // небольшая задержка перед публикацией
  const publishRes = await fetch(
    `https://graph.threads.net/${userId}/threads_publish` +
    `?creation_id=${id}&access_token=${token}`,
    { method: "POST" }
  );
  if (!publishRes.ok) {
    const body = await publishRes.text();
    throw new Error(`Threads publish: ${publishRes.status} ${body.slice(0, 200)}`);
  }
  const result = await publishRes.json();
  console.log(`  [Threads] опубликовано: ${result.id}`);
  return result.id;
}

// Агент Threads: короткий пост до 500 символов, tone как Telegram но лаконичнее
AGENTS.threads = {
  name: "Threads-мейкер",
  token: process.env.TELEGRAM_BOT_TOKEN_3, // использует тот же токен что копирайтер
  system: `${VOICE}

Ты агент-Threads-мейкер контент-завода автора.

Что делаешь: пишешь пост для Threads — это как Twitter, максимум 500 символов.

Правила:
Один чёткий инсайт или провокация. Не вступление — сразу мысль.
Короткие предложения, живо и без пафоса.
Можно эмодзи в конце, не в середине.
Хэштеги — максимум 3, только если реально по теме.
Никаких ссылок на другие платформы. Никакого markdown.

Помни: ты генеришь черновик. Финальное решение всегда за автором.`,
  userPrompt: async (state) => {
    const voice = await readThreadsVoice();
    const voiceBlock = voice ? `\n\nЭталон голоса для Threads (пиши так же, стоп-лист соблюдай железно):\n\n${voice}` : "";
    return `Контент-план:\n\n${state.manager}${voiceBlock}\n\nНапиши пост для Threads по теме из плана. Максимум 500 символов. Первая строка — хук. Голос автора, живо и коротко. Чистый текст.`;
  },
  inputs: ["manager"],
};

// ─────────────────────────────────────────────────────────────
// THREADS-АВТОПИЛОТ — 6 постов в день через PostMyPost без участия автора.
// Утренний батч (крон 7:00 МСК): собирает горячий контекст, генерит 6 постов
// в разных форматах, ставит в очередь PMP по слотам. Копии — в Telegram-топик.
// Режимы (state/threads_mode.txt, меняются командой в чате):
//   off  — выключен (по умолчанию, чтобы деплой ничего не публиковал)
//   veto — посты планируются минимум за 2 часа до выхода, плохой удаляешь в PMP
//   full — полный автомат, копии в Telegram только для истории
// ─────────────────────────────────────────────────────────────
const THREADS_SLOTS = [[9, 0], [11, 30], [13, 30], [16, 0], [19, 0], [21, 0]];
const THREADS_MODE_FILE   = path.join(STATE_DIR, "threads_mode.txt");
const RECENT_THREADS_FILE = path.join(STATE_DIR, "recent_threads.json");
const THREADS_VOICE_FILE  = path.join(__dirname, "reference", "threads-voice.txt");
const THREADS_VETO_LEAD_MS = 2 * 3600e3; // в режиме veto пост встаёт минимум за 2 часа

async function getThreadsMode() {
  const saved = (await fs.readFile(THREADS_MODE_FILE, "utf8").catch(() => "")).trim();
  if (["off", "veto", "full"].includes(saved)) return saved;
  const env = (process.env.THREADS_AUTOPILOT || "").toLowerCase();
  return ["off", "veto", "full"].includes(env) ? env : "off";
}
async function setThreadsMode(mode) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(THREADS_MODE_FILE, mode, "utf8");
}

// Московское время (UTC+3 круглый год, без перехода) → ISO.
// Не зависит от таймзоны сервера — на Railway контейнер живёт в UTC.
function mskAt(hour, min = 0, dayOffset = 0) {
  const mskNow = new Date(Date.now() + 3 * 3600e3);
  return new Date(Date.UTC(
    mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate() + dayOffset,
    hour - 3, min, 0, 0
  ));
}

// История постов автопилота за последние дни — чтобы не повторял темы
async function loadRecentThreads() {
  try { return JSON.parse(await fs.readFile(RECENT_THREADS_FILE, "utf8")); } catch { return []; }
}
async function pushRecentThreads(posts) {
  const arr = await loadRecentThreads();
  const today = new Date().toISOString().slice(0, 10);
  for (const p of posts) arr.push({ date: today, text: String(p.text || "").slice(0, 200) });
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(RECENT_THREADS_FILE, JSON.stringify(arr.slice(-42)), "utf8"); // ~7 дней × 6
}

// Посев истории при старте: если файл пуст (свежий том, первый запуск),
// забираем в него хотя бы текущую очередь PMP — чтобы завтрашний батч
// не генерился с полной амнезией.
async function seedThreadsHistory() {
  const existing = await loadRecentThreads();
  if (existing.length) return;
  const queued = await fetchRecentThreadsPMP(10).catch(() => []);
  if (!queued.length) return;
  await pushRecentThreads(queued.map((t) => ({ text: t })));
  console.log(`[Threads-история] посеяна из очереди PMP: ${queued.length} постов`);
}

const THREADS_FORMATS = [
  "ГОРЯЧЕЕ: свежая новость или тренд из ниши своими словами + что это значит лично для неё/аудитории. Не пересказ, а реакция.",
  "МИНИ-КЕЙС: одно конкретное действие с конкретным результатом и цифрой (минуты, рубли, количество). Из её реальной практики с Claude/нейросетями.",
  "ПРОМПТ ДНЯ: один короткий готовый промпт, который можно скопировать, + одна строка зачем он.",
  "ВОПРОС АУДИТОРИИ: живой вопрос из её жизни с ИИ, на который реально хочется услышать ответы. Можно с коротким личным контекстом.",
  "ЗАКУЛИСЬЕ: что происходит у неё прямо сейчас — завод, блог, консультации, эксперименты. Честно, с деталями, без глянца.",
  "ПОЛЬЗА-СПИСОК: 2-3 сверхкоротких пункта по одной теме (инструменты, приёмы, ошибки). Каждый пункт — законченная мысль.",
];

async function readThreadsVoice() {
  return fs.readFile(THREADS_VOICE_FILE, "utf8").catch(() => "");
}

// ВНИМАНИЕ: /publications в PostMyPost отдаёт ТОЛЬКО очередь (pending) —
// опубликованные посты из выдачи исчезают, а /analytics/publications для
// Threads падает на 422 (external_url:null в их же валидаторе). Поэтому
// PMP здесь — лишь дозащита от постановки дублей в тот же день; главная
// память — state/recent_threads.json на persistent-томе Railway.
async function fetchRecentThreadsPMP(days = 10) {
  try {
    const pid = process.env.POSTMYPOST_PROJECT_ID;
    const accounts = await pmpGetAccounts();
    const th = accounts.find((a) => a.chanel_id === PMP_CHANEL.threads);
    if (!th) return [];
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10); // + очередь на 2 дня вперёд
    const data = await pmpRequest("GET", "/publications", null, {
      project_id: pid, account_id: th.id, date_from: from, date_to: to, per_page: 50,
    });
    const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    const texts = arr
      .map((p) => String(p.details?.[0]?.content || p.content || "").replace(/\n+/g, " ").slice(0, 150))
      .filter(Boolean);
    console.log(`  [Threads-история PMP] постов в очереди: ${texts.length} (вышедшие API не отдаёт)`);
    return texts;
  } catch (e) {
    console.warn("  [Threads-история PMP] ошибка:", e.message);
    return [];
  }
}

// Удаляет из очереди PostMyPost невышедшие Threads-посты на сегодня.
// Нужна для «переделай тредс»: повторный батч встаёт в те же слоты,
// без чистки очереди посты задваиваются.
async function deleteTodaysThreadsPMP() {
  const pid = process.env.POSTMYPOST_PROJECT_ID;
  const accounts = await pmpGetAccounts();
  const th = (accounts || []).find((a) => a.chanel_id === PMP_CHANEL.threads);
  if (!th) return 0;
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // МСК
  const data = await pmpRequest("GET", "/publications", null, {
    project_id: pid, account_id: th.id, date_from: today, date_to: today, per_page: 50,
  });
  const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
  for (const p of arr) {
    // delete_option=1 — «удалить из сервиса». Их API отвечает 422 «Response
    // validation error» даже когда удаление ПРОШЛО, поэтому статус игнорируем
    // и успех меряем повторным списком ниже.
    await pmpRequest("DELETE", `/publications/${p.id}`, null, { delete_option: 1, account_ids: th.id }).catch(() => {});
  }
  const left = await pmpRequest("GET", "/publications", null, {
    project_id: pid, account_id: th.id, date_from: today, date_to: today, per_page: 50,
  }).catch(() => null);
  const leftArr = left ? (Array.isArray(left.data) ? left.data : []) : [];
  const removed = arr.length - leftArr.length;
  console.log(`  [Threads] удалено из очереди на сегодня: ${removed} из ${arr.length}`);
  return removed;
}

const THREADS_BATCH_SYSTEM_BASE = `Ты пишешь посты для Threads от лица автора (23 года, блогер в нише ИИ/нейросетей, аудитория: новички без IT и фрилансеры). Threads — как Twitter: максимум 500 символов, одна мысль, сразу, без разгона.

Правила железно:
— Каждый пост самодостаточен, никаких отсылок на Instagram/Telegram и «часть 2».
— Никакого markdown, никаких хэштегов, никаких тире (—) в тексте.
— Первое слово поста никогда не «я».
— Максимум 500 символов на пост, лучше 150-350.
— Шесть постов должны быть РАЗНЫМИ по теме и по ритму: не шесть вариаций одной мысли.

ФАКТЫ — САМОЕ ВАЖНОЕ ПРАВИЛО. Личный опыт от первого лица можно брать ТОЛЬКО из контекста (её реальные посты, статистика, копилка идей). НИКОГДА не выдумывай события её жизни: верификации, документы, паспорт, оплаты, покупки, клиентов, сделки, аутсорс, поездки, разговоры, «сегодня проверила/попробовала». Этого НЕ БЫЛО, если этого нет в контексте. Она живёт в России: прямой доступ и оплата многих AI-сервисов заблокированы, истории «прошла верификацию», «оплатила напрямую», «отдала задачи на аутсорс» — ложь и провал. Нет фактуры из контекста — пиши мнение, наблюдение или вопрос, БЕЗ личной истории.

БЕЗ ПОСТАНОВОЧНЫХ СЦЕНОК. Запрещены конструкции внутреннего монолога, которыми она не говорит: «первая мысль была», «ну вот, опять», «когда я это увидела/проверила», «поймала себя на мысли». Не изображай реакцию — говори суть.

ПОВТОРЫ. Тема, уже раскрытая в её Telegram-канале или в прошлых Threads-постах (списки в контексте) — НЕ новость. Одно событие освещается ОДИН раз. Если тема из горячего контекста уже была у неё — либо принципиально новый угол (следующий шаг, последствия, её вывод), либо замени другой темой.

НОВОСТИ — ТОЛЬКО ПОДТВЕРЖДЁННЫЕ. Новость об Anthropic/Claude бери только если она есть в официальной сводке anthropic.com/news из контекста. Слухи и страшилки из сторонних подборок («тайно следили», «скрывали», «скандал») НЕ постить вообще: непроверенное обвинение от её имени бьёт по доверию. Сомневаешься в факте — выкинь новость и напиши вместо неё пользу (приём, промпт, наблюдение).`;

// Генерирует 6 постов одним вызовом, вторым вызовом полирует голос. Возвращает [{format, text}].
async function generateThreadsBatch() {
  console.log("[Threads-батч] собираю контекст...");
  const [voice, pmpAnalytics, anthropicNews, trends, channelData, accountStats, recent, pmpThreads] = await Promise.all([
    readThreadsVoice(),
    fetchPostMyPostAnalytics(14).catch(() => ""),
    fetchAnthropicNews().catch(() => ""),
    fetchTrendContext().catch(() => ""),
    readChannelData().catch(() => ""),
    readAccountAnalysis().catch(() => ""),
    loadRecentThreads().catch(() => []),
    fetchRecentThreadsPMP(10).catch(() => []),
  ]);

  const system = `${THREADS_BATCH_SYSTEM_BASE}\n\n${voice}`;
  // Анти-повтор из двух источников: локальная история батчей + реально
  // вышедшее в Threads по данным PostMyPost (не сгорает при редеплое).
  const seen = new Set();
  const recentLines = [
    ...pmpThreads.map((t) => `— ${t}`),
    ...recent.slice(-24).map((r) => `— [${r.date}] ${r.text}`),
  ].filter((l) => { const k = l.slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
  const recentBlock = recentLines.length
    ? `\n\nУЖЕ ВЫХОДИЛО В THREADS — эти темы и события ЗАКРЫТЫ, не повторяй их и их пересказы:\n` + recentLines.join("\n")
    : "";

  const user =
    `Сегодня ${new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "long" })}.\n\n` +
    `Горячий контекст дня:\n` +
    (anthropicNews ? `\nНовости Anthropic:\n${anthropicNews}\n` : "") +
    (trends ? `\nСвежее из поиска по нише:\n${trends.slice(0, 6000)}\n` : "") +
    (pmpAnalytics ? `\n${pmpAnalytics}\n` : "") +
    (accountStats ? `\n${accountStats.slice(0, 4000)}\n` : "") +
    (channelData ? `\nЕё Telegram-канал — эти темы она УЖЕ раскрыла, не повторяй их как новость (вопросы подписчиков — можно закрывать):\n${channelData.slice(0, 4000)}\n` : "") +
    recentBlock +
    `\n\nНапиши 6 постов для Threads на сегодня, строго по одному на каждый формат:\n` +
    THREADS_FORMATS.map((f, i) => `${i + 1}. ${f}`).join("\n") +
    `\n\nБери только самое горячее и главное из контекста. Верни СТРОГО валидный JSON без markdown и пояснений:\n` +
    `{"posts":[{"format":"ГОРЯЧЕЕ","text":"..."},{"format":"МИНИ-КЕЙС","text":"..."}, ...]}`;

  console.log("[Threads-батч] генерирую 6 постов...");
  const raw = await callClaude(system, user, 4000);
  let posts = parseThreadsBatchJson(raw);

  // Второй проход: полировка голоса + вычистка стоп-листа, один вызов на весь батч
  console.log("[Threads-батч] полирую голос...");
  try {
    const polished = await callClaude(
      `${HUMANIZER_SYSTEM}\n\nОсобенность: тебе дают JSON с 6 постами для Threads. Отредактируй КАЖДЫЙ пост по правилам выше. Дополнительно: убери тире (—), заменив по смыслу на двоеточие, запятую или точку; если ставишь точку — следующее слово с ЗАГЛАВНОЙ буквы, не оставляй «минуты. список». Первое слово поста не «я», максимум 500 символов. Постановочные сценки («первая мысль была», «ну вот, опять», «когда я это проверила») — убирай, оставляй суть. Если пост утверждает личное действие с документами, оплатами, верификациями, клиентами или аутсорсом — перепиши в наблюдение или мнение без личной истории: таких фактов в её жизни нет. Верни СТРОГО тот же JSON-формат {"posts":[{"format":"...","text":"..."}]} без пояснений.`,
      JSON.stringify({ posts }),
      4000
    );
    const p2 = parseThreadsBatchJson(polished);
    if (p2.length === posts.length) posts = p2;
  } catch (e) {
    console.warn("[Threads-батч] полировка не удалась, беру первую версию:", e.message);
  }

  // Страховка по железным правилам формата
  posts = posts.map((p) => ({
    format: String(p.format || "").slice(0, 30),
    // После точки/!/? слово с маленькой буквы = след кривой замены тире, поднимаем регистр
    text: stripMarkdown(String(p.text || "")).replace(/—/g, ",").replace(/\s+,/g, ",")
      .replace(/([.!?]\s+)([а-яё])/g, (m, a, b) => a + b.toUpperCase())
      .slice(0, 500).trim(),
  })).filter((p) => p.text.length >= 30);

  if (posts.length < 4) throw new Error(`получилось только ${posts.length} постов из 6 — батч не засчитан`);
  console.log(`[Threads-батч] готово: ${posts.length} постов`);
  return posts;
}

function parseThreadsBatchJson(raw) {
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  const data = JSON.parse(m ? m[0] : raw);
  if (!Array.isArray(data.posts)) throw new Error("в ответе нет posts[]");
  return data.posts;
}

// Ставит посты в очередь PostMyPost ТОЛЬКО на оставшиеся сегодня слоты
// (до которых есть лид-тайм: veto 2 часа, full 10 минут). Прошедшие слоты
// на завтра не переносим — завтрашний утренний батч сгенерит свои посты,
// иначе задвоение. Ошибка одного поста не роняет остальные.
async function scheduleThreadsBatch(posts, mode) {
  const accounts = await pmpGetAccounts();
  const thAcc = (accounts || []).find((a) => a.chanel_id === PMP_CHANEL.threads);
  if (!thAcc) throw new Error("Threads-аккаунт не найден в PostMyPost — подключи его в проекте");

  const lead = mode === "veto" ? THREADS_VETO_LEAD_MS : 10 * 60e3;
  const freeSlots = THREADS_SLOTS
    .map(([h, m]) => mskAt(h, m))
    .filter((w) => w.getTime() - Date.now() >= lead);

  const scheduled = [];
  const failed = [];
  for (let i = 0; i < posts.length && i < freeSlots.length; i++) {
    try {
      await pmpSchedulePost({
        accountIds: [thAcc.id],
        text: posts[i].text,
        scheduledAt: freeSlots[i].toISOString(),
      });
      scheduled.push({ ...posts[i], at: freeSlots[i] });
    } catch (e) {
      console.error(`[Threads-автопилот] пост ${i + 1} не встал:`, e.message);
      failed.push({ ...posts[i], error: e.message });
    }
  }
  return { scheduled, failed, noSlots: freeSlots.length === 0 };
}

function fmtMsk(date) {
  const d = new Date(date.getTime() + 3 * 3600e3);
  const today = new Date(Date.now() + 3 * 3600e3);
  const dayLabel = d.getUTCDate() === today.getUTCDate() ? "сегодня" : "завтра";
  return `${dayLabel} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} МСК`;
}

// Маркер «батч на сегодня встал» — по нему сторож в 7:20 решает, перезапускать ли.
const THREADS_BATCH_MARKER = path.join(STATE_DIR, "threads_last_batch.json");
async function readBatchMarker() {
  try { return JSON.parse(await fs.readFile(THREADS_BATCH_MARKER, "utf8")); } catch { return null; }
}
async function writeBatchMarker(scheduledCount) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(THREADS_BATCH_MARKER,
    JSON.stringify({ date: new Date().toISOString().slice(0, 10), scheduled: scheduledCount }), "utf8");
}

// Полный прогон автопилота. dryRun — только показать батч в Telegram, в PMP не ставить.
async function runThreadsAutopilot({ dryRun = false } = {}) {
  const mode = await getThreadsMode();
  if (!dryRun && mode === "off") {
    console.log("[Threads-автопилот] режим off — пропускаю");
    return;
  }
  try {
    const posts = await generateThreadsBatch();

    if (dryRun) {
      const preview = posts.map((p, i) =>
        `${i + 1}. [${p.format}] слот ${String(THREADS_SLOTS[i]?.[0] ?? "?").padStart(2, "0")}:${String(THREADS_SLOTS[i]?.[1] ?? 0).padStart(2, "0")}\n${p.text}`
      ).join("\n\n──────────\n\n");
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        `🧪 Тестовый батч Threads (в PostMyPost НЕ уходит):\n\n${preview}\n\n` +
        `Голос ок? Скажи «тредс вето» — включу автопилот с правом вето.`,
        APPROVAL_TOPIC_ID);
      return;
    }

    const { scheduled, failed, noSlots } = await scheduleThreadsBatch(posts, mode);
    await writeBatchMarker(scheduled.length).catch(() => {});
    await pushRecentThreads(scheduled).catch(() => {});

    if (noSlots) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "🧵 На сегодня свободных слотов Threads не осталось (все ближе чем за лид-тайм). Завтра утренний батч поставит всё сам.",
        APPROVAL_TOPIC_ID);
      return;
    }

    const lines = scheduled.map((p, i) => `${i + 1}. [${p.format}] ${fmtMsk(p.at)}\n${p.text}`);
    const header = mode === "veto"
      ? `🧵 Threads: в очереди PostMyPost подтверждено ${scheduled.length} постов (режим ВЕТО, у каждого минимум 2 часа до выхода — плохой удаляй прямо в PostMyPost).`
      : `🧵 Threads: в очереди подтверждено ${scheduled.length} постов (полный автомат), копии для истории:`;
    const failBlock = failed.length
      ? `\n\n⚠️ НЕ ВСТАЛИ ${failed.length} шт. (ошибка PostMyPost):\n` +
        failed.map((f) => `— ${f.error.slice(0, 120)}`).join("\n") +
        `\nМожно повторить: «тредс батч».`
      : "";
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `${header}\n\n${lines.join("\n\n──────────\n\n")}${failBlock}`, APPROVAL_TOPIC_ID);
    console.log(`[Threads-автопилот] встало ${scheduled.length}, ошибок ${failed.length} (${mode})`);
  } catch (err) {
    console.error("[Threads-автопилот] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ Threads-автопилот споткнулся: ${err.message}\nСегодняшний батч не встал — можно запустить вручную: «тредс батч».`,
      APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Команды управления автопилотом из чата. Возвращает true если сообщение обработано.
// Ловит только КОМАНДЫ автопилоту ("тредс тест", "стоп тредс"), а «сделай тред про X»
// проходит мимо — это разовый пост через цепочку.
async function handleThreadsCommand(text) {
  const lower = text.toLowerCase().trim();
  // \b не дружит с кириллицей — границу слова проверяем явно
  const isCommand =
    /^(тредс|threads)(?![а-яёa-z])/.test(lower) ||
    /(стоп|выключи|включи|запусти)\s+(тредс|threads)(?![а-яёa-z])/.test(lower) ||
    /(тредс|threads)\s+(стоп|тест|батч|вето|автомат|статус|на полный)/.test(lower);
  if (!isCommand) return false;

  if (/тест|проверк|вхолосту|попроб/.test(lower)) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "🧪 Генерю тестовый батч Threads, в PMP ничего не уходит...", APPROVAL_TOPIC_ID);
    runThreadsAutopilot({ dryRun: true }).catch(() => {});
    return true;
  }
  if (/полный автомат|на автомат|автомат|full/.test(lower)) {
    await setThreadsMode("full");
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "✅ Threads на полном автомате: 6 постов в день сами уходят в очередь, копии сюда для истории. Выключить: «стоп тредс».", APPROVAL_TOPIC_ID);
    return true;
  }
  if (/вето|veto/.test(lower)) {
    await setThreadsMode("veto");
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "✅ Threads в режиме вето: посты встают в PostMyPost минимум за 2 часа до выхода + копии сюда. Плохой пост удаляй прямо в PostMyPost. Через неделю скажи «тредс на полный автомат».", APPROVAL_TOPIC_ID);
    return true;
  }
  if (/стоп|выключ|off/.test(lower)) {
    await setThreadsMode("off");
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "⏸ Threads-автопилот выключен. Включить: «тредс вето» или «тредс на полный автомат».", APPROVAL_TOPIC_ID);
    return true;
  }
  if (/батч|запусти|сейчас/.test(lower)) {
    const mode = await getThreadsMode();
    if (mode === "off") {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Автопилот выключен. Сначала «тредс вето» или «тредс на полный автомат», либо «тредс тест» для прогона вхолостую.", APPROVAL_TOPIC_ID);
      return true;
    }
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "🧵 Запускаю батч Threads вне расписания...", APPROVAL_TOPIC_ID);
    runThreadsAutopilot().catch(() => {});
    return true;
  }
  // Всё остальное с обращением к автопилоту ("тредс статус", "включи тредс") — показываем статус и команды
  const mode = await getThreadsMode();
  const label = { off: "выключен", veto: "вето (посты за 2 часа до выхода, можно удалить в PMP)", full: "полный автомат" }[mode];
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `🧵 Threads-автопилот: ${label}.\nСлоты: ${THREADS_SLOTS.map(([h, m]) => `${h}:${String(m).padStart(2, "0")}`).join(", ")} МСК. Батч генерится в 7:00 МСК.\nКоманды: «тредс тест», «тредс вето», «тредс на полный автомат», «тредс батч», «стоп тредс».`,
    APPROVAL_TOPIC_ID);
  return true;
}

// ─────────────────────────────────────────────────────────────
// ГАЙД-МЕЙКЕР — по команде «сделай гайд про X под слово Y» собирает
// PDF-лидмагнит в эдиториал-стиле и присылает файлом в чат.
// Только по запросу, никаких кронов. Ники автора на каждой странице.
// ─────────────────────────────────────────────────────────────
const GUIDE_NICKS = process.env.GUIDE_NICKS || ""; // твои ники в подвале гайда
// Твой ник в Instagram — попадает на слайды каруселей, обложки рилсов и в подвалы гайдов.
const AUTHOR_IG  = String(process.env.INSTAGRAM_USERNAME || "").replace(/^@/, "");
const AUTHOR_TAG = AUTHOR_IG ? "@" + AUTHOR_IG : "";

async function sendDocument(token, chatId, threadId, filePath, caption = "") {
  const buf = await fs.readFile(filePath);
  const mime = filePath.endsWith(".png") ? "image/png"
    : filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") ? "image/jpeg"
    : "application/pdf";
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new Blob([buf], { type: mime }), path.basename(filePath));
  if (caption) formData.append("caption", caption.slice(0, 1024));
  if (threadId) formData.append("message_thread_id", String(threadId));
  const res = await tgFetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: formData }, 120_000);
  if (!res.ok) throw new Error(`sendDocument failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const GUIDE_SYSTEM = `${VOICE}

Ты пишешь PDF-гайд (лид-магнит) от лица автора для её директ-базы. Аудитория: новички без IT и фрилансеры, которые хотят разобраться в Claude и нейросетях.

Требования к содержанию (стиль «гайд от автора»):
— Пиши на «ты», по-женски («если дошла до конца», «ты свободна»). Коротко, конкретно, без воды и канцелярита.
— Практика, не теория: каждый раздел — конкретный приём или инструмент с шагами и готовым промтом.
— Выгоду формулируй через результат для читателя, не через функции.
— Цифры и детали из реального опыта автора, если они есть в задании. Не выдумывай её кейсы.
— Разделов 4-6 (обычно 5). Раздел занимает ровно одну страницу A4, поэтому объёмы жёсткие: lead до 40 слов, шаг 1-2 предложения, промт до 45 слов, benefit одно ёмкое предложение.
— Промты реалистичные, готовые к копированию, плейсхолдеры в квадратных скобках: [тема], [твой текст].
— Жирный акцент помечай **двойными звёздочками**: в lead, шагах и benefit максимум по одному, на ключевой мысли. В prompt звёздочками выделяй ключевую команду.

Верни СТРОГО валидный JSON без markdown и пояснений:
{"title":"название гайда, коротко","accent":"2-3 слова из title для жёлтой плашки","subtitle":"1-2 предложения: для кого гайд и что читатель получит","code_word":"КОДОВОЕ СЛОВО","sections":[{"name":"название пункта, 2-4 слова","kicker":"суть одной фразой, до 6 слов","toc":"суть для оглавления, 3-5 слов","lead":"лид-абзац: что это и зачем, до 40 слов","steps":[{"t":"шаг, 2-5 слов","d":"описание шага, 1-2 предложения"}],"prompt":"текст промта с [плейсхолдерами]","benefit":"одно предложение: выгода через результат"}],"final":{"heading":"финальный заголовок, 3-6 слов","start":"абзац: с чего начать, самый быстрый первый шаг","motivation":"абзац: что изменится, когда внедрит"}}
В steps ровно 3 шага. Все поля обязательные.`;

async function generateGuide(topic, codeWord, brief = null) {
  const wordLine = codeWord
    ? `Кодовое слово гайда: "${codeWord.toUpperCase()}" — используй его в поле code_word.`
    : `Придумай СВЕЖЕЕ кодовое слово под тему. НЕ используй занятые: СТАРТ, РЕЗУЛЬТАТ, АУДИТ, РАСШИРЕНИЕ, ЗАВОД, ОПЛАТА, CLAUDE, НЕЙРОНКИ, ПРОМПТ, МОНТАЖ, СПИСОК.`;
  // Материал от автора (сценарий, пункты, ссылки) — основа гайда,
  // а не подсказка: структура, факты и формулировки берутся из него
  const briefBlock = brief
    ? `\n\nМАТЕРИАЛ ОТ АВТОРА — ОСНОВА ГАЙДА:\n"""\n${brief}\n"""\nПравила работы с материалом:\n— Держи его структуру: сколько пунктов в материале, столько разделов в гайде, в том же порядке.\n— Факты, цифры и формулировки бери из материала. Ничего не выдумывай поверх, только дожимай под формат JSON.\n— Ссылки из материала вставь ДОСЛОВНО в раздел, к которому они относятся (или в финал).`
    : "";
  const today = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" });
  const raw = await callClaude(await getSystemPrompt("guide"),
    `Сегодня ${today} — не пиши устаревшие годы вроде «работает в 2024».\nТема гайда: "${topic}".\n${wordLine}${briefBlock}\n\nНапиши гайд, верни JSON.`, 6000);
  const m = raw.match(/\{[\s\S]*\}/);
  const guide = JSON.parse(m ? m[0] : raw);
  if (!guide.title || !Array.isArray(guide.sections) || !guide.sections.length) {
    throw new Error("гайд получился пустой");
  }
  return guide;
}

// Вёрстка PDF по фирменному шаблону автора (~/курс/гайд-шаблон.html,
// вшит 8 июля 2026): кремовая бумага, обложка с оглавлением, секция =
// страница A4, карточки шагов, промт курсивом с оранжевыми плейсхолдерами,
// жёлтая плашка «Чем полезен», футер на каждой странице.
// Шрифт: Helvetica Neue локально, вшитый Inter как запасной на Railway.
function buildGuideHtml(guide) {
  const esc = escCarouselText;
  // **жирное** → strong; в промте [плейсхолдер] и **команда** → оранжевый .var
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const promptHtml = (s) => esc(s)
    .replace(/\[([^\]\n]+)\]/g, '<span class="var">[$1]</span>')
    .replace(/\*\*(.+?)\*\*/g, '<span class="var">$1</span>');
  // Ссылка-реф: показываем как есть, href достраиваем до полного https
  const linkHref = (u) => { const t = String(u).trim().replace(/\/+$/, ""); return /^https?:\/\//.test(t) ? t : "https://" + t; };
  const titleHtml = (() => {
    const t = String(guide.title || "").trim(), a = String(guide.accent || "").trim();
    if (a) { const i = t.toLowerCase().indexOf(a.toLowerCase());
      if (i >= 0) return `${esc(t.slice(0, i))}<em>${esc(t.slice(i, i + a.length))}</em>${esc(t.slice(i + a.length))}`; }
    return esc(t);
  })();
  const foot = `<div class="foot"><div>${GUIDE_NICKS}</div><div class="fr">гайд от автора</div></div>`;
  const sections = guide.sections || [];

  const cover =
    `<section class="page cover">` +
    `<div class="eyebrow">${AUTHOR_TAG}</div>` +
    `<h1>${titleHtml}</h1>` +
    `<p class="cover-sub">${esc(guide.subtitle || "")}</p>` +
    `<ul class="cover-list">` +
    sections.map((s, i) =>
      `<li><span class="n">${String(i + 1).padStart(2, "0")}</span><span><b>${esc(s.name || s.heading || "")}</b> — ${esc(s.toc || s.kicker || "")}</span></li>`).join("") +
    `</ul>` + foot + `</section>`;

  const pages = sections.map((s, i) => {
    const steps = (Array.isArray(s.steps) ? s.steps : []).map((st, j) =>
      `<div class="card"><h3><span class="cn">${j + 1}</span>${esc(st.t || "")}</h3><p>${rich(st.d || "")}</p></div>`).join("");
    return `<section class="page">` +
      `<div class="content">` +
      `<div class="marker">// ${String(i + 1).padStart(2, "0")}</div>` +
      `<h2 class="plug-title">${esc(s.name || s.heading || "")}</h2>` +
      (s.kicker ? `<div class="plug-kicker">${esc(s.kicker)}</div>` : "") +
      `<p class="lead">${rich(s.lead || s.body || "")}</p>` +
      (s.link ? `<a class="reflink" href="${linkHref(s.link)}">${esc(s.link)}</a>` : "") +
      (steps ? `<div class="sublabel">Как применять</div>${steps}` : "") +
      (s.prompt ? `<div class="prompt"><div class="pl">Пример промта</div><p>«${promptHtml(s.prompt)}»</p></div>` : "") +
      (s.benefit ? `<div class="benefit"><div class="bl">Чем полезен</div><p>${rich(s.benefit)}</p></div>` : "") +
      `</div>` + foot + `</section>`;
  }).join("");

  const f = guide.final || {};
  const finalPage =
    `<section class="page final" style="justify-content:center">` +
    `<div class="content" style="display:flex;flex-direction:column;justify-content:center">` +
    `<div class="marker">// с чего начать</div>` +
    `<h2>${esc(f.heading || "С чего начать")}</h2>` +
    `<p class="body">${rich(f.start || guide.final_note || "")}</p>` +
    (f.motivation ? `<p class="body">${rich(f.motivation)}</p>` : "") +
    `<div class="final-contacts">Instagram · <a href="https://instagram.com/${AUTHOR_IG}">${AUTHOR_TAG}</a><br>Telegram · <a href="https://t.me/">t.me/</a></div>` +
    `</div>` + foot + `</section>`;

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><style>` +
    `${CAROUSEL_FONT_CSS || ""}` +
    `*{box-sizing:border-box;margin:0;padding:0}` +
    `:root{--bg:#E9E2D4;--card:#F1ECE1;--prompt:#F5F1E8;--ink:#26221B;--body:#6B6459;--marker:#A79F8F;--accent:#F4E6A3;--accent-ink:#3A3421;--ph:#BE6A2E;--line:rgba(38,34,27,.10);--foot:#9C9484}` +
    `html,body{background:var(--bg);color:var(--ink)}` +
    `body{font-family:'Helvetica Neue',Inter,-apple-system,BlinkMacSystemFont,Arial,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}` +
    `.page{max-width:794px;min-height:1123px;margin:0 auto;padding:64px 70px 30px;display:flex;flex-direction:column;position:relative}` +
    `h1,h2{font-weight:900;letter-spacing:-.02em;color:var(--ink);line-height:1.04;-webkit-text-stroke:.8px var(--ink)}` +
    `.plug-title{-webkit-text-stroke:1px var(--ink)}` +
    `.cover h1{-webkit-text-stroke:1.1px var(--ink)}` +
    `.eyebrow{font-size:11px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:var(--marker);margin-bottom:14px}` +
    `.marker{font-size:13px;font-weight:800;letter-spacing:.12em;color:var(--marker);margin-bottom:14px}` +
    `.body{font-size:16px;color:var(--body);line-height:1.7}` +
    `.body strong{color:var(--ink);font-weight:700}` +
    `.body + .body{margin-top:14px}` +
    `.cover{justify-content:center}` +
    `.cover .eyebrow{text-align:center;margin-bottom:26px}` +
    `.cover h1{font-size:62px;line-height:1.0;margin-bottom:26px}` +
    `.cover h1 em{font-style:normal;background:var(--accent);padding:0 10px;border-radius:6px}` +
    `.cover-sub{font-size:18px;color:var(--body);line-height:1.6;max-width:560px;margin-bottom:38px}` +
    `.cover-list{margin:30px 0 0;padding:0;list-style:none}` +
    `.cover-list li{display:flex;gap:14px;align-items:baseline;padding:9px 0;border-top:1px solid var(--line);font-size:16px;color:var(--body)}` +
    `.cover-list li:last-child{border-bottom:1px solid var(--line)}` +
    `.cover-list .n{font-weight:900;color:var(--ink);font-size:15px;min-width:26px}` +
    `.cover-list b{color:var(--ink);font-weight:800}` +
    `.content{flex:1}` +
    `.plug-title{font-size:44px;margin-bottom:6px}` +
    `.plug-kicker{font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ph);margin-bottom:20px}` +
    `.lead{font-size:17px;color:var(--body);line-height:1.65;margin-bottom:26px;max-width:600px}` +
    `.lead strong{color:var(--ink);font-weight:700}` +
    `.reflink{display:inline-block;margin:-14px 0 4px;font-size:15px;font-weight:800;color:var(--ph);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1.5px}` +
    `.sublabel{font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--marker);margin:26px 0 14px}` +
    `.card{background:var(--card);border-radius:14px;padding:20px 22px;margin-bottom:12px}` +
    `.card h3{font-size:17px;font-weight:800;color:var(--ink);margin-bottom:6px;display:flex;gap:12px;align-items:baseline}` +
    `.card h3 .cn{color:var(--ph);font-weight:900;font-size:15px}` +
    `.card p{font-size:14.5px;color:var(--body);line-height:1.6}` +
    `.card p strong{color:var(--ink);font-weight:700}` +
    `.benefit{background:var(--accent);border-radius:14px;padding:20px 24px;margin-top:22px}` +
    `.benefit .bl{font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);opacity:.6;margin-bottom:8px}` +
    `.benefit p{font-size:16px;color:var(--accent-ink);line-height:1.6;font-weight:600}` +
    `.prompt{background:var(--prompt);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-top:14px}` +
    `.prompt .pl{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--marker);margin-bottom:10px}` +
    `.prompt p{font-size:14.5px;color:#4f493f;line-height:1.7;font-style:italic}` +
    `.prompt .var{color:var(--ph);font-style:normal;font-weight:700}` +
    `.final h2{font-size:34px;margin-bottom:18px;line-height:1.1}` +
    `.final .body{font-size:17px}` +
    `.final-contacts{margin-top:26px;font-size:17px;font-weight:800;color:var(--ink);line-height:1.9}` +
    `.final-contacts a{color:var(--ink);text-decoration:none}` +
    `.foot{margin-top:auto;padding-top:22px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--foot)}` +
    `.foot .fr{font-weight:700}` +
    `@media print{@page{margin:0;size:A4}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{max-width:none;width:100%;min-height:100vh;page-break-after:always;break-after:page}.page:last-child{page-break-after:auto}.card,.benefit,.prompt{break-inside:avoid}}` +
    `</style></head><body>${cover}${pages}${finalPage}</body></html>`;
}

async function renderGuidePdf(html, outPath) {
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  };
  const chromiumPath = await findChromium();
  if (chromiumPath) launchOptions.executablePath = chromiumPath;
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 900)); // шрифты
    // Страницы режет print-CSS шаблона (page-break-after на .page) — скрипт пагинации не нужен
    await page.pdf({ path: outPath, width: "794px", height: "1123px", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  } finally {
    await browser.close();
  }
  return outPath;
}

// Верстает PDF, сохраняет JSON гайда в state (для правок) и шлёт файл в чат.
async function finishGuide(guide) {
  const html = buildGuideHtml(guide);
  const dir = path.join(STATE_DIR, "guides");
  await fs.mkdir(dir, { recursive: true });
  // Имя файла латиницей через дефис — по инструкции шаблона гайдов
  const translit = { "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya" };
  const slug = String(guide.title || "guide").toLowerCase()
    .replace(/[а-яё]/g, (ch) => translit[ch] ?? "")
    .replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 60) || "guide";
  const outPath = path.join(dir, `${slug}.pdf`);
  await renderGuidePdf(html, outPath);
  await writeState("guide_data", JSON.stringify(guide));
  const word = String(guide.code_word || "").toUpperCase();
  await sendDocument(APPROVAL_TOKEN, APPROVAL_CHAT_ID, APPROVAL_TOPIC_ID, outPath,
    `📗 «${guide.title}» · кодовое слово: ${word}`);
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `Готово. Отправляй этот PDF всем, кто напишет «${word}» в директ. Не понравился раздел — скажи «переделай гайд, <что поправить>».`,
    APPROVAL_TOPIC_ID);
  console.log(`[Гайд] готов: ${outPath}`);
}

async function cmdMakeGuide(topic, codeWord, brief = null) {
  const startedAt = Date.now();
  await setAgentStatus("guide", { state: "running", startedAt, finishedAt: null, error: null }).catch(() => {});
  try {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `📗 Пишу гайд «${topic}»${codeWord ? ` под слово ${codeWord.toUpperCase()}` : ""}${brief ? " по твоему материалу" : ""} и верстаю PDF...`, APPROVAL_TOPIC_ID);
    const guide = await generateGuide(topic, codeWord, brief);
    await writeState("guide_meta", JSON.stringify({ topic, codeWord: codeWord || null, brief: brief || null }));
    await finishGuide(guide);
    const finishedAt = Date.now();
    const preview = `«${guide.title}»${guide.code_word ? ` · слово ${String(guide.code_word).toUpperCase()}` : ""}`;
    await setAgentStatus("guide", { state: "done", finishedAt, durationMs: finishedAt - startedAt, outputPreview: preview, error: null }).catch(() => {});
    await appendRunHistory({ key: "guide", name: "Гайд-мейкер", ok: true, durationMs: finishedAt - startedAt, preview }).catch(() => {});
  } catch (err) {
    console.error("[Гайд] ошибка:", err.message);
    await setAgentStatus("guide", { state: "error", finishedAt: Date.now(), error: String(err.message || err).slice(0, 300) }).catch(() => {});
    await appendRunHistory({ key: "guide", name: "Гайд-мейкер", ok: false, error: String(err.message || err).slice(0, 200) }).catch(() => {});
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Гайд не получился: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Правит последний гайд по инструкции («переделай гайд, раздел 3 короче»).
// Без инструкции — полная перегенерация по той же теме.
async function cmdEditGuide(instruction) {
  try {
    let guide = null;
    try { guide = JSON.parse(await readState("guide_data")); } catch {}
    if (!guide) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "Свежего гайда нет. Сначала: «сделай гайд про <тему>».", APPROVAL_TOPIC_ID);
      return;
    }
    if (!instruction) {
      let meta = {};
      try { meta = JSON.parse(await readState("guide_meta")); } catch {}
      if (meta.topic) { await cmdMakeGuide(meta.topic, meta.codeWord, meta.brief || null); return; }
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "Что поправить? Скажи: «переделай гайд, <что поправить>».", APPROVAL_TOPIC_ID);
      return;
    }
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `✏️ Правлю гайд и перевёрстываю PDF...`, APPROVAL_TOPIC_ID);
    const raw = await callClaude(await getSystemPrompt("guide"),
      `Текущий гайд (JSON):\n${JSON.stringify(guide)}\n\nПравка от автора: "${instruction}"\n\n` +
      `Примени правку. Всё, чего правка не касается, оставь ДОСЛОВНО как было. Верни полный JSON гайда в том же формате.`, 6000);
    const m = raw.match(/\{[\s\S]*\}/);
    const updated = JSON.parse(m ? m[0] : raw);
    if (!updated.title || !Array.isArray(updated.sections) || !updated.sections.length) {
      throw new Error("правка вернула пустой гайд");
    }
    await finishGuide(updated);
  } catch (err) {
    console.error("[Гайд] ошибка правки:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Правка гайда не получилась: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Ловит команду гайда: «сделай/делай гайд про X», «гайд по X под слово Y»,
// «хочу/нужен гайд про X». Возвращает true если сообщение обработано.
// Чистый разбор команды гайда. Хвост после «гайд про» берём из ОРИГИНАЛА —
// регистр и ссылки сохраняются, [\s\S] вместо точки: материал бывает
// многострочным (сценарий рилса, список пунктов). Первое предложение = тема
// (для статуса и правок), весь хвост = материал-основа, если он длиннее темы.
function parseGuideCommand(text) {
  const tailMatch = String(text || "").match(/гайд[а-яё]*\s+(?:про|по|о|для|на тему)\s+([\s\S]+)/i);
  let tail = tailMatch ? tailMatch[1].trim().replace(/^[«"']+|[»"']+$/g, "").trim() : "";
  // «под (кодовым) словом X» — вырезаем из хвоста, где бы ни стояло.
  // \w не ловит кириллицу — классы [а-яё] обязательны
  let codeWord = null;
  const wordMatch = tail.match(/\s*под\s+(?:кодов[а-яё]*\s+)?слов[а-яё]*\s+[«"']?([а-яёА-ЯЁa-zA-Z]+)[»"']?/);
  if (wordMatch) {
    codeWord = wordMatch[1];
    tail = (tail.slice(0, wordMatch.index) + tail.slice(wordMatch.index + wordMatch[0].length)).trim();
  }
  if (!tail) return { topic: "", codeWord, brief: null };
  const firstSentence = (tail.split(/(?<=[.!?])\s+|\n/)[0] || "").trim().replace(/[.!?]+$/, "");
  const topic = (firstSentence || tail).slice(0, 80).trim();
  // Материал считаем основой, только если после темы есть ощутимый текст
  const brief = tail.length > firstSentence.length + 40 ? tail : null;
  return { topic, codeWord, brief };
}

function handleGuideCommand(text) {
  const lower = text.toLowerCase().trim();
  if (!/(сдела|дела|собер|напиш|созда|сгенер|запил|нужен|нужна|хочу).{0,30}гайд|^гайд\s/.test(lower)) return false;
  // Просят другой формат, а «гайд» — лишь тема ("сделай карусель про гайды"):
  // формат назван РАНЬШЕ слова "гайд" → это не команда гайд-мейкера
  const idxGuide = lower.search(/гайд/);
  const idxFormat = lower.search(/карусел|рилс|reels|тредс|threads|(?<![а-яё])пост(?![а-яё])/);
  if (idxFormat >= 0 && idxFormat < idxGuide) return false;
  const { topic, codeWord, brief } = parseGuideCommand(text);
  if (!topic) {
    sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Про что гайд? Скажи: «сделай гайд про <тему>» (можно добавить «под слово ТАКОЕ-ТО»). После темы можно прислать материал — сценарий, пункты, ссылки: гайд соберётся на его основе.", APPROVAL_TOPIC_ID).catch(() => {});
    return true;
  }
  cmdMakeGuide(topic, codeWord, brief);
  return true;
}

// Ловит правку гайда: «переделай гайд, раздел 3 короче», «поправь гайд ...»,
// «в гайде замени промпт». Возвращает true если сообщение обработано.
function handleGuideEditCommand(text) {
  const t = text.trim();
  const m = t.match(/^(?:переделай|перепиши|поправь|исправь)\s+гайд[а-яё]*[,:\s]*([\s\S]*)$/i) ||
            t.match(/^в\s+гайде\s+([\s\S]+)$/i);
  if (!m) return false;
  cmdEditGuide((m[1] || "").trim());
  return true;
}

// ─────────────────────────────────────────────────────────────
// ОБЛОЖКИ РИЛСОВ — 9:16 (1080×1920) в стиле эдиториал-обложки карусели:
// её фото во весь кадр + стеклянная карточка с заголовком. Фото хранится
// на persistent-томе: прислала раз с подписью «фото для обложек» — дальше
// обложки по тексту: «сделай обложку рилса: <текст>».
// ─────────────────────────────────────────────────────────────
const REELS_COVER_DIR  = path.join(STATE_DIR, "reels_cover");
const REELS_COVER_META = path.join(REELS_COVER_DIR, "last.json");
const REELS_PHOTO_EXTS = ["jpg", "png", "webp"];

// HEIC с айфона (отправка «файлом») Chromium не читает — конвертируем в JPEG
async function normalizeImageBuffer(buf, ext) {
  const e = String(ext || "").toLowerCase().replace("jpeg", "jpg");
  if (e === "heic" || e === "heif") {
    const { default: heicConvert } = await import("heic-convert");
    const out = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.92 });
    return { buf: Buffer.from(out), ext: "jpg" };
  }
  if (!REELS_PHOTO_EXTS.includes(e)) throw new Error(`формат .${e} не поддерживаю — пришли jpg, png, webp или heic`);
  return { buf, ext: e };
}

async function saveReelsPhoto(rawBuf, rawExt) {
  const { buf, ext } = await normalizeImageBuffer(rawBuf, rawExt);
  await fs.mkdir(REELS_COVER_DIR, { recursive: true });
  for (const e of REELS_PHOTO_EXTS) await fs.unlink(path.join(REELS_COVER_DIR, `photo.${e}`)).catch(() => {});
  await fs.writeFile(path.join(REELS_COVER_DIR, `photo.${ext}`), buf);
  return ext;
}

async function loadReelsPhotoUri() {
  for (const e of REELS_PHOTO_EXTS) {
    const p = path.join(REELS_COVER_DIR, `photo.${e}`);
    const buf = await fs.readFile(p).catch(() => null);
    if (buf) return `data:image/${e === "jpg" ? "jpeg" : e};base64,${buf.toString("base64")}`;
  }
  return null;
}

// Первая строка (или до « / ») — заголовок, остальное — подзаголовок.
// knobs: scale (размер текста), veil (затемнение фона), lift (карточка выше/ниже).
function buildReelsCoverHtml(text, photoUri, knobs = {}) {
  const scale = knobs.scale || 1, veil = knobs.veil ?? 0, lift = knobs.lift || 0;
  const parts = String(text || "").split(/\n+|\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
  const headline = parts[0] || "";
  const sub = parts.slice(1).join(" ");
  const size = Math.round(Math.min(headlineFontSize(headline) + 10, 92) * scale);
  const subHtml = sub
    ? `<div style="font:400 34px Inter;line-height:1.35;color:rgba(255,255,255,.85);margin-top:26px">${prepCarouselText(sub)}</div>`
    : "";
  const extraVeil = veil > 0
    ? `<div style="position:absolute;inset:0;background:rgba(20,14,10,${Math.min(veil, 0.5)})"></div>` : "";
  // Безопасная зона 4:5 (в сетке профиля кадр режется до центральных 1080×1350):
  // шапка ниже y=285, низ карточки выше y=1635
  return EDITORIAL_DOC(
    `<div style="position:relative;width:1080px;height:1920px;overflow:hidden;background:#141009;font-family:Inter,sans-serif">` +
    `<img src="${photoUri}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` +
    `<div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(20,14,10,.62) 0%,rgba(20,14,10,.10) 52%)"></div>` +
    extraVeil +
    `<div style="position:absolute;top:320px;left:0;right:0;z-index:5;text-align:center;font:700 26px Inter;letter-spacing:.24em;color:rgba(255,255,255,.85)">${AUTHOR_TAG.toUpperCase()}</div>` +
    `<div style="position:absolute;left:72px;right:72px;bottom:${430 + lift}px;z-index:4;background:rgba(64,58,52,.38);border:1px solid rgba(255,255,255,.18);border-radius:30px;padding:56px 60px;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)">` +
      `<div style="font:900 ${size}px Inter;line-height:1.06;letter-spacing:-.01em;color:#FFFFFF;text-transform:uppercase">${prepCarouselText(headline)}</div>` +
      subHtml +
    `</div>` +
    `<div style="position:absolute;bottom:88px;left:0;right:0;z-index:5;text-align:center;font:500 24px Inter;letter-spacing:.08em;color:rgba(255,255,255,.55)">${AUTHOR_TAG} · t.me/</div>` +
    `</div>`);
}

async function renderReelsCoverPng(html) {
  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  };
  const chromiumPath = await findChromium();
  if (chromiumPath) launchOptions.executablePath = chromiumPath;
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 2 });
    const fontCss = `${CAROUSEL_FONT_CSS || ""}${EDITORIAL_FONT_CSS || ""}`;
    await page.setContent(fontCss ? html.replace("<style>", `<style>${fontCss}`) : html,
      { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800)); // шрифты
    const outPath = path.join(REELS_COVER_DIR, "cover.png");
    await fs.mkdir(REELS_COVER_DIR, { recursive: true });
    await page.screenshot({ path: outPath, type: "png" });
    return outPath;
  } finally {
    await browser.close();
  }
}

// oneShotPhotoUri — разовая обложка с присланным фото, сохранённое не трогаем
async function cmdReelsCover(text, oneShotPhotoUri = null, knobs = {}) {
  try {
    const photoUri = oneShotPhotoUri || await loadReelsPhotoUri();
    if (!photoUri) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "Фото ещё нет. Пришли своё фото с подписью «фото для обложек» (можно файлом, без сжатия) — и повтори команду.",
        APPROVAL_TOPIC_ID);
      return;
    }
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `🎬 Верстаю обложку: «${text}»...`, APPROVAL_TOPIC_ID);
    const outPath = await renderReelsCoverPng(buildReelsCoverHtml(text, photoUri, knobs));
    await fs.writeFile(REELS_COVER_META, JSON.stringify({ text, knobs, oneShot: !!oneShotPhotoUri }), "utf8");
    await sendDocument(APPROVAL_TOKEN, APPROVAL_CHAT_ID, APPROVAL_TOPIC_ID, outPath,
      `🎬 Обложка 1080×1920 · «${text.slice(0, 80)}»`);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Готово, файл без сжатия. Поправить: «переделай обложку рилса, текст крупнее / фон темнее / карточку выше».",
      APPROVAL_TOPIC_ID);
    console.log(`[Обложка] готова: ${outPath}`);
  } catch (err) {
    console.error("[Обложка] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Обложка не получилась: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Правка последней обложки простыми ручками, без LLM
async function cmdReelsCoverEdit(instruction) {
  let meta = null;
  try { meta = JSON.parse(await fs.readFile(REELS_COVER_META, "utf8")); } catch {}
  if (!meta || !meta.text) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Свежей обложки нет. Сначала: «сделай обложку рилса: <текст>».", APPROVAL_TOPIC_ID);
    return;
  }
  const knobs = { scale: 1, veil: 0, lift: 0, ...(meta.knobs || {}) };
  const low = instruction.toLowerCase();
  const quoted = instruction.match(/[«"']([^«»"']{3,})[»"']/);
  if (quoted) meta.text = quoted[1].trim();
  if (/крупнее|больше/.test(low)) knobs.scale = Math.min(knobs.scale + 0.12, 1.5);
  if (/мельче|меньше/.test(low))  knobs.scale = Math.max(knobs.scale - 0.12, 0.6);
  if (/темнее/.test(low))  knobs.veil = Math.min((knobs.veil || 0) + 0.15, 0.5);
  if (/светлее/.test(low)) knobs.veil = Math.max((knobs.veil || 0) - 0.15, 0);
  if (/выше/.test(low)) knobs.lift = Math.min((knobs.lift || 0) + 130, 500);
  if (/ниже/.test(low)) knobs.lift = Math.max((knobs.lift || 0) - 130, -200);
  await cmdReelsCover(meta.text, null, knobs);
}

// «сделай обложку рилса: 5 нейросетей», «обложка рилса про оплату», голосом тоже
function handleReelsCoverCommand(text) {
  const lower = text.toLowerCase().trim();
  if (!/обложк[а-яё]*\s+(?:для\s+)?рилс|рилс[а-яё]*\s+обложк/.test(lower)) return false;
  if (/^(переделай|перерисуй|поправь|исправь)/.test(lower)) return false; // это правка
  const m = text.match(/рилс[а-яё]*\s*[:—-]\s*([\s\S]+)/i) ||
            text.match(/рилс[а-яё]*\s+(?:про|по|о|для|с текстом)\s+([\s\S]+)/i);
  const coverText = m ? m[1].trim().replace(/^[«"']+|[»"']+$/g, "").trim() : "";
  if (!coverText) {
    sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Какой текст на обложку? Скажи: «сделай обложку рилса: <текст>».", APPROVAL_TOPIC_ID).catch(() => {});
    return true;
  }
  cmdReelsCover(coverText);
  return true;
}

function handleReelsCoverEditCommand(text) {
  const m = text.trim().match(/^(?:переделай|перерисуй|поправь|исправь)\s+обложк[а-яё]*\s+(?:для\s+)?рилс[а-яё]*[,:\s]*([\s\S]*)$/i);
  if (!m) return false;
  cmdReelsCoverEdit((m[1] || "").trim());
  return true;
}

// ─────────────────────────────────────────────────────────────
// МОНИТОРИНГ КАНАЛА канала автора
// TELEGRAM_BOT_TOKEN_1 (аналитик-бот) должен быть добавлен в канал
// как администратор. Только читает — никогда не пишет.
// Если в канале есть группа обсуждений — добавь бота туда же,
// тогда будет собирать и комментарии.
// ─────────────────────────────────────────────────────────────
const CHANNEL_POSTS_FILE   = path.join(STATE_DIR, "channel_posts.json");
const CHANNEL_MAX_POSTS    = 60;
const CHANNEL_MAX_COMMENTS = 150;

// Публичный username канала для веб-скрапинга истории (t.me/s/<username>)
const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME || "";
const CHANNEL_PROFILE_FILE = path.join(STATE_DIR, "channel_profile.txt");

async function loadChannelPosts() {
  try {
    return JSON.parse(await fs.readFile(CHANNEL_POSTS_FILE, "utf8"));
  } catch {
    return { posts: [], comments: [], lastOffset: 0 };
  }
}

// Парсит HTML страницы t.me/s/ — возвращает [{id, text}]
function parseChannelHtml(raw) {
  const posts = [];
  const parts = raw.split(/data-post="[^/]+\/(\d+)"/);
  // parts: [pre, id1, html1, id2, html2, ...]
  for (let i = 1; i < parts.length - 1; i += 2) {
    const pid   = Number(parts[i]);
    const chunk = parts[i + 1];
    let m = chunk.match(
      /js-message_text[^>]*>([\s\S]*?)<\/div>\s*<div class="tgme_widget_message_(?:footer|reply_markup|info)/
    );
    if (!m) m = chunk.match(/js-message_text[^>]*>([\s\S]*)$/);
    let t = m ? m[1] : "";
    t = t.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "");
    t = decodeHtmlEntities(t).trim();
    if (t.length > 10) posts.push({ id: pid, text: t.slice(0, 1500) });
  }
  return posts;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// Собирает всю историю канала через публичное веб-превью t.me/s/<username>.
// Работает без бота и без MTProto, листает страницы пока есть посты.
async function fetchChannelHistoryWeb(maxPages = 40) {
  const base = `https://t.me/s/${CHANNEL_USERNAME}`;
  const found = new Map();
  let before = null;

  for (let page = 0; page < maxPages; page++) {
    const url = before ? `${base}?before=${before}` : base;
    let raw;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) { console.warn(`[ChannelHistory] HTTP ${res.status} на ${url}`); break; }
      raw = await res.text();
    } catch (e) {
      console.warn("[ChannelHistory] ошибка загрузки:", e.message);
      break;
    }

    const pagePosts = parseChannelHtml(raw);
    if (pagePosts.length === 0) break;

    let minId = Infinity;
    for (const p of pagePosts) {
      found.set(p.id, p);
      if (p.id < minId) minId = p.id;
    }
    console.log(`[ChannelHistory] стр.${page + 1}: +${pagePosts.length}, всего ${found.size} (before=${minId})`);

    if (before !== null && minId >= before) break; // не сдвинулись — конец
    before = minId;
    await new Promise(r => setTimeout(r, 400)); // не долбим Telegram
  }

  return [...found.values()].sort((a, b) => b.id - a.id);
}

const CHANNEL_PROFILE_PROMPT = `Ты аналитик контент-завода автора. Тебе дают все посты автора из Telegram-канала автора. Твоя задача — разобраться о чём пишет автор и составить профиль канала.

Проанализируй и выдай структуру (чистый текст, без markdown):

ОСНОВНЫЕ ТЕМЫ
Перечисли 5-8 главных тем/направлений о которых она пишет. Для каждой — насколько часто (часто / иногда / редко).

РУБРИКИ И ФОРМАТЫ
Какие повторяющиеся форматы видны: разборы, личные истории, гайды, списки инструментов, закулисье, цифры/результаты.

ТОН И ПОДАЧА
Как она пишет — в двух-трёх предложениях. Конкретные речевые приёмы которые повторяются.

ЧТО УЖЕ ПОДРОБНО РАСКРЫТО
Темы которые она уже разобрала глубоко — их НЕ нужно повторять, можно только развивать под новым углом.

БЕЛЫЕ ПЯТНА
2-4 темы из ниши которые она почти не трогала, но логично укладываются в её контент.

Только факты из постов, без воды.`;

// Анализирует профиль канала на основе собранных постов, сохраняет в стейт
async function analyzeChannelProfile() {
  const state = await loadChannelPosts();
  if (state.posts.length === 0) throw new Error("нет постов для анализа — сначала собери историю");

  const corpus = state.posts
    .slice(0, 80)
    .map((p, i) => `[пост ${i + 1}]\n${p.text}`)
    .join("\n\n———\n\n");

  const profile = await callClaude(
    CHANNEL_PROFILE_PROMPT,
    `Вот ${Math.min(state.posts.length, 80)} постов из канала @${CHANNEL_USERNAME}:\n\n${corpus}\n\nСоставь профиль канала.`,
    6000
  );
  await fs.writeFile(CHANNEL_PROFILE_FILE, profile.trim(), "utf8");
  console.log(`[ChannelProfile] профиль сохранён (${profile.length} симв.)`);
  return profile.trim();
}

async function readChannelProfile() {
  return fs.readFile(CHANNEL_PROFILE_FILE, "utf8").catch(() => "");
}

// Банк из 100 идей + стратегия автора (reference/strategy-ideas.txt).
// Аналитик берёт отсюда готовые темы, не дублируя уже вышедшее.
const STRATEGY_IDEAS_FILE = path.join(__dirname, "reference", "strategy-ideas.txt");
async function readStrategyIdeas() {
  return fs.readFile(STRATEGY_IDEAS_FILE, "utf8").catch(() => "");
}

// Обзор контент-плана на период (что уже запланировано по дням) — чтобы не дублировать
const CONTENT_PLAN_FILE = path.join(__dirname, "reference", "content-plan-overview.txt");
async function readContentPlanOverview() {
  return fs.readFile(CONTENT_PLAN_FILE, "utf8").catch(() => "");
}

// Эталонные посты автора — дословные образцы её голоса (reference/voice-samples.txt)
const VOICE_SAMPLES_FILE = path.join(__dirname, "reference", "voice-samples.txt");
async function readVoiceSamples() {
  return fs.readFile(VOICE_SAMPLES_FILE, "utf8").catch(() => "");
}

// ─────────────────────────────────────────────────────────────
// КОПИЛКА ИДЕЙ — автор кидает идею голосом/текстом, она сохраняется
// (не уходит сразу в продакшн). Аналитик берёт идеи пачкой при генерации
// тем и плана недели. Так голосовые идеи не теряются.
// ─────────────────────────────────────────────────────────────
const IDEA_BANK_FILE = path.join(STATE_DIR, "idea_bank.json");

async function loadIdeas() {
  try { return JSON.parse(await fs.readFile(IDEA_BANK_FILE, "utf8")); }
  catch { return []; }
}
async function saveIdeas(ideas) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(IDEA_BANK_FILE, JSON.stringify(ideas, null, 2), "utf8");
}

// Отдаёт новые (неиспользованные) идеи для контекста аналитика
async function readIdeaBank() {
  const ideas = await loadIdeas();
  const fresh = ideas.filter(i => i.status !== "used");
  if (fresh.length === 0) return "";
  return `Копилка идей автора (её собственные мысли — приоритет, бери в работу в первую очередь):\n` +
    fresh.map((i, n) => `${n + 1}. ${i.text}${i.note ? ` [как подать: ${i.note}]` : ""}`).join("\n");
}

// Сохраняет идею + короткий разбор от аналитика как реализовать
async function cmdSaveIdea(text) {
  // Убираем триггерные слова в начале
  const clean = text.replace(/^(запиши идею|идея на будущее|идея|в копилку|на будущее|не забудь|запомни)\s*[:,—-]?\s*/i, "").trim() || text.trim();
  try {
    const note = await callClaude(
      `Ты аналитик контент-завода автора (ниша: ИИ/нейросети для новичков и фрилансеров). Тебе дают сырую идею. Дай ОЧЕНЬ короткий разбор как её реализовать: в 1-2 предложениях — под какой формат (Reels/карусель/Telegram/Threads) и какой угол. Без воды, чистый текст.`,
      `Идея автора: "${clean}"`,
      400
    ).catch(() => "");

    const ideas = await loadIdeas();
    ideas.unshift({
      id: Date.now(),
      text: clean,
      note: note.trim(),
      date: new Date().toISOString().slice(0, 10),
      status: "new",
    });
    await saveIdeas(ideas);

    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `💡 Записала в копилку (всего идей: ${ideas.filter(i => i.status !== "used").length}):\n"${clean}"` +
      (note ? `\n\nКак реализовать: ${note.trim()}` : "") +
      `\n\nКогда захочешь — скажи "сделай контент из идей" или "мои идеи".`,
      APPROVAL_TOPIC_ID);
  } catch (err) {
    console.error("[Идея] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Показывает копилку
async function cmdListIdeas() {
  const ideas = await loadIdeas();
  const fresh = ideas.filter(i => i.status !== "used");
  if (fresh.length === 0) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Копилка пустая. Кидай идею голосом или текстом — сохраню.", APPROVAL_TOPIC_ID);
    return;
  }
  const lines = fresh.map((i, n) =>
    `${n + 1}. ${i.text}${i.note ? `\n   ↳ ${i.note}` : ""}`
  );
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `💡 Копилка идей (${fresh.length}):\n\n${lines.join("\n\n")}\n\n` +
    `"сделай контент из идей" — пущу в работу. "удали идею N" — убрать. "очисти идеи" — очистить всё.`,
    APPROVAL_TOPIC_ID);
}

// ─────────────────────────────────────────────────────────────
// КОНТЕНT-ПЛАН НА НЕДЕЛЮ
// автор просит план → бот присылает версию → она правит точечно →
// говорит "ок" → бот генерит контент по каждой теме из плана.
// ─────────────────────────────────────────────────────────────
const WEEK_PLAN_FILE = path.join(STATE_DIR, "week_plan.json");
let weekPlanPending = false; // true пока план ждёт правок/утверждения

async function loadWeekPlan() {
  try { return JSON.parse(await fs.readFile(WEEK_PLAN_FILE, "utf8")); }
  catch { return null; }
}
async function saveWeekPlan(plan) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(WEEK_PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
}

const WEEK_PLAN_PROMPT = `Ты контент-стратег автора. Составь контент-план на неделю (7 дней), ОТТАЛКИВАЯСЬ ОТ ЕЁ УЖЕ ВЫШЕДШИХ ПОСТОВ и их реальных цифр — что зашло аудитории по просмотрам, сохранениям, подписке.

Как думать:
- Основа плана — анализ её статистики и вышедших постов (Instagram И Telegram). Бери темы и форматы, которые УЖЕ залетели, и развивай их свежим углом, следующим шагом, новым поводом или глубиной. Не выдумывай темы с потолка.
- Telegram планируй отдельно от Instagram: смотри что выходило в канале канала автора и какие вопросы задают подписчики — закрывай их постами. Не отсылай между платформами.
- НЕ повторяй темы которые уже выходили (список дан). Если тема близка к вышедшей — дай свежий угол и пометь "АДАПТАЦИЯ" (укажи в теме, какой пост развиваешь). Совсем новая тема — "НОВАЯ".
- Банк идей и стратегия — это только справка, НЕ основной источник. Не вытаскивай темы оттуда механически. Свежие идеи из копилки автора можешь учесть, но приоритет у того, что реально заходит по цифрам.
- Распределение: основа — Reels (Instagram), плюс карусель, Telegram-посты и Threads. Примерно 4-5 Reels, 1 карусель, 2-3 Telegram-поста, 1-2 Threads за неделю. Можно несколько форматов в один день.
- У каждого пункта: день, платформа, формат, тема (конкретная, не общая), хук (первая фраза/идея зацепки), статус НОВАЯ/АДАПТАЦИЯ.

Верни СТРОГО валидный JSON без markdown и пояснений:
{"days":[{"day":"Понедельник","platform":"Instagram","format":"Reels","theme":"...","hook":"...","status":"НОВАЯ"}]}`;

async function generateWeekPlan(brief = "") {
  const [pmpAnalytics, accountStats, channelData, strategyIdeas, ideaBank] = await Promise.all([
    fetchPostMyPostAnalytics(30).catch(() => ""),
    readAccountAnalysis().catch(() => ""),
    readChannelData().catch(() => ""),
    readStrategyIdeas().catch(() => ""),
    readIdeaBank().catch(() => ""),
  ]);
  const ctx =
    (pmpAnalytics  ? `ГЛАВНАЯ ОПОРА — СВЕЖАЯ АНАЛИТИКА ВЫШЕДШИХ ПОСТОВ ИЗ POSTMYPOST (реальные просмотры/охваты/ER за последние дни, развивай то, что зашло):\n${pmpAnalytics}\n\n` : "") +
    (accountStats  ? `Доп. статистика и залетевшие посты Instagram:\n${accountStats}\n\n` : "") +
    (channelData   ? `УЖЕ ВЫХОДИЛО В TELEGRAM + ВОПРОСЫ ПОДПИСЧИКОВ (не повторять — развивать новым углом, закрывать вопросы):\n${channelData}\n\n` : "") +
    (ideaBank      ? `Свежие идеи автора из копилки (можно учесть, но не основа плана):\n${ideaBank}\n\n` : "") +
    (strategyIdeas ? `Справочно — стратегия и банк идей (только подсказка, НЕ брать темы механически):\n${strategyIdeas.slice(0, 12000)}\n\n` : "") +
    (brief ? `Пожелание автора: "${brief}"\n\n` : "") +
    `Сегодня ${new Date().toISOString().slice(0, 10)}. Составь план на неделю из анализа вышедших постов, верни JSON.`;

  const raw = await callClaude(WEEK_PLAN_PROMPT, ctx, 4000);
  const m = raw.match(/\{[\s\S]*\}/);
  const plan = JSON.parse(m ? m[0] : raw);
  if (!plan.days || !Array.isArray(plan.days) || plan.days.length === 0) {
    throw new Error("план получился пустой");
  }
  await saveWeekPlan(plan);
  return plan;
}

function renderWeekPlan(plan) {
  const lines = plan.days.map((d, i) =>
    `${i + 1}. ${d.day} · ${d.platform} ${d.format} · ${d.status}\n   Тема: ${d.theme}\n   Хук: ${d.hook}`
  );
  return `📅 Контент-план на неделю:\n\n${lines.join("\n\n")}\n\n` +
    `Раскрыть одну тему: "раскрой 3" или "раскрой среду" — сделаю только её.\n` +
    `Поправить: "замени тему в среду", "пункт 3 переделай под новичков".\n` +
    `Сделать сразу весь план — напиши "ок".`;
}

const WEEK_PLAN_EDIT_PROMPT = `Ты редактор контент-плана автора. У тебя есть текущий план (JSON) и её правка. Примени ТОЛЬКО то что она просит — остальные пункты оставь без изменений, слово в слово.

Верни СТРОГО валидный JSON в том же формате {"days":[...]}, без markdown и пояснений.`;

async function editWeekPlan(instruction) {
  const plan = await loadWeekPlan();
  if (!plan) throw new Error("нет активного плана");
  const raw = await callClaude(
    WEEK_PLAN_EDIT_PROMPT,
    `Текущий план:\n${JSON.stringify(plan)}\n\nПравка автора: "${instruction}"\n\nВерни обновлённый JSON.`,
    4000
  );
  const m = raw.match(/\{[\s\S]*\}/);
  const updated = JSON.parse(m ? m[0] : raw);
  if (!updated.days || !Array.isArray(updated.days)) throw new Error("правка сломала план");
  await saveWeekPlan(updated);
  return updated;
}

// Тема дня → какой агент её делает
function planItemAgent(item) {
  const f = `${item.format || ""} ${item.platform || ""}`.toLowerCase();
  if (/threads|тредс|тред/.test(f)) return "threads";
  if (/карусел|carousel/.test(f))   return "carousel";
  if (/reels|рилс/.test(f))         return "reels";
  if (/telegram|телеграм/.test(f))  return "copywriter";
  return "copywriter";
}

// "ок" → генерим контент по каждому пункту плана
async function executeWeekPlan() {
  const plan = await loadWeekPlan();
  if (!plan) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "❌ Нет плана — сначала попроси контент-план на неделю.", APPROVAL_TOPIC_ID);
    return;
  }
  weekPlanPending = false;
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `Погнали. Делаю контент по ${plan.days.length} пунктам плана — буду присылать по мере готовности.`,
    APPROVAL_TOPIC_ID);

  for (let i = 0; i < plan.days.length; i++) {
    const item = plan.days[i];
    const agentKey = planItemAgent(item);
    const brief =
      `${item.platform} ${item.format}: ${item.theme}\n` +
      `Угол/хук: ${item.hook}\n` +
      (item.status === "АДАПТАЦИЯ" ? `Это АДАПТАЦИЯ уже выходившей темы — дай свежий угол, не повторяй дословно.` : "");

    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `▶️ ${i + 1}/${plan.days.length} · ${item.day} · ${item.platform} ${item.format}: ${item.theme}`,
      APPROVAL_TOPIC_ID);

    // Готовим бриф так же как голосовое задание, гоним через менеджера + нужного агента
    await runChain([agentKey], `план ${item.day} (${item.platform})`, async () => {
      await writeState("analyst",
        `ИДЕЯ ОТ АВТОРА:\n${brief}\n\n` +
        `ВАЖНО: делай ТОЛЬКО ${item.platform} ${item.format}. Не добавляй другие платформы.`);
      await runAgent("manager");
    }).catch(err => console.error(`[План ${item.day}] ошибка:`, err.message));
  }

  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `✅ Весь контент по плану готов. Когда захочешь выложить — напиши "опубликуй".`,
    APPROVAL_TOPIC_ID);
}

// Раскрывает ОДИН пункт плана (автор выбрала тему) — делает только его.
async function executeWeekPlanItem(idx) {
  const plan = await loadWeekPlan();
  if (!plan || !plan.days || !plan.days[idx]) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "❌ Нет такого пункта в плане.", APPROVAL_TOPIC_ID);
    return;
  }
  const item = plan.days[idx];
  const agentKey = planItemAgent(item);
  const brief =
    `${item.platform} ${item.format}: ${item.theme}\n` +
    `Угол/хук: ${item.hook}\n` +
    (item.status === "АДАПТАЦИЯ" ? `Это АДАПТАЦИЯ уже выходившей темы — дай свежий угол, не повторяй дословно.` : "");
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `▶️ Раскрываю тему: ${item.day} · ${item.platform} ${item.format}: ${item.theme}`, APPROVAL_TOPIC_ID);
  await runChain([agentKey], `план ${item.day} (${item.platform})`, async () => {
    await writeState("analyst",
      `ИДЕЯ ОТ АВТОРА:\n${brief}\n\nВАЖНО: делай ТОЛЬКО ${item.platform} ${item.format}. Не добавляй другие платформы.`);
    await runAgent("manager");
  }).catch(err => console.error(`[План пункт] ошибка:`, err.message));
}

// "раскрой 3" / "сделай тему 2" / "раскрой среду" → индекс пункта плана или null.
function parseWeekPlanItemRequest(text, plan) {
  const lower = text.toLowerCase();
  if (!/раскро|раскрут|разверни|подробн|^сделай (тему|пункт|\d|понед|вторн|сред|четв|пятн|суббот|воскр)/.test(lower)) return null;
  const num = lower.match(/\b(\d+)\b/);
  if (num) { const i = parseInt(num[1], 10) - 1; if (i >= 0 && i < plan.days.length) return i; }
  for (let i = 0; i < plan.days.length; i++) {
    const dn = (plan.days[i].day || "").toLowerCase().slice(0, 4);
    if (dn && lower.includes(dn)) return i;
  }
  return null;
}

// Обрабатывает сообщение пока план ждёт утверждения: ок / отмена / раскрыть тему / правка
async function handlePlanReply(text) {
  const lower = text.toLowerCase().trim();
  if (/^(ок|ok|да|давай|погнали|поехали|утвержда|запускай|го|подтвержда|всё ок|все ок|супер)\b/.test(lower)) {
    executeWeekPlan().catch(err => {
      console.error("[План] выполнение:", err.message);
      sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
    });
    return;
  }
  if (/^(отмена|отмени|стоп|stop|не надо|забей)\b/.test(lower)) {
    weekPlanPending = false;
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Окей, план отменила. Скажи когда понадобится новый.", APPROVAL_TOPIC_ID);
    return;
  }
  // Раскрыть ОДНУ выбранную тему ("раскрой 3", "раскрой среду") — план остаётся, можно раскрывать ещё.
  try {
    const plan = await loadWeekPlan();
    const idx = plan ? parseWeekPlanItemRequest(text, plan) : null;
    if (idx !== null) {
      await executeWeekPlanItem(idx);
      return;
    }
  } catch (e) { console.warn("[План] разбор запроса темы:", e.message); }
  // Иначе — точечная правка
  try {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "✏️ Правлю...", APPROVAL_TOPIC_ID);
    const updated = await editWeekPlan(text);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, renderWeekPlan(updated), APPROVAL_TOPIC_ID);
  } catch (err) {
    console.error("[План] правка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Не смогла поправить: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

async function cmdWeekPlan(brief) {
  try {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "📅 Собираю контент-план на неделю...", APPROVAL_TOPIC_ID);
    const plan = await generateWeekPlan(brief);
    weekPlanPending = true;
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, renderWeekPlan(plan), APPROVAL_TOPIC_ID);
  } catch (err) {
    console.error("[План] генерация:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Не смогла составить план: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// РАСКРЫТИЕ ТЕМЫ ИЗ СВОДКИ — «раскрой тему 2» после утренней сводки аналитика.
// Работает и после редеплоя (без weekPlanPending): тему ищет в недельном плане
// (если файл свежее сводки) или в последней сводке аналитика.
// Формат уточняется вопросом, если не назван в сообщении.
// ─────────────────────────────────────────────────────────────
let pendingReveal = null; // { request, summary, ts } — ждём ответ «каким форматом?»

const REVEAL_FORMAT_NAMES = { carousel: "карусель", reels: "рилс", threads: "Threads", copywriter: "Telegram-пост" };

// Формат из текста. Узкие паттерны в стиле detectVoiceAgents — [а-яё], не \b (кириллица).
function detectRevealFormat(lower) {
  if (/карусел/.test(lower)) return "carousel";
  if (/рилс|reels/.test(lower)) return "reels";
  if (/тредс|threads/.test(lower)) return "threads";
  if (/телеграм|телег|(^|[^а-яё])тг([^а-яё]|$)|(^|[\s,])пост(ы|ик|а|ов|у|е)?([\s,.!?]|$)/.test(lower)) return "copywriter";
  return null;
}

// Похоже ли сообщение на просьбу раскрыть тему
function isRevealRequest(lower) {
  return /раскро|разверни|подробнее (про|тем)/.test(lower) ||
    /^(сделай\s+|давай\s+)?тем[ау]\s*(№\s*)?\d+/.test(lower);
}

async function launchTopicReveal(request, summary, agentKey) {
  if (CHAIN_BUSY) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "⏳ Подожди, работает цепочка — раскрою тему после неё, напиши ещё раз.", APPROVAL_TOPIC_ID);
    return;
  }
  const fmtName = REVEAL_FORMAT_NAMES[agentKey] || agentKey;
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    `▶️ Раскрываю тему из сводки: делаю ${fmtName}...`, APPROVAL_TOPIC_ID);
  const brief =
    `СВОДКА АНАЛИТИКА (темы, из которых автор выбирает):\n${summary}\n\n` +
    `АВТОР ПРОСИТ: "${request}"\n\n` +
    `Найди в сводке именно ту тему, которую она просит раскрыть (по номеру или по словам), ` +
    `и сделай по ней ТОЛЬКО ${fmtName}. Другие платформы и форматы не добавляй.`;
  await runChain([agentKey], "раскрытие темы из сводки", async () => {
    await writeState("analyst", brief);
    await runAgent("manager");
  }).catch(err => {
    console.error("[Раскрытие темы] ошибка:", err.message);
    sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Не смогла раскрыть тему: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  });
}

// true = сообщение обработано (заявка на раскрытие или ответ форматом)
async function handleTopicReveal(text) {
  const lower = text.toLowerCase().trim();

  // Заявка ждёт формат не дольше 15 минут
  if (pendingReveal && Date.now() - pendingReveal.ts > 15 * 60 * 1000) pendingReveal = null;

  // Ответ на вопрос «каким форматом?»
  if (pendingReveal) {
    if (/^(отмена|отмени|не надо|забей|стоп|stop)([\s,.!]|$)/.test(lower)) {
      pendingReveal = null;
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Ок, не раскрываю.", APPROVAL_TOPIC_ID);
      return true;
    }
    // Команды Threads-автопилота («тредс статус», «стоп тредс») — не ответ форматом
    if (/(тредс|threads)\s+(стоп|тест|батч|вето|автомат|статус)|(стоп|выключи|включи|запусти)\s+(тредс|threads)/.test(lower)) return false;
    // Короткий ответ с форматом — «карусель», «давай пост». Длинное сообщение
    // с форматом внутри — это уже новое задание, не ответ на вопрос.
    const fmt = lower.length <= 20 ? detectRevealFormat(lower) : null;
    if (fmt) {
      const { request, summary } = pendingReveal;
      pendingReveal = null;
      launchTopicReveal(request, summary, fmt).catch(err => console.error("[Раскрытие темы]", err.message));
      return true;
    }
    // Не формат и не отмена: длинное сообщение = новое задание, заявку снимаем
    if (lower.length > 20) pendingReveal = null;
    return false;
  }

  if (!isRevealRequest(lower)) return false;

  // Недельный план приоритетнее сводки, только если его файл свежее
  const summaryObj = await loadAnalystSummary().catch(() => null);
  let planMtime = 0;
  try { planMtime = (await fs.stat(WEEK_PLAN_FILE)).mtimeMs; } catch {}
  if (planMtime > (summaryObj?.ts || 0)) {
    try {
      const plan = await loadWeekPlan();
      const idx = plan ? parseWeekPlanItemRequest(text, plan) : null;
      if (idx !== null) { await executeWeekPlanItem(idx); return true; }
    } catch (e) { console.warn("[Раскрытие темы] недельный план:", e.message); }
  }

  if (!summaryObj || !summaryObj.text) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Свежей сводки аналитика под рукой нет. Напиши «что нового в нише» — соберу сводку, и раскроем тему из неё.",
      APPROVAL_TOPIC_ID);
    return true;
  }

  // Формат назван прямо в сообщении («раскрой тему 2 каруселью») — делаем сразу
  const fmt = detectRevealFormat(lower);
  if (fmt) {
    launchTopicReveal(text, summaryObj.text, fmt).catch(err => console.error("[Раскрытие темы]", err.message));
    return true;
  }

  pendingReveal = { request: text, summary: summaryObj.text, ts: Date.now() };
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
    "Каким форматом раскрыть тему? Ответь: карусель / пост / рилс / тредс. Передумала — «не надо».",
    APPROVAL_TOPIC_ID);
  return true;
}

async function saveChannelPosts(data) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(CHANNEL_POSTS_FILE, JSON.stringify(data), "utf8");
}

// Формирует блок с данными канала для аналитика
async function readChannelData() {
  const [state, profile] = await Promise.all([loadChannelPosts(), readChannelProfile()]);
  if (state.posts.length === 0 && state.comments.length === 0 && !profile) return "";

  let block = "";

  // Готовый профиль канала — главный контекст (что она пишет в целом)
  if (profile) {
    block += `Профиль канала @${CHANNEL_USERNAME} (анализ всех постов):\n\n${profile}`;
  }

  // Последние посты — чтобы видеть свежие темы и не повторять
  if (state.posts.length > 0) {
    const postLines = state.posts.slice(0, 25).map(
      (p, i) => `${i + 1}. ${p.text.replace(/\n+/g, " ").slice(0, 160)}`
    );
    block += `${block ? "\n\n" : ""}Последние посты в @${CHANNEL_USERNAME} (${state.posts.length} всего):\n${postLines.join("\n")}`;
  }

  // Вопросы подписчиков из комментариев
  const questions = state.comments.filter(c => c.isQuestion).slice(0, 20);
  if (questions.length > 0) {
    const questionLines = questions.map(q => `— ${q.text.slice(0, 200)}`);
    block += `\n\nВопросы подписчиков в комментариях (${questions.length}):\n${questionLines.join("\n")}`;
  }

  return block;
}

// ─────────────────────────────────────────────────────────────
// РАЗБОР ВОПРОСОВ АУДИТОРИИ — аналитик собирает все вопросы из комментариев
// канала, группирует в часто задаваемые и предлагает темы-ответы.
// ─────────────────────────────────────────────────────────────
const FAQ_PROMPT = `Ты аналитик автора (ниша: ИИ/нейросети для новичков и фрилансеров). Тебе дают вопросы и комментарии подписчиков из её Telegram-канала. Сгруппируй их в часто задаваемые темы.

Выдай (чистый текст, без markdown):

ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ
Топ-5-8 повторяющихся тем вопросов. Для каждой:
— Тема вопроса (о чём спрашивают) — сколько раз встречается (примерно)
— Пример формулировки от подписчика
— Что это значит: какая боль/непонимание за этим стоит

ТЕМЫ ДЛЯ КОНТЕНТА
3-5 готовых тем постов/каруселей/рилсов которые закрывают эти вопросы. Конкретно, под её формат.

Только по реальным вопросам из данных. Если вопросов мало — так и скажи, не выдумывай.`;

async function analyzeChannelQuestions() {
  const state = await loadChannelPosts();
  const comments = state.comments || [];
  // Берём вопросы; если их мало — добавляем все комментарии для контекста
  let pool = comments.filter(c => c.isQuestion);
  if (pool.length < 5) pool = comments;
  if (pool.length === 0) {
    return { empty: true };
  }
  const lines = pool.slice(0, 120).map((c, i) => `${i + 1}. ${c.text.replace(/\n+/g, " ").slice(0, 250)}`).join("\n");
  const report = await callClaude(
    FAQ_PROMPT,
    `Вопросы и комментарии подписчиков @${CHANNEL_USERNAME} (${pool.length} шт.):\n\n${lines}\n\nСгруппируй в часто задаваемые и предложи темы.`,
    4000
  );
  return { report: report.trim(), total: pool.length, questions: comments.filter(c => c.isQuestion).length };
}

async function cmdAudienceQuestions() {
  try {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "📊 Собираю вопросы подписчиков из канала...", APPROVAL_TOPIC_ID);
    const res = await analyzeChannelQuestions();
    if (res.empty) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        `Пока нет собранных комментариев из @${CHANNEL_USERNAME}.\n` +
        `Чтобы я их видела — бот @analitic228Bot должен быть добавлен в группу обсуждений канала (где люди пишут комментарии под постами). ` +
        `После этого новые вопросы начнут копиться, и я смогу их разобрать.`,
        APPROVAL_TOPIC_ID);
      return;
    }
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `Разобрала ${res.total} комментариев (из них вопросов: ${res.questions}).\n\n${res.report}`,
      APPROVAL_TOPIC_ID);
  } catch (err) {
    console.error("[FAQ] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Запускает бесконечный цикл мониторинга на отдельном боте.
// Параллелен голосовому слушателю — разные токены, нет конфликта.
async function startChannelMonitor() {
  const token = process.env.TELEGRAM_BOT_TOKEN_1;
  if (!token) {
    console.log("[ChannelMonitor] TELEGRAM_BOT_TOKEN_1 не задан — мониторинг канала отключён");
    return;
  }
  console.log("[ChannelMonitor] запущен — слежу за канала автора");

  const state = await loadChannelPosts();
  let offset = state.lastOffset || 0;

  while (true) {
    try {
      const res  = await tgFetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=55&limit=100`,
        {}, 70_000
      );
      const data = await res.json();
      let changed = false;

      for (const upd of data.result || []) {
        offset = upd.update_id + 1;

        // Новый пост в канале
        if (upd.channel_post) {
          const msg  = upd.channel_post;
          const text = (msg.text || msg.caption || "").trim();
          if (text.length > 10) {
            state.posts.unshift({
              id:   msg.message_id,
              text: text.slice(0, 1000),
              date: new Date(msg.date * 1000).toISOString().slice(0, 10),
            });
            if (state.posts.length > CHANNEL_MAX_POSTS) state.posts.length = CHANNEL_MAX_POSTS;
            changed = true;
            console.log(`[ChannelMonitor] пост: "${text.slice(0, 70)}"`);
          }
        }

        // Сообщение в группе обсуждений или пересланные посты
        if (upd.message) {
          const msg  = upd.message;
          const text = (msg.text || msg.caption || "").trim();

          // Комментарий = ответ на автопересланный пост канала
          const isComment = msg.reply_to_message?.is_automatic_forward === true
            || !!msg.reply_to_message?.forward_from_chat;
          if (isComment && text.length > 3) {
            state.comments.unshift({
              text:       text.slice(0, 400),
              from:       msg.from?.username || msg.from?.first_name || "?",
              date:       new Date(msg.date * 1000).toISOString().slice(0, 10),
              isQuestion: text.includes("?"),
            });
            if (state.comments.length > CHANNEL_MAX_COMMENTS) state.comments.length = CHANNEL_MAX_COMMENTS;
            changed = true;
          }

          // автор пересылает старые посты боту — загружаем историю
          if (msg.forward_from_chat && text.length > 10) {
            const already = state.posts.some(p => p.text.slice(0, 100) === text.slice(0, 100));
            if (!already) {
              state.posts.push({
                id:        msg.forward_from_message_id || msg.message_id,
                text:      text.slice(0, 1000),
                date:      new Date((msg.forward_date || msg.date) * 1000).toISOString().slice(0, 10),
                forwarded: true,
              });
              state.posts.sort((a, b) => b.date.localeCompare(a.date));
              if (state.posts.length > CHANNEL_MAX_POSTS) state.posts.length = CHANNEL_MAX_POSTS;
              changed = true;
              console.log(`[ChannelMonitor] история: "${text.slice(0, 70)}"`);
            }
          }
        }
      }

      if (changed || (data.result || []).length > 0) {
        state.lastOffset = offset;
        await saveChannelPosts(state);
      }
    } catch (err) {
      console.warn("[ChannelMonitor] ошибка:", err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Точечный крон по одному агенту (выключен по умолчанию).
const SCHEDULE = {};

// Ежедневный авто-прогон: цепочка сама придумывает контент из статистики аккаунта
// и присылает черновики в чат. Публикатор сюда НЕ входит — посты уходят в очередь
// PostMyPost только по ручному "опубликуй" (необратимое — зона автора).
// Управление через env:
//   DAILY_CRON=off          — выключить
//   DAILY_CRON_EXPR="..."   — своё cron-выражение (по умолч. будни 7:30 МСК)
const DAILY_CRON_EXPR = process.env.DAILY_CRON_EXPR || "30 7 * * *";
// Дневной авто-прогон: только разбор статистики + Telegram-пост.
// Карусели/рилсы/тредс — по запросу голосом или текстом, не каждый день (бюджет).
const DAILY_CRON_KEYS = ["analyst", "manager", "copywriter"].filter((k) => AGENTS[k]);

function startCron() {
  for (const [key, expr] of Object.entries(SCHEDULE)) {
    cron.schedule(
      expr,
      () => {
        runChain([key], `крон ${AGENTS[key].name}`).catch((err) => {
          console.error(`[${AGENTS[key].name}] failed:`, err);
        });
      },
      { timezone: process.env.TZ || "Europe/Moscow" },
    );
    console.log(`Scheduled ${AGENTS[key].name} at "${expr}"`);
  }

  if ((process.env.DAILY_CRON || "on").toLowerCase() !== "off") {
    cron.schedule(
      DAILY_CRON_EXPR,
      () => {
        if (CHAIN_BUSY) { console.log("[Крон] цепочка уже работает — пропускаю авто-прогон"); return; }
        console.log("[Крон] авто-прогон контента из статистики аккаунта");
        runChain(DAILY_CRON_KEYS, "ежедневный авто-прогон").catch((err) => {
          console.error("[Крон] авто-прогон упал:", err.message);
        });
      },
      { timezone: process.env.TZ || "Europe/Moscow" },
    );
    console.log(`Scheduled ежедневный авто-прогон at "${DAILY_CRON_EXPR}" [${DAILY_CRON_KEYS.join(", ")}]`);
  }

  // Threads-автопилот: утренний батч на 6 постов дня. Внутри сам проверяет режим
  // (off — тихо пропускает), поэтому крон ставим всегда.
  const threadsCronExpr = process.env.THREADS_CRON_EXPR || "0 7 * * *";
  cron.schedule(
    threadsCronExpr,
    () => {
      runThreadsAutopilot().catch((err) => console.error("[Threads-автопилот] крон упал:", err.message));
    },
    { timezone: process.env.TZ || "Europe/Moscow" },
  );
  console.log(`Scheduled Threads-автопилот at "${threadsCronExpr}" (6 постов/день, режим из state/threads_mode.txt)`);

  // Сторож: в 7:20 проверяет, что утренний батч реально встал (маркер за сегодня
  // с ненулевым числом постов). Не встал — перезапуск + громкое сообщение в чат.
  cron.schedule(
    "20 7 * * *",
    async () => {
      const mode = await getThreadsMode().catch(() => "off");
      if (mode === "off") return;
      const marker = await readBatchMarker();
      const today = new Date().toISOString().slice(0, 10);
      if (marker && marker.date === today && marker.scheduled > 0) return; // всё встало
      console.warn("[Threads-сторож] утренний батч не встал — перезапускаю");
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "⚠️ Утренний батч Threads не встал в очередь — перезапускаю сама.", APPROVAL_TOPIC_ID).catch(() => {});
      runThreadsAutopilot().catch((err) => console.error("[Threads-сторож] перезапуск упал:", err.message));
    },
    { timezone: process.env.TZ || "Europe/Moscow" },
  );
  console.log(`Scheduled Threads-сторож at "20 7 * * *" (перезапуск если батч не встал)`);
}

// ─────────────────────────────────────────────────────────────
// ГОЛОСОВОЙ СЛУШАТЕЛЬ — всегда слушает голосовые в топике
// ─────────────────────────────────────────────────────────────
// Определяет список агентов по тексту голосового запроса.
// Если платформа не указана явно — запускает всех.
// ─────────────────────────────────────────────────────────────
function detectVoiceAgents(transcript) {
  // Разметка «Слайд N» / «N слайд:» — это ГОТОВЫЙ текст карусели, не запрос
  // форматов: внутри слайдов «сценарии Reels» и «посты» иначе читаются как
  // «сделай рилс и пост». Форматы ищем только в шапке до первого слайда.
  const slideMark = transcript.search(/(^|\n)[ \t]*(?:слайд[ \t]*\d+|\d+[ \t]*слайд)[ \t]*(?::|\.?[ \t]*(?:\r?\n|$))/i);
  const hasSlides = slideMark >= 0;
  const t = (hasSlides ? transcript.slice(0, slideMark) : transcript).toLowerCase();

  // Формат = что она просит СДЕЛАТЬ. Узкие слова, чтобы тема не путалась с форматом.
  const askCarousel = hasSlides || /карусел|слайд|carousel/.test(t);
  const askReels    = /рилс|reels/.test(t);
  const askThreads  = /threads|тредс/.test(t);
  const askTelegram = /телеграм|telegram|(^|\s)тг(\s|$|,)|телеге/.test(t);
  const askPost     = /(^|[\s,])пост(ы|ик|а|ов|у|е)?([\s,.!?]|$)/.test(t);

  // Просила ли она несколько форматов сразу: есть союз/перечисление
  const hasConj = /\sи\s|\sи$|\+|,|;|плюс|также|тоже|ещё|еще/.test(t);

  const keys = ["manager"];
  if (askCarousel) keys.push("carousel");
  // Рилс добавляем только если карусель НЕ просили, либо рилс явно перечислен союзом
  if (askReels && (!askCarousel || hasConj)) keys.push("reels");
  if (askThreads) keys.push("threads");
  if (askTelegram || (askPost && !askCarousel) || (askPost && hasConj)) keys.push("copywriter");

  if (keys.length === 1) {
    console.log("  [Voice routing] формат не указан — запускаю всех агентов");
    return ["manager", "copywriter", "carousel", "reels", "threads"];
  }

  const result = [...new Set(keys)];
  console.log(`  [Voice routing] определила агентов: [${result.join(", ")}]`);
  return result;
}

// ─────────────────────────────────────────────────────────────
// ТОЧЕЧНАЯ ПРАВКА СЛАЙДА — ловит "на 2 слайде убери фото", "слайд 3 поменяй",
// "переделай обложку", "на первом слайде поправь отступы" и т.п.
// Возвращает { num, bare } или null. bare=true — просто перерисовать без смены текста.
// ─────────────────────────────────────────────────────────────
// Последний слайд который автор правила — чтобы продолжить правки без повтора "слайд N"
let lastEditedSlide = null;

function detectSlideEdit(lower) {
  // Создание НОВОЙ карусели — это не правка слайда
  if (/карусел/.test(lower) && /(сдела|напиши|создай|сгенер|нужн|запили|накидай)/.test(lower)) return null;
  const editVerb = /убер|убра|удал|помен|измен|добав|вставь|постав|поправ|замен|короче|длинн|перепиши|увеличь|уменьш|подвинь|выровн|отступ|цвет|шрифт|фон|текст|фото|акцент|сдела|сократи|допиши|выдели|крупнее|мельче|жирн|светл|тёмн|темн|центр/.test(lower);
  const redraw = /^(переделай|перерисуй|переделать|перерисовать|поменяй)/.test(lower);
  const namesFormat = /карусел|рилс|reels|пост|threads|тредс/.test(lower);
  const bare = redraw && !editVerb;

  if (/слайд|обложк/.test(lower)) {
    if (!editVerb && !redraw) return null; // упоминание слайда без действия — не правка
    if (/обложк/.test(lower)) return { nums: [1], bare };
    if (/послед|крайн|финальн|в конце/.test(lower)) return { nums: ["last"], bare };

    // Номера рядом со словом "слайд": "слайды 2, 3 и 5" / "2 и 4 слайд" / "2 слайд"
    const after  = (lower.match(/слайд[ыеа]?\s*([\d][\d,\sи]*)/) || [])[1] || "";
    const before = (lower.match(/([\d][\d,\sи]*?)\s*слайд/) || [])[1] || "";
    let nums = [...(after.match(/\d+/g) || []), ...(before.match(/\d+/g) || [])]
      .map(Number).filter(n => n >= 1 && n <= 30);
    if (nums.length >= 1) return { nums: [...new Set(nums)], bare };
    const single = lower.match(/на\s+(\d+)/);
    if (single) return { nums: [parseInt(single[1])], bare };
    const words = { перв: 1, втор: 2, трет: 3, четвёрт: 4, четверт: 4, пят: 5, шест: 6, седьм: 7 };
    for (const [w, n] of Object.entries(words)) if (lower.includes(w)) return { nums: [n], bare };
    // "в слайде" без номера → последний правленый, иначе обложка
    return { nums: [lastEditedSlide || 1], bare };
  }

  // Без слова "слайд": продолжение правки последнего слайда
  if (lastEditedSlide && editVerb && !namesFormat) {
    return { nums: [lastEditedSlide], bare: false };
  }
  return null;
}

// Применяет правку к нескольким слайдам по очереди
async function handleSlideEdits(nums, instruction, bare, styleRef = null) {
  for (const n of nums) {
    await handleSlideEdit(n, instruction, bare, styleRef);
  }
}

// Перерисовывает ОДИН слайд. Если instruction содержит правку текста — применяет
// её только к этому слайду (остальное дословно), иначе просто перерисовывает дизайн.
// styleRef — описание визуала с присланного фото-референса (повторить оформление).
async function handleSlideEdit(slideNum, instruction, bare, styleRef = null) {
  if (CHAIN_BUSY) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Подожди, сейчас работает цепочка", APPROVAL_TOPIC_ID);
    return;
  }
  try {
    const carouselText = await readState("carousel");
    // Данные слайдов (структура). Если их нет — восстанавливаем из текста карусели.
    let data = null;
    try { data = JSON.parse(await readState("carousel_data").catch(() => "")); } catch {}
    if (!data || !Array.isArray(data) || !data.length) {
      if (!carouselText) {
        await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Нет карусели — сначала сделай карусель", APPROVAL_TOPIC_ID);
        return;
      }
      data = parseCarouselSlides(carouselText);
      data.forEach((s) => { s.photo = null; });
      if (!data.length) {
        await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Не нашла слайды для правки", APPROVAL_TOPIC_ID);
        return;
      }
    }
    const total = data.length;

    if (slideNum === "last") { slideNum = total; console.log(`[Слайд] последний -> слайд ${slideNum}`); }
    if (slideNum < 1 || slideNum > total) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `Слайда ${slideNum} нет (всего ${total})`, APPROVAL_TOPIC_ID);
      return;
    }
    const idx = slideNum - 1;
    const slide = data[idx];
    const instrLower = instruction.toLowerCase();

    const mentionsPhoto   = /фото|фотк|картинк|снимок|изображени/.test(instrLower);
    const wantRemovePhoto = mentionsPhoto && /(убер|убра|удал|сними|снять|без)/.test(instrLower);
    const wantAddPhoto    = mentionsPhoto && /(добав|вставь|постав|приклей|нужн|хочу|с фото)/.test(instrLower) && !wantRemovePhoto;
    const wantSwapPhoto   = mentionsPhoto && !wantRemovePhoto && !wantAddPhoto;
    const wantLight = /светл/.test(instrLower);
    const wantDark  = /тёмн|темн/.test(instrLower);

    // Только визуал (фото/фон), без смысла текста?
    const onlyVisual = styleRef || ((mentionsPhoto || wantLight || wantDark) &&
      !/(заголов|подзаголов|перепиши|сократи|допиши|короче|длинн|опечат|замени слово|формулиров|акцент|выдели|текст)/.test(instrLower));

    if (wantLight) { slide.theme = "light"; slide.photo = null; }
    if (wantDark)  { slide.theme = "dark"; }
    if (wantRemovePhoto) slide.photo = null;
    if (wantSwapPhoto || wantAddPhoto) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `Меняю фото на слайде ${slideNum}...`, APPROVAL_TOPIC_ID);
      const p = await getMultipleDrivePhotos(1).then(a => a[0] || null).catch(() => null);
      slide.photo = p;
      if (slide.theme !== "light" && !slideIsDark(slide)) slide.theme = "dark"; // фото только на тёмном
    }

    // Текстовая правка одного слайда (правим данные, не вёрстку)
    if (!bare && !onlyVisual) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `Правлю слайд ${slideNum}...`, APPROVAL_TOPIC_ID);
      const cur = { label: slide.label, headline: slide.headline, accent: slide.accent, description: slide.description };
      const raw = await callClaude(
        `Ты редактор ОДНОГО слайда карусели автора. Тебе дают JSON слайда и правку. Примени ТОЛЬКО правку, остальное оставь дословно. Стиль и вёрстку не трогай (их строит шаблон). accent обязан быть точной подстрокой headline. Верни ТОЛЬКО обновлённый JSON с ключами label,headline,accent,description — без текста вокруг и без тройных кавычек.`,
        `Слайд:\n${JSON.stringify(cur)}\n\nПравка автора: "${instruction}"`,
        1500
      );
      try {
        let j = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
        const s = j.indexOf("{"), e = j.lastIndexOf("}");
        if (s >= 0 && e > s) j = j.slice(s, e + 1);
        const upd = JSON.parse(j);
        if (upd.label !== undefined) slide.label = upd.label;
        if (upd.headline !== undefined) slide.headline = upd.headline;
        if (upd.accent !== undefined) slide.accent = upd.accent;
        if (upd.description !== undefined) slide.description = upd.description;
      } catch (e) {
        console.warn("[Слайд] правка JSON не распарсилась:", e.message);
      }
    } else if (wantLight || wantDark || wantRemovePhoto) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `Перерисовываю слайд ${slideNum}...`, APPROVAL_TOPIC_ID);
    }

    // Рендер строго по шаблону того же стиля, что и вся карусель
    let meta = { style: "classic", tint: "beige" };
    try { meta = { ...meta, ...JSON.parse(await readState("carousel_meta").catch(() => "")) }; } catch {}
    const renderOne = (s, i) => meta.style === "editorial"
      ? renderEditorialSlide(s, i, total, s.photo, meta.tint)
      : renderCarouselSlide(s, i, total, s.photo);
    const newHtml = renderOne(slide, idx);
    data[idx] = slide;
    await writeState("carousel_data", JSON.stringify(data));
    let allHtml = null;
    try { allHtml = JSON.parse(await readState("carousel_html").catch(() => "")); } catch {}
    if (Array.isArray(allHtml) && allHtml.length === total) {
      allHtml[idx] = newHtml;
      await writeState("carousel_html", JSON.stringify(allHtml));
    } else {
      await writeState("carousel_html", JSON.stringify(data.map((s, i) => renderOne(s, i))));
    }

    // Правка одного слайда: файл пишется под своим номером, остальные PNG не трогаем
    const imgs = await renderSlidesToPng([newHtml], { startIndex: idx, clean: false });
    await sendPhotoAlbum(APPROVAL_TOKEN, APPROVAL_CHAT_ID, APPROVAL_TOPIC_ID, imgs);
    lastEditedSlide = slideNum;
    console.log(`[Слайд ${slideNum}] обновлён по шаблону`);
  } catch (err) {
    console.error(`[Слайд ${slideNum}] ошибка:`, err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ Не смогла обновить слайд ${slideNum}: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// РАСПОЗНАВАНИЕ НАМЕРЕНИЙ — понимает смысл сообщения, а не точные слова.
// Работает и для голоса, и для текста. автор говорит по-человечески,
// Claude определяет что она хочет.
// ─────────────────────────────────────────────────────────────
async function classifyIntent(text) {
  const raw = await callClaude(
    `Ты диспетчер контент-завода автора. По её сообщению определи ОДНО намерение. Верни СТРОГО JSON без пояснений: {"intent":"content"}

- "save_idea" — она кидает СЫРУЮ ИДЕЮ чтобы не забыть, на потом, в копилку. НЕ просит сделать прямо сейчас. Признаки: "запиши идею", "идея:", "в копилку", "на будущее", "не забудь", "запомни", "мысль пришла", или просто описывает идею без команды сделать.
- "list_ideas" — показать копилку идей. Признаки: "мои идеи", "что в копилке", "покажи идеи".
- "week_plan" — СОСТАВИТЬ НОВЫЙ контент-план на несколько дней или неделю, который она утвердит. Признаки: глагол составь/сделай/распиши + "план", "на неделю", "сделай контент из идей". Если она СПРАШИВАЕТ что уже в плане ("что по контент плану", "что в плане") — это "question", не week_plan.
- "analyst_trends" — СПРАШИВАЕТ у аналитика что нового в нише, какие темы сейчас зайдут, тренды, о чём писать, идеи тем, что горит, свежие новости. Аналитик собирает данные и даёт топ-темы. Это ТОЛЬКО разбор/идеи, БЕЗ создания готового поста/карусели/рилса. Признаки: "что нового", "какие темы зайдут", "что горит", "о чём писать", "дай идеи тем", "что по трендам", "спроси аналитика".
- "guide" — собрать PDF-ГАЙД (лид-магнит для директ-базы). Признак: просит именно ГАЙД, а не пост/карусель/рилс. "сделай гайд про X", "делай гайд по Y", "гайд под слово Z".
- "content" — создать ОДИН конкретный материал ПРЯМО СЕЙЧАС: пост, карусель, рилс или тред по конкретной теме. Глагол сделать/напиши + формат. Без слова "план" и без "на неделю". Если просит ГАЙД — это "guide", не "content".
- "publish" — выложить/опубликовать/запланировать УЖЕ ГОТОВЫЙ контент в постмайпост.
- "analyze_channel" — разобрать ЕЁ канал/аккаунт: что она УЖЕ публиковала, профиль канала, о чём пишет автор. Только про прошлое, НЕ про создание нового.
- "audience_questions" — собрать/разобрать ВОПРОСЫ подписчиков из комментариев канала, частые вопросы, что спрашивает аудитория, боли аудитории. Признаки: "что спрашивают", "вопросы аудитории", "частые вопросы", "FAQ", "о чём спрашивают подписчики", "собери вопросы".
- "montage" — ТОЛЬКО про видео: смонтировать видео, собрать ролик, убрать паузы в видео, наложить субтитры. Должно явно упоминаться видео/ролик/монтаж. Правки слайдов и каруселей сюда НЕ относятся.
- "list_accounts" — показать подключённые площадки/каналы постмайпост.
- "question" — задаёт ВОПРОС о существующих данных и ждёт ответа, а НЕ просит что-то сделать: "что уже в плане на завтра", "какая статистика", "сколько постов". Если она просит ЧТО-ТО СДЕЛАТЬ или СОЗДАТЬ — это НЕ question.

Примеры:
"составь контент на неделю по стратегии" → week_plan
"сделай контент-план на неделю" → week_plan
"распиши неделю" → week_plan
"сделай контент из идей" → week_plan
"что нового в нише" → analyst_trends
"какие темы сейчас зайдут" → analyst_trends
"что горит, о чём писать" → analyst_trends
"дай идеи тем на сегодня" → analyst_trends
"спроси аналитика что по трендам" → analyst_trends
"напиши пост про Claude" → content
"сделай карусель про 5 нейросетей" → content
"делай гайд про оплату claude" → guide
"нужен гайд по нейросетям под слово НЕЙРОНКИ" → guide
"сделай рилс про оплату claude" → content
"запиши идею: показать как фоткаю холодильник и получаю меню" → save_idea
"в копилку: рилс про то как claude спорит" → save_idea
"пришла мысль сделать разбор как я веду финансы через ии" → save_idea
"мои идеи" → list_ideas
"что в копилке" → list_ideas
"разбор моего аккаунта" → analyze_channel
"что я уже писала" → analyze_channel
"что спрашивают подписчики" → audience_questions
"собери частые вопросы аудитории" → audience_questions
"какие вопросы задают в канале" → audience_questions
"что у меня запланировано на завтра" → question
"что по контент плану" → question
"что в плане на неделю" → question
"какая статистика за неделю" → question
"опубликуй это" → publish
"собери ролик из моего видео" → montage
"убери на 2 слайде фото" → content
"на первом слайде поправь отступы" → content
"поменяй текст на 3 слайде" → content
"какие площадки подключены" → list_accounts`,
    `Сообщение автора: "${text}"`,
    200
  );
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);
    return parsed.intent || "content";
  } catch {
    return "content";
  }
}

// ── Обработчики команд (вынесены, чтобы вызывались и регексом, и классификатором) ──

async function cmdPublish(skipShotCheck = false) {
  await runPublisher(skipShotCheck).catch(err => {
    console.error("[Publisher] ошибка:", err.message);
    return sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ Публикатор: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  });
}


async function cmdAnalyzeChannel() {
  try {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `📚 Собираю историю @${CHANNEL_USERNAME}...`, APPROVAL_TOPIC_ID);
    const history = await fetchChannelHistoryWeb();
    if (history.length === 0) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "❌ Не нашла постов. Канал публичный? Проверь TELEGRAM_CHANNEL_USERNAME.",
        APPROVAL_TOPIC_ID);
      return;
    }
    const state = await loadChannelPosts();
    const byId = new Map(state.posts.map(p => [p.id, p]));
    for (const p of history) if (!byId.has(p.id)) byId.set(p.id, p);
    state.posts = [...byId.values()].sort((a, b) => b.id - a.id);
    await saveChannelPosts(state);

    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `Собрала ${history.length} постов (всего в базе ${state.posts.length}). Анализирую о чём ты пишешь...`,
      APPROVAL_TOPIC_ID);

    const profile = await analyzeChannelProfile();
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `📊 Профиль канала готов:\n\n${profile}`, APPROVAL_TOPIC_ID);
  } catch (err) {
    console.error("[ChannelProfile] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

async function cmdListAccounts() {
  try {
    const accounts = await pmpGetAccounts();
    if (accounts.length === 0) {
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        "PostMyPost: аккаунтов не найдено. Проверь PROJECT_ID и что площадки подключены.",
        APPROVAL_TOPIC_ID);
      return;
    }
    const lines = accounts.map(a => {
      const net = PMP_CHANEL_NAME[a.chanel_id] || `id${a.chanel_id}`;
      return `— ${net}: ${a.name || a.login || a.id} (@${a.login || "?"})`;
    });
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `Подключённые площадки (${accounts.length}):\n${lines.join("\n")}`,
      APPROVAL_TOPIC_ID);
  } catch (err) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// Запускает ТОЛЬКО аналитика: собирает свежие данные и даёт топ-темы.
// Никакой цепочки (пост/карусель/рилс/тредс) — просто разбор трендов.
async function cmdAnalystTrends() {
  if (CHAIN_BUSY) {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Подожди, сейчас работает цепочка", APPROVAL_TOPIC_ID);
    return;
  }
  console.log("[Аналитик-тренды] запускаю только аналитика");
  try {
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      "Аналитик собирает свежие данные по нише...", APPROVAL_TOPIC_ID);
    await runAgentReviewed("analyst"); // в автономном режиме сам пришлёт разбор в чат
    console.log("[Аналитик-тренды] готово");
  } catch (err) {
    console.error("[Аналитик-тренды] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ Не смогла собрать тренды: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

async function cmdAnswerQuestion(text) {
  console.log(`[Q&A] вопрос: "${text.slice(0, 80)}"`);
  try {
    const [upcomingPlan, weekPlan, analystSummary, accountStats, channelData, strategyIdeas, anthropicNews, pmpAnalytics] = await Promise.all([
      readContentPlan("upcoming").catch(() => []),
      loadWeekPlan().catch(() => null),
      loadAnalystSummary().catch(() => null),
      readAccountAnalysis().catch(() => ""),
      readChannelData().catch(() => ""),
      readStrategyIdeas().catch(() => ""),
      fetchAnthropicNews().catch(() => ""),
      fetchPostMyPostAnalytics(30).catch(() => ""),
    ]);
    const planBlock = upcomingPlan.length > 0
      ? `Контент-план из Google Sheets (сегодня и дальше):\n` +
        upcomingPlan.map((r) => `— ${r.date} | ${r.platform} | ${r.format} | ${r.topic}`).join("\n")
      : "Контент-план из Google Sheets: записей на сегодня и дальше нет.";
    // План недели, собранный и утверждённый прямо в боте — Sheets про него не знает
    const weekPlanBlock = weekPlan?.days?.length
      ? `\n\nКонтент-план недели из бота (автор составила и утвердила в этом чате):\n` +
        weekPlan.days.map((d, i) => `${i + 1}. ${d.day} · ${d.platform} ${d.format} · ${d.theme}`).join("\n")
      : "";
    const summaryQBlock = analystSummary?.text
      ? `\n\nПоследняя сводка аналитика (${new Date(analystSummary.ts).toISOString().slice(0, 10)}):\n${analystSummary.text.slice(0, 4000)}`
      : "";
    const pmpBlock     = pmpAnalytics ? `\n\n${pmpAnalytics}` : "";
    const accountBlock = accountStats ? `\n\n${accountStats}` : "";
    const channelBlock = channelData  ? `\n\n${channelData}` : "";
    const ideasBlock   = strategyIdeas ? `\n\nБанк из 100 идей и стратегия:\n${strategyIdeas.slice(0, 26000)}` : "";
    const newsBlock    = anthropicNews ? `\n\nСвежие официальные новости Anthropic (anthropic.com/news):\n${anthropicNews}` : "";
    const reply = await callClaude(
      AGENTS.analyst.system,
      `${pmpBlock}${planBlock}${weekPlanBlock}${summaryQBlock}${accountBlock}${channelBlock}${ideasBlock}${newsBlock}\n\nСегодня ${new Date().toISOString().slice(0, 10)}.\n\n` +
      `Вопрос от автора: "${text}"\n\n` +
      `Ответь на вопрос коротко и по делу, опираясь на данные выше. ` +
      `По цифрам постов/охватов/просмотров опирайся в первую очередь на блок АНАЛИТИКА ВЫШЕДШИХ ПОСТОВ ИЗ POSTMYPOST (это самые свежие живые данные), затем на статистику аккаунта. ` +
      `Не генерируй формат ТЕМА 1/2/3 — это просто разговор. Чистый текст.`
    );
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, stripMarkdown(reply), APPROVAL_TOPIC_ID);
    console.log("[Q&A] ответил");
  } catch (err) {
    console.error("[Q&A] ошибка:", err.message);
    await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
      `❌ Не смогла ответить: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// ТЕМА РАССУЖДЕНИЙ — свободный диалог с Аналитиком по статистике, с памятью.
// Сообщения из BRAINSTORM_TOPIC_ID идут сюда, а не в классификатор команд.
// ─────────────────────────────────────────────────────────────
const BRAINSTORM_SYSTEM = `Ты Аналитик-собеседник автора (ниша: ИИ/нейросети для новичков и фрилансеров). Вы вместе раскручиваете темы для её контента.

Как себя вести:
- Это живой диалог, а не отчёт. Отвечай по-человечески, коротко, по делу, без markdown и без формата "ТЕМА 1/2/3".
- Опирайся на её реальную статистику (залетевшие посты Instagram и Telegram, вопросы подписчиков) — она дана в начале разговора. Аргументируй цифрами, а не общими словами.
- Когда автор кидает свою идею — развивай её: предлагай угол, хук, формат, следующий шаг. Спорь, если идея слабая, и говори почему. Помогай довести до конкретного готового замысла.
- Держи нить: помни, о чём говорили выше.
- Не пиши готовый пост и не уходи в публикацию, пока она прямо не попросит. Твоя задача — додумать идею вместе с ней.`;

let brainstorm = { messages: [], seeded: false };

function isFromBrainstormTopic(msg) {
  if (!BRAINSTORM_TOPIC_ID || !msg || !msg.chat) return false;
  const id = String(APPROVAL_CHAT_ID || "");
  const chatMatch = id.startsWith("@") ? msg.chat.username === id.slice(1) : String(msg.chat.id) === id;
  return chatMatch && msg.message_thread_id === BRAINSTORM_TOPIC_ID;
}

async function bsSend(text) {
  await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, stripMarkdown(text), BRAINSTORM_TOPIC_ID);
}

function brainstormTranscript() {
  return brainstorm.messages
    .filter((m, i) => m.role === "assistant" || i > 0) // первый user несёт статистику-контекст
    .map(m => `${m.role === "user" ? "автор" : "Аналитик"}: ${m.content}`)
    .join("\n").slice(0, 12000);
}

// Сжимает обсуждение в чистую идею и кладёт в копилку
async function brainstormSaveIdea() {
  const idea = await callClaude(
    `Тебе дают расшифровку обсуждения автора с аналитиком. Сожми ИТОГ в готовую идею для контента: первая строка — ёмкая суть одним предложением; вторая строка — "Формат и угол: ...". Голос автора, без воды, чистый текст.`,
    brainstormTranscript(), 500
  ).catch(() => "");
  const text = (idea.split("\n")[0] || "").replace(/^(идея|суть)[:\s]*/i, "").trim() || "идея из обсуждения";
  const note = idea.split("\n").slice(1).join(" ").replace(/^Формат и угол[:\s—-]*/i, "").trim();
  const ideas = await loadIdeas();
  ideas.unshift({ id: Date.now(), text, note, date: new Date().toISOString().slice(0, 10), status: "new" });
  await saveIdeas(ideas);
  await bsSend(`💡 Записала готовую идею в копилку:\n"${text}"${note ? `\n\nФормат и угол: ${note}` : ""}\n\nЗахочешь сделать — прямо тут "сделай пост/карусель", или позже "сделай контент из идей".`);
}

// Превращает обсуждение в бриф и запускает цепочку. Одобрение — в рабочей теме.
async function brainstormToContent(command) {
  if (CHAIN_BUSY) { await bsSend("⏳ Сейчас работает цепочка — как закончит, повтори."); return; }
  const agents = detectVoiceAgents(command);
  const brief = await callClaude(
    `Тебе дают обсуждение автора с аналитиком и её команду. Сформулируй ЧЁТКИЙ бриф из того, к чему пришли: тема, угол, хук, ключевые мысли. Чистый текст, голос автора.`,
    `Команда: "${command}"\n\nОбсуждение:\n${brainstormTranscript()}`, 800
  ).catch(() => brainstormTranscript().slice(0, 2000));
  const whatRuns = agents.filter(k => k !== "manager").map(k => ({ copywriter: "Telegram-пост", carousel: "карусель", reels: "рилс", threads: "Threads" }[k] || k)).join(" + ") || "контент";
  await bsSend(`Поняла, делаю: ${whatRuns}. Превью и одобрение пришлю в рабочую тему.`);
  const analystOutput =
    `ИДЕЯ ОТ АВТОРА (итог обсуждения):\n${brief}\n\n` +
    `ВАЖНО — работать СТРОГО по этому брифу. Не добавлять платформы и форматы, которых нет в запросе "${command}".`;
  runChain(agents, "из обсуждения", () => writeState("analyst", analystOutput)).catch(err => {
    console.error("[Обсуждение→контент] ошибка:", err.message);
    sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
  });
}

async function handleBrainstorm(text) {
  const lower = text.toLowerCase().trim();

  if (/^(новая тема|сброс|хватит|закончили|стоп|давай заново|с нуля)\b/.test(lower)) {
    brainstorm = { messages: [], seeded: false };
    await bsSend("Окей, чистый лист. О чём думаем?");
    return;
  }
  if (brainstorm.messages.length && /^(запиши|сохрани|в копилку|готово)\b/.test(lower)) {
    await brainstormSaveIdea();
    return;
  }
  if (brainstorm.messages.length
      && /^(сделай|сделаем|запили|собери|напиши|давай сдела)\b/.test(lower)
      && /пост|карусел|рилс|reels|тред|threads|контент/.test(lower)) {
    await brainstormToContent(text);
    return;
  }

  // Обычный ход диалога. На старте вшиваем статистику в первый запрос (строго чередуем роли).
  if (!brainstorm.seeded) {
    brainstorm.seeded = true;
    const [pmp, acc, channel] = await Promise.all([
      fetchPostMyPostAnalytics(30).catch(() => ""),
      readAccountAnalysis().catch(() => ""),
      readChannelData().catch(() => ""),
    ]);
    const ground = [pmp, acc, channel].filter(Boolean).join("\n\n");
    const first = ground
      ? `Мои реальные цифры, опирайся на них в разговоре:\n\n${ground}\n\n---\n\n${text}`
      : text;
    brainstorm.messages.push({ role: "user", content: first });
  } else {
    brainstorm.messages.push({ role: "user", content: text });
  }
  if (brainstorm.messages.length > 40) brainstorm.messages = brainstorm.messages.slice(-40);

  const reply = await callClaudeMessages(BRAINSTORM_SYSTEM, brainstorm.messages);
  brainstorm.messages.push({ role: "assistant", content: reply });
  await bsSend(reply);
}

async function routeBrainstormMessage(msg) {
  let text = msg.text?.trim() || null;
  if (!text && msg.voice) {
    try {
      const { tmpPath, extension } = await downloadTelegramFile(msg.voice.file_id);
      text = await transcribeAudio(tmpPath, extension);
      await fs.unlink(tmpPath).catch(() => {});
      await bsSend(`📝 "${text}"`);
    } catch (err) {
      await bsSend(`❌ Не расслышала: ${err.message}`);
      return;
    }
  }
  if (!text) return;
  try { await handleBrainstorm(text); }
  catch (err) {
    console.error("[Обсуждение] ошибка:", err.message);
    await bsSend(`❌ ${err.message}`);
  }
}

// Запуск: node factory.js listen
// Отправь голосовое → расшифровывается → запускает цепочку
// ─────────────────────────────────────────────────────────────
async function startVoiceListener() {
  console.log("🎤 Голосовой слушатель запущен");
  console.log(`   Топик: ${APPROVAL_CHAT_ID} #${APPROVAL_TOPIC_ID}`);
  console.log("   Отправь голосовое сообщение — запущу цепочку агентов с твоей идеей\n");

  let offset = await getUpdateOffset();

  while (true) {
    // Пока работает цепочка — молчим, чтобы не воровать getUpdates у режима
    // одобрения. Offset НЕ сбрасываем: в автономном режиме внутри цепочки
    // никто не читает чат, и всё написанное за это время разбираем после её
    // конца (раньше offset прыгал на последний апдейт и сообщения молча терялись).
    if (CHAIN_BUSY) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    let data;
    try {
      const res = await tgFetch(
        `https://api.telegram.org/bot${APPROVAL_TOKEN}/getUpdates` +
          `?offset=${offset}&timeout=55&limit=20`,
        {}, 70_000
      );
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of data.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      // Тема рассуждений — отдельный диалог с памятью, мимо классификатора команд
      if (isFromBrainstormTopic(msg)) { await routeBrainstormMessage(msg); continue; }
      if (!isFromApprovalChat(msg)) continue;


      // Фото для обложек рилсов: обычное фото ИЛИ файл-изображение.
      // Любая подпись со словом «обложка» уходит сюда (кроме правок слайдов
      // карусели: «как на фото», «референс», «скрин», «слайд»).
      // Есть текст в подписи → сохранить фото И сразу сверстать обложку,
      // текста нет («фото для обложек») → просто сохранить.
      const imgDoc = msg.document && /^image\//.test(msg.document.mime_type || "") ? msg.document : null;
      const imgMeta = (msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1] : null) || imgDoc;
      const imgCap = (msg.caption || "").trim();
      const capLower = imgCap.toLowerCase();
      if (imgMeta && /облож/.test(capLower) && !/как на фото|референс|скрин|слайд/.test(capLower)) {
        // Текст обложки: после двоеточия/тире или после «про» / «с текстом»
        const tm = imgCap.match(/облож[а-яё]*[^:—-]{0,20}[:—-]\s*([\s\S]+)/i) ||
                   imgCap.match(/облож[а-яё]*\s+(?:про|с текстом)\s+([\s\S]+)/i);
        const coverText = tm ? tm[1].trim().replace(/^[«"']+|[»"']+$/g, "").trim() : "";
        console.log(`[Обложка-фото] подпись: "${imgCap.slice(0, 60)}" → ${coverText ? `обложка «${coverText.slice(0, 40)}»` : "сохранить фото"}`);
        (async () => {
          try {
            const { tmpPath, extension } = await downloadTelegramFile(imgMeta.file_id);
            const buf = await fs.readFile(tmpPath);
            await fs.unlink(tmpPath).catch(() => {});
            const ext = await saveReelsPhoto(buf, extension);
            if (coverText) {
              await cmdReelsCover(coverText);
            } else {
              await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
                `📸 Фото сохранила (${ext}, ${(buf.length / 1e6).toFixed(1)} МБ). Теперь: «сделай обложку рилса: <текст>». Новое фото с подписью «обложка» заменит это.`,
                APPROVAL_TOPIC_ID);
            }
          } catch (err) {
            console.error("[Обложка-фото] ошибка:", err.message);
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ С фото не вышло: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
          }
        })();
        continue;
      }

      // Скриншот В СЛАЙД: картинка + подпись со словом "скрин" ("скрин на слайд 3") —
      // вставляется в слайд карточкой с тенью (эдиториал), а не как референс стиля.
      if (msg.photo && msg.photo.length && /скрин|screenshot/i.test(msg.caption || "")) {
        const cap = (msg.caption || "").toLowerCase();
        const numMatch = cap.match(/слайд[ауе]?\s*(\d+)/) || cap.match(/на\s+(\d+)/);
        const slideNum = /обложк/.test(cap) ? 1 : numMatch ? parseInt(numMatch[1], 10) : (lastEditedSlide || 1);
        (async () => {
          try {
            const largest = msg.photo[msg.photo.length - 1];
            const { tmpPath, extension } = await downloadTelegramFile(largest.file_id);
            const buf = await fs.readFile(tmpPath);
            await fs.unlink(tmpPath).catch(() => {});
            const dataUri = `data:image/${extension === "png" ? "png" : "jpeg"};base64,${buf.toString("base64")}`;
            let data = null;
            try { data = JSON.parse(await readState("carousel_data")); } catch {}
            if (!data || !data.length) {
              await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "Нет карусели — сначала сделай карусель, потом пришли скрин.", APPROVAL_TOPIC_ID);
              return;
            }
            if (slideNum < 1 || slideNum > data.length) {
              await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `Слайда ${slideNum} нет (всего ${data.length})`, APPROVAL_TOPIC_ID);
              return;
            }
            data[slideNum - 1].screenshot = dataUri;
            await writeState("carousel_data", JSON.stringify(data));
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `🖼 Вставляю скрин в слайд ${slideNum}...`, APPROVAL_TOPIC_ID);
            await handleSlideEdit(slideNum, "вставила скрин", true);
          } catch (err) {
            console.error("[Скрин] ошибка:", err.message);
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Не смогла вставить скрин: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
          }
        })();
        continue;
      }

      // Фото-референс: картинка + подпись "переделай слайд N как на фото"
      if (msg.photo && msg.photo.length) {
        const caption = (msg.caption || "").trim();
        const ed = detectSlideEdit(caption.toLowerCase());
        const nums = ed ? ed.nums : [lastEditedSlide || 1];
        if (CHAIN_BUSY) {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "⏳ Подожди, работает цепочка", APPROVAL_TOPIC_ID);
          continue;
        }
        (async () => {
          try {
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
              `🔎 Разбираю референс и применяю к слайду ${nums.join(", ")}...`, APPROVAL_TOPIC_ID);
            const largest = msg.photo[msg.photo.length - 1];
            const { tmpPath, extension } = await downloadTelegramFile(largest.file_id);
            const buf = await fs.readFile(tmpPath);
            const mime = extension === "png" ? "image/png" : "image/jpeg";
            const style = await describeReferenceStyle(buf.toString("base64"), mime);
            await fs.unlink(tmpPath).catch(() => {});
            await handleSlideEdits(nums, caption || "сделай по референсу", false, style);
          } catch (err) {
            console.error("[Референс] ошибка:", err.message);
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
              `❌ Не смогла применить референс: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
          }
        })();
        continue;
      }

      // Задание приходит голосом или текстом
      let transcript = null;

      if (msg.voice) {
        console.log(`[Voice] получено голосовое (${msg.voice.duration}с)`);
        try {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            "🎤 Слышу тебя, расшифровываю...", APPROVAL_TOPIC_ID);
          const { tmpPath, extension } = await downloadTelegramFile(msg.voice.file_id);
          transcript = await transcribeAudio(tmpPath, extension);
          console.log(`[Voice] расшифровка: "${transcript}"`);
        } catch (err) {
          console.error("[Voice] ошибка расшифровки:", err.message);
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            `❌ Не смогла расшифровать: ${err.message}`, APPROVAL_TOPIC_ID);
          continue;
        }
      } else if (msg.text) {
        const t = msg.text.trim();
        const lower = t.toLowerCase();

        // Пока контент-план ждёт утверждения — ок/отмена/правка идут в обработчик плана
        if (weekPlanPending) { await handlePlanReply(t); continue; }

        // Раскрытие темы из сводки аналитика («раскрой тему 2») и ответ на вопрос
        // «каким форматом?» — ДО остальных команд и до отсечки коротких сообщений:
        // «пост» и «тему 2» короче 8 символов, а «тредс» перехватил бы автопилот
        if (await handleTopicReveal(t).catch(() => false)) continue;

        // Управление копилкой идей: "удали идею 3" / "очисти идеи"
        const ideaDel = lower.match(/^удали идею\s+(\d+)/);
        if (ideaDel) {
          (async () => {
            const ideas = await loadIdeas();
            const fresh = ideas.filter(i => i.status !== "used");
            const n = parseInt(ideaDel[1]) - 1;
            if (n >= 0 && n < fresh.length) {
              const removed = fresh[n];
              await saveIdeas(ideas.filter(i => i.id !== removed.id));
              await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `🗑 Убрала: "${removed.text}"`, APPROVAL_TOPIC_ID);
            } else {
              await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `Нет идеи №${ideaDel[1]}. Глянь "мои идеи".`, APPROVAL_TOPIC_ID);
            }
          })();
          continue;
        }
        if (/^очисти (идеи|копилку)/.test(lower)) {
          (async () => {
            await saveIdeas([]);
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "🗑 Копилка очищена.", APPROVAL_TOPIC_ID);
          })();
          continue;
        }

        // Управление Threads-автопилотом: "тредс тест", "тредс вето",
        // "тредс на полный автомат", "тредс батч", "стоп тредс", "тредс статус"
        if (await handleThreadsCommand(t).catch(() => false)) continue;

        // Дефолтный стиль каруселей: "карусели в эдиториале по умолчанию" /
        // "карусели в эдиториале крем по умолчанию" / "карусели в классике по умолчанию"
        const styleCmd = lower.match(/^карусели\s+(?:в\s+)?(эдиториал\w*|классик\w*)\s*(беж\w*|крем\w*)?/);
        if (styleCmd) {
          const isEd = styleCmd[1].startsWith("эдиториал");
          const tint = (styleCmd[2] || "").startsWith("крем") ? "cream" : "beige";
          const val = isEd ? `editorial-${tint}` : "classic";
          await writeState("carousel_style", val);
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            isEd
              ? `✅ Карусели по умолчанию: эдиториал (${tint === "cream" ? "крем, твой бренд" : "беж, как референс"}). Разово в старом стиле: «сделай карусель в классике про...»`
              : "✅ Карусели по умолчанию: классика (тёмный стиль). Разово в новом: «сделай карусель в эдиториале про...»",
            APPROVAL_TOPIC_ID);
          continue;
        }

        // Точечная правка слайда: "на 2 слайде убери фото", "переделай обложку",
        // "слайд 3 поменяй текст" и т.п. Меняет ТОЛЬКО названный слайд.
        const slideEdit = detectSlideEdit(lower);
        if (slideEdit) {
          handleSlideEdits(slideEdit.nums, t, slideEdit.bare);
          continue;
        }

        // Перезапуск: «переделай карусель», «перепиши пост», «переделай тредс,
        // полная хрень». Раньше ловилась только точная фраза «переделай карусель» —
        // любое лишнее слово роняло запрос в классификатор, и тот запускал ВСЕХ
        // агентов. Теперь: формат ищем в любом месте фразы, без формата — спрашиваем.
        if (/передела|перепиш|заново/.test(lower) && !/слайд|обложк/.test(lower)) {
          const keyMap = [["карусел", "carousel"], ["рилс", "reels"], ["тредс", "threads"], ["threads", "threads"], ["пост", "copywriter"]];
          const keys = [...new Set(keyMap.filter(([w]) => lower.includes(w)).map(([, k]) => k))];
          if (keys.includes("threads")) {
            // Тредс переделываем батчем: чистим сегодняшнюю очередь PMP, иначе задвоение
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "🧵 Чищу сегодняшнюю очередь Threads и пересобираю батч...", APPROVAL_TOPIC_ID);
            deleteTodaysThreadsPMP()
              .then(() => runThreadsAutopilot())
              .catch((e) => sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, `❌ Переделка Threads споткнулась: ${e.message}`, APPROVAL_TOPIC_ID).catch(() => {}));
            const rest = keys.filter((k) => k !== "threads");
            if (rest.length && !CHAIN_BUSY) runChain(rest, `переделка (${rest.join(", ")})`).catch(console.error);
          } else if (keys.length) {
            if (!CHAIN_BUSY) runChain(keys, `переделка (${keys.join(", ")})`).catch(console.error);
            else await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID, "⏳ Подожди, работает цепочка", APPROVAL_TOPIC_ID);
          } else {
            await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
              "Что переделать: рилс, карусель, пост или тредс? Скажи, например: «переделай тредс».", APPROVAL_TOPIC_ID);
          }
          continue;
        }

        // Одиночные команды одобрения (ок/стоп) без активного агента — игнорируем
        if (["ок", "ok", "стоп", "stop", "перерисуй", "redesign"].includes(lower)) continue;
        if (t.length < 8) continue;

        // Обращение к агенту по имени = вопрос (быстрый путь без классификатора)
        if (/^(аналитик|менеджер|контент-менеджер)[,:!?\s]/i.test(t)) {
          cmdAnswerQuestion(t);
          continue;
        }

        transcript = t;
        console.log(`[Text] получено сообщение: "${t.slice(0, 80)}"`);
      } else {
        continue;
      }

      // Пока контент-план ждёт утверждения — голосовые тоже идут в обработчик плана
      if (weekPlanPending) { await handlePlanReply(transcript); continue; }

      // Раскрытие темы из сводки голосом — до Threads-команд и классификатора
      // (текст сюда не дойдёт: он перехвачен выше, для голоса вызов повторный и безопасный)
      if (await handleTopicReveal(transcript).catch(() => false)) continue;

      // Команды Threads-автопилота голосом — до классификатора
      if (await handleThreadsCommand(transcript).catch(() => false)) continue;

      // Гайд-мейкер (голос и текст) — до классификатора и до правок слайдов,
      // иначе «делай гайд про X» уходит в цепочку контента и спамит форматами
      if (handleGuideEditCommand(transcript)) continue;
      if (handleGuideCommand(transcript)) continue;

      // Обложки рилсов — тоже до классификатора и правок слайдов:
      // «переделай обложку рилса» иначе улетит в правку слайда 1 карусели
      if (handleReelsCoverEditCommand(transcript)) continue;
      if (handleReelsCoverCommand(transcript)) continue;

      // Точечная правка слайда голосом ("на втором слайде убери фото") — до классификатора
      const voiceSlideEdit = detectSlideEdit(transcript.toLowerCase());
      if (voiceSlideEdit) { handleSlideEdits(voiceSlideEdit.nums, transcript, voiceSlideEdit.bare); continue; }

      // ── Классификатор намерений: понимает смысл для голоса И текста ──
      // Так автор может говорить по-человечески: "разбор аккаунта",
      // "выложи это", "смонтируй видео" — не обязательно точные команды.
      let intent;
      try {
        intent = await classifyIntent(transcript);
        console.log(`[Intent] "${transcript.slice(0, 60)}" → ${intent}`);
      } catch (err) {
        console.warn("[Intent] ошибка классификации:", err.message);
        intent = "content";
      }

      if (intent === "guide") {
        // Регулярка не разобрала формулировку, но смысл — гайд: уточняем тему
        if (!handleGuideEditCommand(transcript) && !handleGuideCommand(transcript)) {
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            "Про что гайд? Скажи: «сделай гайд про <тему>» (можно добавить «под слово ТАКОЕ-ТО»).", APPROVAL_TOPIC_ID);
        }
        continue;
      }
      if (intent === "publish")        { await cmdPublish(/без\s+скрин/i.test(transcript)); continue; }
      if (intent === "analyst_trends"){ cmdAnalystTrends();          continue; }
      if (intent === "analyze_channel"){ cmdAnalyzeChannel();        continue; }
      if (intent === "audience_questions"){ cmdAudienceQuestions();   continue; }
      if (intent === "list_accounts")  { await cmdListAccounts();     continue; }
      if (intent === "question")       { cmdAnswerQuestion(transcript); continue; }
      if (intent === "save_idea")      { cmdSaveIdea(transcript);     continue; }
      if (intent === "list_ideas")     { cmdListIdeas();              continue; }
      if (intent === "week_plan")      { cmdWeekPlan(transcript);     continue; }
      // intent === "content" → дальше по цепочке генерации

      // «Переделай» голосом без формата: НЕ запускать всю фабрику, спросить
      const vt = transcript.toLowerCase();
      if (/передела|перепиш|заново/.test(vt) && !/карусел|рилс|тредс|threads|пост|слайд|обложк/.test(vt)) {
        await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
          "Что переделать: рилс, карусель, пост или тредс? Скажи, например: «переделай карусель».", APPROVAL_TOPIC_ID);
        continue;
      }

      // Подтверждаем приём и показываем что запустим
      const agentsPreview = detectVoiceAgents(transcript);
      const agentNames = {
        manager:    "контент-менеджер",
        copywriter: "Telegram-пост",
        carousel:   "карусель",
        reels:      "рилс",
        threads:    "Threads",
      };
      const whatRuns = agentsPreview
        .filter(k => k !== "manager")
        .map(k => agentNames[k] || k)
        .join(" + ") || "контент-менеджер";
      await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
        `📝 Поняла: "${transcript}"\n\nЗапускаю: ${whatRuns}`,
        APPROVAL_TOPIC_ID);

      // Задание от автора — определяем платформы и ставим цепочку
      // в очередь. Она захватит CHAIN_BUSY и слушатель замолчит до конца.
      const briefing = transcript;
      (async () => {
        try {
          const analystOutput =
            `ИДЕЯ ОТ АВТОРА:\n${briefing}\n\n` +
            `ВАЖНО — автор указала конкретное задание. ` +
            `Работать СТРОГО по этому запросу. ` +
            `Не добавлять платформы и форматы которые не упомянуты в запросе.`;

          await runChain(agentsPreview, "идея автора", () => writeState("analyst", analystOutput));
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            "✅ Готово — проверь контент выше", APPROVAL_TOPIC_ID);
        } catch (err) {
          console.error("[Chain] ошибка:", err.message);
          await sendToChat(APPROVAL_TOKEN, APPROVAL_CHAT_ID,
            `❌ Ошибка в цепочке: ${err.message}`, APPROVAL_TOPIC_ID).catch(() => {});
        }
      })();
    }
  }
}

// Глобальная защита: одна непойманная ошибка не должна ронять весь завод.
// Логируем и продолжаем — крон и слушатель остаются живыми.
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] необработанная ошибка промиса:", err?.stack || err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] необработанное исключение:", err?.stack || err);
});

const cmd = process.argv[2];
if (cmd === "review-test") {
  // Проверка Ревизора без Telegram и без прогона агентов: node factory.js review-test
  (async () => {
    const cases = [
      { key: "copywriter", label: "пустой результат",   output: "",              error: null,                 expectTech: false },
      { key: "copywriter", label: "упавший прогон",      output: null,            error: new Error("fetch failed"), expectTech: false },
      { key: "copywriter", label: "обрыв на полуслове",  output: "Сегодня расскажу про нейросети которые помогают в работе и вот первая из них это", error: null, expectContent: "fail" },
      { key: "copywriter", label: "здоровый пост",       output: "Instagram выкатил новую фичу для рилсов.\n\nТеперь можно вшивать субтитры прямо в редакторе — раньше это делали сторонними приложениями. Для тех, кто снимает много, экономия ощутимая: один шаг вместо трёх. Пробуй на ближайшем ролике и смотри, добивают ли досмотры.", error: null, expectContent: "ok" },
    ];
    let pass = 0;
    for (const c of cases) {
      const tech = technicalCheck(c.key, c.output, c.error);
      if (c.expectTech === false) {
        const ok = tech.ok === false;
        console.log(`${ok ? "✅" : "❌"} [тех] ${c.label}: ${ok ? "пойман" : "ПРОПУЩЕН"} — ${tech.reason || "ok"}`);
        if (ok) pass++;
        continue;
      }
      if (!tech.ok) { console.log(`❌ [тех] ${c.label}: неожиданно забраковал — ${tech.reason}`); continue; }
      const v = await reviewContent(c.key, c.output);
      const ok = v.verdict === c.expectContent || (c.expectContent === "fail" && v.verdict === "warn");
      console.log(`${ok ? "✅" : "❌"} [контент] ${c.label}: вердикт=${v.verdict} (ждали ${c.expectContent}) — ${v.reason || "-"}`);
      if (ok) pass++;
    }
    console.log(`\nИтог: ${pass}/${cases.length} проверок прошло.`);
    process.exit(pass === cases.length ? 0 : 1);
  })();
} else if (cmd === "run" && process.argv[3]) {
  runAgentReviewed(process.argv[3]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === "run-all") {
  runChain(Object.keys(AGENTS), "run-all").catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === "render-carousel" && process.argv[3]) {
  // Рендер уже готового текста карусели в PNG, без LLM-генерации текста:
  // node factory.js render-carousel slides.txt [фото-обложки.jpg] [N=скрин.png ...]
  // Второй аргумент — конкретное фото на обложку вместо случайного с Drive.
  // Аргументы «N=файл» кладут скрин в слот слайда N.
  (async () => {
    const text = await fs.readFile(process.argv[3], "utf8");
    const toDataUri = async (file) => {
      const buf = await fs.readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    };
    let cover = null;
    const screenshots = {};
    for (const arg of process.argv.slice(4)) {
      const m = arg.match(/^(\d+)=(.+)$/);
      if (m) screenshots[m[1]] = await toDataUri(m[2]);
      else cover = await toDataUri(arg);
    }
    const slides = await generateCarouselHtml(extractCarouselCaption(text).slides, cover,
      Object.keys(screenshots).length ? screenshots : null);
    const paths = await renderSlidesToPng(slides);
    console.log(`\n✅ Готово: ${paths.length} слайдов`);
    paths.forEach((p) => console.log(p));
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === "idea" && process.argv[3]) {
  // Разовый прогон цепочки по идее, как голосом в чат: node factory.js idea "сделай пост про X"
  const briefing = process.argv.slice(3).join(" ");
  const agents = detectVoiceAgents(briefing);
  console.log(`[CLI-идея] агенты: [${agents.join(", ")}]`);
  runChain(agents, "CLI-идея", () => writeState("analyst",
    `ИДЕЯ ОТ АВТОРА:\n${briefing}\n\nВАЖНО — работать СТРОГО по этому запросу. Не добавлять платформы и форматы которые не упомянуты.`))
    .then(() => { console.log("✅ Цепочка отработала"); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "reels-cover" && process.argv[3]) {
  // Локальный тест обложки: node factory.js reels-cover "текст" [путь-к-фото]
  (async () => {
    if (process.argv[4]) {
      const buf = await fs.readFile(process.argv[4]);
      await saveReelsPhoto(buf, path.extname(process.argv[4]).slice(1));
    }
    const uri = await loadReelsPhotoUri();
    if (!uri) throw new Error("нет фото: передай путь вторым аргументом");
    const outPath = await renderReelsCoverPng(buildReelsCoverHtml(process.argv[3], uri));
    console.log(`✅ Обложка: ${outPath}`);
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "guide-render") {
  // Перерендер PDF из сохранённого JSON (state/guide_data.txt), без Claude:
  // node factory.js guide-render — для итераций по дизайну
  (async () => {
    const guide = JSON.parse(await readState("guide_data"));
    const outPath = path.join(STATE_DIR, "guides", "гайд-тест.pdf");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await renderGuidePdf(buildGuideHtml(guide), outPath);
    console.log(`✅ Перерендер: ${outPath}`);
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "guide-send") {
  // Верстает и шлёт на проверку в Telegram гайд из state/guide_data.txt,
  // без вызова Claude — когда контент уже написан и проверен вручную:
  // node factory.js guide-send
  (async () => {
    const guide = JSON.parse(await readState("guide_data"));
    await finishGuide(guide);
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "guide-parse" && process.argv[3]) {
  // Проверка разбора команды гайда без генерации:
  // node factory.js guide-parse "сделай гайд про <тему>. <материал>"
  console.log(JSON.stringify(parseGuideCommand(process.argv[3]), null, 2));
  process.exit(0);
} else if (cmd === "guide" && process.argv[3]) {
  // Локальный тест гайд-мейкера без Telegram: node factory.js guide "тема" [СЛОВО]
  // Или полной командой с материалом: node factory.js guide "сделай гайд про <тему>. <материал>"
  (async () => {
    const arg = process.argv[3];
    const parsed = /гайд[а-яё]*\s+(?:про|по|о|для|на тему)\s/i.test(arg)
      ? parseGuideCommand(arg)
      : { topic: arg, codeWord: null, brief: null };
    const guide = await generateGuide(parsed.topic, parsed.codeWord || process.argv[4] || null, parsed.brief);
    const html = buildGuideHtml(guide);
    const dir = path.join(STATE_DIR, "guides");
    await fs.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, "гайд-тест.pdf");
    await renderGuidePdf(html, outPath);
    await writeState("guide_data", JSON.stringify(guide));
    console.log(`✅ Гайд «${guide.title}» · слово: ${guide.code_word}\n${outPath}`);
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "threads-test") {
  // Тестовый батч Threads: генерит 6 постов и шлёт превью в Telegram-топик,
  // в PostMyPost ничего не уходит. node factory.js threads-test
  runThreadsAutopilot({ dryRun: true })
    .then(() => { console.log("✅ Тестовый батч отправлен в Telegram"); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "threads-run") {
  // Боевой разовый прогон автопилота (реально ставит в очередь PMP по режиму).
  // node factory.js threads-run
  runThreadsAutopilot()
    .then(() => { console.log("✅ Прогон автопилота завершён"); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
} else if (cmd === "listen") {
  startVoiceListener().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  // Режим по умолчанию (npm start / Railway) — крон + голосовой слушатель вместе.
  // Слушатель и монитор сами перезапускаются при любом падении: сетевой сбой
  // (fetch failed) больше не убивает завод навсегда — поднимется через 5 секунд.
  const keepAlive = (name, fn, delay = 5000) => {
    const run = () => fn().catch((err) => {
      console.error(`[${name}] упал: ${err.message} — перезапуск через ${delay / 1000}с`);
      setTimeout(run, delay);
    });
    run();
  };
  startCron();
  seedThreadsHistory().catch((e) => console.warn("[Threads-история] посев не удался:", e.message));
  // Мониторинг канала запускается параллельно — отдельный токен, нет конфликта
  keepAlive("ChannelMonitor", startChannelMonitor);
  keepAlive("Voice listener", startVoiceListener);
  console.log("✅ Контент-завод запущен: голосовой слушатель + мониторинг канала активны");
}
