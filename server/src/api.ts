import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { db } from "./db.js";
import { bot } from "./bot.js";
import { appendBookingRow, addClientSpend, syncClientExtraField, syncInventoryItem } from "./sheets.js";
import { uploadPhoto, deletePhoto, pathFromPublicUrl } from "./storage.js";
import { isWorkDay } from "./schedule.js";
import { bookingActionButtons, ratingButtons, masterBookingActionButtons } from "./bookingScene.js";
import { getRole, requireAdmin } from "./roles.js";
import { toIso, formatRuDateTime } from "./format.js";
import { accrueForCompletedVisit, getLoyaltyStatus, maxRedeemable, commitRedeem, getLoyaltyHistory } from "./loyalty.js";
import {
  assignAccessCode,
  findStaffByAccessCode,
  createPwaSession,
  deletePwaSession,
  PWA_SESSION_HEADER,
} from "./pwaAuth.js";

// Фото храним в памяти (не на диске сервера) и сразу заливаем в Supabase
// Storage. Современные телефоны (особенно iPhone) снимают фото по 10-15 МБ
// в высоком качестве — 8 МБ оказалось мало и обрывало загрузку без понятной
// ошибки (см. обработчик ниже)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function extFromMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

export const api = Router();

// Для записей без Telegram (звонок/WhatsApp) телефон — единственный ID
// клиента. Приводим к цифрам, чтобы "+7 999 123-45-67" и "79991234567"
// считались одним и тем же клиентом и совпадали со ссылкой wa.me
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

// Заметка об аллергии и комментарий админа на момент создания записи —
// чтобы сразу были видны в журнале записей в Google Таблице, а не только
// в «Клиентах». Если у клиента их ещё нет — вернёт пустые значения
async function getClientExtraFields(
  clientTelegramId: number | null,
  clientPhone: string | null
): Promise<{ note: string | null; adminComment: string | null }> {
  const { rows } = await db.query(
    clientTelegramId
      ? "SELECT note, admin_comment FROM client_notes WHERE client_telegram_id = $1"
      : "SELECT note, admin_comment FROM client_notes WHERE client_phone = $1",
    [clientTelegramId ?? clientPhone]
  );
  return { note: rows[0]?.note ?? null, adminComment: rows[0]?.admin_comment ?? null };
}

// Для уведомления мастеру о новой записи — способ связаться с клиентом.
// @username кликабелен прямо в сообщении Telegram (открывает диалог), без
// username — просто ID для ручного поиска; для записи без Telegram — телефон
function clientContactLine(telegramId?: number | null, username?: string | null, phone?: string | null): string {
  if (telegramId) return username ? `@${username}` : `Telegram ID: ${telegramId}`;
  if (phone) return phone;
  return "не указан";
}

// Уведомления в чат клиенту — если не получилось отправить (бот заблокирован,
// тестовый client_telegram_id и т.п.), это не должно ломать сам запрос.
// bookingId — если указан, под сообщением появляются кнопки "Перенести"/"Отменить"
// (их нажатия обрабатывает bot.ts — телефон клиента не открывает Mini App)
function notifyClient(clientTelegramId: number, text: string, bookingId?: number) {
  bot.telegram
    .sendMessage(clientTelegramId, text, bookingId ? { reply_markup: { inline_keyboard: bookingActionButtons(bookingId) } } : undefined)
    .catch((err) => {
      console.warn("Не удалось отправить уведомление клиенту:", err instanceof Error ? err.message : err);
    });
}

// Уведомление мастеру — только если у него есть доступ в staff (иначе некому слать).
// bookingId — если передан, под сообщением появляются кнопки "Выполнена"/"Не пришёл"
// (см. masterBookingActionButtons) — так же, как у клиента появляются свои кнопки
async function notifyMaster(masterId: number, text: string, bookingId?: number) {
  const { rows } = await db.query<{ telegram_id: string }>(
    "SELECT telegram_id FROM staff WHERE role = 'master' AND master_id = $1",
    [masterId]
  );
  const masterTelegramId = rows[0]?.telegram_id;
  if (!masterTelegramId) return;
  bot.telegram
    .sendMessage(
      masterTelegramId,
      text,
      bookingId ? { reply_markup: { inline_keyboard: masterBookingActionButtons(bookingId) } } : undefined
    )
    .catch((err) => {
      console.warn("Не удалось отправить уведомление мастеру:", err instanceof Error ? err.message : err);
    });
}

// Уведомление всем админам сразу (админов может быть несколько)
async function notifyAdmins(text: string) {
  const { rows } = await db.query<{ telegram_id: string }>("SELECT telegram_id FROM staff WHERE role = 'admin'");
  rows.forEach((r) => {
    bot.telegram.sendMessage(r.telegram_id, text).catch((err) => {
      console.warn("Не удалось отправить уведомление админу:", err instanceof Error ? err.message : err);
    });
  });
}

// Проверка подписи Telegram (см. server/src/telegramAuthMiddleware.ts): убеждаемся,
// что claimedId — это реально тот Telegram-аккаунт, который сейчас обращается к
// серверу, а не произвольный ID, вписанный в запрос вручную (например, из
// консоли браузера). internalTrusted — запрос от самого сервера (диалог в чате),
// там личность уже подтвердил Telegram, доставив сообщение боту
function isVerifiedTelegramId(req: Request, claimedId: number): boolean {
  if (req.internalTrusted) return true;
  // Number(...) — на случай, если claimedId пришёл строкой (например, из тела
  // JSON-запроса, куда попало число из BIGINT-столбца Postgres — pg возвращает
  // такие столбцы строкой, а не числом). Без этого сравнение 123 === "123"
  // всегда ложно, и запрос отклоняется, даже если личность на самом деле верна
  return req.verifiedTelegramId != null && req.verifiedTelegramId === Number(claimedId);
}

function rejectIfNotVerified(req: Request, res: Response, claimedId: number): boolean {
  if (isVerifiedTelegramId(req, claimedId)) return false;
  res.status(403).json({ error: "Не удалось подтвердить личность в Telegram" });
  return true;
}

// Для эндпоинтов, доступных и клиенту (о себе), и персоналу (о любом клиенте) —
// заметки о клиенте, где в самом запросе нет отдельного поля "кто спрашивает"
async function canAccessClientNotes(req: Request, clientTelegramId: number): Promise<boolean> {
  if (isVerifiedTelegramId(req, clientTelegramId)) return true;
  if (req.verifiedTelegramId == null) return false;
  const role = await getRole(req.verifiedTelegramId);
  return role.role !== "client";
}

// Заметки клиента без Telegram (записан по телефону) — доступны только
// персоналу, самого клиента здесь по определению нет
async function isVerifiedStaff(req: Request): Promise<boolean> {
  if (req.internalTrusted) return true;
  if (req.verifiedTelegramId == null) return false;
  const role = await getRole(req.verifiedTelegramId);
  return role.role !== "client";
}

