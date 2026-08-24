import { Telegraf, Markup } from "telegraf";
import { db } from "./db.js";

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

export const bot = new Telegraf(token);

bot.start((ctx) => {
  const webAppUrl = getWebAppUrl();
  if (webAppUrl) {
    ctx.reply(
      "Привет! Я помогу записаться в салон красоты.",
      Markup.inlineKeyboard([Markup.button.webApp("Записаться", webAppUrl)])
    );
  } else {
    ctx.reply("Привет! Я помогу записаться в салон красоты.");
  }
});

bot.command("masters", (ctx) => {
  const masters = db.prepare("SELECT name FROM masters").all() as { name: string }[];
  if (masters.length === 0) {
    ctx.reply("Мастеров пока нет.");
    return;
  }
  const list = masters.map((m, i) => `${i + 1}. ${m.name}`).join("\n");
  ctx.reply(`Наши мастера:\n${list}`);
});

bot.command("services", (ctx) => {
  const services = db
    .prepare("SELECT name, duration_minutes, price FROM services")
    .all() as { name: string; duration_minutes: number; price: number }[];
  if (services.length === 0) {
    ctx.reply("Услуг пока нет.");
    return;
  }
  const list = services
    .map((s, i) => `${i + 1}. ${s.name} — ${s.duration_minutes} мин, ${s.price} ₽`)
    .join("\n");
  ctx.reply(`Наши услуги:\n${list}`);
});
