import { apiFetch } from './apiFetch'
import type { ScheduleFormPayload } from './MasterScheduleEditor'

const API_URL = import.meta.env.VITE_API_URL ?? ''

// Запрос "изменить график мастера X", общий для обоих мест, откуда админ может
// это сделать (карточка мастера в "Управление" и сабкнопка "График работы" в
// "Расписании") — чтобы сам запрос не пришлось дублировать в двух файлах.
// Возвращает свежие поля мастера от сервера при успехе, иначе текст ошибки
export async function requestMasterScheduleUpdate(
  telegramId: number,
  masterId: number,
  payload: ScheduleFormPayload
): Promise<{ error: string } | { master: Record<string, unknown> }> {
  try {
    const res = await apiFetch(`${API_URL}/api/staff/masters/${masterId}/schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: telegramId, ...payload }),
    })
    const data = await res.json()
    if (!res.ok) return { error: data.error ?? 'Не удалось сохранить' }
    return { master: data }
  } catch {
    return { error: 'Не удалось связаться с сервером' }
  }
}
