import crypto from "node:crypto";

// Проверка подписи Telegram WebApp initData — доказывает, что запрос от
// мини-приложения действительно пришёл от того Telegram-аккаунта, за который
// он себя выдаёт (а не просто прислал произвольный telegram_id в запросе).
// Алгоритм — официальный, из документации Telegram:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// 1. Убрать из initData поле hash, остальные пары key=value отсортировать по
//    ключу и склеить через "\n" — это "data-check-string"
// 2. secret_key = HMAC-SHA256(botToken), ключ — строка "WebAppData"
// 3. Настоящий hash = HMAC-SHA256(data-check-string), ключ — secret_key
// 4. Сравнить с присланным hash

// Сколько времени доверяем однажды сгенерированной Telegram'ом initData —
// защита от воспроизведения очень старой (например, случайно утёкшей) строки.
// Мини-приложение может быть открыто у сотрудника весь рабочий день, поэтому
// окно намеренно большое, а не 5-10 минут
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

export interface VerifiedTelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

// Возвращает данные пользователя, только если подпись верна и initData не
// протухла — иначе null. botToken передаётся параметром (не читает process.env
// сам), чтобы функцию было легко тестировать с любым токеном
export function verifyInitData(initData: string, botToken: string): VerifiedTelegramUser | null {
  if (!initData) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Сравнение постоянной длины — не через ===, чтобы не давать утечку по
  // времени ответа (мелочь, но раз уж делаем проверку подписи — делаем аккуратно)
  const hashBuffer = Buffer.from(hash, "hex");
  const computedBuffer = Buffer.from(computedHash, "hex");
  if (hashBuffer.length !== computedBuffer.length || !crypto.timingSafeEqual(hashBuffer, computedBuffer)) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) {
    return null;
  }

  const userJson = params.get("user");
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson) as VerifiedTelegramUser;
    if (!user.id) return null;
    return user;
  } catch {
    return null;
  }
}
