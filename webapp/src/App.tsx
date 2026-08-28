import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Home,
  Palette,
  Scissors,
  Sparkles,
  UserRound,
  Wind,
} from 'lucide-react'
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
// (если зашли через конкретную услугу/мастера — этот выбор уже сделано)
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

const TIME_SLOTS = ['10:00', '11:30', '13:00', '15:00', '16:30', '18:00']
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

const API_URL = import.meta.env.VITE_API_URL ?? ''

function getTelegramUserId(): number {
  const tgUser = (window as any).Telegram?.WebApp?.initDataUnsafe?.user
  return tgUser?.id ?? 111111
}

function ServiceIcon({ name, size = 20 }: { name: string; size?: number }) {
  const n = name.toLowerCase()
  if (n.includes('стриж')) return <Scissors size={size} />
  if (n.includes('окраш') || n.includes('цвет')) return <Palette size={size} />
  if (n.includes('маник') || n.includes('педик')) return <Sparkles size={size} />
  if (n.includes('уклад') || n.includes('причёск') || n.includes('прическ')) return <Wind size={size} />
  if (n.includes('брит') || n.includes('бород')) return <UserRound size={size} />
  return <Sparkles size={size} />
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

function pluralizeYears(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} год`
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return `${n} года`
  return `${n} лет`
}

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function buildUpcomingDates(count = 7): { key: string; label: string }[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const result: { key: string; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() + i)
    const dayLabel = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : WEEKDAYS[d.getDay()]
    const label = `${dayLabel}, ${d.getDate()} ${MONTHS[d.getMonth()]}`
    result.push({ key: dateKeyOf(d), label })
  }
  return result
}

function ServiceRow({ service, onClick }: { service: Service; onClick: () => void }) {
  return (
    <button className="service-row" onClick={onClick}>
      <span className="service-row-icon">
        <ServiceIcon name={service.name} size={22} />
      </span>
      <span className="service-row-body">
        <span className="service-row-name">{service.name}</span>
        <span className="service-row-duration">
          <Clock3 size={13} />
          {service.duration_minutes} мин
        </span>
      </span>
      <span className="service-row-price">{service.price} ₽</span>
      <ChevronRight size={16} className="service-row-arrow" />
    </button>
  )
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
  const [dateKey, setDateKey] = useState('')
  const [timeSlot, setTimeSlot] = useState('')

  const clientTelegramId = getTelegramUserId()
  const isTestUser = !(window as any).Telegram?.WebApp?.initDataUnsafe?.user

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp
    tg?.ready?.()
    tg?.expand?.()
    // Цвет шапки/фона самого Telegram вокруг мини-приложения — подгоняем под
    // палитру дизайна (без этого Telegram красит их своим цветом темы)
    try {
      tg?.setHeaderColor?.('#fffaf6')
      tg?.setBackgroundColor?.('#fffaf6')
      tg?.setBottomBarColor?.('#fffaf6')
    } catch {
      // старые версии Telegram могут не поддерживать эти методы — не критично
    }
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

  useEffect(() => {
    setStartsAt(dateKey && timeSlot ? `${dateKey}T${timeSlot}` : '')
  }, [dateKey, timeSlot])

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
    setDateKey('')
    setTimeSlot('')
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
            <p className="hero-eyebrow">{masterProfile.experience_years != null ? pluralizeYears(masterProfile.experience_years) + ' опыта' : ''}</p>
            <div className="hero-name">{masterProfile.name}</div>
          </div>
        </div>
        <div className="content">
          {error && <p className="error">{error}</p>}
          {masterProfile.bio && <p className="profile-bio">{masterProfile.bio}</p>}
          <div className="section-title">Услуги мастера</div>
          <div className="list">
            {masterServices.map((s) => (
              <ServiceRow key={s.id} service={s} onClick={() => bookFromProfile(masterProfile, s)} />
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
          <div className="done-icon">
            <Check size={32} />
          </div>
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

  const upcomingDates = buildUpcomingDates()
  const todayKey = upcomingDates[0]?.key ?? ''
  const nowHHMM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
  const availableTimeSlots = dateKey === todayKey ? TIME_SLOTS.filter((t) => t > nowHHMM) : TIME_SLOTS

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
            <img
              className="hero-photo"
              src={`${import.meta.env.BASE_URL}images/atelier-header.jpg`}
              alt=""
            />
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
                <div className="confirm-card-media">
                  <ServiceIcon name={heroBooking.service_name} size={26} />
                </div>
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
              <div className="service-strip">
                {services.slice(0, 5).map((s) => (
                  <button key={s.id} className="service-chip" onClick={() => setActiveTab('services')}>
                    <span className="service-chip-icon">
                      <ServiceIcon name={s.name} size={22} />
                    </span>
                    <span className="service-chip-name">{s.name}</span>
                  </button>
                ))}
              </div>
              <button className="primary" onClick={() => setActiveTab('services')}>
                Записаться сейчас
              </button>
              <button className="link-button" onClick={() => setActiveTab('masters')}>
                Смотреть мастеров <Sparkles size={14} />
              </button>
            </>
          ))}

        {!inFlow && activeTab === 'services' && (
          <div className="list">
            {services.map((s) => (
              <ServiceRow
                key={s.id}
                service={s}
                onClick={() => {
                  setSelectedService(s)
                  startFlow('services')
                }}
              />
            ))}
          </div>
        )}

        {!inFlow && activeTab === 'masters' && (
          <div className="masters-grid">
            {masters.map((m, i) => (
              <button
                key={m.id}
                className={`master-tile master-tile-${i % 3}`}
                onClick={() => setMasterProfile(m)}
              >
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
              <div className="empty-icon">
                <CalendarDays size={26} />
              </div>
              <h2>Записей пока нет</h2>
              <p>Выберите услугу и найдите удобное время для визита.</p>
              <button className="primary" onClick={() => setActiveTab('services')}>
                Выбрать услугу
              </button>
            </div>
          ) : (
            <div className="list">
              {bookings.map((b) => {
                const master = masters.find((m) => m.id === b.master_id)
                return (
                  <article key={b.id} className="booking-tile">
                    {master?.photo_url ? (
                      <img className="booking-tile-photo" src={master.photo_url} alt={master.name} />
                    ) : (
                      <div className="booking-tile-photo booking-tile-photo-fallback">
                        <ServiceIcon name={b.service_name} size={24} />
                      </div>
                    )}
                    <div className="booking-tile-body">
                      <div>
                        <p className="confirm-eyebrow">Предстоящая</p>
                        <h2 className="confirm-title">{b.service_name}</h2>
                        <p className="booking-tile-master">{b.master_name}</p>
                      </div>
                      <div className="booking-tile-footer">
                        <span className="booking-tile-time">{formatDateTime(b.starts_at)}</span>
                        <button
                          className="cancel-link"
                          disabled={cancellingId === b.id}
                          onClick={() => cancelBooking(b.id)}
                        >
                          {cancellingId === b.id ? 'Отменяем…' : 'Отменить'}
                        </button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ))}

        {inFlow && flowStep === 'service' && (
          <div className="list">
            {flowServices.map((s) => (
              <ServiceRow
                key={s.id}
                service={s}
                onClick={() => {
                  setSelectedService(s)
                  setFlowIndex((i) => i + 1)
                }}
              />
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

        {inFlow && flowStep === 'time' && selectedMaster && selectedService && (
          <>
            <p className="eyebrow-label">Ваш специалист</p>
            <div className="specialist-card">
              {selectedMaster.photo_url ? (
                <img className="specialist-photo" src={selectedMaster.photo_url} alt={selectedMaster.name} />
              ) : (
                <div className="avatar">{initials(selectedMaster.name)}</div>
              )}
              <div className="specialist-body">
                <div className="specialist-name">{selectedMaster.name}</div>
                <div className="specialist-service">
                  {selectedService.name} · {selectedService.duration_minutes} мин
                </div>
              </div>
              <Check size={18} className="specialist-check" />
            </div>

            <div className="section-title">Выберите дату</div>
            <div className="date-pills">
              {upcomingDates.map((d) => (
                <button
                  key={d.key}
                  className={`date-pill${dateKey === d.key ? ' active' : ''}`}
                  onClick={() => {
                    setDateKey(d.key)
                    setTimeSlot('')
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>

            <div className="section-title">Свободное время</div>
            {dateKey ? (
              availableTimeSlots.length > 0 ? (
                <div className="time-grid">
                  {availableTimeSlots.map((t) => (
                    <button
                      key={t}
                      className={`time-slot${timeSlot === t ? ' active' : ''}`}
                      onClick={() => setTimeSlot(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="hub-greeting">На сегодня свободного времени не осталось — выберите другой день.</p>
              )
            ) : (
              <p className="hub-greeting">Сначала выберите дату.</p>
            )}
          </>
        )}

        {inFlow && flowStep === 'confirm' && selectedService && selectedMaster && (
          <article className="confirm-card confirm-card-tall">
            {selectedMaster.photo_url ? (
              <img className="confirm-card-photo" src={selectedMaster.photo_url} alt={selectedMaster.name} />
            ) : (
              <div className="confirm-card-photo confirm-card-photo-fallback">{initials(selectedMaster.name)}</div>
            )}
            <div className="confirm-card-tall-body">
              <p className="confirm-eyebrow">Ваша запись</p>
              <h2 className="confirm-title">{selectedService.name}</h2>
              <div className="confirm-master-row">
                {selectedMaster.photo_url ? (
                  <img className="avatar-photo" src={selectedMaster.photo_url} alt={selectedMaster.name} />
                ) : (
                  <div className="avatar">{initials(selectedMaster.name)}</div>
                )}
                <span className="confirm-master-name">{selectedMaster.name}</span>
              </div>
              <div className="summary-list">
                <div className="summary-row">
                  <span className="summary-label">Дата и время</span>
                  <span className="summary-value">{formatDateTime(startsAt)}</span>
                </div>
                <div className="summary-row">
                  <span className="summary-label">Стоимость</span>
                  <span className="summary-value">{selectedService.price} ₽</span>
                </div>
              </div>
            </div>
          </article>
        )}
      </motion.div>
      </AnimatePresence>

      {!inFlow && activeTab === 'bookings' && bookings.length > 0 && (
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
            Продолжить
          </button>
        </div>
      )}

      {inFlow && flowStep === 'confirm' && (
        <>
          <div className="footer footer-note">
            <button className="primary" disabled={submitting} onClick={submitBooking}>
              {submitting ? 'Записываем…' : 'Записаться'}
            </button>
            <p className="footer-hint">Оплата производится в салоне после визита.</p>
          </div>
        </>
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
