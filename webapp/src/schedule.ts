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

// Слоты времени каждые 30 минут в пределах часов работы мастера —
// используется и у клиента при записи, и у админа при ручной записи
export function generateTimeSlots(startTime: string, endTime: string, stepMinutes = 30): string[] {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }
  const start = toMinutes(startTime)
  const end = toMinutes(endTime)
  const slots: string[] = []
  for (let m = start; m <= end; m += stepMinutes) {
    const pad = (n: number) => String(n).padStart(2, '0')
    slots.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`)
  }
  return slots
}
