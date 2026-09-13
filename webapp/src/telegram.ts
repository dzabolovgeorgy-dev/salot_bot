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

// Открыть текущую страницу в системном браузере телефона (Safari/Chrome),
// а не во встроенном браузере Telegram — оттуда, в отличие от Telegram,
// можно установить PWA на домашний экран. openLink — специальный метод
// Telegram именно для этого; обычная ссылка открылась бы внутри Telegram
export function openCurrentPageExternally(): void {
  const url = `${window.location.origin}${window.location.pathname}`
  const webApp = (window as any).Telegram?.WebApp
  if (webApp?.openLink) {
    webApp.openLink(url)
  } else {
    window.open(url, '_blank')
  }
}
