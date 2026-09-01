export function getTelegramUserId(): number {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.id ?? 111111
}

export function getTelegramUserName(): string {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  if (!tgUser) return 'Тестовый клиент'
  return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Клиент'
}