// Проверка, что у мастера нет другой записи или заблокированного времени,
// пересекающегося по времени — с учётом перерыва между записями (у каждого
// мастера свой, masters.buffer_minutes): соседние записи должны быть разнесены
// минимум на этот перерыв, впритык друг к другу нельзя.
// excludeBookingId — чтобы при переносе запись не конфликтовала сама с собой
async function hasConflict(
  masterId: number,
  startsAt: string,
  durationMinutes: number,
  bufferMinutes: number,
  excludeBookingId?: number
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT b.id FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.master_id = $1
       AND ($4::int IS NULL OR b.id != $4)
       AND (b.starts_at - ($5 * interval '1 minute')) < ($2::timestamp + ($3 * interval '1 minute'))
       AND $2::timestamp < (b.starts_at + (s.duration_minutes * interval '1 minute') + ($5 * interval '1 minute'))
     UNION ALL
     SELECT bs.id FROM blocked_slots bs
     WHERE bs.master_id = $1
       AND (bs.starts_at - ($5 * interval '1 minute')) < ($2::timestamp + ($3 * interval '1 minute'))
       AND $2::timestamp < (bs.ends_at + ($5 * interval '1 minute'))`,
    [masterId, startsAt, durationMinutes, excludeBookingId ?? null, bufferMinutes]
  );
  return rows.length > 0;
}

api.get("/masters", async (_req, res) => {
  const { rows: masters } = await db.query(
    `SELECT m.id, m.name, m.bio, m.experience_years, m.photo_url, m.schedule_type, m.schedule_anchor,
            m.work_days, m.off_days, m.work_weekdays, m.schedule_month, m.schedule_month_off_days,
            m.buffer_minutes, m.work_start_time, m.work_end_time,
            r.avg_rating, COALESCE(r.ratings_count, 0)::int AS ratings_count
     FROM masters m
     LEFT JOIN (
       SELECT master_id, ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*) AS ratings_count
       FROM master_ratings GROUP BY master_id
     ) r ON r.master_id = m.id`
  );
  const { rows: relations } = await db.query("SELECT master_id, service_id FROM master_services");

  const result = masters.map((m) => ({
    ...m,
    avg_rating: m.avg_rating != null ? Number(m.avg_rating) : null,
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

// "Вдохновение" — общая галерея примеров для клиента, доступна без входа,
// как и /masters, /services. master_name/master_photo_url подтягиваем сразу
// джойном, чтобы на карточке показать автора без отдельного запроса на фото
api.get("/inspiration-photos", async (_req, res) => {
  const { rows } = await db.query(
    `SELECT ip.id, ip.image_url, ip.category, ip.tags, ip.master_id, ip.click_count, ip.created_at,
            m.name AS master_name, m.photo_url AS master_photo_url
     FROM inspiration_photos ip
     LEFT JOIN masters m ON m.id = ip.master_id
     ORDER BY ip.created_at DESC`
  );
  res.json(rows.map((r) => ({ ...r, created_at: toIso(r.created_at) })));
});

// Клиент нажал "Записаться на такое" под фото — считаем клики, чтобы мастер
// потом видел в своей статистике, какие примеры чаще всего приводят к записи
api.post("/inspiration-photos/:id/click", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Не хватает id" });
    return;
  }
  await db.query("UPDATE inspiration_photos SET click_count = click_count + 1 WHERE id = $1", [id]);
  res.json({ ok: true });
});

// Фото из "Вдохновения", сохранённые клиентом (раздел "Сохранённое" в профиле)
api.get("/saved-photos/:client_telegram_id", async (req, res) => {
  const clientTelegramId = Number(req.params.client_telegram_id);
  if (!clientTelegramId) {
    res.status(400).json({ error: "Не хватает client_telegram_id" });
    return;
  }
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  const { rows } = await db.query(
    `SELECT sp.photo_id, sp.saved_at, ip.image_url, ip.category, ip.tags, ip.master_id,
            m.name AS master_name, m.photo_url AS master_photo_url
     FROM saved_photos sp
     JOIN inspiration_photos ip ON ip.id = sp.photo_id
     LEFT JOIN masters m ON m.id = ip.master_id
     WHERE sp.client_telegram_id = $1
     ORDER BY sp.saved_at DESC`,
    [clientTelegramId]
  );
  res.json(rows.map((r) => ({ ...r, saved_at: toIso(r.saved_at) })));
});

api.post("/saved-photos", async (req, res) => {
  const clientTelegramId = Number(req.body.client_telegram_id);
  const photoId = Number(req.body.photo_id);
  if (!clientTelegramId || !photoId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  await db.query(
    `INSERT INTO saved_photos (client_telegram_id, photo_id) VALUES ($1, $2)
     ON CONFLICT (client_telegram_id, photo_id) DO NOTHING`,
    [clientTelegramId, photoId]
  );
  res.status(201).json({ ok: true });
});

api.delete("/saved-photos/:client_telegram_id/:photo_id", async (req, res) => {
  const clientTelegramId = Number(req.params.client_telegram_id);
  const photoId = Number(req.params.photo_id);
  if (!clientTelegramId || !photoId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  await db.query("DELETE FROM saved_photos WHERE client_telegram_id = $1 AND photo_id = $2", [
    clientTelegramId,
    photoId,
  ]);
  res.json({ ok: true });
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
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name,
            b.service_id, s.name AS service_name, s.duration_minutes, s.price
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.client_telegram_id = $1
       AND b.starts_at >= now()
       AND b.status = 'upcoming'
     ORDER BY b.starts_at ASC`,
    [clientTelegramId]
  );

  res.json(rows.map((r) => ({ ...r, starts_at: toIso(r.starts_at) })));
});

api.get("/loyalty/:client_telegram_id", async (req, res) => {
  const clientTelegramId = Number(req.params.client_telegram_id);
  if (!clientTelegramId) {
    res.status(400).json({ error: "Не хватает client_telegram_id" });
    return;
  }
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  const status = await getLoyaltyStatus(clientTelegramId);
  const servicePrice = Number(req.query.service_price);
  res.json({
    points_balance: status.pointsBalance,
    total_spent: status.totalSpent,
    tier_name: status.tierName,
    cashback_rate: status.cashbackRate,
    next_tier_name: status.nextTierName,
    amount_to_next_tier: status.amountToNextTier,
    max_redeemable: servicePrice ? maxRedeemable(status.pointsBalance, servicePrice) : null,
  });
});

api.get("/loyalty/:client_telegram_id/history", async (req, res) => {
  const clientTelegramId = Number(req.params.client_telegram_id);
  if (!clientTelegramId) {
    res.status(400).json({ error: "Не хватает client_telegram_id" });
    return;
  }
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  const rows = await getLoyaltyHistory(clientTelegramId, 10);
  res.json(rows.map((r) => ({ ...r, created_at: toIso(r.created_at) })));
});

