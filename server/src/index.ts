import "dotenv/config";
import express from "express";
import { initDb } from "./db.js";
import { bot, setupMenuButton } from "./bot.js";
import { api } from "./api.js";

// Большинство обработчиков в api.ts не ловят свои ошибки — если запрос к базе
// неожиданно упадёт (сетевой сбой и т.п.), Node по умолчанию завершает весь
// процесс из-за необработанного отклонённого промиса. Ловим это здесь, чтобы
// падал только один запрос, а не весь сервер
process.on("unhandledRejection", (reason) => {
  console.error("Необработанная ошибка в запросе (сервер продолжает работать):", reason);
});

await initDb();

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, PUT");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", api);

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

// При деплое старая копия бота ещё пару секунд не отключена, и Telegram
// отвечает ошибкой 409 (getUpdates conflict) — пробуем ещё раз, пока она не освободится
async function startBot(attemptsLeft = 8) {
  try {
    await bot.launch();
    console.log("Бот запущен");
  } catch (err) {
    if (attemptsLeft <= 0) {
      console.error("Не удалось запустить бота:", err);
      return;
    }
    console.warn(`Бот не смог запуститься (осталось попыток: ${attemptsLeft}), повтор через 3с`);
    setTimeout(() => startBot(attemptsLeft - 1), 3000);
  }
}

startBot();
setupMenuButton();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
