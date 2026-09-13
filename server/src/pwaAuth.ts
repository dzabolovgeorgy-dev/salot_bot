import crypto from "node:crypto";
import { db } from "./db.js";
import { generateAccessCode } from "./accessCode.js";

// Имя cookie с сессией PWA-входа и то, сколько она живёт без повторного
// ввода кода — сотрудник открывает PWA раз в несколько дней, а не каждый час,
// поэтому срок сделан большим (90 дней)
export const PWA_SESSION_COOKIE = "staff_session";
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
  const { rows } = await db.query<StaffByCode>("SELECT telegram_id FROM staff WHERE access_code = $1", [
    normalized,
  ]);
  return rows[0] ?? null;
}

// Создаёт новую сессию (случайный непредсказуемый токен) и возвращает его —
// сохранить в httpOnly cookie должен вызывающий код
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