api.delete("/bookings/:id", async (req, res) => {
  const id = Number(req.params.id);
  const clientTelegramId = Number(req.query.client_telegram_id);
  if (!id || !clientTelegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, clientTelegramId)) return;

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name, s.name AS service_name
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     WHERE b.id = $1 AND b.client_telegram_id = $2 AND b.status = 'upcoming'`,
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
  client_username?: string;
  redeem_points?: number;
  reference_photo_id?: number;
}

api.post("/bookings", async (req, res) => {
  const {
    client_telegram_id,
    master_id,
    service_id,
    starts_at,
    client_name,
    client_username,
    redeem_points,
    reference_photo_id,
  } = req.body as Partial<CreateBookingBody>;

  if (!client_telegram_id || !master_id || !service_id || !starts_at) {
    res.status(400).json({ error: "Не хватает полей запроса" });
    return;
  }
  if (rejectIfNotVerified(req, res, client_telegram_id)) return;

  const { rows: masterRows } = await db.query(
    "SELECT id, name, schedule_type, schedule_anchor, work_days, off_days, work_weekdays, schedule_month, schedule_month_off_days, buffer_minutes FROM masters WHERE id = $1",
    [master_id]
  );
  const master = masterRows[0] as
    | {
        id: number;
        name: string;
        schedule_type: "cycle" | "weekdays" | "month" | null;
        schedule_anchor: string | null;
        work_days: number | null;
        off_days: number | null;
        work_weekdays: number[] | null;
        schedule_month: string | null;
        schedule_month_off_days: number[] | null;
        buffer_minutes: number;
      }
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

  const pointsToRedeem = redeem_points ?? 0;
  if (pointsToRedeem) {
    if (!Number.isInteger(pointsToRedeem) || pointsToRedeem < 0) {
      res.status(400).json({ error: "Некорректное количество баллов" });
      return;
    }
    const status = await getLoyaltyStatus(client_telegram_id);
    const allowed = maxRedeemable(status.pointsBalance, service.price);
    if (pointsToRedeem > allowed) {
      res.status(400).json({ error: `Баллами можно оплатить не больше ${allowed} (30% от суммы и доступный баланс)` });
      return;
    }
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

  if (await hasConflict(master_id, starts_at, service.duration_minutes, master.buffer_minutes)) {
    res.status(409).json({ error: "Это время уже занято, выберите другое" });
    return;
  }

  // Фото-референс из "Вдохновения" — необязательное, проверяем, что оно
  // реально существует, а не просто молча падаем на нарушении внешнего ключа
  let referencePhotoId: number | null = null;
  if (reference_photo_id) {
    const { rows: photoRows } = await db.query("SELECT id FROM inspiration_photos WHERE id = $1", [
      reference_photo_id,
    ]);
    if (photoRows[0]) referencePhotoId = reference_photo_id;
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO bookings (client_telegram_id, master_id, service_id, starts_at, client_name, client_username, reference_photo_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [client_telegram_id, master_id, service_id, starts_at, client_name ?? null, client_username ?? null, referencePhotoId]
  );

  // Проверка лимита уже прошла выше — тут только сам факт списания.
  // Если баланс параллельно изменился и списать не вышло, запись всё равно
  // остаётся в силе — просто без скидки баллами
  const redeemedOk = pointsToRedeem ? await commitRedeem(client_telegram_id, pointsToRedeem) : false;

  notifyClient(
    client_telegram_id,
    `✅ Вы записаны!\n\n${service.name}\nМастер: ${master.name}\n${formatRuDateTime(starts_at)}\nЦена: ${service.price} €${redeemedOk ? `\nСписано баллов: ${pointsToRedeem}` : ""}\n\nЖдём вас в салоне!`,
    inserted[0].id
  );

  // Заметка об аллергии (если есть) — сразу в уведомлении мастеру, чтобы не
  // искать её отдельно в «Клиентах» перед визитом
  const { note, adminComment } = await getClientExtraFields(client_telegram_id, null);
  notifyMaster(
    master_id,
    `📅 Новая запись\n\nКлиент: ${client_name ?? "Клиент"} (${clientContactLine(client_telegram_id, client_username)})\n${service.name}\n${formatRuDateTime(starts_at)}${note ? `\n⚠️ Аллергия/особенности: ${note}` : ""}`,
    inserted[0].id
  );

  appendBookingRow({
    clientName: client_name ?? "Клиент",
    contact: client_username ? `@${client_username}` : `Telegram ID: ${client_telegram_id}`,
    clientKey: String(client_telegram_id),
    serviceName: service.name,
    masterName: master.name,
    startsAtIso: starts_at,
    price: service.price,
    allergyNote: note,
    adminComment,
  });

  res.status(201).json({ ...inserted[0], starts_at: toIso(inserted[0].starts_at) });
});

interface AdminCreateBookingBody {
  telegram_id: number;
  master_id: number;
  service_id: number;
  starts_at: string;
  client_name: string;
  client_telegram_id?: number;
  client_phone?: string;
}

// Админ создаёт запись вручную — клиент позвонил или написал в WhatsApp,
// а не открывал Mini App. Нужен либо Telegram ID клиента (если он известен),
// либо телефон — но не оба сразу, чтобы не путать одного и того же клиента
// с разными карточками в «Клиенты»
api.post("/staff/bookings", async (req, res) => {
  const { telegram_id, service_id, starts_at, client_name, client_telegram_id, client_phone } =
    req.body as Partial<AdminCreateBookingBody>;
  let { master_id } = req.body as Partial<AdminCreateBookingBody>;

  if (!telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }
  // Мастер может записать клиента только к себе — id мастера берётся из его
  // роли, а не из тела запроса, иначе он мог бы записать «к себе» на самом деле к другому мастеру
  if (role.role === "master") {
    master_id = role.master_id;
  }

  if (!master_id || !service_id || !starts_at || !client_name?.trim()) {
    res.status(400).json({ error: "Не хватает полей запроса" });
    return;
  }
  if (!client_telegram_id && !client_phone?.trim()) {
    res.status(400).json({ error: "Укажите Telegram ID или телефон клиента" });
    return;
  }
  if (client_telegram_id && client_phone?.trim()) {
    res.status(400).json({ error: "Укажите либо Telegram ID, либо телефон — не оба" });
    return;
  }

  const { rows: masterRows } = await db.query(
    "SELECT id, name, schedule_type, schedule_anchor, work_days, off_days, work_weekdays, schedule_month, schedule_month_off_days, buffer_minutes FROM masters WHERE id = $1",
    [master_id]
  );
  const master = masterRows[0] as
    | {
        id: number;
        name: string;
        schedule_type: "cycle" | "weekdays" | "month" | null;
        schedule_anchor: string | null;
        work_days: number | null;
        off_days: number | null;
        work_weekdays: number[] | null;
        schedule_month: string | null;
        schedule_month_off_days: number[] | null;
        buffer_minutes: number;
      }
    | undefined;
  if (!master) {
    res.status(400).json({ error: "Мастер не найден" });
    return;
  }

  const { rows: serviceRows } = await db.query(
    "SELECT id, name, duration_minutes, price FROM services WHERE id = $1",
    [service_id]
  );
  const service = serviceRows[0] as { id: number; name: string; duration_minutes: number; price: number } | undefined;
  if (!service) {
    res.status(400).json({ error: "Услуга не найдена" });
    return;
  }

  if (!isWorkDay(starts_at.slice(0, 10), master)) {
    res.status(400).json({ error: "У мастера выходной в этот день" });
    return;
  }

  if (await hasConflict(master_id, starts_at, service.duration_minutes, master.buffer_minutes)) {
    res.status(409).json({ error: "Это время уже занято, выберите другое" });
    return;
  }

  const normalizedPhone = client_phone?.trim() ? normalizePhone(client_phone) : null;

  const { rows: inserted } = await db.query(
    `INSERT INTO bookings (client_telegram_id, master_id, service_id, starts_at, client_name, client_phone)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [client_telegram_id ?? null, master_id, service_id, starts_at, client_name.trim(), normalizedPhone]
  );

  if (client_telegram_id) {
    notifyClient(
      client_telegram_id,
      `✅ Вы записаны!\n\n${service.name}\nМастер: ${master.name}\n${formatRuDateTime(starts_at)}\n\nЖдём вас в салоне!`,
      inserted[0].id
    );
  }
  const { note, adminComment } = await getClientExtraFields(client_telegram_id ?? null, normalizedPhone);

  // Если мастер завёл запись сам себе — он и так видит подтверждение в приложении,
  // уведомление в Telegram нужно только когда запись создал кто-то другой (клиент или админ)
  if (role.role !== "master") {
    notifyMaster(
      master_id,
      `📅 Новая запись\n\nКлиент: ${client_name.trim()} (${clientContactLine(client_telegram_id, null, normalizedPhone)})\n${service.name}\n${formatRuDateTime(starts_at)}${note ? `\n⚠️ Аллергия/особенности: ${note}` : ""}`,
      inserted[0].id
    );
  }

  appendBookingRow({
    clientName: client_name.trim(),
    contact: client_telegram_id ? `Telegram ID: ${client_telegram_id}` : (normalizedPhone ?? "-"),
    clientKey: client_telegram_id ? String(client_telegram_id) : (normalizedPhone ?? ""),
    serviceName: service.name,
    masterName: master.name,
    startsAtIso: starts_at,
    price: service.price,
    allergyNote: note,
    adminComment,
  });

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
  if (rejectIfNotVerified(req, res, client_telegram_id)) return;

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at AS old_starts_at, b.master_id, m.name AS master_name,
            s.name AS service_name, s.duration_minutes,
            m.schedule_type, m.schedule_anchor, m.work_days, m.off_days, m.work_weekdays,
            m.schedule_month, m.schedule_month_off_days, m.buffer_minutes
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
        schedule_type: "cycle" | "weekdays" | "month" | null;
        schedule_anchor: string | null;
        work_days: number | null;
        off_days: number | null;
        work_weekdays: number[] | null;
        schedule_month: string | null;
        schedule_month_off_days: number[] | null;
        buffer_minutes: number;
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

  if (await hasConflict(booking.master_id, starts_at, booking.duration_minutes, booking.buffer_minutes, booking.id)) {
    res.status(409).json({ error: "Это время уже занято, выберите другое" });
    return;
  }

  // Сбрасываем отметки об отправленных напоминаниях — время другое, значит и
  // напоминания должны прийти заново, ближе к новому времени
  await db.query(
    "UPDATE bookings SET starts_at = $1, reminder_24h_sent = false, reminder_2h_sent = false WHERE id = $2",
    [starts_at, id]
  );

  notifyClient(
    client_telegram_id,
    `🔄 Запись перенесена\n\n${booking.service_name} — ${booking.master_name}\nБыло: ${formatRuDateTime(booking.old_starts_at)}\nСтало: ${formatRuDateTime(starts_at)}`,
    id
  );
  notifyMaster(
    booking.master_id,
    `🔄 Запись перенесена\n\n${booking.service_name}\nБыло: ${formatRuDateTime(booking.old_starts_at)}\nСтало: ${formatRuDateTime(starts_at)}`
  );

  const { rows: updated } = await db.query("SELECT * FROM bookings WHERE id = $1", [id]);
  res.json({ ...updated[0], starts_at: toIso(updated[0].starts_at) });
});

