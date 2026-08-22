import { Telegraf } from "telegraf";

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error("BOT_TOKEN не задан в .env");
}

export const bot = new Telegraf(token);

bot.start((ctx) => {
  ctx.reply("Привет! Я помогу записаться в салон красоты.");
});
