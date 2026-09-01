import type { Master } from './types'

// Расчёт графика "N дней работает — N выходных", крутится по кругу от
// даты начала (schedule_anchor). Без графика мастер работает всегда.
// Тот же расчёт используется на сервере (server/src/api.ts) — держать в синхроне
export function isWorkDay(dateKey: string, master: Master): boolean {
  if (!master.schedule_anchor || !master.work_days || !master.off_days) return true
  const anchor = new Date(`${master.schedule_anchor}T00:00:00`)
  const date = new Date(`${dateKey}T00:00:00`)
  const diffDays = Math.round((date.getTime() - anchor.getTime()) / 86400000)
  const cycle = master.work_days + master.off_days
  const position = ((diffDays % cycle) + cycle) % cycle
  return position < master.work_days
}