interface LateBody {
  client_telegram_id: number;
  minutes: number;
}

// Клиент предупреждает, что опаздывает — просто уведомляет мастера, саму
// запись не трогает (мастер сам решает, ждать или нет)
api.post("/bookings/:id/late", async (req, res) => {
  const id = Number(req.params.id);
  const { client_telegram_id, minutes } = req.body as Partial<LateBody>;
  if (!id || !client_telegram_id || !minutes) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, client_telegram_id)) return;

  const { rows } = await db.query(
    `SELECT b.master_id, b.starts_at, s.name AS service_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.id = $1 AND b.client_telegram_id = $2 AND b.status = 'upcoming'`,
    [id, client_telegram_id]
  );
  const booking = rows[0] as { master_id: number; starts_at: string; service_name: string } | undefined;
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }

  notifyMaster(
    booking.master_id,
    `⏳ Клиент опаздывает на ${minutes} мин.\n\n${booking.service_name}\n${formatRuDateTime(booking.starts_at)}`
  );

  res.json({ ok: true });
});

interface RatingBody {
  client_telegram_id: number;
  rating: number;
  comment?: string;
}

// booking_id UNIQUE в master_ratings — ON CONFLICT просто обновляет ту же
// строку, поэтому этот же эндпоинт годится и для первой оценки звёздами,
// и для добавления комментария к ней позже
api.post("/bookings/:id/rating", async (req, res) => {
  const id = Number(req.params.id);
  const { client_telegram_id, rating, comment } = req.body as Partial<RatingBody>;
  if (!id || !client_telegram_id || !rating) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: "Оценка должна быть от 1 до 5" });
    return;
  }
  if (rejectIfNotVerified(req, res, client_telegram_id)) return;

  const { rows } = await db.query(
    `SELECT master_id FROM bookings WHERE id = $1 AND client_telegram_id = $2 AND status = 'completed'`,
    [id, client_telegram_id]
  );
  const booking = rows[0] as { master_id: number } | undefined;
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }

  await db.query(
    `INSERT INTO master_ratings (booking_id, master_id, client_telegram_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (booking_id) DO UPDATE SET rating = $4, comment = COALESCE($5, master_ratings.comment)`,
    [id, booking.master_id, client_telegram_id, rating, comment?.trim() || null]
  );

  res.json({ ok: true });
});

// ===== Эндпоинты для персонала (мастера и администраторы) =====

api.get("/me", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает telegram_id" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;
  res.json(await getRole(telegramId));
});

// Код для входа в PWA-версию — показывается самому сотруднику в его же
// разделе "Ещё"/"Профиль", поэтому claimedId здесь — это он сам
api.get("/staff/access-code", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает telegram_id" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;

  const { rows } = await db.query<{ access_code: string | null }>(
    "SELECT access_code FROM staff WHERE telegram_id = $1",
    [telegramId]
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Сотрудник не найден" });
    return;
  }
  res.json({ access_code: rows[0].access_code });
});

// Вход в PWA-версию по короткому коду — без Telegram. Специально не проверяет
// verifiedTelegramId (его тут и не может быть): именно этот код и заменяет
// подтверждение личности
api.post("/pwa/login", async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code || !code.trim()) {
    res.status(400).json({ error: "Введите код" });
    return;
  }

  const staff = await findStaffByAccessCode(code);
  if (!staff) {
    res.status(404).json({ error: "Код не найден, проверьте правильность" });
    return;
  }

  // Токен возвращаем в теле ответа — сохранить его должен сам клиент
  // (в localStorage, см. webapp/src/staffSession.ts) и присылать дальше
  // заголовком X-Staff-Session. httpOnly cookie раньше не запоминалась на
  // iPhone в установленном на экран приложении между запусками
  const { token } = await createPwaSession(staff.telegram_id);
  res.json({ ...(await getRole(staff.telegram_id)), telegram_id: staff.telegram_id, session_token: token });
});

// Проверка сессии при открытии PWA — attachTelegramIdentity уже разобрал
// заголовок X-Staff-Session и, если сессия валидна, положил telegram_id
// в req.verifiedTelegramId
api.get("/pwa/session", async (req, res) => {
  if (req.verifiedTelegramId == null) {
    res.status(401).json({ error: "Нет активной сессии" });
    return;
  }
  res.json({ ...(await getRole(req.verifiedTelegramId)), telegram_id: req.verifiedTelegramId });
});

api.post("/pwa/logout", async (req, res) => {
  const token = req.header(PWA_SESSION_HEADER);
  if (token) await deletePwaSession(token);
  res.json({ ok: true });
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
  if (rejectIfNotVerified(req, res, telegramId)) return;

  const role = await getRole(telegramId);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }
  const onlyMasterId = role.role === "master" ? role.master_id : null;

  const { rows: bookings } = await db.query(
    `SELECT b.id, b.starts_at, b.master_id, m.name AS master_name,
            s.name AS service_name, s.duration_minutes, b.client_name, b.status,
            b.client_telegram_id, b.client_username, b.client_phone,
            cn.note AS client_note,
            b.reference_photo_id, ip.image_url AS reference_photo_url
     FROM bookings b
     JOIN masters m ON m.id = b.master_id
     JOIN services s ON s.id = b.service_id
     LEFT JOIN client_notes cn ON cn.client_telegram_id = b.client_telegram_id
       OR (b.client_telegram_id IS NULL AND cn.client_phone = b.client_phone)
     LEFT JOIN inspiration_photos ip ON ip.id = b.reference_photo_id
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

api.get("/staff/my-stats", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;

  const role = await getRole(telegramId);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }

  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(s.price) FILTER (WHERE b.status = 'completed'), 0)::int AS income,
       COUNT(*) AS bookings_count,
       COUNT(DISTINCT COALESCE(b.client_telegram_id::text, b.client_phone)) AS clients_count
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.master_id = $1
       AND b.starts_at >= date_trunc('month', now())
       AND b.starts_at < date_trunc('month', now()) + interval '1 month'`,
    [role.master_id]
  );

  const row = rows[0];
  res.json({
    income: row.income,
    bookings_count: Number(row.bookings_count),
    clients_count: Number(row.clients_count),
  });
});

// Профиль мастера — сколько раз под каждым его фото в клиентском разделе
// "Вдохновение" нажали "Записаться на такое" (click_count)
api.get("/staff/inspiration-stats", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;

  const role = await getRole(telegramId);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }

  const { rows } = await db.query(
    `SELECT id, image_url, category, tags, click_count
     FROM inspiration_photos
     WHERE master_id = $1
     ORDER BY click_count DESC, created_at DESC`,
    [role.master_id]
  );
  res.json(rows);
});

