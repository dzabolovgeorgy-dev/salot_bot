import { getInitData } from './telegram'
import { getStaffSessionToken } from './staffSession'

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
  return fetch(input, { ...init, headers })
}
