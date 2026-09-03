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

// Проверка по графику "N дней работает — N дней выходной", который крутится
// по кругу от даты начала (schedule_anchor). Если график не задан — мастер
// работает всегда (обратная совместимость с мастерами без графика)
function isWorkDay(
  dateStr: string,
  master: { schedule_anchor: string | null; work_days: number | null; off_days: number | null }
): boolean {
  if (!master.schedule_anchor || !master.work_days || !master.off_days) return true;
  const anchor = new Date(`${master.schedule_anchor}T00:00:00`);
  const date = new Date(`${dateStr}T00:00:00`);
  const diffDays = Math.round((date.getTime() - anchor.getTime()) / 86400000);
  const cycle = master.work_days + master.off_days;
  const position = ((diffDays % cycle) + cycle) % cycle;
  return position < master.work_days;
}

async function requireAdmin(telegramId: number): Promise<boolean> {
  const role = await getRole(telegramId);
  return role.role === "admin";
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
    "SELECT id, name, bio, experience_years, photo_url, schedule_anchor, work_days, off_days FROM masters"
  );
  const { rows: relations } = await db.query("SELECT master_id, service_id FROM master_services");

  const result = masters.map((m) => ({
    ...m,
    service_ids: relations.filter((r) => r.master_id === m.id).map((r) => r.service_id),
  }));

  res.json(result);
});