// Главная у админа — похоже на my-stats у мастера (только за сегодня, а не за
// месяц) и по всему салону (без фильтра по master_id)
api.get("/staff/salon-stats", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;

  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(s.price) FILTER (WHERE b.status = 'completed'), 0)::int AS income,
       COUNT(*) AS bookings_count,
       COUNT(DISTINCT COALESCE(b.client_telegram_id::text, b.client_phone)) AS clients_count
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.starts_at >= date_trunc('day', now())
       AND b.starts_at < date_trunc('day', now()) + interval '1 day'`
  );

  const row = rows[0];
  res.json({
    income: row.income,
    bookings_count: Number(row.bookings_count),
    clients_count: Number(row.clients_count),
  });
});

interface BookingStatusBody {
  telegram_id: number;
  status: "upcoming" | "completed" | "no_show";
}

// Автосписание расходников при завершении услуги — состав (что и сколько
// уходит на одно выполнение) настраивается в карточке услуги и хранится в
// service_inventory_items. Остаток может уйти в минус: это не должно мешать
// мастеру отметить визит выполненным, а минус в остатке — честный сигнал,
// что материала реально не хватает, а не повод блокировать работу
async function writeOffServiceMaterials(serviceId: number, bookingId: number, serviceName: string): Promise<void> {
  const { rows: recipe } = await db.query(
    "SELECT item_id, quantity_per_use FROM service_inventory_items WHERE service_id = $1",
    [serviceId]
  );
  for (const { item_id, quantity_per_use } of recipe) {
    const { rows: updated } = await db.query(
      "UPDATE inventory_items SET quantity = quantity - $1, updated_at = now() WHERE id = $2 RETURNING *",
      [quantity_per_use, item_id]
    );
    await db.query("INSERT INTO inventory_transactions (item_id, change_amount, reason) VALUES ($1, $2, $3)", [
      item_id,
      -quantity_per_use,
      `Автосписание: ${serviceName}, запись #${bookingId}`,
    ]);
    if (updated[0]) {
      syncInventoryItem({
        name: updated[0].name,
        quantity: updated[0].quantity,
        unit: updated[0].unit,
        minThreshold: updated[0].min_threshold,
      });
    }
  }
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;

  const role = await getRole(telegram_id);
  if (role.role === "client") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.master_id, b.service_id, b.client_telegram_id, b.client_phone, s.price, s.name AS service_name, m.name AS master_name
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN masters m ON m.id = b.master_id
     WHERE b.id = $1`,
    [id]
  );
  const booking = rows[0] as
    | {
        master_id: number;
        service_id: number;
        client_telegram_id: string | null;
        client_phone: string | null;
        price: number;
        service_name: string;
        master_name: string;
      }
    | undefined;
  if (!booking) {
    res.status(404).json({ error: "Запись не найдена" });
    return;
  }
  if (role.role === "master" && role.master_id !== booking.master_id) {
    res.status(403).json({ error: "Можно менять статус только своих записей" });
    return;
  }

  await db.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);

  if (status === "completed") {
    try {
      await writeOffServiceMaterials(booking.service_id, id, booking.service_name);
    } catch (err) {
      console.warn("Не удалось списать материалы услуги:", err instanceof Error ? err.message : err);
    }

    const clientKey = booking.client_telegram_id ?? booking.client_phone;
    if (clientKey) addClientSpend(clientKey, booking.price);
    // Кэшбэк начисляем только клиентам с Telegram ID — у записей без него
    // (клиент без Telegram, добавлен вручную по телефону) нет аккаунта, куда копить баллы
    if (booking.client_telegram_id) {
      const clientTelegramId = Number(booking.client_telegram_id);
      const { cashback, newBalance } = await accrueForCompletedVisit(clientTelegramId, booking.price, booking.service_name);
      bot.telegram
        .sendMessage(clientTelegramId, `Начислено +${cashback} баллов 🎉\nВаш баланс: ${newBalance}`)
        .catch((err) => {
          console.warn("Не удалось отправить уведомление о начислении баллов:", err instanceof Error ? err.message : err);
        });
      bot.telegram
        .sendMessage(
          clientTelegramId,
          `✅ Услуга завершена\n\n${booking.service_name}\nМастер: ${booking.master_name}\n\nКак вам? Оцените визит:`,
          { reply_markup: { inline_keyboard: ratingButtons(id) } }
        )
        .catch((err) => {
          console.warn("Не удалось отправить запрос оценки клиенту:", err instanceof Error ? err.message : err);
        });
    }
  }

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
  if (rejectIfNotVerified(req, res, telegram_id)) return;

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

  // Если время заблокировал сам мастер — сообщаем об этом админу (например, мастер ушёл на обед)
  if (role.role === "master") {
    const endTime = toIso(ends_at).slice(11, 16);
    notifyAdmins(
      `🚫 У мастера ${role.master_name} заблокировано время\n\n${formatRuDateTime(starts_at)}–${endTime}${note ? `\n${note}` : ""}`
    );
  }

  res.status(201).json({ ...rows[0], starts_at: toIso(rows[0].starts_at), ends_at: toIso(rows[0].ends_at) });
});

api.delete("/staff/blocked-slots/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!id || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;

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

interface MyScheduleBody {
  telegram_id: number;
  schedule_type: "none" | "weekdays" | "month";
  work_weekdays: number[] | null;
  schedule_month: string | null;
  schedule_month_off_days: number[] | null;
  work_start_time: string;
  work_end_time: string;
  buffer_minutes: number;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Готовые варианты перерыва между записями — чтобы мастер выбирал одним тапом,
// а не вводил число вручную
const ALLOWED_BUFFER_MINUTES = [0, 10, 15, 20, 30];

// Мастер сам настраивает свой график и часы работы в течение дня. Раньше это
// можно было поменять только напрямую в базе данных. Два вида графика на
// выбор: фиксированные дни недели (проще для большинства) или отметить
// выходные дни вручную на конкретный месяц (для нерегулярного графика —
// настраивается заново каждый месяц). Старый режим 'cycle' (скользящий
// N-через-N) в интерфейсе больше не выбирается — см. isWorkDay()
api.patch("/staff/my-schedule", async (req, res) => {
  const {
    telegram_id,
    schedule_type,
    work_weekdays,
    schedule_month,
    schedule_month_off_days,
    work_start_time,
    work_end_time,
    buffer_minutes,
  } = req.body as Partial<MyScheduleBody>;
  if (!telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;

  const role = await getRole(telegram_id);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }

  if (!schedule_type || !["none", "weekdays", "month"].includes(schedule_type)) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (schedule_type === "weekdays" && (!work_weekdays || work_weekdays.length === 0)) {
    res.status(400).json({ error: "Отметьте хотя бы один день недели" });
    return;
  }
  if (schedule_type === "month") {
    if (!schedule_month || !MONTH_RE.test(schedule_month)) {
      res.status(400).json({ error: "Не указан месяц" });
      return;
    }
    if (!Array.isArray(schedule_month_off_days) || schedule_month_off_days.some((d) => d < 1 || d > 31)) {
      res.status(400).json({ error: "Некорректные выходные дни" });
      return;
    }
  }

  if (!work_start_time || !work_end_time || !TIME_RE.test(work_start_time) || !TIME_RE.test(work_end_time)) {
    res.status(400).json({ error: "Укажите часы работы в формате ЧЧ:ММ" });
    return;
  }
  if (work_start_time >= work_end_time) {
    res.status(400).json({ error: "Время начала должно быть раньше времени окончания" });
    return;
  }
  if (buffer_minutes === undefined || !ALLOWED_BUFFER_MINUTES.includes(buffer_minutes)) {
    res.status(400).json({ error: "Некорректный перерыв между записями" });
    return;
  }

  const isWeekdays = schedule_type === "weekdays";
  const isMonth = schedule_type === "month";

  const { rows } = await db.query(
    `UPDATE masters SET
       schedule_type = $1, schedule_anchor = NULL, work_days = NULL, off_days = NULL, work_weekdays = $2,
       schedule_month = $3, schedule_month_off_days = $4,
       work_start_time = $5, work_end_time = $6, buffer_minutes = $7
     WHERE id = $8
     RETURNING id, name, schedule_type, schedule_anchor, work_days, off_days, work_weekdays,
               schedule_month, schedule_month_off_days, work_start_time, work_end_time, buffer_minutes`,
    [
      schedule_type === "none" ? null : schedule_type,
      isWeekdays ? work_weekdays : null,
      isMonth ? schedule_month : null,
      isMonth ? schedule_month_off_days : null,
      work_start_time,
      work_end_time,
      buffer_minutes,
      role.master_id,
    ]
  );
  res.json(rows[0]);
});

// ===== Профиль мастера: аватар, описание, фото работ (портфолио) =====

// Описание "о себе" — отдельно от графика, чтобы не грузить лишним один эндпоинт
api.patch("/staff/my-profile", async (req, res) => {
  const { telegram_id, bio } = req.body as { telegram_id?: number; bio?: string };
  if (!telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }
  const { rows } = await db.query(`UPDATE masters SET bio = $1 WHERE id = $2 RETURNING id, bio`, [
    bio ?? null,
    role.master_id,
  ]);
  res.json(rows[0]);
});

api.post("/staff/my-avatar", upload.single("photo"), async (req, res) => {
  const telegram_id = Number(req.body.telegram_id);
  if (!telegram_id || !req.file) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!req.file.mimetype.startsWith("image/")) {
    res.status(400).json({ error: "Файл должен быть изображением" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }

  const { rows: prevRows } = await db.query("SELECT photo_url FROM masters WHERE id = $1", [role.master_id]);
  const prevUrl: string | null = prevRows[0]?.photo_url ?? null;

  const path = `avatars/${role.master_id}-${Date.now()}.${extFromMimeType(req.file.mimetype)}`;
  const url = await uploadPhoto(path, req.file.buffer, req.file.mimetype);

  const { rows } = await db.query(`UPDATE masters SET photo_url = $1 WHERE id = $2 RETURNING id, photo_url`, [
    url,
    role.master_id,
  ]);

  const prevPath = prevUrl ? pathFromPublicUrl(prevUrl) : null;
  if (prevPath) deletePhoto(prevPath).catch(() => {});

  res.json(rows[0]);
});

api.get("/masters/:id/photos", async (req, res) => {
  const masterId = Number(req.params.id);
  const { rows } = await db.query(
    `SELECT p.id, p.url, p.caption,
            COALESCE(array_agg(mpf.folder_id) FILTER (WHERE mpf.folder_id IS NOT NULL), '{}') AS folder_ids
     FROM master_photos p
     LEFT JOIN master_photo_folders mpf ON mpf.photo_id = p.id
     WHERE p.master_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [masterId]
  );
  res.json(rows);
});

