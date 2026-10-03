import { Telegraf, Markup, Scenes, session } from "telegraf";
import { db } from "./db.js";
import {
  bookingScene,
  bookButtonText,
  API_BASE,
  bookingActionButtons,
  reminderActionButtons,
  masterStatusLine,
  type BotContext,
  type RescheduleEntryState,
} from "./bookingScene.js";
import { internalHeaders } from "./internalAuth.js";
import { getRole } from "./roles.js";
import { DEFAULT_LANG, SUPPORTED_LANGS, allLangs, isSupportedLang, localizedSql, normalizeLang, t, type Lang } from "./i18n.js";
import { resolveLanguage, getUserLanguage, confirmLanguage, isLanguageConfirmed } from "./userLanguage.js";
import { formatDateTime, formatRuDateTime } from "./format.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error("BOT_TOKEN не задан в .env");
}

// Адрес сайта записи (webapp) на GitHub Pages. Пока не опубликован — кнопка не показывается.
const webAppBaseUrl = process.env.WEBAPP_URL;

// К адресу каждый раз добавляем свежую метку времени — иначе Telegram может
// закэшировать старую версию мини-приложения и не подгружать новую после обновления сайта.
function getWebAppUrl(): string | undefined {
  if (!webAppBaseUrl) return undefined;
  return `${webAppBaseUrl}${webAppBaseUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

export const bot = new Telegraf<BotContext>(token);

// Ошибка в любом обработчике бота. Без этого библиотека Telegraf по умолчанию
// останавливает приём сообщений целиком — бот молча перестаёт отвечать ВСЕМ,
// а сервер при этом работает дальше, и Render его не перезапускает. Здесь
// ошибка только записывается в журнал, человеку уходит "попробуйте ещё раз",
// а бот продолжает работать для всех остальных
bot.catch(async (err, ctx) => {
  console.error(`Ошибка бота (${ctx.updateType}, от ${ctx.from?.id ?? "?"}):`, err);
  // 403 — человек заблокировал бота: написать ему всё равно не получится
  if ((err as { response?: { error_code?: number } }).response?.error_code === 403) return;
  // Язык мог не определиться, если сломалось как раз его чтение из базы
  const lang = ctx.lang ?? normalizeLang(ctx.from?.language_code);
  const text = t(lang, "bot.somethingWrong");
  try {
    if (ctx.callbackQuery) {
      // Гасим "часики" на нажатой кнопке и показываем текст всплывающим окном
      await ctx.answerCbQuery(text, { show_alert: true });
    } else if (ctx.chat) {
      await ctx.reply(text);
    }
  } catch {
    // Не получилось даже сообщить (например, нажатие кнопки уже "устарело") —
    // главное, что бот продолжает работать
  }
});

// Диалог записи прямо в чате (команда /book, без Mini App). Состояние диалога
// хранится в памяти сервера (не в базе) — если сервер перезапустится посреди
// диалога, человеку придётся начать заново командой /book
const stage = new Scenes.Stage<BotContext>([bookingScene]);

// Язык пользователя — первым делом, до остальных обработчиков: при самом
// первом обращении определяется по языку Telegram и сохраняется в базе, дальше
// только читается оттуда (а не определяется заново на каждом сообщении/шаге)
bot.use(async (ctx, next) => {
  ctx.lang = ctx.from ? await resolveLanguage(ctx.from.id, ctx.from.language_code) : DEFAULT_LANG;
  return next();
});
bot.use(session());
bot.use(stage.middleware());

// Кнопка слева от поля ввода в чате — открывает Mini App в один клик,
// без необходимости писать /start. По умолчанию (для тех, кто ещё не писал
// /start) стоит клиентский текст — большинство открывающих бота впервые это клиенты
export async function setupMenuButton(): Promise<void> {
  // Список команд в меню "/" — у каждого языка Telegram свой (русский по
  // умолчанию, английский для тех, у кого Telegram на английском)
  for (const lang of SUPPORTED_LANGS) {
    try {
      await bot.telegram.setMyCommands(
        [
          { command: "book", description: t(lang, "bot.cmdBook") },
          { command: "services", description: t(lang, "bot.cmdServices") },
          { command: "masters", description: t(lang, "bot.cmdMasters") },
          { command: "faq", description: t(lang, "bot.cmdFaq") },
          { command: "language", description: t(lang, "bot.cmdLanguage") },
        ],
        lang === DEFAULT_LANG ? undefined : { language_code: lang }
      );
    } catch (err) {
      console.warn("Не удалось настроить список команд:", err instanceof Error ? err.message : err);
    }
  }

  const webAppUrl = getWebAppUrl();
  if (!webAppUrl) return;
  try {
    await bot.telegram.setChatMenuButton({
      menuButton: { type: "web_app", text: "Записаться", web_app: { url: webAppUrl } },
    });
  } catch (err) {
    console.warn("Не удалось настроить кнопку меню:", err instanceof Error ? err.message : err);
  }
}

// Персональная кнопка меню для конкретного чата — у персонала (мастер/админ)
// она должна называться иначе, чем у клиента. setChatMenuButton с chat_id
// переопределяет глобальную кнопку только для этого одного собеседника
async function setPersonalMenuButton(chatId: number, text: string, webAppUrl: string): Promise<void> {
  try {
    await bot.telegram.setChatMenuButton({
      chatId,
      menuButton: { type: "web_app", text, web_app: { url: webAppUrl } },
    });
  } catch (err) {
    console.warn("Не удалось настроить персональную кнопку меню:", err instanceof Error ? err.message : err);
  }
}

bot.start(async (ctx) => {
  const webAppUrl = getWebAppUrl();
  const role = await getRole(ctx.from.id);

  // Сотрудник (мастер/админ) открывает свою панель только через приложение —
  // кнопка быстрой записи в чате ему не нужна, это чисто клиентский сценарий.
  // Markup.removeKeyboard() на всякий случай убирает эту кнопку, если она
  // осталась видна с более раннего /start (до этого разделения)
  if (role.role !== "client") {
    const name = ctx.from.first_name ?? "коллега";
    const roleLabel = role.role === "master" ? "мастера" : "администратора";
    await ctx.reply(`Здравствуйте, ${name}! Панель ${roleLabel} — в приложении.`, Markup.removeKeyboard());
    if (webAppUrl) {
      await ctx.reply(
        "Нажмите, чтобы открыть:",
        Markup.inlineKeyboard([Markup.button.webApp("Панель", webAppUrl)])
      );
      await setPersonalMenuButton(ctx.chat.id, "Панель", webAppUrl);
    }
    return;
  }

  // Новому клиенту — сначала выбор языка (одно маленькое сообщение с
  // флагами); тем, кто язык уже выбирал, — сразу приветствие
  if (!(await isLanguageConfirmed(ctx.from.id))) {
    await ctx.reply(LANGUAGE_PICKER_TEXT, { reply_markup: startLanguageButtons() });
    return;
  }
  await sendClientWelcome(ctx, ctx.lang);
});

// Одно короткое приветствие с кнопками внизу чата (запись и FAQ).
// Приложение открывается кнопкой меню слева от поля ввода — отдельное
// сообщение "Открыть приложение" больше не шлём
async function sendClientWelcome(ctx: BotContext, lang: Lang) {
  // Названия кнопок в тексте — те же, что на самих кнопках, жирным, чтобы
  // их было легко найти глазами
  const text = t(lang, "bot.welcome", {
    book: bookButtonText(lang),
    app: t(lang, "bot.menuBook"),
    faq: t(lang, "bot.faqButton"),
  });
  await ctx.reply(text, { parse_mode: "HTML", ...clientKeyboard(lang) });
  const webAppUrl = getWebAppUrl();
  // На случай, если у этого чата раньше стояла кнопка "Панель" (роль сменилась
  // с персонала на клиента, например, при тестировании) — возвращаем клиентский текст
  if (webAppUrl && ctx.chat) await setPersonalMenuButton(ctx.chat.id, t(lang, "bot.menuBook"), webAppUrl);
}

// Выбор языка при первом /start — на обоих языках сразу, раз язык ещё не выбран
const LANGUAGE_PICKER_TEXT = "🌐 Выберите язык / Choose language";

function startLanguageButtons() {
  return {
    inline_keyboard: [SUPPORTED_LANGS.map((l) => ({ text: LANG_LABELS[l], callback_data: `startlang:${l}` }))],
  };
}

// Нажали флаг: сообщение с выбором убираем, присылаем приветствие на этом языке
bot.action(/^startlang:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chosen = ctx.match[1];
  if (!isSupportedLang(chosen)) return;
  await confirmLanguage(ctx.from.id, chosen);
  ctx.lang = chosen;
  try {
    await ctx.deleteMessage();
  } catch {
    // старое сообщение (больше 48 часов) Telegram удалить не даёт — просто убираем кнопки
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  }
  await sendClientWelcome(ctx, chosen);
});

// ── Переписка клиента с мастером через бота ──────────────────────────────
// Под сообщением о записи у клиента кнопка "💬 Написать мастеру": клиент
// пишет боту, бот передаёт мастеру (с данными записи и кнопкой "Ответить"),
// ответ мастера бот передаёт клиенту. Личный Telegram мастера клиенту не
// раскрывается. Если у мастера нет доступа к боту — сообщение получают
// администраторы. Сторона персонала — по-русски, как и вся панель.
// Ожидание "следующего сообщения" живёт в памяти сервера (как и комментарий
// к оценке): после перезапуска сервера кнопку нужно нажать заново
const CHAT_WAIT_MS = 30 * 60 * 1000;
// Писать по записи можно, пока она предстоит, и ещё 2 дня после визита
const CHAT_DAYS_AFTER = 2;

interface ChatWait {
  bookingId: number;
  until: number;
}
const awaitingClientMessage = new Map<number, ChatWait>();
const awaitingMasterReply = new Map<number, ChatWait>();

interface ChatBooking {
  id: number;
  client_telegram_id: string | null;
  client_name: string | null;
  starts_at: string;
  service_name: string;
  service_name_en: string | null;
  master_name: string;
  master_telegram_id: string | null;
  active: boolean;
}

async function loadChatBooking(bookingId: number): Promise<ChatBooking | null> {
  const { rows } = await db.query<ChatBooking>(
    `SELECT b.id, b.client_telegram_id, b.client_name, b.starts_at,
            s.name AS service_name, s.name_en AS service_name_en, m.name AS master_name,
            st.telegram_id AS master_telegram_id,
            (b.status = 'upcoming' OR b.starts_at > now() - make_interval(days => $2)) AS active
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN masters m ON m.id = b.master_id
     LEFT JOIN staff st ON st.master_id = b.master_id AND st.role = 'master'
     WHERE b.id = $1`,
    [bookingId, CHAT_DAYS_AFTER]
  );
  return rows[0] ?? null;
}

// Кому из персонала уходит сообщение клиента: мастер записи, а если у него
// нет доступа к боту — все администраторы
async function chatStaffRecipients(booking: ChatBooking): Promise<number[]> {
  if (booking.master_telegram_id) return [Number(booking.master_telegram_id)];
  const { rows } = await db.query<{ telegram_id: string }>("SELECT telegram_id FROM staff WHERE role = 'admin'");
  return rows.map((r) => Number(r.telegram_id));
}

function chatCancelButton(lang: Lang) {
  return { inline_keyboard: [[{ text: t(lang, "common.cancel"), callback_data: "chatcancel" }]] };
}

// Кнопки внизу чата и команды — не сообщение мастеру: отменяем ожидание и
// даём им сработать как обычно
function isChatEscape(text: string): boolean {
  return text.startsWith("/") || allLangs("bot.bookButton").includes(text) || allLangs("bot.faqButton").includes(text);
}

bot.action(/^msgm:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const booking = await loadChatBooking(Number(ctx.match[1]));
  if (!booking || Number(booking.client_telegram_id) !== ctx.from.id || !booking.active) {
    await ctx.reply(t(ctx.lang, "chat.notAvailable"));
    return;
  }
  awaitingMasterReply.delete(ctx.from.id);
  awaitingClientMessage.set(ctx.from.id, { bookingId: booking.id, until: Date.now() + CHAT_WAIT_MS });
  await ctx.reply(t(ctx.lang, "chat.prompt", { master: booking.master_name }), {
    reply_markup: chatCancelButton(ctx.lang),
  });
});

bot.action(/^replyc:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const booking = await loadChatBooking(Number(ctx.match[1]));
  const role = await getRole(ctx.from.id);
  const allowed =
    booking &&
    (role.role === "admin" || (role.role === "master" && Number(booking.master_telegram_id) === ctx.from.id));
  if (!booking || !allowed || !booking.client_telegram_id) {
    await ctx.reply("Ответить по этой записи не получится.");
    return;
  }
  awaitingClientMessage.delete(ctx.from.id);
  awaitingMasterReply.set(ctx.from.id, { bookingId: booking.id, until: Date.now() + CHAT_WAIT_MS });
  await ctx.reply(`Напишите ответ клиенту (${booking.client_name ?? "клиент"}) одним сообщением — я передам его.`, {
    reply_markup: chatCancelButton(DEFAULT_LANG),
  });
});

bot.action("chatcancel", async (ctx) => {
  await ctx.answerCbQuery();
  awaitingClientMessage.delete(ctx.from.id);
  awaitingMasterReply.delete(ctx.from.id);
  await ctx.editMessageText(t(ctx.lang, "chat.cancelled"));
});

bot.on("message", async (ctx, next) => {
  const fromId = ctx.from.id;
  const clientWait = awaitingClientMessage.get(fromId);
  const masterWait = awaitingMasterReply.get(fromId);
  const wait = clientWait ?? masterWait;
  if (!wait) return next();

  const text = "text" in ctx.message ? ctx.message.text.trim() : null;
  if (wait.until < Date.now() || (text !== null && isChatEscape(text))) {
    awaitingClientMessage.delete(fromId);
    awaitingMasterReply.delete(fromId);
    return next();
  }
  if (!text) {
    await ctx.reply(t(ctx.lang, "chat.textOnly"));
    return;
  }

  const booking = await loadChatBooking(wait.bookingId);
  awaitingClientMessage.delete(fromId);
  awaitingMasterReply.delete(fromId);
  if (!booking || !booking.client_telegram_id) {
    await ctx.reply(t(ctx.lang, "chat.failed"));
    return;
  }

  if (clientWait) {
    // Клиент → мастер (или админам)
    const recipients = await chatStaffRecipients(booking);
    const header =
      `💬 Сообщение от клиента\n\n${booking.client_name ?? "Клиент"}\n` +
      `${booking.service_name} — ${booking.master_name}, ${formatRuDateTime(booking.starts_at)}`;
    let delivered = 0;
    for (const staffId of recipients) {
      try {
        await bot.telegram.sendMessage(staffId, `${header}\n\n${text}`, {
          reply_markup: { inline_keyboard: [[{ text: "↩️ Ответить клиенту", callback_data: `replyc:${booking.id}` }]] },
        });
        delivered++;
      } catch (err) {
        console.warn(`Не удалось передать сообщение клиента сотруднику ${staffId}:`, err);
      }
    }
    await ctx.reply(t(ctx.lang, delivered ? "chat.sent" : "chat.failed"));
    return;
  }

  // Мастер/админ → клиент, на языке клиента
  const clientId = Number(booking.client_telegram_id);
  const lang = await getUserLanguage(clientId);
  const service = lang === "en" && booking.service_name_en ? booking.service_name_en : booking.service_name;
  try {
    await bot.telegram.sendMessage(
      clientId,
      t(lang, "chat.fromMaster", {
        master: booking.master_name,
        service,
        date: formatDateTime(booking.starts_at, lang),
        text,
      }),
      { reply_markup: { inline_keyboard: [[{ text: t(lang, "buttons.messageMaster"), callback_data: `msgm:${booking.id}` }]] } }
    );
    await ctx.reply("✅ Ответ отправлен клиенту.");
  } catch {
    await ctx.reply("Не получилось отправить ответ — возможно, клиент заблокировал бота.");
  }
});

bot.command("book", (ctx) => ctx.scene.enter("booking"));

// ── FAQ прямо в чате ─────────────────────────────────────────────────────
// Кнопка "❓ FAQ" внизу чата (или /faq): адрес салона, часы работы, кнопка
// маршрута и вопросы кнопками; нажатие на вопрос показывает ответ в том же
// сообщении, "← Все вопросы" возвращает список. Данные — тот же /api/faq,
// что и у вкладки FAQ в приложении, на языке клиента
interface FaqData {
  // button_label — короткая подпись для кнопки (или сам вопрос, если её нет)
  items: { id: number; question: string; answer: string; button_label: string }[];
  salon_address: string | null;
  salon_location_url: string | null;
  working_hours: string | null;
}

async function fetchFaq(lang: Lang): Promise<FaqData> {
  const res = await fetch(`${API_BASE}/faq`, { headers: internalHeaders({ "X-Lang": lang }) });
  if (!res.ok) throw new Error(`FAQ: ${res.status}`);
  return (await res.json()) as FaqData;
}

function faqRouteUrl(faq: FaqData): string | null {
  if (faq.salon_location_url) return faq.salon_location_url;
  return faq.salon_address ? `https://maps.google.com/?q=${encodeURIComponent(faq.salon_address)}` : null;
}

