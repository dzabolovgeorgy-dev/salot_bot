import crypto from "node:crypto";
import { db } from "./db.js";
import { generateAccessCode } from "./accessCode.js";

// Заголовок с сессией PWA-входа и то, сколько она живёт без повторного
// ввода кода — сотрудник открывает PWA раз в несколько дней, а не каждый час,
// поэтому срок сделан большим (90 дней).
//
// Раньше сессия хранилась в httpOnly cookie, но на iPhone установленное на
// экран приложение (не обычная вкладка Safari) не сохраняет такие cookie
// между запусками — каждый раз просило код заново, независимо от того, что
// сайт и сервер уже на одном адресе. Токен теперь хранится в localStorage
// на телефоне (см. webapp/src/staffSession.ts) и отправляется этим
// заголовком на каждый запрос — так работает надёжно и на iPhone, и на Android
export const PWA_SESSION_HEADER = "X-Staff-Session";
const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

// Пытаемся выдать staff-строке уникальный код входа — коллизии почти
// невозможны (6 символов из 33-буквенного алфавита), но на всякий случай
// пробуем несколько раз, прежде чем сдаться
export async function assignAccessCode(staffId: number): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateAccessCode();
    try {
      await db.query("UPDATE staff SET access_code = $1 WHERE id = $2", [code, staffId]);
      return code;
    } catch {
      // код уже занят другим сотрудником — пробуем сгенерировать ещё раз
    }
  }
  throw new Error("Не удалось сгенерировать уникальный код входа");
}

export interface StaffByCode {
  telegram_id: number;
}

export async function findStaffByAccessCode(code: string): Promise<StaffByCode | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  // telegram_id в базе — BIGINT, драйвер pg возвращает такие столбцы строкой
  // (чтобы не терять точность у очень больших чисел), а не числом, как заявлено
  // в типе StaffByCode. Без Number(...) эта строка потом улетает в JSON-тело
  // запросов вида {"telegram_id":"123"} вместо {"telegram_id":123} — сервер
  // сравнивает его с настоящим числом из сессии и не находит совпадения (403)
  const { rows } = await db.query<{ telegram_id: string }>(
    "SELECT telegram_id FROM staff WHERE access_code = $1",
    [normalized]
  );
  if (!rows[0]) return null;
  return { telegram_id: Number(rows[0].telegram_id) };
}

// Создаёт новую сессию (случайный непредсказуемый токен) и возвращает его —
// вернуть его клиенту (чтобы сохранил в localStorage) должен вызывающий код
export async function createPwaSession(telegramId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await db.query("INSERT INTO pwa_sessions (token, telegram_id, expires_at) VALUES ($1, $2, $3)", [
    token,
    telegramId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

// Telegram ID владельца сессии, если токен существует и ещё не истёк — иначе null
export async function getPwaSessionTelegramId(token: string): Promise<number | null> {
  if (!token) return null;
  const { rows } = await db.query<{ telegram_id: string }>(
    "SELECT telegram_id FROM pwa_sessions WHERE token = $1 AND expires_at > now()",
    [token]
  );
  return rows[0] ? Number(rows[0].telegram_id) : null;
}

export async function deletePwaSession(token: string): Promise<void> {
  if (!token) return;
  await db.query("DELETE FROM pwa_sessions WHERE token = $1", [token]);
}
