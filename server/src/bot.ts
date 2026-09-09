import { Telegraf, Markup, Scenes, session } from "telegraf";
import { db } from "./db.js";
import {
  bookingScene,
  BOOK_BUTTON_TEXT,
  API_BASE,
  bookingActionButtons,
  type BotContext,
  type RescheduleEntryState,
} from "./bookingScene.js";

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
bot.use(session());
bot.use(stage.middleware());

// Кнопка слева от поля ввода в чате — открывает Mini App в один клик,
// без необходимости писать /start
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

bot.start(async (ctx) => {
  const webAppUrl = getWebAppUrl();

  // .persistent() — иначе Telegram на телефоне сворачивает эту кнопку в
  // маленькую иконку клавиатуры после первого нажатия, и кажется, что она пропала
  await ctx.reply(
    `Привет! Я помогу записаться в салон красоты.\n\nДля быстрой записи прямо здесь, в чате, нажмите кнопку «${BOOK_BUTTON_TEXT}» внизу — она всегда под рукой.`,
    Markup.keyboard([[BOOK_BUTTON_TEXT]]).resize().persistent()
  );

  if (webAppUrl) {
    await ctx.reply(
      "А в приложении можно подробнее посмотреть всех мастеров и услуги — с фото и описанием.",
      Markup.inlineKeyboard([Markup.button.webApp("Открыть приложение", webAppUrl)])
    );
  }
});

bot.command("book", (ctx) => ctx.scene.enter("booking"));
bot.hears(BOOK_BUTTON_TEXT, (ctx) => ctx.scene.enter("booking"));

// Кнопка "🔄 Перенести" под сообщением о записи — работает вне зависимости от
// того, идёт ли сейчас какой-то диалог, поэтому обработчик общий, не внутри
// сцены. Подтягивает услугу/мастера старой записи и сразу открывает выбор дня
bot.action(/^resched:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const bookingId = Number(ctx.match[1]);
  const res = await fetch(`${API_BASE}/bookings?client_telegram_id=${ctx.from.id}`);
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
    await ctx.reply("Эту запись уже нельзя перенести — она прошла или отменена.");
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
      [{ text: "Да, отменить", callback_data: `cancelbk_yes:${id}` }],
      [{ text: "Нет, оставить", callback_data: `cancelbk_no:${id}` }],
    ],
  });
});

bot.action(/^cancelbk_yes:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const res = await fetch(`${API_BASE}/bookings/${id}?client_telegram_id=${ctx.from.id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    await ctx.reply(`Не получилось отменить: ${data.error ?? "неизвестная ошибка"}`);
    return;
  }
  await ctx.editMessageText("❌ Запись отменена.");
});

bot.action(/^cancelbk_no:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await ctx.editMessageReplyMarkup({ inline_keyboard: bookingActionButtons(id) });
});

bot.command("masters", async (ctx) => {
  const { rows: masters } = await db.query<{ name: string }>("SELECT name FROM masters");
  if (masters.length === 0) {
    ctx.reply("Мастеров пока нет.");
    return;
  }
  const list = masters.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
  ctx.reply(`Наши мастера:\n${list}`);
});

bot.command("services", async (ctx) => {
  const { rows: services } = await db.query<{ name: string; duration_minutes: number; price: number }>(
    "SELECT name, duration_minutes, price FROM services"
  );
  if (services.length === 0) {
    ctx.reply("Услуг пока нет.");
    return;
  }
  const list = services
    .map((s, i) => `${i + 1}. ${s.name} — ${s.duration_minutes} мин, ${s.price} ₽`)
    .join("\n");
  ctx.reply(`Наши услуги:\n${list}`);
});
