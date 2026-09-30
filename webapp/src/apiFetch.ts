import { getInitData } from './telegram'
import { getStaffSessionToken } from './staffSession'
import i18n from './i18n'

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
  return fetchWithFriendlyErrors(input, { ...init, headers })
}

// Текст ошибки на языке человека. В панели персонала apiLang не задан — она
// всегда на русском
function friendlyError(key: 'errors.noConnection' | 'errors.serverNotResponding'): string {
  return i18n.t(key, { lng: apiLang ?? 'ru' })
}

// Без этого человек видел технический английский текст вместо понятного:
// - нет интернета / сервер недоступен — браузер пишет "Load failed" или
//   "Failed to fetch";
// - вместо ответа нашего сервера пришла чужая страница (например, Render
//   ещё будит заснувший сервер и отдаёт свою HTML-страницу ошибки) — и
//   попытка прочитать её как данные давала "Unexpected token '<'...".
// Все экраны показывают data.error из ответа или текст пойманной ошибки —
// поэтому здесь оба случая превращаются в понятное сообщение, и править
// каждый экран по отдельности не нужно
async function fetchWithFriendlyErrors(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (err) {
    // Отмена запроса самим приложением — не ошибка связи, пусть идёт как есть
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new Error(friendlyError('errors.noConnection'))
  }
  const isJson = res.headers.get('Content-Type')?.includes('application/json')
  if (!res.ok && !isJson) {
    return new Response(JSON.stringify({ error: friendlyError('errors.serverNotResponding') }), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return res
}
