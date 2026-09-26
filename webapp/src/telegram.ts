export function getTelegramUserId(): number {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.id ?? 111111
}

export function getTelegramUserName(): string {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  if (!tgUser) return 'Тестовый клиент'
  return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Клиент'
}

// Публичный @username — есть не у всех, нужен, чтобы мастер мог открыть
// с клиентом личный чат в Telegram (t.me/username)
export function getTelegramUsername(): string | null {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.username ?? null
}

// "Подписанный конверт" от Telegram — сырая строка initData (не initDataUnsafe).
// В отличие от initDataUnsafe (её любой может подделать в браузере), эту строку
// сервер может проверить: она подписана секретным ключом бота, подделать её
// без ключа нельзя. Отправляем её на сервер с каждым запросом (см. apiFetch.ts)
export function getInitData(): string {
  return (window as any).Telegram?.WebApp?.initData ?? ''
}

// Открыть PWA-версию в системном браузере телефона (Safari/Chrome), а не во
// встроенном браузере Telegram — оттуда, в отличие от Telegram, можно
// установить PWA на домашний экран. openLink — специальный метод Telegram
// именно для этого; обычная ссылка открылась бы внутри Telegram.
//
// PWA-версия живёт на адресе сервера (не там, где открыт сам Mini App) —
// чтобы вход по коду запоминался и на iPhone (Safari не разрешает cookie
// между разными адресами, а сервер и PWA теперь на одном).
//
// ?install=1 — метка "это переход ради установки, а не ради входа": на этом
// экране сразу видна инструкция по установке, без формы входа. Сам код в
// ссылку не кладём — он одноразовый и показывается в приложении Telegram
export function openPwaExternally(): void {
  const base = (import.meta.env.VITE_API_URL as string | undefined) || window.location.origin
  const params = new URLSearchParams({ install: '1' })
  const pwaUrl = `${base.replace(/\/$/, '')}/?${params.toString()}`
  const webApp = (window as any).Telegram?.WebApp
  if (webApp?.openLink) {
    webApp.openLink(pwaUrl)
  } else {
    window.open(pwaUrl, '_blank')
  }
}

// Язык интерфейса Telegram у пользователя ('ru', 'en', 'de-DE'…) — подсказка для
// первого выбора языка приложения (дальше язык хранится на сервере, см. App.tsx)
export function getTelegramLanguageCode(): string | null {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.language_code ?? null
}
