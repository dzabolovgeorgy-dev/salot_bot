import { db } from "./db.js";
import { DEFAULT_LANG, isSupportedLang, normalizeLang, type Lang } from "./i18n.js";

// Язык пользователя хранится в базе (таблица user_languages) — один на человека,
// общий для бота и TWA. Определяется по языку Telegram один раз, при первом
// обращении, и дальше только читается — не переопределяется на каждом шаге.
// Кэш в памяти нужен, чтобы не ходить в базу на каждое сообщение бота
const cache = new Map<number, Lang>();

export async function getStoredLanguage(telegramId: number): Promise<Lang | null> {
  const cached = cache.get(telegramId);
  if (cached) return cached;
  const { rows } = await db.query<{ language: string }>("SELECT language FROM user_languages WHERE telegram_id = $1", [
    telegramId,
  ]);
  const stored = rows[0]?.language;
  if (isSupportedLang(stored)) {
    cache.set(telegramId, stored);
    return stored;
  }
  return null;
}

export async function saveLanguage(telegramId: number, lang: Lang): Promise<void> {
  await db.query(
    `INSERT INTO user_languages (telegram_id, language, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (telegram_id) DO UPDATE SET language = $2, updated_at = now()`,
    [telegramId, lang]
  );
  cache.set(telegramId, lang);
}

// Первое обращение — определяем по языку Telegram и сохраняем; дальше — из базы
export async function resolveLanguage(telegramId: number, languageCodeHint?: string | null): Promise<Lang> {
  const stored = await getStoredLanguage(telegramId);
  if (stored) return stored;
  const detected = normalizeLang(languageCodeHint);
  await saveLanguage(telegramId, detected);
  return detected;
}

// Язык человека, когда подсказки от Telegram под рукой нет (например, сервер
// сам шлёт уведомление или напоминание): сохранённый, а если не заходил — русский
export async function getUserLanguage(telegramId: number | string): Promise<Lang> {
  return (await getStoredLanguage(Number(telegramId))) ?? DEFAULT_LANG;
}