function faqOverview(faq: FaqData, lang: Lang) {
  const lines = [t(lang, "faq.title")];
  if (faq.salon_address) lines.push(`\n📍 ${faq.salon_address}`);
  if (faq.working_hours) lines.push(`${faq.salon_address ? "" : "\n"}🕐 ${faq.working_hours}`);
  lines.push(`\n${t(lang, faq.items.length ? "faq.pick" : "faq.empty")}`);

  const keyboard: ({ text: string; callback_data: string } | { text: string; url: string })[][] = faq.items.map(
    (item) => [{ text: item.button_label || item.question, callback_data: `faq:${item.id}` }]
  );
  const route = faqRouteUrl(faq);
  if (route) keyboard.push([{ text: t(lang, "faq.route"), url: route }]);
  // Смена языка прямо отсюда; текущий отмечен галочкой
  keyboard.push(
    SUPPORTED_LANGS.map((l) => ({
      text: l === lang ? `✓ ${LANG_LABELS[l]}` : LANG_LABELS[l],
      callback_data: `faqlang:${l}`,
    }))
  );
  // Если FAQ открыли случайно — убрать сообщение из чата одним нажатием
  keyboard.push([{ text: t(lang, "faq.close"), callback_data: "faq_close" }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

async function sendFaq(ctx: BotContext) {
  const { text, reply_markup } = faqOverview(await fetchFaq(ctx.lang), ctx.lang);
  await ctx.reply(text, { reply_markup });
}

bot.command("faq", sendFaq);
bot.hears(allLangs("bot.faqButton"), sendFaq);

bot.action(/^faq:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const faq = await fetchFaq(ctx.lang);
  const item = faq.items.find((i) => i.id === Number(ctx.match[1]));
  if (!item) {
    // вопрос успели удалить — показываем актуальный список
    const { text, reply_markup } = faqOverview(faq, ctx.lang);
    await ctx.editMessageText(text, { reply_markup });
    return;
  }
  await ctx.editMessageText(`❓ ${item.question}\n\n${item.answer}`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: t(ctx.lang, "faq.back"), callback_data: "faq_list" },
          { text: t(ctx.lang, "faq.close"), callback_data: "faq_close" },
        ],
      ],
    },
  });
});

