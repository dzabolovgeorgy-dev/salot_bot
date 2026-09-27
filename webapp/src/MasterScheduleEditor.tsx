import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Master } from './types'
import { isWorkDay, DEFAULT_BUFFER_MINUTES } from './schedule'
import { MONTH_NAMES, WEEKDAY_LABELS, dateKeyOf, startOfMonth, buildMonthCells } from './calendar'

function monthKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

export interface ScheduleFormPayload {
  schedule_type: 'none' | 'weekdays' | 'month'
  work_weekdays: number[] | null
  schedule_month: string | null
  schedule_month_off_days: number[] | null
  work_start_time: string
  work_end_time: string
  buffer_minutes: number
}

interface Props {
  master: Master
  // null — сохранено успешно, строка — текст ошибки для показа под формой
  onSave: (payload: ScheduleFormPayload) => Promise<string | null>
}

// Настройка графика работы мастера: какие дни рабочие (всегда / по дням
// недели / выходные отмечены вручную на конкретный месяц), часы работы и
// перерыв между записями. Раньше это можно было менять только самому мастеру
// в своей панели (см. "Мой график" в StaffApp.tsx) — этот же экран, вынесенный
// в отдельный компонент, использует и панель администратора (AdminManage.tsx),
// чтобы график можно было настроить и за мастера
export default function MasterScheduleEditor({ master, onSave }: Props) {
  const [scheduleMode, setScheduleMode] = useState<'none' | 'weekdays' | 'month'>('none')
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([])
  const [monthOffDays, setMonthOffDays] = useState<number[]>([])
  const [workStartInput, setWorkStartInput] = useState('09:00')
  const [workEndInput, setWorkEndInput] = useState('20:00')
  const [bufferInput, setBufferInput] = useState(DEFAULT_BUFFER_MINUTES)
  const [previewMonth, setPreviewMonth] = useState(() => startOfMonth(new Date()))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // Подтягиваем текущий график мастера в форму при открытии и при смене мастера.
  // 'cycle' — устаревший режим, в переключателе его больше нет, показываем как «Всегда»
  useEffect(() => {
    setScheduleMode(master.schedule_type === 'cycle' ? 'none' : (master.schedule_type ?? 'none'))
    setSelectedWeekdays(master.work_weekdays ?? [])
    setWorkStartInput(master.work_start_time ?? '09:00')
    setWorkEndInput(master.work_end_time ?? '20:00')
    setBufferInput(master.buffer_minutes ?? DEFAULT_BUFFER_MINUTES)
    // "Сохранено" и ошибку тут не сбрасываем: после успешного submit() родитель
    // обновляет master свежими данными с сервера — тот же master.id, тот же
    // schedule_type и т.д., этот эффект перезапускается, и сброс тут стёр бы
    // только что показанное "Сохранено ✓" в тот же момент, как оно появилось
  }, [
    master.id,
    master.schedule_type,
    master.work_weekdays,
    master.work_start_time,
    master.work_end_time,
    master.buffer_minutes,
  ])

  // Режим «По месяцу» настраивается заново на каждый месяц — при открытии или
  // перелистывании превью-календаря подтягиваем сохранённые выходные дни,
  // только если они относятся именно к показанному месяцу
  useEffect(() => {
    setMonthOffDays(master.schedule_month === monthKey(previewMonth) ? (master.schedule_month_off_days ?? []) : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master.schedule_month, master.schedule_month_off_days, previewMonth])

  function toggleWeekday(day: number) {
    setSelectedWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()))
    setSaved(false)
  }

  function toggleMonthDay(day: number) {
    setMonthOffDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)))
    setSaved(false)
  }

  const previewMaster = {
    ...master,
    schedule_type: scheduleMode === 'none' ? null : scheduleMode,
    work_weekdays: scheduleMode === 'weekdays' ? selectedWeekdays : null,
    schedule_month: scheduleMode === 'month' ? monthKey(previewMonth) : null,
    schedule_month_off_days: scheduleMode === 'month' ? monthOffDays : null,
  }
  const todayIsWorkDay = isWorkDay(dateKeyOf(new Date()), previewMaster)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaved(false)
    setError('')
    const result = await onSave({
      schedule_type: scheduleMode,
      work_weekdays: scheduleMode === 'weekdays' ? selectedWeekdays : null,
      schedule_month: scheduleMode === 'month' ? monthKey(previewMonth) : null,
      schedule_month_off_days: scheduleMode === 'month' ? monthOffDays : null,
      work_start_time: workStartInput,
      work_end_time: workEndInput,
      buffer_minutes: bufferInput,
    })
    if (result) setError(result)
    else setSaved(true)
    setSaving(false)
  }

  return (
    // staff-admin-form — тот же класс, что несёт стили самой формы "Мой график"
    // у мастера (оформление полей, заголовка, отступов). Класс нужен именно
    // здесь, на своей же обёртке компонента, а не полагаться на то, что его
    // добавит вызывающий экран — иначе без него подписи полей и кнопка
    // остаются неоформленными браузером по умолчанию
    <div className="staff-admin-form">
      <div className="staff-shift-row">
        <span className={`staff-shift-chip${todayIsWorkDay ? '' : ' staff-shift-chip--off'}`}>
          Сегодня
          <span className="staff-shift-dot" />
          {todayIsWorkDay ? 'рабочий день' : 'выходной'}
        </span>
      </div>

      <div className="staff-month-calendar">
        <div className="staff-month-nav">
          <button
            type="button"
            className="staff-month-arrow"
            onClick={() => setPreviewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            aria-label="Предыдущий месяц"
          >
            ‹
          </button>
          <span className="staff-month-label">
            {MONTH_NAMES[previewMonth.getMonth()]} {previewMonth.getFullYear()}
          </span>
          <button
            type="button"
            className="staff-month-arrow"
            onClick={() => setPreviewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            aria-label="Следующий месяц"
          >
            ›
          </button>
        </div>
        <div className="staff-month-weekdays">
          {WEEKDAY_LABELS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="staff-month-grid">
          {buildMonthCells(previewMonth).map((d, i) => {
            if (!d) return <span key={`empty-${i}`} className="staff-month-day staff-month-day-empty" />
            const working = isWorkDay(dateKeyOf(d), previewMaster)
            if (scheduleMode === 'month') {
              return (
                <button
                  key={dateKeyOf(d)}
                  type="button"
                  className={`staff-month-day${working ? '' : ' staff-month-day--off'}`}
                  onClick={() => toggleMonthDay(d.getDate())}
                >
                  {d.getDate()}
                </button>
              )
            }
            return (
              <span key={dateKeyOf(d)} className={`staff-month-day${working ? '' : ' staff-month-day--off'}`}>
                {d.getDate()}
              </span>
            )
          })}
        </div>
        {scheduleMode === 'month' && (
          <p className="staff-form-hint">
            Нажимайте на дни, чтобы отметить выходные — сохранится только для показанного месяца. На следующий месяц
            нужно будет настроить заново.
          </p>
        )}
      </div>

      <form onSubmit={submit}>
        <label>
          Начало рабочего дня
          <input
            type="time"
            value={workStartInput}
            onChange={(e) => {
              setWorkStartInput(e.target.value)
              setSaved(false)
            }}
            required
          />
        </label>
        <label>
          Конец рабочего дня
          <input
            type="time"
            value={workEndInput}
            onChange={(e) => {
              setWorkEndInput(e.target.value)
              setSaved(false)
            }}
            required
          />
        </label>

        <span className="staff-checkbox-label">Перерыв между записями</span>
        <div className="staff-mode-toggle">
          {[0, 10, 15, 20, 30].map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={bufferInput === minutes ? 'active' : ''}
              onClick={() => {
                setBufferInput(minutes)
                setSaved(false)
              }}
            >
              {minutes === 0 ? 'Без перерыва' : `${minutes} мин`}
            </button>
          ))}
        </div>

        <span className="staff-checkbox-label">Какие дни работает</span>
        <div className="staff-mode-toggle">
          <button
            type="button"
            className={scheduleMode === 'none' ? 'active' : ''}
            onClick={() => {
              setScheduleMode('none')
              setSaved(false)
            }}
          >
            Всегда
          </button>
          <button
            type="button"
            className={scheduleMode === 'weekdays' ? 'active' : ''}
            onClick={() => {
              setScheduleMode('weekdays')
              setSaved(false)
            }}
          >
            По дням недели
          </button>
          <button
            type="button"
            className={scheduleMode === 'month' ? 'active' : ''}
            onClick={() => {
              setScheduleMode('month')
              setSaved(false)
            }}
          >
            По месяцу
          </button>
        </div>

        {scheduleMode === 'weekdays' && (
          <div>
            <span className="staff-checkbox-label">Рабочие дни</span>
            <div className="staff-time-grid staff-time-grid--weekdays">
              {WEEKDAY_LABELS.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  className={`staff-time-slot${selectedWeekdays.includes(i) ? ' active' : ''}`}
                  onClick={() => toggleWeekday(i)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {scheduleMode === 'month' && <p className="staff-form-hint">Отметьте выходные дни в календаре выше.</p>}

        <div className="staff-form-actions">
          <button type="submit" disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить график'}
          </button>
        </div>
      </form>
      {saved && <p className="staff-form-hint">Сохранено ✓ — видно клиентам сразу</p>}
      {error && <p className="staff-form-hint staff-form-hint--error">{error}</p>}
    </div>
  )
}
