// Ограничение неудачных попыток входа по коду: с одного адреса — не больше
// MAX_FAILURES ошибок за окно времени, после этого вход блокируется до конца
// окна. Хранится в памяти сервера: при перезапуске счётчики обнуляются, для
// защиты от перебора этого достаточно (код к тому же живёт всего 10 минут)
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const failures = new Map<string, { count: number; resetAt: number }>();

// Сколько секунд ждать, если адрес заблокирован, иначе 0
export function secondsUntilUnblocked(ip: string): number {
  const entry = failures.get(ip);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    failures.delete(ip);
    return 0;
  }
  return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
}

export function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= now) {
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function recordSuccess(ip: string): void {
  failures.delete(ip);
}

// Периодически чистим устаревшие записи, чтобы карта не росла бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) {
    if (entry.resetAt <= now) failures.delete(ip);
  }
}, WINDOW_MS).unref();