// Закрыть FAQ — сообщение удаляется из чата. Сообщения старше 48 часов
// Telegram удалять не даёт — тогда просто сворачиваем его до одной строки
bot.action("faq_close", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    await ctx.editMessageText(t(ctx.lang, "faq.closed"));
  }
});

// Выбор языка из FAQ: само сообщение FAQ перерисовывается на новом языке.
// Кнопки внизу чата Telegram меняет только вместе с новым сообщением —
// поэтому клиенту приходит одна короткая строка "✅ Язык: …" с новыми кнопками
bot.action(/^faqlang:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chosen = ctx.match[1];
  if (!isSupportedLang(chosen) || chosen === ctx.lang) return;
  await confirmLanguage(ctx.from.id, chosen);
  ctx.lang = chosen;
  const { text, reply_markup } = faqOverview(await fetchFaq(chosen), chosen);
  await ctx.editMessageText(text, { reply_markup });

  const role = await getRole(ctx.from.id);
  if (role.role !== "client") return;
  await ctx.reply(t(chosen, "bot.languageChanged", { language: LANG_LABELS[chosen] }), clientKeyboard(chosen));
  const webAppUrl = getWebAppUrl();
  if (webAppUrl && ctx.chat) await setPersonalMenuButton(ctx.chat.id, t(chosen, "bot.menuBook"), webAppUrl);
});

