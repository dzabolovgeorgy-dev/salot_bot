import { Router } from "express";
import { db } from "./db.js";
import { bot } from "./bot.js";

export const api = Router();

function formatRuDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Уведомления в чат клиенту — если не получилось отправить (бот заблокирован,
// тестовый client_telegram_id и т.п.), это не должно ломать сам запрос
function notifyClient(clientTelegramId: number, text: string) {
  bot.telegram.sendMessage(clientTelegramId, text).catch((err) => {
    console.warn("Не удалось отправить уведомление клиенту:", err instanceof Error ? err.message : err);
  });
}

api.get("/masters", (_req, res) => {
  const masters = db
    .prepare("SELECT id, name, bio, experience_years, photo_url FROM masters")
    .all() as { id: number }[];
  const relations = db
    .prepare("SELECT master_id, service_id FROM master_services")
    .all() as { master_id: number; service_id: number }[];

  const result = masters.map((m) => ({
    ...m,
    service_ids: relations.filter((r) => r.master_id === m.id).map((r) => r.service_id),
  }));

  res.json(result);
});

api.get("/services", (_req, res) => {
  const services = db
    .prepare("SELECT id, name, duration_minutes, price FROM services")
    .all();
  res.json(services);
});

// Занятые интервалы времени у мастера на конкретную дату — чтобы фронтенд
// мог не показывать клиенту уже занятые слоты
api.get("/masters/:id/bookings", (req, res) => {
  const masterId = Number(req.params.id);
  const date = String(req.query.date ?? "");
  if (!masterId || !date) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const bookings = db
    .prepare(
      `SELECT b.starts_at, s.duration_minutes
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       WHERE b.master_id = ?
         AND date(b.starts_at) = ?`
    )
    .all(masterId, date);

  res.json(bookings);
});

api.get("/bookings", (req, res) => {
  const clientTelegramId = Number(req.query.client_telegram_id);
  if (!clientTelegramId) {
    res.status(400).json({ error: "Не хватает client_telegram_id" });
    return;
  }

  const bookings = db
    .prepare(
      `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name,
              b.service_id, s.name AS service_name, s.duration_minutes, s.price
       FROM bookings b
       JOIN masters m ON m.id = b.master_id
       JOIN services s ON s.id = b.service_id
       WHERE b.client_telegram_id = ?
         AND datetime(b.starts_at) >= datetime('now')
       ORDER BY datetime(b.starts_at) ASC`
    )
    .all(clientTelegramId);

  res.json(bookings);
});

api.delete("/bookings/:id", (req, res) => {
  const id = Number(req.params.id);
  const clientTelegramId = Number(req.query.client_telegram_id);
  if (!id || !clientTelegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const booking = db
    .prepare(
      `SELECT b.id, b.starts_at, m.name AS master_name, s.name AS service_name
       FROM bookings b
       JOIN masters m ON m.id = b.master_id
       JOIN services s ON s.id = b.service_id
       WHERE b.id = ? AND b.client_telegram_id = ?`
    )
    .get(id, clientTelegramId) as
    | { id: number; starts_at: string; master_name: string; service_name: string }
    | undefined;
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }

  db.prepare("DELETE FROM bookings WHERE id = ?").run(id);

  notifyClient(
    clientTelegramId,
    `❌ Запись отменена\n\n${booking.service_name} — ${booking.master_name}\n${formatRuDateTime(booking.starts_at)}`
  );

  res.json({ ok: true });
});

interface CreateBookingBody {
  client_telegram_id: number;
  master_id: number;
  service_id: number;
  starts_at: string;
}

api.post("/bookings", (req, res) => {
  const { client_telegram_id, master_id, service_id, starts_at } =
    req.body as Partial<CreateBookingBody>;

  if (!client_telegram_id || !master_id || !service_id || !starts_at) {
    res.status(400).json({ error: "Не хватает полей запроса" });
    return;
  }

  const master = db.prepare("SELECT id, name FROM masters WHERE id = ?").get(master_id) as
    | { id: number; name: string }
    | undefined;
  if (!master) {
    res.status(400).json({ error: "Мастер не найден" });
    return;
  }

  const service = db
    .prepare("SELECT id, name, duration_minutes, price FROM services WHERE id = ?")
    .get(service_id) as { id: number; name: string; duration_minutes: number; price: number } | undefined;
  if (!service) {
    res.status(400).json({ error: "Услуга не найдена" });
    return;
  }

  const isPast = db
    .prepare("SELECT datetime(@startsAt) < datetime('now') AS value")
    .get({ startsAt: starts_at }) as { value: number };
  if (isPast.value) {
    res.status(400).json({ error: "Нельзя записаться на прошедшее время" });
    return;
  }

  const conflict = db
    .prepare(
      `SELECT b.id FROM bookings b
       JOIN services s ON s.id = b.service_id
       WHERE b.master_id = @masterId
         AND datetime(b.starts_at) < datetime(@startsAt, '+' || @duration || ' minutes')
         AND datetime(@startsAt) < datetime(b.starts_at, '+' || s.duration_minutes || ' minutes')`
    )
    .get({
      masterId: master_id,
      startsAt: starts_at,
      duration: service.duration_minutes,
    });

  if (conflict) {
    res.status(409).json({ error: "Это время уже занято, выберите другое" });
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO bookings (client_telegram_id, master_id, service_id, starts_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(client_telegram_id, master_id, service_id, starts_at);

  const booking = db
    .prepare("SELECT * FROM bookings WHERE id = ?")
    .get(result.lastInsertRowid);

  notifyClient(
    client_telegram_id,
    `✅ Вы записаны!\n\n${service.name}\nМастер: ${master.name}\n${formatRuDateTime(starts_at)}\nЦена: ${service.price} ₽\n\nЖдём вас в салоне!`
  );

  res.status(201).json(booking);
});
