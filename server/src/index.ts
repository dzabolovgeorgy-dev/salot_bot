import "dotenv/config";
import express from "express";
import "./db.js";
import { bot } from "./bot.js";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});

bot.launch();
console.log("Бот запущен");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