bot.action("faq_list", async (ctx) => {
  await ctx.answerCbQuery();
  const { text, reply_markup } = faqOverview(await fetchFaq(ctx.lang), ctx.lang);
  await ctx.editMessageText(text, { reply_markup });
});
// Кнопка внизу чата называется по-разному на разных языках — узнаём любую
bot.hears(allLangs("bot.bookButton"), (ctx) => ctx.scene.enter("booking"));

// Выбор языка: /language (и старое /lang — вдруг кто-то запомнил). Язык
// определяется сам по настройкам Telegram при первом обращении, эта команда —
// чтобы сменить его вручную. Выбор хранится в базе один на человека и
// действует сразу и в боте, и в мини-приложении
// Кнопки внизу чата у клиента: запись в чате и частые вопросы.
// .persistent() — иначе Telegram на телефоне сворачивает их в иконку
function clientKeyboard(lang: Lang) {
  return Markup.keyboard([[bookButtonText(lang), t(lang, "bot.faqButton")]]).resize().persistent();
}

const LANG_LABELS: Record<Lang, string> = { ru: "🇷🇺 Русский", en: "🇬🇧 English" };

function languageButtons(current: Lang) {
  return {
    inline_keyboard: [
      SUPPORTED_LANGS.map((l) => ({
        text: l === current ? `✓ ${LANG_LABELS[l]}` : LANG_LABELS[l],
        callback_data: `setlang:${l}`,
      })),
    ],
  };
}

