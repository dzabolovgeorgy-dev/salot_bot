import type { Master } from './types'

// Три вида графика: 'weekdays' — фиксированные дни недели (0=Пн…6=Вс, как
// WEEKDAY_LABELS в calendar.ts); 'month' — выходные дни отмечены вручную на
// конкретный месяц (schedule_month "YYYY-MM" + номера дней в
// schedule_month_off_days), для другого месяца не действует; 'cycle' —
// устаревший скользящий график, в интерфейсе больше не выбирается, но старые
// данные читаем для обратной совместимости. Без schedule_type мастер работает
// всегда. Тот же расчёт используется на сервере (server/src/api.ts) — держать в синхроне
export function isWorkDay(dateKey: string, master: Master): boolean {
  if (master.schedule_type === 'weekdays') {
    if (!master.work_weekdays || master.work_weekdays.length === 0) return true
    const jsDay = new Date(`${dateKey}T00:00:00`).getDay()
    const weekday = (jsDay + 6) % 7
    return master.work_weekdays.includes(weekday)
  }
  if (master.schedule_type === 'month') {
    if (master.schedule_month !== dateKey.slice(0, 7)) return true
    const dayOfMonth = Number(dateKey.slice(8, 10))
    return !(master.schedule_month_off_days ?? []).includes(dayOfMonth)
  }
  if (master.schedule_type !== 'cycle') return true
  if (!master.schedule_anchor || !master.work_days || !master.off_days) return true
  const anchor = new Date(`${master.schedule_anchor}T00:00:00`)
  const date = new Date(`${dateKey}T00:00:00`)
  const diffDays = Math.round((date.getTime() - anchor.getTime()) / 86400000)
  const cycle = master.work_days + master.off_days
  const position = ((diffDays % cycle) + cycle) % cycle
  return position < master.work_days
}

// Значение по умолчанию для перерыва между записями (master.buffer_minutes) —
// используется, только если у мастера почему-то не задано. То же значение
// отдельно задано в server/src/schedule.ts — держать в синхроне
export const DEFAULT_BUFFER_MINUTES = 15

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
