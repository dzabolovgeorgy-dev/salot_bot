import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, CalendarDays, Home, Sparkles, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './App.css'

interface Master {
  id: number
  name: string
  bio: string | null
  experience_years: number | null
  photo_url: string | null
  service_ids: number[]
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

type Tab = 'home' | 'services' | 'masters' | 'bookings'
type FlowOrigin = 'services' | 'masters' | 'bookings'
type FlowStep = 'service' | 'master' | 'time' | 'confirm'

const TABS: { key: Tab; label: string; Icon: LucideIcon }[] = [
  { key: 'home', label: 'Главная', Icon: Home },
  { key: 'services', label: 'Услуги', Icon: Sparkles },
  { key: 'masters', label: 'Мастера', Icon: UserRound },
  { key: 'bookings', label: 'Записи', Icon: CalendarDays },
]

const TAB_TITLES: Record<Tab, string> = {
  home: 'Главная',
  services: 'Услуги',
  masters: 'Мастера',
  bookings: 'Мои записи',
}

// Какие шаги остаются пройти в зависимости от того, откуда начали запись
// (если зашли через конкретную услугу/мастера — этот выбор уже сделан)
const FLOW_STEPS: Record<FlowOrigin, FlowStep[]> = {
  services: ['master', 'time', 'confirm'],
  masters: ['service', 'time', 'confirm'],
  bookings: ['service', 'master', 'time', 'confirm'],
}

const STEP_TITLES: Record<FlowStep, string> = {
  service: 'Выберите услугу',
  master: 'Выберите мастера',
  time: 'Дата и время',
  confirm: 'Подтвердите запись',
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

function nowForDateTimeInput(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function pluralizeYears(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} год`
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return `${n} года`
  return `${n} лет`
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home')
  const [flowOrigin, setFlowOrigin] = useState<FlowOrigin | null>(null)
  const [flowIndex, setFlowIndex] = useState(0)
  const [isDone, setIsDone] = useState(false)
  const [masterProfile, setMasterProfile] = useState<Master | null>(null)

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

  const startFlow = (origin: FlowOrigin) => {
    setError(null)
    setFlowOrigin(origin)
    setFlowIndex(0)
  }

  const bookFromProfile = (master: Master, service: Service) => {
    setError(null)
    setSelectedMaster(master)
    setSelectedService(service)
    setMasterProfile(null)
    setFlowOrigin('masters')
    // и услуга, и мастер уже известны — сразу переходим к выбору времени
    setFlowIndex(FLOW_STEPS.masters.indexOf('time'))
  }

  const exitFlow = () => {
    setSelectedService(null)
    setSelectedMaster(null)
    setStartsAt('')
    setError(null)
    setFlowOrigin(null)
    setFlowIndex(0)
  }

  const goBack = () => {
    setError(null)
    if (masterProfile) {
      setMasterProfile(null)
      return
    }
    if (flowIndex === 0) exitFlow()
    else setFlowIndex((i) => i - 1)
  }

  const goToBookings = () => {
    setIsDone(false)
    exitFlow()
    setActiveTab('bookings')
  }

  const cancelBooking = async (id: number) => {
    if (!window.confirm('Отменить эту запись?')) return
    setCancellingId(id)
    try {
      const res = await fetch(
        `${API_URL}/api/bookings/${id}?client_telegram_id=${clientTelegramId}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        setError('Не удалось отменить запись')
        return
      }
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
      setIsDone(true)
    } catch {
      setError('Не удалось связаться с сервером')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="loading-screen">Загрузка…</div>
  }

