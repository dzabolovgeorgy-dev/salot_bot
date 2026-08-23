import "dotenv/config";
import express from "express";
import "./db.js";
import { bot } from "./bot.js";
import { api } from "./api.js";

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
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

bot.launch();
console.log("Бот запущен");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
