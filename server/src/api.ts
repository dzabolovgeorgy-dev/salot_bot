import { Router } from "express";
import { db } from "./db.js";

export const api = Router();

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
    .prepare("SELECT id FROM bookings WHERE id = ? AND client_telegram_id = ?")
    .get(id, clientTelegramId);
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }

  db.prepare("DELETE FROM bookings WHERE id = ?").run(id);
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

  const master = db.prepare("SELECT id FROM masters WHERE id = ?").get(master_id);
  if (!master) {
    res.status(400).json({ error: "Мастер не найден" });
    return;
  }

  const service = db
    .prepare("SELECT id, duration_minutes FROM services WHERE id = ?")
    .get(service_id) as { id: number; duration_minutes: number } | undefined;
  if (!service) {
    res.status(400).json({ error: "Услуга не найдена" });
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

  res.status(201).json(booking);
});