api.get("/services", async (_req, res) => {
  const { rows } = await db.query(
    "SELECT id, name, duration_minutes, price, requires_allergy_check FROM services"
  );
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

  const { rows: masterRows } = await db.query(
    "SELECT id, name, schedule_anchor, work_days, off_days FROM masters WHERE id = $1",
    [master_id]
  );
  const master = masterRows[0] as
    | { id: number; name: string; schedule_anchor: string | null; work_days: number | null; off_days: number | null }
    | undefined;
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

  if (!isWorkDay(starts_at.slice(0, 10), master)) {
    res.status(400).json({ error: "У мастера выходной в этот день" });
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
            s.name AS service_name, s.duration_minutes,
            m.schedule_anchor, m.work_days, m.off_days
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
        schedule_anchor: string | null;
        work_days: number | null;
        off_days: number | null;
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

  if (!isWorkDay(starts_at.slice(0, 10), booking)) {
    res.status(400).json({ error: "У мастера выходной в этот день" });
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

// Расписание на дату: записи клиентов + заблокированное время. Админ видит
// всех мастеров сразу; мастер — только себя (не должен видеть чужие записи)
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
  const onlyMasterId = role.role === "master" ? role.master_id : null;

  const { rows: bookings } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name,
            s.name AS service_name, s.duration_minutes, b.client_name, b.status,
            b.client_telegram_id
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at::date = $1::date
       AND ($2::int IS NULL OR b.master_id = $2)
     ORDER BY b.starts_at ASC`,
    [date, onlyMasterId]
  );

  const { rows: blocks } = await db.query(
    `SELECT bs.id, bs.starts_at, bs.ends_at, bs.master_id, m.name AS master_name, bs.note
     FROM blocked_slots bs
     JOIN masters m ON m.id = bs.master_id
     WHERE bs.starts_at::date = $1::date
       AND ($2::int IS NULL OR bs.master_id = $2)
     ORDER BY bs.starts_at ASC`,
    [date, onlyMasterId]
  );

  res.json({
    bookings: bookings.map((r) => ({ ...r, starts_at: toIso(r.starts_at) })),
    blocked_slots: blocks.map((r) => ({ ...r, starts_at: toIso(r.starts_at), ends_at: toIso(r.ends_at) })),
  });
});

interface BookingStatusBody {
  telegram_id: number;
  status: "upcoming" | "completed" | "no_show";
}

api.patch("/staff/bookings/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, status } = req.body as Partial<BookingStatusBody>;
  if (!id || !telegram_id || !status) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!["upcoming", "completed", "no_show"].includes(status)) {
    res.status(400).json({ error: "Некорректный статус" });
    return;
  }

  const role = await getRole(telegram_id);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query("SELECT master_id FROM bookings WHERE id = $1", [id]);
  const booking = rows[0] as { master_id: number } | undefined;
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }
  if (role.role === "master" && role.master_id !== booking.master_id) {
    res.status(403).json({ error: "Можно менять статус только своих записей" });
    return;
  }

  await db.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);
  // При status = 'completed' — сюда позже подключим начисление бонусов на карту лояльности

  res.json({ ok: true });
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

// ===== Управление мастерами, услугами и персоналом (только админ) =====

interface MasterBody {
  telegram_id: number;
  name: string;
  bio?: string;
  experience_years?: number;
  photo_url?: string;
  access_telegram_id?: number | null;
}

// Выдать/поменять/убрать доступ мастера к панели персонала — используется
// сразу при создании мастера и при редактировании (полностью заменяет
// существующую привязку в staff, если она была)
async function setMasterAccess(masterId: number, accessTelegramId: number | null | undefined): Promise<string | null> {
  if (accessTelegramId === undefined) return null;
  await db.query("DELETE FROM staff WHERE master_id = $1", [masterId]);
  if (!accessTelegramId) return null;
  try {
    await db.query(`INSERT INTO staff (telegram_id, role, master_id) VALUES ($1, 'master', $2)`, [
      accessTelegramId,
      masterId,
    ]);
    return null;
  } catch {
    return "Мастер сохранён, но этот Telegram ID уже занят другим сотрудником — доступ не выдан";
  }
}

api.post("/masters", async (req, res) => {
  const { telegram_id, name, bio, experience_years, photo_url, access_telegram_id } =
    req.body as Partial<MasterBody>;
  if (!telegram_id || !name) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO masters (name, bio, experience_years, photo_url) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, bio ?? null, experience_years ?? null, photo_url ?? null]
  );
  const master = rows[0];
  const warning = await setMasterAccess(master.id, access_telegram_id);

  res.status(201).json(warning ? { ...master, warning } : master);
});

api.patch("/masters/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, name, bio, experience_years, photo_url, access_telegram_id } =
    req.body as Partial<MasterBody>;
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `UPDATE masters SET
       name = COALESCE($1, name),
       bio = COALESCE($2, bio),
       experience_years = COALESCE($3, experience_years),
       photo_url = COALESCE($4, photo_url)
     WHERE id = $5 RETURNING *`,
    [name ?? null, bio ?? null, experience_years ?? null, photo_url ?? null, id]
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Мастер не найден" });
    return;
  }
  const warning = await setMasterAccess(id, access_telegram_id);

  res.json(warning ? { ...rows[0], warning } : rows[0]);
});

api.delete("/masters/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!id || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  try {
    const { rowCount } = await db.query("DELETE FROM masters WHERE id = $1", [id]);
    if (!rowCount) {
      res.status(404).json({ error: "Мастер не найден" });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "Нельзя удалить: у мастера есть записи, услуги или доступ в системе" });
  }
});

interface ServiceBody {
  telegram_id: number;
  name: string;
  duration_minutes: number;
  price: number;
  requires_allergy_check?: boolean;
}

api.post("/services", async (req, res) => {
  const { telegram_id, name, duration_minutes, price, requires_allergy_check } =
    req.body as Partial<ServiceBody>;
  if (!telegram_id || !name || !duration_minutes || price === undefined) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO services (name, duration_minutes, price, requires_allergy_check) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, duration_minutes, price, requires_allergy_check ?? false]
  );
  res.status(201).json(rows[0]);
});

api.patch("/services/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, name, duration_minutes, price, requires_allergy_check } =
    req.body as Partial<ServiceBody>;
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `UPDATE services SET
       name = COALESCE($1, name),
       duration_minutes = COALESCE($2, duration_minutes),
       price = COALESCE($3, price),
       requires_allergy_check = COALESCE($4, requires_allergy_check)
     WHERE id = $5 RETURNING *`,
    [name ?? null, duration_minutes ?? null, price ?? null, requires_allergy_check ?? null, id]
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Услуга не найдена" });
    return;
  }
  res.json(rows[0]);
});

api.delete("/services/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!id || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  try {
    const { rowCount } = await db.query("DELETE FROM services WHERE id = $1", [id]);
    if (!rowCount) {
      res.status(404).json({ error: "Услуга не найдена" });
      return;
    }
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "Нельзя удалить: услуга используется в записях" });
  }
});

interface MasterServicesBody {
  telegram_id: number;
  service_ids: number[];
}

// Полностью заменяет список услуг мастера на переданный
api.put("/masters/:id/services", async (req, res) => {
  const masterId = Number(req.params.id);
  const { telegram_id, service_ids } = req.body as Partial<MasterServicesBody>;
  if (!masterId || !telegram_id || !Array.isArray(service_ids)) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  await db.query("DELETE FROM master_services WHERE master_id = $1", [masterId]);
  for (const serviceId of service_ids) {
    await db.query("INSERT INTO master_services (master_id, service_id) VALUES ($1, $2)", [masterId, serviceId]);
  }
  res.json({ ok: true });
});

interface ServiceMastersBody {
  telegram_id: number;
  master_ids: number[];
}

// Полностью заменяет список мастеров, которые делают эту услугу, на переданный
api.put("/services/:id/masters", async (req, res) => {
  const serviceId = Number(req.params.id);
  const { telegram_id, master_ids } = req.body as Partial<ServiceMastersBody>;
  if (!serviceId || !telegram_id || !Array.isArray(master_ids)) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  await db.query("DELETE FROM master_services WHERE service_id = $1", [serviceId]);
  for (const masterId of master_ids) {
    await db.query("INSERT INTO master_services (master_id, service_id) VALUES ($1, $2)", [masterId, serviceId]);
  }
  res.json({ ok: true });
});

// Список клиентов, собранный из истории записей: имя (последнее известное),
// сколько раз записывался, когда был в последний раз, сколько потратил
// (только за выполненные визиты). Только для администратора
api.get("/staff/clients", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает telegram_id" });
    return;
  }
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.client_telegram_id,
            (array_agg(b.client_name ORDER BY b.created_at DESC))[1] AS name,
            COUNT(*)::int AS visits,
            MAX(b.starts_at) AS last_visit,
            COALESCE(SUM(CASE WHEN b.status = 'completed' THEN s.price ELSE 0 END), 0)::int AS total_spent
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     GROUP BY b.client_telegram_id
     ORDER BY MAX(b.starts_at) DESC`
  );

  res.json(rows.map((r) => ({ ...r, last_visit: toIso(r.last_visit) })));
});

// История записей одного клиента — карточка при открытии из списка
api.get("/staff/clients/:clientTelegramId", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  const clientTelegramId = Number(req.params.clientTelegramId);
  if (!telegramId || !clientTelegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at, b.status, s.name AS service_name, s.price, m.name AS master_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN masters m ON m.id = b.master_id
     WHERE b.client_telegram_id = $1
     ORDER BY b.starts_at DESC`,
    [clientTelegramId]
  );

  res.json(rows.map((r) => ({ ...r, starts_at: toIso(r.starts_at) })));
});

// Заметка о клиенте (аллергии/особенности) — одна на клиента. Читает и пишет
// и сам клиент (перед записью на услугу с риском), и мастер (после визита)
api.get("/client-notes/:clientTelegramId", async (req, res) => {
  const clientTelegramId = Number(req.params.clientTelegramId);
  if (!clientTelegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const { rows } = await db.query("SELECT note, updated_at FROM client_notes WHERE client_telegram_id = $1", [
    clientTelegramId,
  ]);
  const row = rows[0] as { note: string; updated_at: string } | undefined;
  res.json(row ? { note: row.note, updated_at: toIso(row.updated_at) } : { note: null, updated_at: null });
});

interface ClientNoteBody {
  note: string;
}

api.put("/client-notes/:clientTelegramId", async (req, res) => {
  const clientTelegramId = Number(req.params.clientTelegramId);
  const { note } = req.body as Partial<ClientNoteBody>;
  if (!clientTelegramId || !note) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO client_notes (client_telegram_id, note, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (client_telegram_id) DO UPDATE SET note = $2, updated_at = now()
     RETURNING note, updated_at`,
    [clientTelegramId, note]
  );
  res.json({ note: rows[0].note, updated_at: toIso(rows[0].updated_at) });
});

api.get("/staff", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает telegram_id" });
    return;
  }
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT s.id, s.telegram_id, s.role, s.master_id, m.name AS master_name
     FROM staff s
     LEFT JOIN masters m ON m.id = s.master_id
     ORDER BY s.id ASC`
  );
  res.json(rows);
});

interface AddStaffBody {
  telegram_id: number;
  target_telegram_id: number;
  role: "master" | "admin";
  master_id?: number;
}

api.post("/staff", async (req, res) => {
  const { telegram_id, target_telegram_id, role, master_id } = req.body as Partial<AddStaffBody>;
  if (!telegram_id || !target_telegram_id || !role) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }
  if (role === "master" && !master_id) {
    res.status(400).json({ error: "Для роли «мастер» нужно выбрать мастера" });
    return;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO staff (telegram_id, role, master_id) VALUES ($1, $2, $3) RETURNING *`,
      [target_telegram_id, role, role === "master" ? master_id : null]
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(409).json({ error: "Этот Telegram ID уже добавлен в персонал" });
  }
});

api.delete("/staff/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!id || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  await db.query("DELETE FROM staff WHERE id = $1", [id]);
  res.json({ ok: true });
});
