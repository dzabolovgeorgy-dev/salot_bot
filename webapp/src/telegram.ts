export function getTelegramUserId(): number {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.id ?? 111111
}
