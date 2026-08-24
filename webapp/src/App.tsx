import { useEffect, useState } from 'react'
import './App.css'

interface Master {
  id: number
  name: string
}

interface Service {
  id: number
  name: string
  duration_minutes: number
  price: number
}

interface Booking {
  id: number
  starts_at: string
  master_id: number
  master_name: string
  service_id: number
  service_name: string
  duration_minutes: number
  price: number
}

type Step = 'home' | 'service' | 'master' | 'time' | 'confirm' | 'done'

const STEP_ORDER: Step[] = ['service', 'master', 'time', 'confirm']

const STEP_TITLES: Record<Step, string> = {
  home: 'Мои записи',
  service: 'Выберите услугу',
  master: 'Выберите мастера',
  time: 'Дата и время',
  confirm: 'Подтвердите запись',
  done: 'Готово',
}

const API_URL = import.meta.env.VITE_API_URL ?? ''

function getTelegramUserId(): number {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.id ?? 111111
}

function serviceIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('стриж')) return '✂️'
  if (n.includes('окраш') || n.includes('цвет')) return '🎨'
  if (n.includes('маник') || n.includes('педик')) return '💅'
  if (n.includes('уклад') || n.includes('причёск') || n.includes('прическ')) return '💇‍♀️'
  if (n.includes('брит') || n.includes('бород')) return '🪒'
  if (n.includes('масс')) return '💆'
  return '✨'
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function App() {
  const [step, setStep] = useState<Step>('home')
  const [services, setServices] = useState<Service[]>([])
  const [masters, setMasters] = useState<Master[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [selectedService, setSelectedService] = useState<Service | null>(null)
  const [selectedMaster, setSelectedMaster] = useState<Master | null>(null)
  const [startsAt, setStartsAt] = useState('')

  const clientTelegramId = getTelegramUserId()
  const isTestUser = !(window as any).Telegram?.WebApp?.initDataUnsafe?.user

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp
    tg?.ready?.()
    tg?.expand?.()
  }, [])

  const fetchBookings = () =>
    fetch(`${API_URL}/api/bookings?client_telegram_id=${clientTelegramId}`)
      .then((r) => r.json())
      .then(setBookings)

  useEffect(() => {
    Promise.all([
      fetch(`${API_URL}/api/services`).then((r) => r.json()),
      fetch(`${API_URL}/api/masters`).then((r) => r.json()),
      fetchBookings(),
    ])
      .then(([servicesData, mastersData]) => {
        setServices(servicesData)
        setMasters(mastersData)
      })
      .catch(() => setError('Не удалось загрузить данные с сервера'))
      .finally(() => setLoading(false))
  }, [])

  const reset = () => {
    setSelectedService(null)
    setSelectedMaster(null)
    setStartsAt('')
    setError(null)
    setStep('home')
  }

  const goBack = () => {
    setError(null)
    if (step === 'service') setStep('home')
    else if (step === 'master') setStep('service')
    else if (step === 'time') setStep('master')
    else if (step === 'confirm') setStep('time')
  }

  const cancelBooking = async (id: number) => {
    if (!window.confirm('Отменить эту запись?')) return
    setCancellingId(id)
    try {
      await fetch(
        `${API_URL}/api/bookings/${id}?client_telegram_id=${clientTelegramId}`,
        { method: 'DELETE' }
      )
      setBookings((prev) => prev.filter((b) => b.id !== id))
    } catch {
      setError('Не удалось отменить запись')
    } finally {
      setCancellingId(null)
    }
  }

  const submitBooking = async () => {
    if (!selectedService || !selectedMaster || !startsAt) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_telegram_id: clientTelegramId,
          master_id: selectedMaster.id,
          service_id: selectedService.id,
          starts_at: startsAt,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не удалось создать запись')
        return
      }
      await fetchBookings()
      setStep('done')
    } catch {
      setError('Не удалось связаться с сервером')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="loading-screen">Загрузка…</div>
  }

  if (step === 'done') {
    return (
      <div className="app">
        <div className="done-screen">
          <div className="done-icon">🎉</div>
          <h1>Готово!</h1>
          <p>Вы записаны. Ждём вас в салоне.</p>
        </div>
        <div className="footer">
          <button className="primary" onClick={reset}>
            К моим записям
          </button>
        </div>
      </div>
    )
  }

  const progress = ((STEP_ORDER.indexOf(step) + 1) / STEP_ORDER.length) * 100

  return (
    <div className="app">
      <div className="topbar">
        {step !== 'home' && (
          <button className="icon-back" onClick={goBack} aria-label="Назад">
            ←
          </button>
        )}
        <div className="topbar-title">{STEP_TITLES[step]}</div>
        {isTestUser && <div className="test-badge">тест</div>}
      </div>

      {step !== 'home' && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="content">
        {error && <p className="error">{error}</p>}

        {step === 'home' &&
          (bookings.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🗓️</div>
              <p>У вас пока нет записей</p>
            </div>
          ) : (
            <div className="list">
              {bookings.map((b) => (
                <div key={b.id} className="booking-card">
                  <div className="booking-row">
                    <div className="badge">{serviceIcon(b.service_name)}</div>
                    <div className="card-body">
                      <div className="card-title">{b.service_name}</div>
                      <div className="card-sub">
                        {b.master_name} · {formatDateTime(b.starts_at)}
                      </div>
                    </div>
                  </div>
                  <button
                    className="cancel-link"
                    disabled={cancellingId === b.id}
                    onClick={() => cancelBooking(b.id)}
                  >
                    {cancellingId === b.id ? 'Отменяем…' : 'Отменить запись'}
                  </button>
                </div>
              ))}
            </div>
          ))}

        {step === 'service' && (
          <div className="list">
            {services.map((s) => (
              <button
                key={s.id}
                className="card"
                onClick={() => {
                  setSelectedService(s)
                  setStep('master')
                }}
              >
                <div className="badge">{serviceIcon(s.name)}</div>
                <div className="card-body">
                  <div className="card-title">{s.name}</div>
                  <div className="card-sub">
                    {s.duration_minutes} мин · {s.price} ₽
                  </div>
                </div>
                <div className="card-arrow">›</div>
              </button>
            ))}
          </div>
        )}

        {step === 'master' && (
          <div className="list">
            {masters.map((m) => (
              <button
                key={m.id}
                className="card"
                onClick={() => {
                  setSelectedMaster(m)
                  setStep('time')
                }}
              >
                <div className="avatar">{initials(m.name)}</div>
                <div className="card-body">
                  <div className="card-title">{m.name}</div>
                </div>
                <div className="card-arrow">›</div>
              </button>
            ))}
          </div>
        )}

        {step === 'time' && (
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="datetime-input"
          />
        )}

        {step === 'confirm' && selectedService && selectedMaster && (
          <div className="summary">
            <div className="summary-row">
              <span className="summary-label">Услуга</span>
              <span className="summary-value">{selectedService.name}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Мастер</span>
              <span className="summary-value">{selectedMaster.name}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Время</span>
              <span className="summary-value">{startsAt.replace('T', ' ')}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Цена</span>
              <span className="summary-value">{selectedService.price} ₽</span>
            </div>
          </div>
        )}
      </div>

      {step === 'home' && (
        <div className="footer">
          <button className="primary" onClick={() => setStep('service')}>
            Записаться
          </button>
        </div>
      )}

      {step === 'time' && (
        <div className="footer">
          <button className="primary" disabled={!startsAt} onClick={() => setStep('confirm')}>
            Далее
          </button>
        </div>
      )}

      {step === 'confirm' && (
        <div className="footer">
          <button className="primary" disabled={submitting} onClick={submitBooking}>
            {submitting ? 'Записываем…' : 'Записаться'}
          </button>
        </div>
      )}
    </div>
  )
}

export default App
