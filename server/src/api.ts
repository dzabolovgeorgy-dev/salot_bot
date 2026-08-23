import { Router } from "express";
import { db } from "./db.js";

export const api = Router();

api.get("/masters", (_req, res) => {
  const masters = db.prepare("SELECT id, name FROM masters").all();
  res.json(masters);
});

api.get("/services", (_req, res) => {
  const services = db
    .prepare("SELECT id, name, duration_minutes, price FROM services")
    .all();
  res.json(services);
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
