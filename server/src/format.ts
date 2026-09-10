// Postgres отдаёт время как "2026-11-02 14:30:00" (пробел, с секундами).
// Приводим к строгому ISO с "T", чтобы new Date(...) одинаково работал везде,
// включая WebKit в Telegram Mini App на iPhone
export function toIso(value: string): string {
  return value.replace(" ", "T");
}

export function formatRuDateTime(value: string): string {
  return new Date(toIso(value)).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