// Папки видны и клиенту (выбрать категорию работ перед записью), поэтому
// без проверки личности — как и сам список фото выше
api.get("/masters/:id/photo-folders", async (req, res) => {
  const masterId = Number(req.params.id);
  const { rows } = await db.query("SELECT id, name FROM photo_folders WHERE master_id = $1 ORDER BY created_at ASC", [
    masterId,
  ]);
  res.json(rows);
});

api.post("/staff/photo-folders", async (req, res) => {
  const { telegram_id, name } = req.body as { telegram_id?: number; name?: string };
  if (!telegram_id || !name || !name.trim()) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }

  const { rows } = await db.query("INSERT INTO photo_folders (master_id, name) VALUES ($1, $2) RETURNING id, name", [
    role.master_id,
    name.trim(),
  ]);
  res.status(201).json(rows[0]);
});

api.patch("/staff/photo-folders/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, name } = req.body as { telegram_id?: number; name?: string };
  if (!id || !telegram_id || !name || !name.trim()) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows: existing } = await db.query("SELECT master_id FROM photo_folders WHERE id = $1", [id]);
  const folder = existing[0];
  if (!folder) {
    res.status(404).json({ error: "Папка не найдена" });
    return;
  }
  if (role.role === "master" && folder.master_id !== role.master_id) {
    res.status(403).json({ error: "Это папка другого мастера" });
    return;
  }

  const { rows } = await db.query("UPDATE photo_folders SET name = $1 WHERE id = $2 RETURNING id, name", [
    name.trim(),
    id,
  ]);
  res.json(rows[0]);
});

api.delete("/staff/photo-folders/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegram_id = Number(req.query.telegram_id);
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows: existing } = await db.query("SELECT master_id FROM photo_folders WHERE id = $1", [id]);
  const folder = existing[0];
  if (!folder) {
    res.status(404).json({ error: "Папка не найдена" });
    return;
  }
  if (role.role === "master" && folder.master_id !== role.master_id) {
    res.status(403).json({ error: "Это папка другого мастера" });
    return;
  }

  await db.query("DELETE FROM photo_folders WHERE id = $1", [id]);
  res.json({ ok: true });
});

// Заменяет полный набор папок для фото — проще, чем отдельные add/remove,
// клиент просто присылает итоговый список после того, как отметил галочки
api.put("/staff/portfolio-photos/:id/folders", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, folder_ids } = req.body as { telegram_id?: number; folder_ids?: number[] };
  if (!id || !telegram_id || !Array.isArray(folder_ids)) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows: existingPhoto } = await db.query("SELECT master_id FROM master_photos WHERE id = $1", [id]);
  const photo = existingPhoto[0];
  if (!photo) {
    res.status(404).json({ error: "Фото не найдено" });
    return;
  }
  if (role.role === "master" && photo.master_id !== role.master_id) {
    res.status(403).json({ error: "Это фото другого мастера" });
    return;
  }

  // Только папки этого же мастера — чтобы нельзя было пометить фото чужой папкой
  const { rows: ownFolders } = await db.query("SELECT id FROM photo_folders WHERE master_id = $1", [photo.master_id]);
  const ownFolderIds = new Set(ownFolders.map((f) => f.id));
  const validFolderIds = folder_ids.filter((fid) => ownFolderIds.has(fid));

  await db.query("DELETE FROM master_photo_folders WHERE photo_id = $1", [id]);
  for (const folderId of validFolderIds) {
    await db.query("INSERT INTO master_photo_folders (photo_id, folder_id) VALUES ($1, $2)", [id, folderId]);
  }
  res.json({ id, folder_ids: validFolderIds });
});

// Только оценки с текстом — это и есть "отзывы", которые клиент читает
// перед записью. Без имени/контакта клиента — не показываем чужим личность
// того, кто оставил отзыв
api.get("/masters/:id/ratings", async (req, res) => {
  const masterId = Number(req.params.id);
  const { rows } = await db.query(
    `SELECT id, rating, comment, created_at FROM master_ratings
     WHERE master_id = $1 AND comment IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 50`,
    [masterId]
  );
  res.json(rows.map((r) => ({ ...r, created_at: toIso(r.created_at) })));
});

api.post("/staff/portfolio-photos", upload.single("photo"), async (req, res) => {
  const telegram_id = Number(req.body.telegram_id);
  if (!telegram_id || !req.file) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!req.file.mimetype.startsWith("image/")) {
    res.status(400).json({ error: "Файл должен быть изображением" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master") {
    res.status(403).json({ error: "Доступно только мастеру" });
    return;
  }

  const path = `portfolio/${role.master_id}/${Date.now()}-${Math.round(Math.random() * 1e6)}.${extFromMimeType(
    req.file.mimetype
  )}`;
  const url = await uploadPhoto(path, req.file.buffer, req.file.mimetype);
  const caption = typeof req.body.caption === "string" && req.body.caption.trim() ? req.body.caption.trim() : null;

  const { rows } = await db.query(
    `INSERT INTO master_photos (master_id, url, storage_path, caption) VALUES ($1, $2, $3, $4) RETURNING id, url, caption`,
    [role.master_id, url, path, caption]
  );
  res.status(201).json(rows[0]);
});

// Подпись можно добавить/поменять уже после загрузки — отдельная кнопка
// "Сохранить" под фото в профиле мастера, как и для описания "О себе"
api.patch("/staff/portfolio-photos/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, caption } = req.body as { telegram_id?: number; caption?: string };
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows: existing } = await db.query("SELECT master_id FROM master_photos WHERE id = $1", [id]);
  const photo = existing[0];
  if (!photo) {
    res.status(404).json({ error: "Фото не найдено" });
    return;
  }
  if (role.role === "master" && photo.master_id !== role.master_id) {
    res.status(403).json({ error: "Это фото другого мастера" });
    return;
  }

  const normalizedCaption = typeof caption === "string" && caption.trim() ? caption.trim() : null;
  const { rows } = await db.query(
    "UPDATE master_photos SET caption = $1 WHERE id = $2 RETURNING id, url, caption",
    [normalizedCaption, id]
  );
  res.json(rows[0]);
});

api.delete("/staff/portfolio-photos/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegram_id = Number(req.query.telegram_id);
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query("SELECT master_id, storage_path FROM master_photos WHERE id = $1", [id]);
  const photo = rows[0];
  if (!photo) {
    res.status(404).json({ error: "Фото не найдено" });
    return;
  }
  if (role.role === "master" && photo.master_id !== role.master_id) {
    res.status(403).json({ error: "Это фото другого мастера" });
    return;
  }

  await db.query("DELETE FROM master_photos WHERE id = $1", [id]);
  deletePhoto(photo.storage_path).catch(() => {});
  res.json({ ok: true });
});