bot.command(["language", "lang"], async (ctx) => {
  await ctx.reply(t(ctx.lang, "bot.languagePrompt", { language: LANG_LABELS[ctx.lang] }), {
    reply_markup: languageButtons(ctx.lang),
  });
});

bot.action(/^setlang:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chosen = ctx.match[1];
  if (!isSupportedLang(chosen)) return;
  await confirmLanguage(ctx.from.id, chosen);
  ctx.lang = chosen;
  await ctx.editMessageText(t(chosen, "bot.languageChanged", { language: LANG_LABELS[chosen] }));

  // Кнопки внизу чата и слева от поля ввода — тоже на новом языке. Только
  // клиенту: у персонала там своя кнопка "Панель", её не трогаем
  const role = await getRole(ctx.from.id);
  if (role.role !== "client") return;
  await ctx.reply(t(chosen, "bot.languageKeyboard"), clientKeyboard(chosen));
  const webAppUrl = getWebAppUrl();
  if (webAppUrl && ctx.chat) await setPersonalMenuButton(ctx.chat.id, t(chosen, "bot.menuBook"), webAppUrl);
});

// Кнопка "🔄 Перенести" под сообщением о записи — работает вне зависимости от
// того, идёт ли сейчас какой-то диалог, поэтому обработчик общий, не внутри
// сцены. Подтягивает услугу/мастера старой записи и сразу открывает выбор дня
bot.action(/^resched:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = Number(ctx.match[1]);
  const res = await fetch(`${API_BASE}/bookings?client_telegram_id=${ctx.from.id}`, {
    headers: internalHeaders({ "X-Lang": ctx.lang }),
  });
  const bookings = (await res.json()) as {
    id: number;
    master_id: number;
    master_name: string;
    service_id: number;
    service_name: string;
    duration_minutes: number;
    price: number;
  }[];
  const booking = bookings.find((b) => b.id === bookingId);
  if (!booking) {
    await ctx.reply(t(ctx.lang, "bot.reschedUnavailable"));
    return;
  }
  const entryState: RescheduleEntryState = {
    reschedule: {
      bookingId: booking.id,
      masterId: booking.master_id,
      masterName: booking.master_name,
      serviceId: booking.service_id,
      serviceName: booking.service_name,
      serviceDuration: booking.duration_minutes,
      servicePrice: booking.price,
    },
  };
  await ctx.scene.enter("booking", entryState);
});

