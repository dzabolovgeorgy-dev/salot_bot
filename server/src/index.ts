import "dotenv/config";
import express from "express";
import type { ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { initDb } from "./db.js";
import { initStorage } from "./storage.js";
import { bot, setupMenuButton } from "./bot.js";
import { api } from "./api.js";
import { attachTelegramIdentity } from "./telegramAuthMiddleware.js";
import { startReminderScheduler } from "./reminders.js";
import { normalizeLang, type Lang } from "./i18n.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      lang: Lang;
    }
  }
}

// Сервер на Render по умолчанию работает по UTC, а салон — по своему местному
// времени. Даты/время клиента и мастера везде считаются в браузере (там уже
// местное время), но диалог записи в Telegram-чате (bookingScene.ts) считает
// "сегодня"/"сейчас" прямо на сервере — без этой строки он бы называл "сегодня"
// и "прошедшее время" не по часам салона, а по UTC (расхождение — как раз
// разница часовых поясов). Если салон в другом часовом поясе — поменять здесь
process.env.TZ = "Europe/Moscow";

// Большинство обработчиков в api.ts не ловят свои ошибки — если запрос к базе
// неожиданно упадёт (сетевой сбой и т.п.), Node по умолчанию завершает весь
// процесс из-за необработанного отклонённого промиса. Ловим это здесь, чтобы
// падал только один запрос, а не весь сервер
process.on("unhandledRejection", (reason) => {
  console.error("Необработанная ошибка в запросе (сервер продолжает работать):", reason);
});

await initDb();
await initStorage();

const app = express();
// За Render мы сидим за его прокси-сервером — эта строка нужна, чтобы Express
// правильно определял IP-адрес настоящего посетителя (полезно для логов и
// возможных ограничений в будущем)
app.set("trust proxy", 1);
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, PUT");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data, X-Staff-Session, X-Lang");
  next();
});

// Язык, на котором клиент хочет получить ответ (тексты ошибок, названия услуг).
// Приложение и бот присылают его заголовком X-Lang; нет заголовка или язык
// неизвестен — русский. Панель персонала заголовок не шлёт и остаётся русской
app.use((req, _res, next) => {
  req.lang = normalizeLang(req.header("X-Lang"));
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", attachTelegramIdentity, api);

// Раньше ошибка загрузки слишком большого файла (multer) просто обрывала
// соединение без ответа — на телефоне это выглядело как загадочное
// "Load failed". Теперь в ответ приходит понятное сообщение
const handleApiErrors: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "Файл слишком большой — максимум 20 МБ" });
    return;
  }
  console.error("Необработанная ошибка запроса:", err);
  res.status(500).json({ error: "Что-то пошло не так на сервере, попробуйте ещё раз" });
};
app.use("/api", handleApiErrors);

// PWA-версия для мастеров/админов (вход по коду, не через Telegram) — этот же
// сервер отдаёт ещё и сам сайт, собранный отдельно (npm run build:pwa в
// webapp/). Специально на том же адресе, что и API: cookie с сессией входа
// иначе не запоминается на iPhone (Safari блокирует её между разными
// адресами) — см. server/src/pwaAuth.ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PWA_DIST_DIR = path.join(__dirname, "..", "..", "webapp", "dist-pwa");

app.use(express.static(PWA_DIST_DIR));
app.get(/^(?!\/api).*/, (_req, res) => {
  const indexPath = path.join(PWA_DIST_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(404).send("PWA не собрана — выполните build:pwa в webapp/");
    return;
  }
  res.sendFile(indexPath);
});

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
startReminderScheduler();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