// Добавление фото в клиентский раздел "Вдохновение" — мастер добавляет
// только свои (привязка к себе выставляется сама, поменять нельзя),
// администратор может привязать к любому мастеру или оставить без привязки
api.post("/staff/inspiration-photos", upload.single("photo"), async (req, res) => {
  const telegram_id = Number(req.body.telegram_id);
  const category = typeof req.body.category === "string" ? req.body.category.trim() : "";
  if (!telegram_id || !req.file || !category) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!req.file.mimetype.startsWith("image/")) {
    res.status(400).json({ error: "Файл должен быть изображением" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  let masterId: number | null;
  if (role.role === "master") {
    masterId = role.master_id;
  } else {
    const raw = Number(req.body.master_id);
    masterId = raw ? raw : null;
  }

  const tags =
    typeof req.body.tags === "string"
      ? req.body.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : [];

  const path = `inspiration/${Date.now()}-${Math.round(Math.random() * 1e6)}.${extFromMimeType(
    req.file.mimetype
  )}`;
  const url = await uploadPhoto(path, req.file.buffer, req.file.mimetype);

  const { rows: inserted } = await db.query(
    `INSERT INTO inspiration_photos (image_url, category, tags, master_id, storage_path)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [url, category, tags, masterId, path]
  );
  // Сразу подтягиваем имя и фото мастера (join), как это делает публичный
  // GET /inspiration-photos — иначе в списке после загрузки не будет видно,
  // чья это работа, пока страницу не перезагрузят
  const { rows } = await db.query(
    `SELECT ip.id, ip.image_url, ip.category, ip.tags, ip.master_id, ip.click_count, ip.created_at,
            m.name AS master_name, m.photo_url AS master_photo_url
     FROM inspiration_photos ip
     LEFT JOIN masters m ON m.id = ip.master_id
     WHERE ip.id = $1`,
    [inserted[0].id]
  );
  res.status(201).json(rows[0]);
});

api.delete("/staff/inspiration-photos/:id", async (req, res) => {
  const id = Number(req.params.id);
  const telegram_id = Number(req.query.telegram_id);
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  const role = await getRole(telegram_id);
  if (role.role !== "master" && role.role !== "admin") {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query("SELECT master_id, storage_path FROM inspiration_photos WHERE id = $1", [id]);
  const photo = rows[0];
  if (!photo) {
    res.status(404).json({ error: "Фото не найдено" });
    return;
  }
  if (role.role === "master" && photo.master_id !== role.master_id) {
    res.status(403).json({ error: "Это фото другого мастера" });
    return;
  }

  try {
    await db.query("DELETE FROM inspiration_photos WHERE id = $1", [id]);
  } catch {
    res.status(409).json({ error: "Нельзя удалить — это фото прикреплено как референс к чьей-то записи" });
    return;
  }
  if (photo.storage_path) deletePhoto(photo.storage_path).catch(() => {});
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
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO staff (telegram_id, role, master_id) VALUES ($1, 'master', $2) RETURNING id`,
      [accessTelegramId, masterId]
    );
    await assignAccessCode(rows[0].id);
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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
  if (rejectIfNotVerified(req, res, telegramId)) return;
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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
  if (rejectIfNotVerified(req, res, telegramId)) return;
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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

// Состав услуги — какие материалы и сколько списывать при её выполнении
api.get("/services/:id/inventory-items", async (req, res) => {
  const serviceId = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!serviceId || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT sii.item_id, sii.quantity_per_use, ii.name, ii.unit
     FROM service_inventory_items sii
     JOIN inventory_items ii ON ii.id = sii.item_id
     WHERE sii.service_id = $1
     ORDER BY ii.name ASC`,
    [serviceId]
  );
  res.json(rows);
});

interface ServiceInventoryItemsBody {
  telegram_id: number;
  items: { item_id: number; quantity_per_use: number }[];
}

// Полностью заменяет состав услуги на переданный — так же, как /services/:id/masters
api.put("/services/:id/inventory-items", async (req, res) => {
  const serviceId = Number(req.params.id);
  const { telegram_id, items } = req.body as Partial<ServiceInventoryItemsBody>;
  if (!serviceId || !telegram_id || !Array.isArray(items)) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  await db.query("DELETE FROM service_inventory_items WHERE service_id = $1", [serviceId]);
  for (const { item_id, quantity_per_use } of items) {
    if (!item_id || !Number.isInteger(quantity_per_use) || quantity_per_use <= 0) continue;
    await db.query(
      "INSERT INTO service_inventory_items (service_id, item_id, quantity_per_use) VALUES ($1, $2, $3)",
      [serviceId, item_id, quantity_per_use]
    );
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
  if (rejectIfNotVerified(req, res, telegramId)) return;
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.client_telegram_id, b.client_phone,
            (array_agg(b.client_name ORDER BY b.created_at DESC))[1] AS name,
            (array_agg(b.client_username ORDER BY b.created_at DESC) FILTER (WHERE b.client_username IS NOT NULL))[1] AS username,
            COUNT(*)::int AS visits,
            MAX(b.starts_at) AS last_visit,
            COALESCE(SUM(CASE WHEN b.status = 'completed' THEN s.price ELSE 0 END), 0)::int AS total_spent
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     GROUP BY b.client_telegram_id, b.client_phone
     ORDER BY MAX(b.starts_at) DESC`
  );

  res.json(rows.map((r) => ({ ...r, last_visit: toIso(r.last_visit) })));
});

// История записей одного клиента — карточка при открытии из списка.
// clientKey — Telegram ID как есть, либо "phone-<цифры>" для клиента без
// Telegram (записан вручную по звонку/WhatsApp)
api.get("/staff/clients/:clientKey", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  const clientKey = req.params.clientKey;
  if (!telegramId || !clientKey) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const isPhone = clientKey.startsWith("phone-");
  const whereClause = isPhone ? "b.client_phone = $1" : "b.client_telegram_id = $1";
  const whereValue = isPhone ? clientKey.slice("phone-".length) : Number(clientKey);
  if (isPhone ? !whereValue : !whereValue) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.starts_at, b.status, s.name AS service_name, s.price, m.name AS master_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN masters m ON m.id = b.master_id
     WHERE ${whereClause}
     ORDER BY b.starts_at DESC`,
    [whereValue]
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
  if (!(await canAccessClientNotes(req, clientTelegramId))) {
    res.status(403).json({ error: "Не удалось подтвердить личность в Telegram" });
    return;
  }

  const { rows } = await db.query(
    "SELECT note, admin_comment, updated_at FROM client_notes WHERE client_telegram_id = $1",
    [clientTelegramId]
  );
  const row = rows[0] as { note: string | null; admin_comment: string | null; updated_at: string } | undefined;
  res.json(
    row
      ? { note: row.note, admin_comment: row.admin_comment, updated_at: toIso(row.updated_at) }
      : { note: null, admin_comment: null, updated_at: null }
  );
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
  if (!(await canAccessClientNotes(req, clientTelegramId))) {
    res.status(403).json({ error: "Не удалось подтвердить личность в Telegram" });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO client_notes (client_telegram_id, note, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (client_telegram_id) DO UPDATE SET note = $2, updated_at = now()
     RETURNING note, updated_at`,
    [clientTelegramId, note]
  );
  syncClientExtraField("note", String(clientTelegramId), note);
  res.json({ note: rows[0].note, updated_at: toIso(rows[0].updated_at) });
});

// Те же заметки, но для клиентов без Telegram (запись вручную по звонку/WhatsApp) —
// телефон вместо Telegram ID как ключ
api.get("/client-notes/by-phone/:phone", async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await isVerifiedStaff(req))) {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query(
    "SELECT note, admin_comment, updated_at FROM client_notes WHERE client_phone = $1",
    [phone]
  );
  const row = rows[0] as { note: string | null; admin_comment: string | null; updated_at: string } | undefined;
  res.json(
    row
      ? { note: row.note, admin_comment: row.admin_comment, updated_at: toIso(row.updated_at) }
      : { note: null, admin_comment: null, updated_at: null }
  );
});