// "❌ Отменить" — сперва просим подтвердить (кнопку легко нажать случайно
// среди других кнопок в сообщении), а отменяем только по "Да"
bot.action(/^cancelbk:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [{ text: t(ctx.lang, "buttons.yesCancel"), callback_data: `cancelbk_yes:${id}` }],
      [{ text: t(ctx.lang, "buttons.noKeep"), callback_data: `cancelbk_no:${id}` }],
    ],
  });
});

bot.action(/^cancelbk_yes:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const res = await fetch(`${API_BASE}/bookings/${id}?client_telegram_id=${ctx.from.id}`, {
    method: "DELETE",
    headers: internalHeaders({ "X-Lang": ctx.lang }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    await ctx.reply(t(ctx.lang, "bot.cancelFailed", { error: data.error ?? t(ctx.lang, "common.unknownError") }));
    return;
  }
  await ctx.editMessageText(t(ctx.lang, "bot.cancelled"));
});

bot.action(/^cancelbk_no:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await ctx.editMessageReplyMarkup({ inline_keyboard: bookingActionButtons(id, ctx.lang) });
});

// "⏳ Я опаздываю" (кнопка есть только под напоминанием) — на сколько минут,
// выбирается готовыми вариантами, чтобы не печатать вручную
bot.action(/^late:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [
        ...[10, 15, 20, 30].map((n) => ({
          text: t(ctx.lang, "buttons.minutes", { n }),
          callback_data: `late_ok:${id}:${n}`,
        })),
      ],
      [{ text: t(ctx.lang, "common.back"), callback_data: `late_cancel:${id}` }],
    ],
  });
});

