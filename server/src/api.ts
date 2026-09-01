import { Router } from "express";
import { db } from "./db.js";
import { bot } from "./bot.js";

export const api = Router();

// Postgres отдаёт время как "2026-11-02 14:30:00" (пробел, с секундами).
// Приводим к строгому ISO с "T", чтобы new Date(...) одинаково работал везде,
// включая WebKit в Telegram Mini App на iPhone
function toIso(value: string): string {
  return value.replace(" ", "T");
}

function formatRuDateTime(value: string): string {
  return new Date(toIso(value)).toLocaleString("ru-RU", {
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

// Уведомление мастеру — только если у него есть доступ в staff (иначе некому слать)
async function notifyMaster(masterId: number, text: string) {
  const { rows } = await db.query<{ telegram_id: string }>(
    "SELECT telegram_id FROM staff WHERE role = 'master' AND master_id = $1",
    [masterId]
  );
  const masterTelegramId = rows[0]?.telegram_id;
  if (!masterTelegramId) return;
  bot.telegram.sendMessage(masterTelegramId, text).catch((err) => {
    console.warn("Не удалось отправить уведомление мастеру:", err instanceof Error ? err.message : err);
  });
}

// Роль пользователя по Telegram ID: клиент (нет в staff), мастер или админ
async function getRole(
  telegramId: number
): Promise<{ role: "client" } | { role: "master"; master_id: number; master_name: string } | { role: "admin" }> {
  const { rows } = await db.query<{ role: "master" | "admin"; master_id: number | null; master_name: string | null }>(
    `SELECT s.role, s.master_id, m.name AS master_name
     FROM staff s
     LEFT JOIN masters m ON m.id = s.master_id
     WHERE s.telegram_id = $1`,
    [telegramId]
  );
  const row = rows[0];
  if (!row) return { role: "client" };
  if (row.role === "master") {
    return { role: "master", master_id: row.master_id!, master_name: row.master_name! };
  }
  return { role: "admin" };
}

// Проверка, что у мастера нет другой записи или заблокированного времени,
// пересекающегося по времени. excludeBookingId — чтобы при переносе запись
// не конфликтовала сама с собой
async function hasConflict(
  masterId: number,
  startsAt: string,
  durationMinutes: number,
  excludeBookingId?: number
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT b.id FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.master_id = $1
       AND ($4::int IS NULL OR b.id != $4)
       AND b.starts_at < ($2::timestamp + ($3 * interval '1 minute'))
       AND $2::timestamp < (b.starts_at + (s.duration_minutes * interval '1 minute'))
     UNION ALL
     SELECT bs.id FROM blocked_slots bs
     WHERE bs.master_id = $1
       AND bs.starts_at < ($2::timestamp + ($3 * interval '1 minute'))
       AND $2::timestamp < bs.ends_at`,
    [masterId, startsAt, durationMinutes, excludeBookingId ?? null]
  );
  return rows.length > 0;
}

api.get("/masters", async (_req, res) => {
  const { rows: masters } = await db.query(
    "SELECT id, name, bio, experience_years, photo_url FROM masters"
  );
  const { rows: relations } = await db.query("SELECT master_id, service_id FROM master_services");

  const result = masters.map((m) => ({
    ...m,
    service_ids: relations.filter((r) => r.master_id === m.id).map((r) => r.service_id),
  }));

  res.json(result);
});

api.get("/services", async (_req, res) => {
  const { rows } = await db.query("SELECT id, name, duration_minutes, price FROM services");
  res.json(rows);
});

// Занятые интервалы времени у мастера на конкретную дату — чтобы фронтенд
// мог не показывать клиенту уже занятые слоты
api.get("/masters/:id/bookings", async (req, res) => {
  const masterId = Number(req.params.id);
  const date = String(req.query.date ?? "");
  const excludeId = req.query.exclude_booking_id ? Number(req.query.exclude_booking_id) : null;
  if (!masterId || !date) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.starts_at, s.duration_minutes
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.master_id = $1
       AND b.starts_at::date = $2::date
       AND ($3::int IS NULL OR b.id != $3)
     UNION ALL
     SELECT bs.starts_at, EXTRACT(EPOCH FROM (bs.ends_at - bs.starts_at))::int / 60 AS duration_minutes
     FROM blocked_slots bs
     WHERE bs.master_id = $1
       AND bs.starts_at::date = $2::date`,
    [masterId, date, excludeId]
  );

  res.json(rows.map((r) => ({ ...r, starts_at: toIso(r.starts_at) })));
});

api.get("/bookings", async (req, res) => {
  const clientTelegramId = Number(req.query.client_telegram_id);
  if (!clientTelegramId) {
    res.status(400).json({ error: "Не хватает client_telegram_id" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name,
            b.service_id, s.name AS service_name, s.duration_minutes, s.price
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.client_telegram_id = $1
       AND b.starts_at >= now()
     ORDER BY b.starts_at ASC`,
    [clientTelegramId]
  );

  res.json(rows.map((r) => ({ ...r, starts_at: toIso(r.starts_at) })));
});

api.delete("/bookings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const clientTelegramId = Number(req.query.client_telegram_id);
  if (!id || !clientTelegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name, s.name AS service_name
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.id = $1 AND b.client_telegram_id = $2`,
    [id, clientTelegramId]
  );
  const booking = rows[0] as
    | { id: number; starts_at: string; master_id: number; master_name: string; service_name: string }
    | undefined;
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }

  await db.query("DELETE FROM bookings WHERE id = $1", [id]);

  notifyClient(
    clientTelegramId,
    `❌ Запись отменена\n\n${booking.service_name} — ${booking.master_name}\n${formatRuDateTime(booking.starts_at)}`
  );
  notifyMaster(
    booking.master_id,
    `❌ Запись отменена клиентом\n\n${booking.service_name}\n${formatRuDateTime(booking.starts_at)}`
  );

  res.json({ ok: true });
});

interface CreateBookingBody {
  client_telegram_id: number;
  master_id: number;
  service_id: number;
  starts_at: string;
  client_name?: string;
}

api.post("/bookings", async (req, res) => {
  const { client_telegram_id, master_id, service_id, starts_at, client_name } =
    req.body as Partial<CreateBookingBody>;

  if (!client_telegram_id || !master_id || !service_id || !starts_at) {
    res.status(400).json({ error: "Не хватает полей запроса" });
    return;
  }

  const { rows: masterRows } = await db.query("SELECT id, name FROM masters WHERE id = $1", [master_id]);
  const master = masterRows[0] as { id: number; name: string } | undefined;
  if (!master) {
    res.status(400).json({ error: "Мастер не найден" });
    return;
  }

  const { rows: serviceRows } = await db.query(
    "SELECT id, name, duration_minutes, price FROM services WHERE id = $1",
    [service_id]
  );
  const service = serviceRows[0] as
    | { id: number; name: string; duration_minutes: number; price: number }
    | undefined;
  if (!service) {
    res.status(400).json({ error: "Услуга не найдена" });
    return;
  }

  const { rows: pastRows } = await db.query("SELECT ($1::timestamp < now()) AS value", [starts_at]);
  if (pastRows[0].value) {
    res.status(400).json({ error: "Нельзя записаться на прошедшее время" });
    return;
  }

  if (await hasConflict(master_id, starts_at, service.duration_minutes)) {
    res.status(409).json({ error: "Это время уже занято, выберите другое" });
    return;
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO bookings (client_telegram_id, master_id, service_id, starts_at, client_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [client_telegram_id, master_id, service_id, starts_at, client_name ?? null]
  );

  notifyClient(
    client_telegram_id,
    `✅ Вы записаны!\n\n${service.name}\nМастер: ${master.name}\n${formatRuDateTime(starts_at)}\nЦена: ${service.price} ₽\n\nЖдём вас в салоне!`
  );
  notifyMaster(master_id, `📅 Новая запись\n\n${service.name}\n${formatRuDateTime(starts_at)}`);

  res.status(201).json({ ...inserted[0], starts_at: toIso(inserted[0].starts_at) });
});

interface RescheduleBody {
  client_telegram_id: number;
  starts_at: string;
}

api.patch("/bookings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { client_telegram_id, starts_at } = req.body as Partial<RescheduleBody>;

  if (!id || !client_telegram_id || !starts_at) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at AS old_starts_at, b.master_id, m.name AS master_name,
            s.name AS service_name, s.duration_minutes
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.id = $1 AND b.client_telegram_id = $2`,
    [id, client_telegram_id]
  );
  const booking = rows[0] as
    | {
        id: number;
        old_starts_at: string;
        master_id: number;
        master_name: string;
        service_name: string;
        duration_minutes: number;
      }
    | undefined;

  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }

  const { rows: pastRows } = await db.query("SELECT ($1::timestamp < now()) AS value", [starts_at]);
  if (pastRows[0].value) {
    res.status(400).json({ error: "Нельзя перенести на прошедшее время" });
    return;
  }

  if (await hasConflict(booking.master_id, starts_at, booking.duration_minutes, booking.id)) {
    res.status(409).json({ error: "Это время уже занято, выберите другое" });
    return;
  }

  await db.query("UPDATE bookings SET starts_at = $1 WHERE id = $2", [starts_at, id]);

  notifyClient(
    client_telegram_id,
    `🔄 Запись перенесена\n\n${booking.service_name} — ${booking.master_name}\nБыло: ${formatRuDateTime(booking.old_starts_at)}\nСтало: ${formatRuDateTime(starts_at)}`
  );
  notifyMaster(
    booking.master_id,
    `🔄 Запись перенесена\n\n${booking.service_name}\nБыло: ${formatRuDateTime(booking.old_starts_at)}\nСтало: ${formatRuDateTime(starts_at)}`
  );

  const { rows: updated } = await db.query("SELECT * FROM bookings WHERE id = $1", [id]);
  res.json({ ...updated[0], starts_at: toIso(updated[0].starts_at) });
});

// ===== Эндпоинты для персонала (мастера и администраторы) =====

api.get("/me", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает telegram_id" });
    return;
  }
  res.json(await getRole(telegramId));
});

// Расписание всех мастеров на дату: записи клиентов + заблокированное время.
// Доступно только персоналу
api.get("/staff/schedule", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  const date = String(req.query.date ?? "");
  if (!telegramId || !date) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const role = await getRole(telegramId);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows: bookings } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name,
            s.name AS service_name, s.duration_minutes, b.client_name
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at::date = $1::date
     ORDER BY b.starts_at ASC`,
    [date]
  );

  const { rows: blocks } = await db.query(
    `SELECT bs.id, bs.starts_at, bs.ends_at, bs.master_id, m.name AS master_name, bs.note
     FROM blocked_slots bs
     JOIN masters m ON m.id = bs.master_id
     WHERE bs.starts_at::date = $1::date
     ORDER BY bs.starts_at ASC`,
    [date]
  );

  res.json({
    bookings: bookings.map((r) => ({ ...r, starts_at: toIso(r.starts_at) })),
    blocked_slots: blocks.map((r) => ({ ...r, starts_at: toIso(r.starts_at), ends_at: toIso(r.ends_at) })),
  });
});

interface BlockedSlotBody {
  telegram_id: number;
  master_id: number;
  starts_at: string;
  ends_at: string;
  note?: string;
}

api.post("/staff/blocked-slots", async (req, res) => {
  const { telegram_id, master_id, starts_at, ends_at, note } = req.body as Partial<BlockedSlotBody>;
  if (!telegram_id || !master_id || !starts_at || !ends_at) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const role = await getRole(telegram_id);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }
  if (role.role === "master" && role.master_id !== master_id) {
    res.status(403).json({ error: "Можно блокировать только своё время" });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO blocked_slots (master_id, starts_at, ends_at, note) VALUES ($1, $2, $3, $4) RETURNING *`,
    [master_id, starts_at, ends_at, note ?? null]
  );

  res.status(201).json({ ...rows[0], starts_at: toIso(rows[0].starts_at), ends_at: toIso(rows[0].ends_at) });
});

api.delete("/staff/blocked-slots/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!id || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const role = await getRole(telegramId);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query("SELECT master_id FROM blocked_slots WHERE id = $1", [id]);
  const block = rows[0] as { master_id: number } | undefined;
  if (!block) {
    res.status(404).json({ error: "Не найдено" });
    return;
  }
  if (role.role === "master" && role.master_id !== block.master_id) {
    res.status(403).json({ error: "Можно снимать только свою блокировку" });
    return;
  }

  await db.query("DELETE FROM blocked_slots WHERE id = $1", [id]);
  res.json({ ok: true });
});
