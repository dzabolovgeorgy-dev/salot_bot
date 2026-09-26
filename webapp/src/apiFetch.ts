import { getInitData } from './telegram'
import { getStaffSessionToken } from './staffSession'

// Язык, на котором клиентское приложение просит ответы сервера (названия услуг,
// тексты ошибок). Задаётся только клиентским App — панель персонала его не
// ставит и остаётся русской, чтобы редактирование не перезаписало русские
// названия чужим переводом
let apiLang: string | null = null
export function setApiLang(lang: string | null) {
  apiLang = lang
}

// Обёртка над обычным fetch — делает то же самое, но к каждому запросу
// автоматически прикладывает "подписанный конверт" от Telegram (initData)
// заголовком, либо токен PWA-сессии (вход по коду вне Telegram) — смотря что
// есть. Сервер этим проверяет, что telegram_id в запросе реально принадлежит
// тому, кто открыл приложение, а не подставлен вручную. Используется вместо
// fetch() везде, где мы обращаемся к своему серверу
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const initData = getInitData()
  if (initData) {
    headers.set('X-Telegram-Init-Data', initData)
  }
  const sessionToken = getStaffSessionToken()
  if (sessionToken) {
    headers.set('X-Staff-Session', sessionToken)
  }
  if (apiLang) {
    headers.set('X-Lang', apiLang)
  }
  return fetch(input, { ...init, headers })
}
