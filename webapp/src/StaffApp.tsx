import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Master, Booking, BlockedSlot } from './types'
import { isWorkDay } from './schedule'
import { MONTH_NAMES, WEEKDAY_LABELS, dateKeyOf, startOfMonth, buildMonthCells } from './calendar'
import AdminManage from './AdminManage'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

type StaffTab = 'today' | 'week' | 'schedule' | 'block' | 'manage'

const MONTH_LABELS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
]

// 7 дат начиная с сегодня + смещение в неделях
function weekDates(weekOffset: number): Date[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() + weekOffset * 7)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function formatDayLabel(d: Date): string {
  const jsDay = d.getDay() // 0 = вс
  const weekday = WEEKDAY_LABELS[(jsDay + 6) % 7]
  return `${weekday}, ${d.getDate()} ${MONTH_LABELS[d.getMonth()]}`
}

interface StaffAppProps {
  telegramId: number
  role: 'master' | 'admin'
  masterId?: number
  masterName?: string
}

function todayKey(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatTime(iso: string): string {
  return iso.slice(11, 16)
}

export default function StaffApp({ telegramId, role, masterId, masterName }: StaffAppProps) {
  const [activeTab, setActiveTab] = useState<StaffTab>(role === 'master' ? 'today' : 'schedule')
  const [date, setDate] = useState(todayKey())
  const [masters, setMasters] = useState<Master[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [blocks, setBlocks] = useState<BlockedSlot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [todayBookings, setTodayBookings] = useState<Booking[]>([])
  const [todayLoading, setTodayLoading] = useState(true)
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [statusSaving, setStatusSaving] = useState(false)

  const [weekOffset, setWeekOffset] = useState(0)
  const [weekData, setWeekData] = useState<Record<string, Booking[]>>({})
  const [weekLoading, setWeekLoading] = useState(true)

  const [scheduleMonth, setScheduleMonth] = useState(() => startOfMonth(new Date()))
  const [monthCounts, setMonthCounts] = useState<Record<string, number>>({})
  const [monthLoading, setMonthLoading] = useState(true)

  const [blockMasterId, setBlockMasterId] = useState<number | ''>(role === 'master' ? masterId ?? '' : '')
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [blockNote, setBlockNote] = useState('')
  const [blockAllDay, setBlockAllDay] = useState(false)
  const [blockSubmitting, setBlockSubmitting] = useState(false)

  useEffect(() => {
    fetch(`${API_URL}/api/masters`)
      .then((r) => r.json())
      .then(setMasters)
      .catch(() => {})
  }, [])

  async function loadSchedule() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/schedule?telegram_id=${telegramId}&date=${date}`)
      if (!res.ok) throw new Error('Не удалось загрузить расписание')
      const data = await res.json()
      setBookings(data.bookings)
      setBlocks(data.blocked_slots)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить расписание')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSchedule()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  // Сколько записей и блокировок на каждый день видимого месяца — для сетки календаря
  async function loadMonthCounts() {
    setMonthLoading(true)
    try {
      const days = buildMonthCells(scheduleMonth).filter((d): d is Date => d !== null)
      const results = await Promise.all(
        days.map((d) =>
          fetch(`${API_URL}/api/staff/schedule?telegram_id=${telegramId}&date=${dateKeyOf(d)}`).then((r) => r.json())
        )
      )
      const counts: Record<string, number> = {}
      days.forEach((d, i) => {
        counts[dateKeyOf(d)] = (results[i].bookings?.length ?? 0) + (results[i].blocked_slots?.length ?? 0)
      })
      setMonthCounts(counts)
    } catch {
      // тихо — сетка просто не покажет отметки
    } finally {
      setMonthLoading(false)
    }
  }

  useEffect(() => {
    loadMonthCounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleMonth])

  // "Мой день" — только записи клиентов у самого мастера на сегодня
  async function loadToday() {
    if (role !== 'master' || !masterId) return
    setTodayLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/staff/schedule?telegram_id=${telegramId}&date=${todayKey()}`)
      const data = await res.json()
      setTodayBookings((data.bookings as Booking[]).filter((b) => b.master_id === masterId))
    } catch {
      // тихо — на этой вкладке нет отдельного места для ошибки
    } finally {
      setTodayLoading(false)
    }
  }

  useEffect(() => {
    loadToday()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, masterId, telegramId])

  // "Неделя" — свои записи мастера на 7 дней вперёд (или назад/вперёд от текущей недели)
  async function loadWeek() {
    if (role !== 'master' || !masterId) return
    setWeekLoading(true)
    try {
      const days = weekDates(weekOffset)
      const results = await Promise.all(
        days.map((d) =>
          fetch(`${API_URL}/api/staff/schedule?telegram_id=${telegramId}&date=${dateKeyOf(d)}`).then((r) => r.json())
        )
      )
      const map: Record<string, Booking[]> = {}
      days.forEach((d, i) => {
        map[dateKeyOf(d)] = (results[i].bookings as Booking[]).filter((b) => b.master_id === masterId)
      })
      setWeekData(map)
    } catch {
      // тихо — на этой вкладке нет отдельного места для ошибки
    } finally {
      setWeekLoading(false)
    }
  }

  useEffect(() => {
    loadWeek()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, masterId, telegramId, weekOffset])

  async function setBookingStatus(bookingId: number, status: 'completed' | 'no_show') {
    setStatusSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/bookings/${bookingId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, status }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setSelectedBooking(null)
      await loadToday()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setStatusSaving(false)
    }
  }

  async function submitBlock(e: FormEvent) {
    e.preventDefault()
    if (!blockMasterId || (!blockAllDay && (!blockStart || !blockEnd))) return
    setBlockSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/blocked-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          master_id: blockMasterId,
          starts_at: `${date}T${blockAllDay ? '00:00' : blockStart}`,
          ends_at: `${date}T${blockAllDay ? '23:59' : blockEnd}`,
          note: blockNote || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setBlockStart('')
      setBlockEnd('')
      setBlockNote('')
      setBlockAllDay(false)
      await loadSchedule()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setBlockSubmitting(false)
    }
  }

  async function removeBlock(id: number) {
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/blocked-slots/${id}?telegram_id=${telegramId}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось удалить')
      await loadSchedule()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить')
    }
  }

  const dayItems = [
    ...bookings.map((b) => ({ kind: 'booking' as const, time: formatTime(b.starts_at), booking: b })),
    ...blocks.map((b) => ({ kind: 'block' as const, time: formatTime(b.starts_at), block: b })),
  ].sort((a, b) => a.time.localeCompare(b.time))

  return (
    <div className="staff-app">
      <header className="staff-header">
        <h1>Персонал</h1>
        <span className="staff-role-badge">{role === 'admin' ? 'Администратор' : `Мастер: ${masterName}`}</span>
      </header>

      <nav className="staff-tabs">
        {role === 'master' && (
          <button type="button" className={activeTab === 'today' ? 'active' : ''} onClick={() => setActiveTab('today')}>
            Мой день
          </button>
        )}
        {role === 'master' && (
          <button type="button" className={activeTab === 'week' ? 'active' : ''} onClick={() => setActiveTab('week')}>
            Неделя
          </button>
        )}
        <button
          type="button"
          className={activeTab === 'schedule' ? 'active' : ''}
          onClick={() => setActiveTab('schedule')}
        >
          Расписание
        </button>
        <button type="button" className={activeTab === 'block' ? 'active' : ''} onClick={() => setActiveTab('block')}>
          Заблокировать время
        </button>
        {role === 'admin' && (
          <button type="button" className={activeTab === 'manage' ? 'active' : ''} onClick={() => setActiveTab('manage')}>
            Управление
          </button>
        )}
      </nav>

      {activeTab === 'block' && (
        <div className="staff-date-nav">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      )}

      {error && <div className="staff-error">{error}</div>}

      {activeTab === 'today' && !selectedBooking && (
        <section className="staff-schedule">
          {todayLoading ? (
            <p className="staff-empty">Загрузка…</p>
          ) : todayBookings.length === 0 ? (
            <p className="staff-empty">На сегодня записей нет</p>
          ) : (
            <ul className="staff-list">
              {todayBookings.map((b) => (
                <li key={b.id} className="staff-list-item staff-list-item--clickable" onClick={() => setSelectedBooking(b)}>
                  <span className="staff-list-time">{formatTime(b.starts_at)}</span>
                  <span className="staff-list-body">
                    {b.client_name ?? 'Клиент'} — {b.service_name}
                    {b.status === 'completed' && <span className="staff-status staff-status--done"> ✓ выполнено</span>}
                    {b.status === 'no_show' && <span className="staff-status staff-status--no-show"> ✕ не пришёл</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === 'today' && selectedBooking && (
        <section className="staff-booking-card">
          <button type="button" className="staff-back-btn" onClick={() => setSelectedBooking(null)}>
            ← Назад
          </button>
          <h2>{selectedBooking.client_name ?? 'Клиент'}</h2>
          <p className="staff-card-line">{selectedBooking.service_name}</p>
          <p className="staff-card-line">{formatTime(selectedBooking.starts_at)}</p>
          {selectedBooking.status !== 'upcoming' && (
            <p className="staff-card-line">
              Статус: {selectedBooking.status === 'completed' ? 'Выполнено' : 'Клиент не пришёл'}
            </p>
          )}
          <div className="staff-card-actions">
            <button
              type="button"
              className="staff-card-done"
              disabled={statusSaving}
              onClick={() => setBookingStatus(selectedBooking.id, 'completed')}
            >
              Отметить выполненной
            </button>
            <button
              type="button"
              className="staff-card-no-show"
              disabled={statusSaving}
              onClick={() => setBookingStatus(selectedBooking.id, 'no_show')}
            >
              Клиент не пришёл
            </button>
          </div>
        </section>
      )}

      {activeTab === 'week' && (
        <section className="staff-week">
          <div className="staff-week-nav">
            <button type="button" onClick={() => setWeekOffset((w) => w - 1)}>
              ← Пред. неделя
            </button>
            <button type="button" onClick={() => setWeekOffset((w) => w + 1)}>
              Следующая →
            </button>
          </div>
          {weekLoading ? (
            <p className="staff-empty">Загрузка…</p>
          ) : (
            weekDates(weekOffset).map((d) => {
              const key = dateKeyOf(d)
              const items = weekData[key] ?? []
              return (
                <div key={key} className="staff-week-day">
                  <h3>{formatDayLabel(d)}</h3>
                  {items.length === 0 ? (
                    <p className="staff-empty staff-empty--compact">Записей нет</p>
                  ) : (
                    <ul className="staff-list">
                      {items.map((b) => (
                        <li key={b.id} className="staff-list-item">
                          <span className="staff-list-time">{formatTime(b.starts_at)}</span>
                          <span className="staff-list-body">
                            {b.client_name ?? 'Клиент'} — {b.service_name}
                            {b.status === 'completed' && <span className="staff-status staff-status--done"> ✓</span>}
                            {b.status === 'no_show' && <span className="staff-status staff-status--no-show"> ✕</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })
          )}
        </section>
      )}

      {activeTab === 'schedule' && (
        <section className="staff-schedule">
          <div className="staff-month-calendar">
            <div className="staff-month-nav">
              <button
                type="button"
                className="staff-month-arrow"
                onClick={() => setScheduleMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                aria-label="Предыдущий месяц"
              >
                ‹
              </button>
              <span className="staff-month-label">
                {MONTH_NAMES[scheduleMonth.getMonth()]} {scheduleMonth.getFullYear()}
              </span>
              <button
                type="button"
                className="staff-month-arrow"
                onClick={() => setScheduleMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
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
              {buildMonthCells(scheduleMonth).map((d, i) => {
                if (!d) return <span key={`empty-${i}`} className="staff-month-day staff-month-day-empty" />
                const key = dateKeyOf(d)
                const count = monthCounts[key] ?? 0
                return (
                  <button
                    key={key}
                    type="button"
                    className={`staff-month-day${date === key ? ' active' : ''}`}
                    onClick={() => setDate(key)}
                  >
                    {d.getDate()}
                    {count > 0 && <span className="staff-month-day-count">{count}</span>}
                  </button>
                )
              })}
            </div>
          </div>

          {masters.length > 0 && (
            <div className="staff-shift-row">
              {masters.map((m) => {
                const working = isWorkDay(date, m)
                return (
                  <span key={m.id} className={`staff-shift-chip${working ? '' : ' staff-shift-chip--off'}`}>
                    {m.name}
                    <span className="staff-shift-dot" />
                    {working ? 'на смене' : 'выходной'}
                  </span>
                )
              })}
            </div>
          )}
          {loading ? (
            <p className="staff-empty">Загрузка…</p>
          ) : dayItems.length === 0 ? (
            <p className="staff-empty">На этот день ничего нет</p>
          ) : (
            <ul className="staff-list">
              {dayItems.map((entry) =>
                entry.kind === 'booking' ? (
                  <li key={`booking-${entry.booking.id}`} className="staff-list-item">
                    <span className="staff-list-time">{entry.time}</span>
                    <span className="staff-list-body">
                      {entry.booking.service_name} — {entry.booking.master_name}
                    </span>
                  </li>
                ) : (
                  <li key={`block-${entry.block.id}`} className="staff-list-item staff-list-item--block">
                    <span className="staff-list-time">{entry.time}</span>
                    <span className="staff-list-body">
                      Заблокировано ({entry.block.master_name}
                      {entry.block.note ? `, ${entry.block.note}` : ''})
                    </span>
                    <button type="button" className="staff-remove-btn" onClick={() => removeBlock(entry.block.id)}>
                      Убрать
                    </button>
                  </li>
                )
              )}
            </ul>
          )}
        </section>
      )}

      {activeTab === 'block' && (
        <section className="staff-block-form">
          <form onSubmit={submitBlock}>
            {role === 'admin' ? (
              <label>
                Мастер
                <select
                  value={blockMasterId}
                  onChange={(e) => setBlockMasterId(Number(e.target.value))}
                  required
                >
                  <option value="" disabled>
                    Выберите мастера
                  </option>
                  {masters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="staff-fixed-master">Мастер: {masterName}</p>
            )}
            <label className="staff-checkbox-row">
              <input type="checkbox" checked={blockAllDay} onChange={(e) => setBlockAllDay(e.target.checked)} />
              Закрыть весь день
            </label>
            {!blockAllDay && (
              <>
                <label>
                  С
                  <input type="time" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} required />
                </label>
                <label>
                  До
                  <input type="time" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} required />
                </label>
              </>
            )}
            <label>
              Заметка (необязательно)
              <input
                type="text"
                value={blockNote}
                onChange={(e) => setBlockNote(e.target.value)}
                placeholder="Обед"
              />
            </label>
            <button type="submit" disabled={blockSubmitting}>
              {blockSubmitting ? 'Сохранение…' : 'Заблокировать'}
            </button>
          </form>
        </section>
      )}

      {activeTab === 'manage' && <AdminManage telegramId={telegramId} />}
    </div>
  )
}
