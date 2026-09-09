import crypto from "node:crypto";

// Диалог записи в чате (bookingScene.ts, bot.ts) обращается к своим же
// /api/... эндпоинтам обычными HTTP-запросами, как это делает браузер.
// Но у него нет initData от Telegram (это не открытие Mini App, а сам сервер
// стучится сам к себе) — поэтому вместо подписи Telegram шлём этот секрет.
// Подделать его снаружи нельзя: он никогда не покидает сервер и не попадает
// в браузер. Генерируется случайно при каждом запуске сервера — ничего
// настраивать вручную не нужно (тот же процесс сам себе и отправляет,
// и проверяет секрет)
export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || crypto.randomBytes(32).toString("hex");

export function internalHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...extra, "X-Internal-Secret": INTERNAL_API_SECRET };
}
