import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Мультиязычность на сервере (бот, уведомления клиентам, ответы API).
// Русский — основной язык и запасной вариант: если на выбранном языке для
// ключа нет перевода (или он пустой), показывается русский текст, а не пустота
// и не ошибка. Новый язык: добавить его код в SUPPORTED_LANGS, положить рядом
// файл locales/<код>.json и (для контента из базы) колонки name_<код>/bio_<код>
export const SUPPORTED_LANGS = ["ru", "en"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: Lang = "ru";

type Dict = { [key: string]: string | Dict };

// Файлы словарей лежат рядом с этим модулем (src/locales при разработке,
// dist/locales после сборки — при сборке их копирует скрипт build)
const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
const dictionaries = Object.fromEntries(
  SUPPORTED_LANGS.map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(localesDir, `${lang}.json`), "utf8")) as Dict])
) as Record<Lang, Dict>;

function lookup(dict: Dict, key: string): string | undefined {
  let node: string | Dict | undefined = dict;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" && node !== "" ? node : undefined;
}

// t("ru", "book.confirm", { name: "..." }) — {{name}} в тексте подставляется
export function t(lang: Lang, key: string, params: Record<string, string | number> = {}): string {
  const raw = lookup(dictionaries[lang], key) ?? lookup(dictionaries[DEFAULT_LANG], key) ?? key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name) => (name in params ? String(params[name]) : `{{${name}}}`));
}

export function isSupportedLang(value: unknown): value is Lang {
  return typeof value === "string" && (SUPPORTED_LANGS as readonly string[]).includes(value);
}

// Язык Telegram-пользователя ("en", "en-US", "ru", "de"...) → один из наших.
// Язык, которого у нас нет, — русский (основной)
export function normalizeLang(code?: string | null): Lang {
  const base = (code ?? "").toLowerCase().split("-")[0];
  return isSupportedLang(base) ? base : DEFAULT_LANG;
}

// Текст из базы на нужном языке: перевод, если он есть и не пустой, иначе
// основной (русский). translations — переводы по языкам: { en: row.name_en }
export function localized(
  lang: Lang,
  base: string | null | undefined,
  translations: Partial<Record<Lang, string | null | undefined>>
): string {
  const tr = lang === DEFAULT_LANG ? undefined : translations[lang];
  return tr && tr.trim() !== "" ? tr : (base ?? "");
}

// Кусок SQL "имя на языке lang, а если перевода нет — основное". alias и base —
// только из нашего кода (не из запроса), поэтому подставляются напрямую
export function localizedSql(lang: Lang, alias: string, base: string): string {
  if (lang === DEFAULT_LANG) return `${alias}.${base}`;
  return `COALESCE(NULLIF(${alias}.${base}_${lang}, ''), ${alias}.${base})`;
}

// Тексты одной и той же фразы на всех языках — например, для bot.hears(),
// которому нужно узнавать кнопку на любом языке
export function allLangs(key: string, params: Record<string, string | number> = {}): string[] {
  return SUPPORTED_LANGS.map((lang) => t(lang, key, params));
}
