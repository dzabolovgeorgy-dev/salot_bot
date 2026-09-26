import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ru from './locales/ru.json'
import en from './locales/en.json'

// Языки клиентского приложения. Чтобы добавить новый: положить файл
// locales/<код>.json, добавить его сюда и в SUPPORTED_LANGS — то же самое
// нужно сделать на сервере (server/src/i18n.ts, папка locales)
export const SUPPORTED_LANGS = ['ru', 'en'] as const
export type Lang = (typeof SUPPORTED_LANGS)[number]
export const DEFAULT_LANG: Lang = 'ru'

export function isSupportedLang(code: string | null | undefined): code is Lang {
  return (SUPPORTED_LANGS as readonly string[]).includes(code ?? '')
}

// 'en-GB' / 'EN' → 'en'; неизвестный язык → русский
export function normalizeLang(code: string | null | undefined): Lang {
  const base = (code ?? '').toLowerCase().split('-')[0]
  return isSupportedLang(base) ? base : DEFAULT_LANG
}

// Язык для форматирования дат и чисел (месяц словами и т.п.)
const DATE_LOCALES: Record<Lang, string> = { ru: 'ru-RU', en: 'en-GB' }
export function dateLocale(lang: string): string {
  return DATE_LOCALES[normalizeLang(lang)]
}

// fallbackLng: если на выбранном языке нет перевода ключа — берётся русский,
// а не пустота и не сам ключ. returnEmptyString: false — пустая строка тоже
// считается "перевода нет" (так же ведёт себя сервер)
void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru }, en: { translation: en } },
  lng: DEFAULT_LANG,
  fallbackLng: DEFAULT_LANG,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
})

export default i18n
