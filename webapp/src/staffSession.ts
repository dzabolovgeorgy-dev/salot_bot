// Токен входа в PWA-версию — хранится в localStorage (а не в httpOnly cookie,
// как было раньше): установленное на экран iPhone приложение не запоминало
// cookie между запусками, а localStorage работает надёжно и на iPhone,
// и на Android. Отправляется на сервер заголовком (см. apiFetch.ts)
const STORAGE_KEY = 'staff_session_token'

export function getStaffSessionToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function setStaffSessionToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token)
  } catch {
    // тихо — в худшем случае просто попросит код при следующем открытии
  }
}

export function clearStaffSessionToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // тихо
  }
}
