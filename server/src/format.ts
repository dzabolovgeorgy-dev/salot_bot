import type { Lang } from "./i18n.js";

// Postgres отдаёт время как "2026-11-02 14:30:00" (пробел, с секундами).
// Приводим к строгому ISO с "T", чтобы new Date(...) одинаково работал везде,
// включая WebKit в Telegram Mini App на iPhone
export function toIso(value: string): string {
  return value.replace(" ", "T");
}

export function formatRuDateTime(value: string): string {
  return formatDateTime(value, "ru");
}

// Дата и время в формате выбранного языка (месяц словами — по-русски или по-английски)
const DATE_LOCALES: Record<Lang, string> = { ru: "ru-RU", en: "en-GB" };

export function formatDateTime(value: string, lang: Lang): string {
  return new Date(toIso(value)).toLocaleString(DATE_LOCALES[lang], {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
