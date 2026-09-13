import { getInitData } from './telegram'

// Обёртка над обычным fetch — делает то же самое, но к каждому запросу
// автоматически прикладывает "подписанный конверт" от Telegram (initData)
// заголовком. Сервер этим конвертом проверяет, что telegram_id в запросе
// реально принадлежит тому, кто открыл приложение, а не подставлен вручную.
// Используется вместо fetch() везде, где мы обращаемся к своему серверу.
// credentials: 'include' — чтобы браузер отправлял (и принимал) cookie с
// PWA-сессией входа по коду, даже когда сайт и сервер на разных доменах
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const initData = getInitData()
  if (initData) {
    headers.set('X-Telegram-Init-Data', initData)
  }
  return fetch(input, { ...init, headers, credentials: 'include' })
}
