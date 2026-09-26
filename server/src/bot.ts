import { Telegraf, Markup, Scenes, session } from "telegraf";
import { db } from "./db.js";
import {
  bookingScene,
  bookButtonText,
  API_BASE,
  bookingActionButtons,
  reminderActionButtons,
  type BotContext,
  type RescheduleEntryState,
} from "./bookingScene.js";
import { internalHeaders } from "./internalAuth.js";
import { getRole } from "./roles.js";
import { DEFAULT_LANG, SUPPORTED_LANGS, allLangs, isSupportedLang, localizedSql, t, type Lang } from "./i18n.js";
import { resolveLanguage, saveLanguage } from "./userLanguage.js";

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

  // .persistent() — иначе Telegram на телефоне сворачивает эту кнопку в
  // маленькую иконку клавиатуры после первого нажатия, и кажется, что она пропала
  const lang = ctx.lang;
  await ctx.reply(
    t(lang, "bot.welcome", { button: bookButtonText(lang) }),
    Markup.keyboard([[bookButtonText(lang)]]).resize().persistent()
  );

  if (webAppUrl) {
    await ctx.reply(
      t(lang, "bot.welcomeApp"),
      Markup.inlineKeyboard([Markup.button.webApp(t(lang, "buttons.openApp"), webAppUrl)])
    );
    // На случай, если у этого чата раньше стояла кнопка "Панель" (роль сменилась
    // с персонала на клиента, например, при тестировании) — возвращаем клиентский текст
    await setPersonalMenuButton(ctx.chat.id, t(lang, "bot.menuBook"), webAppUrl);
  }
});

bot.command("book", (ctx) => ctx.scene.enter("booking"));
// Кнопка внизу чата называется по-разному на разных языках — узнаём любую
bot.hears(allLangs("bot.bookButton"), (ctx) => ctx.scene.enter("booking"));

// ВРЕМЕННЫЙ переключатель языка — только чтобы проверять мультиязычность руками
// (не финальный интерфейс; убрать/заменить настоящим выбором языка). /lang
// показывает кнопки выбора, выбор сохраняется в базе и действует и для бота,
// и для TWA (общая запись на пользователя)
bot.command("lang", async (ctx) => {
  await ctx.reply(t(ctx.lang, "dev.langPrompt", { lang: ctx.lang }), {
    reply_markup: {
      inline_keyboard: [SUPPORTED_LANGS.map((l) => ({ text: l.toUpperCase(), callback_data: `setlang:${l}` }))],
    },
  });
});

bot.action(/^setlang:(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chosen = ctx.match[1];
  if (!isSupportedLang(chosen)) return;
  await saveLanguage(ctx.from.id, chosen);
  ctx.lang = chosen;
  await ctx.editMessageText(t(chosen, "dev.langPrompt", { lang: chosen }), {
    reply_markup: {
      inline_keyboard: [SUPPORTED_LANGS.map((l) => ({ text: l.toUpperCase(), callback_data: `setlang:${l}` }))],
    },
  });
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
  const status = ctx.match[2];
  const res = await fetch(`${API_BASE}/staff/bookings/${id}/status`, {
    method: "PATCH",
    headers: internalHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ telegram_id: ctx.from.id, status }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    await ctx.reply(`Не получилось изменить статус: ${data.error ?? "неизвестная ошибка"}`);
    return;
  }
  await ctx.editMessageText(
    status === "completed" ? "✅ Запись отмечена как выполненная." : "🚫 Запись отмечена: клиент не пришёл."
  );
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