bot.action(/^late_cancel:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await ctx.editMessageReplyMarkup({ inline_keyboard: reminderActionButtons(id, ctx.lang) });
});

bot.action(/^late_ok:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const minutes = ctx.match[2];
  const res = await fetch(`${API_BASE}/bookings/${id}/late`, {
    method: "POST",
    headers: internalHeaders({ "Content-Type": "application/json", "X-Lang": ctx.lang }),
    body: JSON.stringify({ client_telegram_id: ctx.from.id, minutes: Number(minutes) }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    await ctx.reply(t(ctx.lang, "bot.lateFailed", { error: data.error ?? t(ctx.lang, "common.unknownError") }));
    return;
  }
  await ctx.editMessageText(t(ctx.lang, "bot.lateDone", { minutes }));
});

// Оценка визита звёздами — под сообщением "услуга завершена" (см. api.ts,
// отправляется при отметке записи "Выполнена")
bot.action(/^rate:(\d+):([1-5])$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const rating = Number(ctx.match[2]);
  const res = await fetch(`${API_BASE}/bookings/${id}/rating`, {
    method: "POST",
    headers: internalHeaders({ "Content-Type": "application/json", "X-Lang": ctx.lang }),
    body: JSON.stringify({ client_telegram_id: ctx.from.id, rating }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    await ctx.reply(t(ctx.lang, "bot.rateFailed", { error: data.error ?? t(ctx.lang, "common.unknownError") }));
    return;
  }
  await ctx.editMessageText(t(ctx.lang, "bot.rateThanks", { stars: "⭐".repeat(rating) }), {
    reply_markup: {
      inline_keyboard: [[{ text: t(ctx.lang, "buttons.addComment"), callback_data: `ratecomment:${id}:${rating}` }]],
    },
  });
});

// Комментарий к оценке — необязательный шаг, ловим следующее текстовое
// сообщение от этого клиента. Не через ctx.session/сцену (та работает только
// внутри диалога /book) — обычная Map в памяти сервера, тот же принцип "состояние
// живёт в памяти", что и у сцены записи (см. комментарий в начале файла)
const awaitingRatingComment = new Map<number, { bookingId: number; rating: number }>();

bot.action(/^ratecomment:(\d+):([1-5])$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = Number(ctx.match[1]);
  const rating = Number(ctx.match[2]);
  awaitingRatingComment.set(ctx.from.id, { bookingId, rating });
  await ctx.editMessageText(t(ctx.lang, "bot.rateAskComment", { stars: "⭐".repeat(rating) }));
});

// Свободный текст ловим, только пока реально ждём комментарий — иначе
// пропускаем дальше (next()), чтобы не мешать остальным обработчикам
bot.on("text", async (ctx, next) => {
  const pending = awaitingRatingComment.get(ctx.from.id);
  if (!pending) {
    await next();
    return;
  }
  awaitingRatingComment.delete(ctx.from.id);

  const comment = ctx.message.text.trim();
  const res = await fetch(`${API_BASE}/bookings/${pending.bookingId}/rating`, {
    method: "POST",
    headers: internalHeaders({ "Content-Type": "application/json", "X-Lang": ctx.lang }),
    body: JSON.stringify({ client_telegram_id: ctx.from.id, rating: pending.rating, comment }),
  });
  if (!res.ok) {
    await ctx.reply(t(ctx.lang, "bot.commentFailed"));
    return;
  }
  await ctx.reply(t(ctx.lang, "bot.commentSaved"));
});

bot.command("masters", async (ctx) => {
  const { rows: masters } = await db.query<{ name: string }>("SELECT name FROM masters");
  if (masters.length === 0) {
    ctx.reply(t(ctx.lang, "bot.noMasters"));
    return;
  }
  const list = masters.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
  ctx.reply(t(ctx.lang, "bot.mastersList", { list }));
});

bot.command("services", async (ctx) => {
  const lang = ctx.lang;
  const { rows: services } = await db.query<{ name: string; duration_minutes: number; price: number }>(
    `SELECT ${localizedSql(lang, "s", "name")} AS name, duration_minutes, price FROM services s ORDER BY s.id`
  );
  if (services.length === 0) {
    ctx.reply(t(lang, "bot.noServices"));
    return;
  }
  const list = services
    .map((s, i) => t(lang, "bot.serviceLine", { n: i + 1, name: s.name, minutes: s.duration_minutes, price: s.price }))
    .join("\n");
  ctx.reply(t(lang, "bot.servicesList", { list }));
});

// Мастер отмечает визит выполненным или неявкой прямо под уведомлением о
// записи (см. notifyMaster/masterBookingActionButtons в api.ts) — то же самое,
// что кнопки статуса в Mini App, но без необходимости её открывать
bot.action(/^mstatus:(\d+):(completed|no_show)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const status = ctx.match[2] as "completed" | "no_show";
  const res = await fetch(`${API_BASE}/staff/bookings/${id}/status`, {
    method: "PATCH",
    headers: internalHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ telegram_id: ctx.from.id, status }),
  });
  if (!res.ok) {
    // Запись уже отмечена в панели (а это сообщение старое, без сохранённой
    // привязки) — просто убираем кнопки, чтобы не висели
    if (res.status === 409) {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    await ctx.reply(`Не получилось изменить статус: ${data.error ?? "неизвестная ошибка"}`);
    return;
  }
  // Сохраняем текст записи и дописываем итог вместо кнопок — так же делает
  // сервер, когда статус меняют в панели (api.ts, syncMasterMessage). Если
  // сервер уже успел обновить это же сообщение — Telegram скажет "не изменено",
  // это не ошибка
  const original = (ctx.callbackQuery.message as { text?: string } | undefined)?.text;
  await ctx
    .editMessageText(original ? `${original}\n\n${masterStatusLine(status)}` : masterStatusLine(status), {
      reply_markup: { inline_keyboard: [] },
    })
    .catch(() => {});
});

