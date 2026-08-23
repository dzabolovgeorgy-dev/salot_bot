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

type Step = 'service' | 'master' | 'time' | 'confirm' | 'done'

const API_URL = import.meta.env.VITE_API_URL ?? ''

function getTelegramUserId(): number {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.id ?? 111111
}

function App() {
  const [step, setStep] = useState<Step>('service')
  const [services, setServices] = useState<Service[]>([])
  const [masters, setMasters] = useState<Master[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [selectedService, setSelectedService] = useState<Service | null>(null)
  const [selectedMaster, setSelectedMaster] = useState<Master | null>(null)
  const [startsAt, setStartsAt] = useState('')

  const clientTelegramId = getTelegramUserId()
  const isTestUser = !(window as any).Telegram?.WebApp?.initDataUnsafe?.user

  useEffect(() => {
    Promise.all([
      fetch(`${API_URL}/api/services`).then((r) => r.json()),
      fetch(`${API_URL}/api/masters`).then((r) => r.json()),
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
    setStep('service')
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
      setStep('done')
    } catch {
      setError('Не удалось связаться с сервером')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="screen">Загрузка…</div>
  }

  return (
    <div className="screen">
      {isTestUser && <div className="test-badge">тестовый пользователь</div>}

      {step === 'service' && (
        <>
          <h1>Выберите услугу</h1>
          {error && <p className="error">{error}</p>}
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
                <div className="card-title">{s.name}</div>
                <div className="card-sub">
                  {s.duration_minutes} мин · {s.price} ₽
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 'master' && (
        <>
          <h1>Выберите мастера</h1>
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
                <div className="card-title">{m.name}</div>
              </button>
            ))}
          </div>
          <button className="back" onClick={() => setStep('service')}>
            Назад
          </button>
        </>
      )}

      {step === 'time' && (
        <>
          <h1>Выберите дату и время</h1>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="datetime-input"
          />
          <button
            className="primary"
            disabled={!startsAt}
            onClick={() => setStep('confirm')}
          >
            Далее
          </button>
          <button className="back" onClick={() => setStep('master')}>
            Назад
          </button>
        </>
      )}

      {step === 'confirm' && selectedService && selectedMaster && (
        <>
          <h1>Подтвердите запись</h1>
          <div className="summary">
            <div>
              <strong>Услуга:</strong> {selectedService.name}
            </div>
            <div>
              <strong>Мастер:</strong> {selectedMaster.name}
            </div>
            <div>
              <strong>Время:</strong> {startsAt.replace('T', ' ')}
            </div>
            <div>
              <strong>Цена:</strong> {selectedService.price} ₽
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={submitting} onClick={submitBooking}>
            {submitting ? 'Записываем…' : 'Записаться'}
          </button>
          <button className="back" onClick={() => setStep('time')}>
            Назад
          </button>
        </>
      )}

      {step === 'done' && (
        <>
          <h1>Готово!</h1>
          <p>Вы записаны. Ждём вас в салоне.</p>
          <button className="primary" onClick={reset}>
            Записаться ещё
          </button>
        </>
      )}
    </div>
  )
}

export default App