  if (masterProfile) {
    const masterServices = services.filter((s) => masterProfile.service_ids.includes(s.id))
    return (
      <motion.div
        className="app app-hero"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="hero">
          {masterProfile.photo_url ? (
            <img className="hero-photo" src={masterProfile.photo_url} alt={masterProfile.name} />
          ) : (
            <div className="hero-photo hero-photo-fallback">{initials(masterProfile.name)}</div>
          )}
          <div className="hero-scrim" />
          <button className="hero-back" onClick={goBack} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
          {isTestUser && <div className="hero-badge">тест</div>}
          <div className="hero-text">
            <div className="hero-name">{masterProfile.name}</div>
            {masterProfile.experience_years != null && (
              <div className="hero-sub">{pluralizeYears(masterProfile.experience_years)} опыта</div>
            )}
          </div>
        </div>
        <div className="content">
          {error && <p className="error">{error}</p>}
          {masterProfile.bio && <p className="profile-bio">{masterProfile.bio}</p>}
          <div className="section-title">Что делает</div>
          <div className="list">
            {masterServices.map((s) => (
              <button key={s.id} className="card" onClick={() => bookFromProfile(masterProfile, s)}>
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
        </div>
      </motion.div>
    )
  }

  if (isDone) {
    return (
      <motion.div
        className="app"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="done-screen">
          <div className="done-icon">🎉</div>
          <h1>Готово!</h1>
          <p>Вы записаны. Ждём вас в салоне.</p>
        </div>
        <div className="footer">
          <button className="primary" onClick={goToBookings}>
            К моим записям
          </button>
        </div>
      </motion.div>
    )
  }

  const inFlow = flowOrigin !== null
  const flowSteps = flowOrigin ? FLOW_STEPS[flowOrigin] : null
  const flowStep = flowSteps ? flowSteps[flowIndex] : null
  const progress = flowSteps ? ((flowIndex + 1) / flowSteps.length) * 100 : 0
  const showChrome = !inFlow

  const flowServices = selectedMaster
    ? services.filter((s) => selectedMaster.service_ids.includes(s.id))
    : services
  const flowMasters = selectedService
    ? masters.filter((m) => m.service_ids.includes(selectedService.id))
    : masters

  const screenKey = inFlow ? `flow-${flowStep}` : `tab-${activeTab}`
  const isHomeHero = !inFlow && activeTab === 'home'
  const heroBooking = bookings[0] ?? null
  const heroMaster = heroBooking ? masters.find((m) => m.id === heroBooking.master_id) ?? null : null

  return (
    <div className="app">
      {isHomeHero ? (
        <div className="hero hero-compact">
          {heroMaster?.photo_url ? (
            <img className="hero-photo" src={heroMaster.photo_url} alt="" />
          ) : (
            <div className="hero-photo hero-photo-fallback">✨</div>
          )}
          <div className="hero-scrim" />
          {isTestUser && <div className="hero-badge">тест</div>}
          <div className="hero-text">
            <p className="hero-eyebrow">{heroBooking ? 'ВАША ЗАПИСЬ' : 'САЛОН КРАСОТЫ'}</p>
            <div className="hero-name">{heroBooking ? heroBooking.service_name : 'Добро пожаловать'}</div>
          </div>
        </div>
      ) : (
        <div className="topbar">
          {inFlow && (
            <button className="icon-back" onClick={goBack} aria-label="Назад">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="topbar-title">
            {inFlow && flowStep ? STEP_TITLES[flowStep] : TAB_TITLES[activeTab]}
          </div>
          {isTestUser && <div className="test-badge">тест</div>}
        </div>
      )}

      {inFlow && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={screenKey}
        className={`content${isHomeHero ? ' sheet' : ''}`}
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -16 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        {error && <p className="error">{error}</p>}

        {isHomeHero &&
          (heroBooking && heroMaster ? (
            <>
              <article className="confirm-card">
                <div className="confirm-card-media">{serviceIcon(heroBooking.service_name)}</div>
                <div className="confirm-card-body">
                  <div>
                    <p className="confirm-eyebrow">Подтверждено</p>
                    <h2 className="confirm-title">{heroBooking.service_name}</h2>
                  </div>
                  <div className="confirm-master-row">
                    {heroMaster.photo_url ? (
                      <img className="avatar-photo" src={heroMaster.photo_url} alt={heroMaster.name} />
                    ) : (
                      <div className="avatar">{initials(heroMaster.name)}</div>
                    )}
                    <span className="confirm-master-name">{heroMaster.name}</span>
                  </div>
                </div>
              </article>

              <div className="details-grid">
                <div className="details-col">
                  <p className="eyebrow-label">Быстрые действия</p>
                  <button className="text-link" onClick={() => setActiveTab('services')}>
                    Все услуги
                  </button>
                  <button className="text-link" onClick={() => setActiveTab('masters')}>
                    Наши мастера
                  </button>
                </div>
                <div className="details-col">
                  <p className="eyebrow-label">Дата и время</p>
                  <div className="detail-row">
                    <span>Дата</span>
                    <strong>{formatDateTime(heroBooking.starts_at)}</strong>
                  </div>
                </div>
              </div>

              <button className="primary" onClick={() => setActiveTab('bookings')}>
                Мои записи
              </button>
              <button className="link-button" onClick={() => setActiveTab('services')}>
                Смотреть все услуги <Sparkles size={14} />
              </button>
            </>
          ) : (
            <>
              <p className="hub-greeting">
                У вас пока нет записи. Выберите услугу или мастера, чтобы записаться в пару кликов.
              </p>
              <button className="primary" onClick={() => setActiveTab('services')}>
                Записаться
              </button>
              <button className="link-button" onClick={() => setActiveTab('masters')}>
                Смотреть мастеров <Sparkles size={14} />
              </button>
            </>
          ))}

        {!inFlow && activeTab === 'services' && (
          <div className="list">
            {services.map((s) => (
              <button
                key={s.id}
                className="card"
                onClick={() => {
                  setSelectedService(s)
                  startFlow('services')
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

        {!inFlow && activeTab === 'masters' && (
          <div className="masters-grid">
            {masters.map((m) => (
              <button key={m.id} className="master-tile" onClick={() => setMasterProfile(m)}>
                {m.photo_url ? (
                  <img src={m.photo_url} alt={m.name} />
                ) : (
                  <div className="master-tile-fallback">{initials(m.name)}</div>
                )}
                <div className="master-tile-scrim" />
                <div className="master-tile-caption">
                  <div className="master-tile-name">{m.name}</div>
                  {m.experience_years != null && (
                    <div className="master-tile-sub">{pluralizeYears(m.experience_years)} опыта</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {!inFlow &&
          activeTab === 'bookings' &&
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

        {inFlow && flowStep === 'service' && (
          <div className="list">
            {flowServices.map((s) => (
              <button
                key={s.id}
                className="card"
                onClick={() => {
                  setSelectedService(s)
                  setFlowIndex((i) => i + 1)
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

        {inFlow && flowStep === 'master' && (
          <div className="list">
            {flowMasters.map((m) => (
              <button
                key={m.id}
                className="card"
                onClick={() => {
                  setSelectedMaster(m)
                  setFlowIndex((i) => i + 1)
                }}
              >
                {m.photo_url ? (
                  <img className="avatar-photo" src={m.photo_url} alt={m.name} />
                ) : (
                  <div className="avatar">{initials(m.name)}</div>
                )}
                <div className="card-body">
                  <div className="card-title">{m.name}</div>
                </div>
                <div className="card-arrow">›</div>
              </button>
            ))}
          </div>
        )}

        {inFlow && flowStep === 'time' && (
          <input
            type="datetime-local"
            value={startsAt}
            min={nowForDateTimeInput()}
            onChange={(e) => setStartsAt(e.target.value)}
            className="datetime-input"
          />
        )}

        {inFlow && flowStep === 'confirm' && selectedService && selectedMaster && (
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
      </motion.div>
      </AnimatePresence>

      {!inFlow && activeTab === 'bookings' && (
        <div className="footer">
          <button className="primary" onClick={() => startFlow('bookings')}>
            Записаться
          </button>
        </div>
      )}

      {inFlow && flowStep === 'time' && (
        <div className="footer">
          <button
            className="primary"
            disabled={!startsAt}
            onClick={() => setFlowIndex((i) => i + 1)}
          >
            Далее
          </button>
        </div>
      )}

      {inFlow && flowStep === 'confirm' && (
        <div className="footer">
          <button className="primary" disabled={submitting} onClick={submitBooking}>
            {submitting ? 'Записываем…' : 'Записаться'}
          </button>
        </div>
      )}

      {showChrome && (
        <div className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab-item${activeTab === t.key ? ' active' : ''}`}
              onClick={() => {
                setError(null)
                setActiveTab(t.key)
              }}
            >
              <t.Icon className="tab-icon" size={20} strokeWidth={1.75} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default App