// ВРЕМЕННЫЙ переключатель роли для тестов — работает только для одного
// Telegram ID из DEV_ROLE_SWITCH_TELEGRAM_ID в .env. Если переменная не
// задана — команда не отвечает вообще никому. ОБЯЗАТЕЛЬНО убрать переменную
// (или весь этот блок) перед передачей боту реального салона — иначе
// владелец этого Telegram ID сможет сам назначать себе роль админа
const devRoleSwitchId = process.env.DEV_ROLE_SWITCH_TELEGRAM_ID
  ? Number(process.env.DEV_ROLE_SWITCH_TELEGRAM_ID)
  : null;

if (devRoleSwitchId) {
  bot.command("role", async (ctx) => {
    if (ctx.from.id !== devRoleSwitchId) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();

    if (!arg) {
      const role = await getRole(ctx.from.id);
      const { rows: masters } = await db.query<{ id: number; name: string }>("SELECT id, name FROM masters ORDER BY id");
      const list = masters.map((m) => `${m.id} — ${m.name}`).join("\n") || "(мастеров пока нет)";
      await ctx.reply(
        `Сейчас роль: ${role.role}${role.role === "master" ? ` (${role.master_name})` : ""}\n\n` +
          `Команды:\n/role client\n/role admin\n/role master <id>\n\nМастера:\n${list}`
      );
      return;
    }

    if (arg === "client") {
      await db.query("DELETE FROM staff WHERE telegram_id = $1", [ctx.from.id]);
      await ctx.reply("Готово — теперь вы клиент.");
      return;
    }

    if (arg === "admin") {
      await db.query(
        `INSERT INTO staff (telegram_id, role, master_id) VALUES ($1, 'admin', NULL)
         ON CONFLICT (telegram_id) DO UPDATE SET role = 'admin', master_id = NULL`,
        [ctx.from.id]
      );
      await ctx.reply("Готово — теперь вы админ.");
      return;
    }

    if (arg === "master") {
      const masterId = Number(parts[2]);
      if (!masterId) {
        await ctx.reply("Укажите ID мастера: /role master 1 (список — просто /role)");
        return;
      }
      const { rows } = await db.query<{ name: string }>("SELECT name FROM masters WHERE id = $1", [masterId]);
      if (!rows[0]) {
        await ctx.reply("Мастер с таким ID не найден.");
        return;
      }
      await db.query(
        `INSERT INTO staff (telegram_id, role, master_id) VALUES ($1, 'master', $2)
         ON CONFLICT (telegram_id) DO UPDATE SET role = 'master', master_id = $2`,
        [ctx.from.id, masterId]
      );
      await ctx.reply(`Готово — теперь вы мастер (${rows[0].name}).`);
      return;
    }

    await ctx.reply("Не понял. Команды: /role client, /role admin, /role master <id>");
  });
}