api.put("/client-notes/by-phone/:phone", async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const { note } = req.body as Partial<ClientNoteBody>;
  if (!phone || !note) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!(await isVerifiedStaff(req))) {
    res.status(403).json({ error: "Доступно только персоналу" });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO client_notes (client_phone, note, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (client_phone) DO UPDATE SET note = $2, updated_at = now()
     RETURNING note, updated_at`,
    [phone, note]
  );
  syncClientExtraField("note", phone, note);
  res.json({ note: rows[0].note, updated_at: toIso(rows[0].updated_at) });
});

interface AdminCommentBody {
  telegram_id: number;
  client_telegram_id?: number;
  client_phone?: string;
  comment: string;
}

// Комментарий администратора о клиенте — отдельно от заметки об аллергии
// (ту может писать и клиент, и мастер; этот — только админ, для себя)
api.put("/staff/client-comment", async (req, res) => {
  const { telegram_id, client_telegram_id, client_phone, comment } = req.body as Partial<AdminCommentBody>;
  if (!telegram_id || rejectIfNotVerified(req, res, telegram_id)) return;
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }
  if (!client_telegram_id && !client_phone) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }

  const rows = client_telegram_id
    ? (
        await db.query(
          `INSERT INTO client_notes (client_telegram_id, admin_comment, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (client_telegram_id) DO UPDATE SET admin_comment = $2, updated_at = now()
           RETURNING admin_comment, updated_at`,
          [client_telegram_id, comment ?? null]
        )
      ).rows
    : (
        await db.query(
          `INSERT INTO client_notes (client_phone, admin_comment, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (client_phone) DO UPDATE SET admin_comment = $2, updated_at = now()
           RETURNING admin_comment, updated_at`,
          [normalizePhone(client_phone!), comment ?? null]
        )
      ).rows;

  const clientKey = client_telegram_id ? String(client_telegram_id) : normalizePhone(client_phone!);
  syncClientExtraField("comment", clientKey, comment ?? null);

  res.json({ admin_comment: rows[0].admin_comment, updated_at: toIso(rows[0].updated_at) });
});

api.get("/staff", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает telegram_id" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;
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
  if (rejectIfNotVerified(req, res, telegram_id)) return;
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
    const accessCode = await assignAccessCode(rows[0].id);
    res.status(201).json({ ...rows[0], access_code: accessCode });
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
  if (rejectIfNotVerified(req, res, telegramId)) return;
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  await db.query("DELETE FROM staff WHERE id = $1", [id]);
  res.json({ ok: true });
});

// ===== Склад (материалы: краска, лак и т.п.) — доступно только админу =====

interface InventoryItemBody {
  telegram_id: number;
  name: string;
  unit: string;
  quantity?: number;
  min_threshold?: number;
}

api.get("/staff/inventory-items", async (req, res) => {
  const telegramId = Number(req.query.telegram_id);
  if (!telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    "SELECT id, name, unit, quantity, min_threshold, updated_at FROM inventory_items ORDER BY name ASC"
  );
  res.json(rows.map((r) => ({ ...r, updated_at: toIso(r.updated_at) })));
});

api.post("/staff/inventory-items", async (req, res) => {
  const { telegram_id, name, unit, quantity, min_threshold } = req.body as Partial<InventoryItemBody>;
  if (!telegram_id || !name?.trim() || !unit?.trim()) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const initialQuantity = Number.isFinite(quantity) && quantity! >= 0 ? Math.trunc(quantity!) : 0;
  const threshold = Number.isFinite(min_threshold) && min_threshold! >= 0 ? Math.trunc(min_threshold!) : 0;

  const { rows } = await db.query(
    `INSERT INTO inventory_items (name, unit, quantity, min_threshold) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name.trim(), unit.trim(), initialQuantity, threshold]
  );
  const item = rows[0];

  // Начальный остаток тоже фиксируем в истории — иначе в карточке материала
  // количество как будто "появляется из ниоткуда" без объяснения
  if (initialQuantity > 0) {
    await db.query(
      "INSERT INTO inventory_transactions (item_id, change_amount, reason) VALUES ($1, $2, $3)",
      [item.id, initialQuantity, "начальный остаток"]
    );
  }

  syncInventoryItem({ name: item.name, quantity: item.quantity, unit: item.unit, minThreshold: item.min_threshold });

  res.status(201).json({ ...item, updated_at: toIso(item.updated_at) });
});

interface InventoryItemUpdateBody {
  telegram_id: number;
  name?: string;
  unit?: string;
  min_threshold?: number;
  quantity?: number;
}

// Исправление ошибок при заполнении: название, единица измерения, порог.
// Если передано quantity — это прямая коррекция остатка (например, ошиблись
// при вводе), она тоже попадает в историю отдельной строкой с причиной
// "коррекция", чтобы в истории не появлялось необъяснимое изменение числа
api.patch("/staff/inventory-items/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, name, unit, min_threshold, quantity } = req.body as Partial<InventoryItemUpdateBody>;
  if (!id || !telegram_id) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows: existing } = await db.query("SELECT * FROM inventory_items WHERE id = $1", [id]);
  const current = existing[0];
  if (!current) {
    res.status(404).json({ error: "Материал не найден" });
    return;
  }

  const newName = typeof name === "string" && name.trim() ? name.trim() : current.name;
  const newUnit = typeof unit === "string" && unit.trim() ? unit.trim() : current.unit;
  const newThreshold =
    Number.isFinite(min_threshold) && min_threshold! >= 0 ? Math.trunc(min_threshold!) : current.min_threshold;

  const { rows } = await db.query(
    "UPDATE inventory_items SET name = $1, unit = $2, min_threshold = $3, updated_at = now() WHERE id = $4 RETURNING *",
    [newName, newUnit, newThreshold, id]
  );
  const item = rows[0];

  if (Number.isInteger(quantity) && quantity !== current.quantity && quantity! >= 0) {
    const delta = quantity! - current.quantity;
    const { rows: corrected } = await db.query(
      "UPDATE inventory_items SET quantity = $1 WHERE id = $2 RETURNING *",
      [quantity, id]
    );
    await db.query("INSERT INTO inventory_transactions (item_id, change_amount, reason) VALUES ($1, $2, 'коррекция')", [
      id,
      delta,
    ]);
    Object.assign(item, corrected[0]);
  }

  syncInventoryItem({
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    minThreshold: item.min_threshold,
    previousName: item.name !== current.name ? current.name : undefined,
  });

  res.json({ ...item, updated_at: toIso(item.updated_at) });
});

interface InventoryTransactionBody {
  telegram_id: number;
  change_amount: number;
  reason?: string;
}

// История поступлений/списаний конкретного материала — для карточки
api.get("/staff/inventory-items/:id/transactions", async (req, res) => {
  const id = Number(req.params.id);
  const telegramId = Number(req.query.telegram_id);
  if (!id || !telegramId) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegramId)) return;
  if (!(await requireAdmin(telegramId))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  const { rows } = await db.query(
    `SELECT id, change_amount, reason, created_at
     FROM inventory_transactions
     WHERE item_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [id]
  );
  res.json(rows.map((r) => ({ ...r, created_at: toIso(r.created_at) })));
});

// Поступление (change_amount > 0) или списание (change_amount < 0) —
// направление уже заложено в знак числа, отдельного поля "тип" не нужно
api.post("/staff/inventory-items/:id/transactions", async (req, res) => {
  const id = Number(req.params.id);
  const { telegram_id, change_amount, reason } = req.body as Partial<InventoryTransactionBody>;
  if (!id || !telegram_id || !change_amount) {
    res.status(400).json({ error: "Не хватает параметров" });
    return;
  }
  if (!Number.isInteger(change_amount) || change_amount === 0) {
    res.status(400).json({ error: "Некорректное количество" });
    return;
  }
  if (rejectIfNotVerified(req, res, telegram_id)) return;
  if (!(await requireAdmin(telegram_id))) {
    res.status(403).json({ error: "Доступно только администратору" });
    return;
  }

  // Условие в WHERE не даёт остатку уйти в минус при списании — проверка и
  // само обновление одним запросом, без риска, что между ними что-то изменится
  const { rows: updated } = await db.query(
    `UPDATE inventory_items SET quantity = quantity + $1, updated_at = now()
     WHERE id = $2 AND quantity + $1 >= 0 RETURNING *`,
    [change_amount, id]
  );
  if (!updated[0]) {
    const { rows: existing } = await db.query("SELECT id FROM inventory_items WHERE id = $1", [id]);
    if (!existing[0]) {
      res.status(404).json({ error: "Материал не найден" });
    } else {
      res.status(400).json({ error: "Нельзя списать больше, чем есть на складе" });
    }
    return;
  }

  const trimmedReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;
  await db.query("INSERT INTO inventory_transactions (item_id, change_amount, reason) VALUES ($1, $2, $3)", [
    id,
    change_amount,
    trimmedReason,
  ]);

  syncInventoryItem({
    name: updated[0].name,
    quantity: updated[0].quantity,
    unit: updated[0].unit,
    minThreshold: updated[0].min_threshold,
  });

  res.status(201).json({ ...updated[0], updated_at: toIso(updated[0].updated_at) });
});
