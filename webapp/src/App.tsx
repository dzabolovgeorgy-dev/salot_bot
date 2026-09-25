import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  Award,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Heart,
  Home,
  Images,
  Palette,
  Scissors,
  Sparkles,
  UserRound,
  Wind,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './App.css'
import type {
  Master,
  Service,
  Booking,
  MasterPhoto,
  PhotoFolder,
  InspirationPhoto,
  SavedPhoto,
  LoyaltyStatus,
  MasterReview,
  LoyaltyHistoryEntry,
} from './types'
import { getTelegramUserId, getTelegramUserName, getTelegramUsername } from './telegram'
import { apiFetch } from './apiFetch'
import { isWorkDay, generateTimeSlots, slotStep, DEFAULT_BUFFER_MINUTES } from './schedule'
import { MONTH_NAMES, WEEKDAY_LABELS, dateKeyOf, startOfMonth, buildMonthCells } from './calendar'

// Нижняя навигация: 3 раздела. "Главная" — карточка клиента (имя, контакт),
// карта лояльности, "Сохранённое" и статус ближайшей записи — как было
// изначально, плюс карточка клиента (раньше жила в отдельной вкладке
// "Профиль", но дублировала "Главную" почти целиком — убрали, чтобы не
// путать одно и то же под двумя разными кнопками).
// "Записаться" объединяет в себе бывшие Услуги + Мастера + Вдохновение
// (см. BookSubTab ниже)
type Tab = 'home' | 'book' | 'bookings'
type BookSubTab = 'services' | 'masters' | 'inspiration'
type BookingsSubTab = 'upcoming' | 'history'
type FlowOrigin = 'services' | 'masters' | 'bookings'
type FlowStep = 'service' | 'master' | 'time' | 'confirm'

const TABS: { key: Tab; label: string; Icon: LucideIcon }[] = [
  { key: 'home', label: 'Главная', Icon: Home },
  { key: 'book', label: 'Записаться', Icon: Sparkles },
  { key: 'bookings', label: 'Мои записи', Icon: CalendarDays },
]

const TAB_TITLES: Record<Tab, string> = {
  home: 'Главная',
  book: 'Записаться',
  bookings: 'Мои записи',
}

const BOOK_SUB_TABS: { key: BookSubTab; label: string }[] = [
  { key: 'services', label: 'Услуги' },
  { key: 'masters', label: 'Мастера' },
  { key: 'inspiration', label: 'Вдохновение' },
]

const BOOKINGS_SUB_TABS: { key: BookingsSubTab; label: string }[] = [
  { key: 'upcoming', label: 'Предстоящие' },
  { key: 'history', label: 'История' },
]

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

const API_URL = import.meta.env.VITE_API_URL ?? ''

// Пороги (в € потраченного) и цвета уровней — для подписи и прогресс-бара на
// карточке лояльности. Пороги должны совпадать с LOYALTY_TIERS на сервере
// (server/src/loyalty.ts) — там источник истины для самого начисления,
// здесь только чтобы нарисовать прогресс, держать значения в синхроне
const TIER_META = [
  { name: 'Новичок', min: 0, color: '#9c8b7d', bg: '#efe9e1' },
  { name: 'Серебро', min: 150, color: '#8f8478', bg: '#efe9e2' },
  { name: 'Золото', min: 450, color: '#ad7f1f', bg: '#f4e8d0' },
  { name: 'Платина', min: 900, color: '#8c6a63', bg: '#f1e6e2' },
] as const

function tierProgress(status: LoyaltyStatus) {
  const idx = TIER_META.findIndex((t) => t.name === status.tier_name)
  const current = TIER_META[idx] ?? TIER_META[0]
  const next = TIER_META[idx + 1] ?? null
  const span = next ? next.min - current.min : 0
  const pct = next && span > 0 ? Math.min(100, Math.max(0, ((status.total_spent - current.min) / span) * 100)) : 100
  return { current, next, pct }
}

// Насыщенные, "физические" цвета карты на отдельном экране "Моя карта
// лояльности" — в духе настоящей металлической карты. Отдельно от TIER_META
// (та даёт приглушённый тон для компактной карточки на главном экране)
const TIER_CARD_META: Record<string, { bg: string; text: string; sub: string; accent: string }> = {
  Новичок: { bg: '#E8DFD3', text: '#2E2A26', sub: 'rgba(46, 42, 38, 0.62)', accent: '#B08F6A' },
  Серебро: { bg: '#B8BCC2', text: '#2E2A26', sub: 'rgba(46, 42, 38, 0.62)', accent: '#6E7580' },
  Золото: { bg: '#D4AF6A', text: '#2E2A26', sub: 'rgba(46, 42, 38, 0.62)', accent: '#8A6A2C' },
  Платина: { bg: '#3D3D42', text: '#F5F1EA', sub: 'rgba(245, 241, 234, 0.62)', accent: '#D4AF6A' },
}

function loyaltyHistoryLabel(h: LoyaltyHistoryEntry): string {
  if (h.reason === 'начисление за визит') return h.service_name ?? 'Начисление за визит'
  if (h.reason === 'списание при оплате') return 'Списание при оплате'
  if (h.reason === 'сгорание') return 'Сгорание баллов'
  return h.reason
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

// Категория фото в "Вдохновении" — это просто текст (например "Стрижка"),
// а не привязка к конкретной услуге. Чтобы кнопка "Записаться" сама
// подставила нужную услугу, ищем услугу с похожим названием
function matchServiceByCategory(category: string, services: Service[]): Service | null {
  const norm = (s: string) => s.trim().toLowerCase()
  const target = norm(category)
  return (
    services.find((s) => norm(s.name) === target) ??
    services.find((s) => norm(s.name).includes(target) || target.includes(norm(s.name))) ??
    null
  )
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

function startOfDay(d: Date): Date {
  const copy = new Date(d)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}


function isSlotFree(
  slotTime: string,
  durationMinutes: number,
  busy: { starts_at: string; duration_minutes: number }[],
  bufferMinutes: number
): boolean {
  const slotStart = minutesOf(slotTime)
  const slotEnd = slotStart + durationMinutes
  return !busy.some((b) => {
    const busyStart = minutesOf(b.starts_at.slice(11, 16)) - bufferMinutes
    const busyEnd = busyStart + b.duration_minutes + 2 * bufferMinutes
    return slotStart < busyEnd && busyStart < slotEnd
  })
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
      <span className="service-row-price">{service.price} €</span>
      <ChevronRight size={16} className="service-row-arrow" />
    </button>
  )
}

function DateTimePicker({
  master,
  service,
  dateKey,
  timeSlot,
  calendarMonth,
  today,
  todayKey,
  availableTimeSlots,
  isCurrentMonth,
  onPickDate,
  onPickTime,
  onPrevMonth,
  onNextMonth,
}: {
  master: Master
  service: Service
  dateKey: string
  timeSlot: string
  calendarMonth: Date
  today: Date
  todayKey: string
  availableTimeSlots: string[]
  isCurrentMonth: boolean
  onPickDate: (key: string) => void
  onPickTime: (t: string) => void
  onPrevMonth: () => void
  onNextMonth: () => void
}) {
  const monthCells = buildMonthCells(calendarMonth)
  return (
    <>
      <p className="eyebrow-label">Ваш специалист</p>
      <div className="specialist-card">
        {master.photo_url ? (
          <img className="specialist-photo" src={master.photo_url} alt={master.name} />
        ) : (
          <div className="avatar">{initials(master.name)}</div>
        )}
        <div className="specialist-body">
          <div className="specialist-name">{master.name}</div>
          <div className="specialist-service">
            {service.name} · {service.duration_minutes} мин
          </div>
        </div>
        <Check size={18} className="specialist-check" />
      </div>

      <div className="section-title">Выберите дату</div>
      <div className="calendar">
        <div className="calendar-header">
          <button
            type="button"
            className="calendar-nav-btn"
            disabled={isCurrentMonth}
            onClick={onPrevMonth}
            aria-label="Предыдущий месяц"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="calendar-month-label">
            {MONTH_NAMES[calendarMonth.getMonth()]} {calendarMonth.getFullYear()}
          </span>
          <button type="button" className="calendar-nav-btn" onClick={onNextMonth} aria-label="Следующий месяц">
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="calendar-weekdays">
          {WEEKDAY_LABELS.map((w) => (
            <span key={w} className="calendar-weekday">
              {w}
            </span>
          ))}
        </div>
        <div className="calendar-grid">
          {monthCells.map((d, i) => {
            if (!d) return <span key={`empty-${i}`} className="calendar-day calendar-day-empty" />
            const key = dateKeyOf(d)
            const dayOff = !isWorkDay(key, master)
            return (
              <button
                key={key}
                type="button"
                className={`calendar-day${dateKey === key ? ' active' : ''}${key === todayKey ? ' today' : ''}${dayOff ? ' day-off' : ''}`}
                disabled={d < today || dayOff}
                title={dayOff ? 'У мастера выходной' : undefined}
                onClick={() => onPickDate(key)}
              >
                {d.getDate()}
              </button>
            )
          })}
        </div>
      </div>

      <div className="section-title">Свободное время</div>
      {dateKey ? (
        availableTimeSlots.length > 0 ? (
          <div className="time-grid">
            {availableTimeSlots.map((t) => (
              <button
                key={t}
                className={`time-slot${timeSlot === t ? ' active' : ''}`}
                onClick={() => onPickTime(t)}
              >
                {t}
              </button>
            ))}
          </div>
        ) : (
          <p className="hub-greeting">На эту дату свободного времени не осталось — выберите другой день.</p>
        )
      ) : (
        <p className="hub-greeting">Сначала выберите дату.</p>
      )}
    </>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home')
  const [activeBookSubTab, setActiveBookSubTab] = useState<BookSubTab>('services')
  const [flowOrigin, setFlowOrigin] = useState<FlowOrigin | null>(null)
  const [flowIndex, setFlowIndex] = useState(0)
  const [isDone, setIsDone] = useState(false)
  const [masterProfile, setMasterProfile] = useState<Master | null>(null)
  const [masterProfilePhotos, setMasterProfilePhotos] = useState<MasterPhoto[]>([])
  const [masterPhotoFolders, setMasterPhotoFolders] = useState<PhotoFolder[]>([])
  const [activeProfileFolder, setActiveProfileFolder] = useState<number | 'all'>('all')
  const [masterReviews, setMasterReviews] = useState<MasterReview[]>([])
  const [reviewsOpen, setReviewsOpen] = useState(false)
  const [openPhoto, setOpenPhoto] = useState<MasterPhoto | null>(null)

  const [services, setServices] = useState<Service[]>([])
  const [masters, setMasters] = useState<Master[]>([])
  const [inspirationPhotos, setInspirationPhotos] = useState<InspirationPhoto[]>([])
  const [activeInspirationCategory, setActiveInspirationCategory] = useState<string | 'all'>('all')
  const [activeInspirationTag, setActiveInspirationTag] = useState<string | 'all'>('all')
  const [openInspirationPhoto, setOpenInspirationPhoto] = useState<InspirationPhoto | null>(null)
  const [savedPhotos, setSavedPhotos] = useState<SavedPhoto[]>([])
  const [savingPhotoId, setSavingPhotoId] = useState<number | null>(null)
  const [savedPhotosOpen, setSavedPhotosOpen] = useState(false)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [activeBookingsSubTab, setActiveBookingsSubTab] = useState<BookingsSubTab>('upcoming')
  const [bookingHistory, setBookingHistory] = useState<Booking[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [openHistoryBooking, setOpenHistoryBooking] = useState<Booking | null>(null)
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [selectedService, setSelectedService] = useState<Service | null>(null)
  const [selectedMaster, setSelectedMaster] = useState<Master | null>(null)
  const [referencePhoto, setReferencePhoto] = useState<{ id: number; image_url: string } | null>(null)
  const [startsAt, setStartsAt] = useState('')
  const [dateKey, setDateKey] = useState('')
  const [timeSlot, setTimeSlot] = useState('')
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()))
  const [busySlots, setBusySlots] = useState<{ starts_at: string; duration_minutes: number }[]>([])
  const [reschedule, setReschedule] = useState<{ booking: Booking; master: Master; service: Service } | null>(
    null
  )
  const [rescheduling, setRescheduling] = useState(false)

  const [loyaltyStatus, setLoyaltyStatus] = useState<LoyaltyStatus | null>(null)
  const [useLoyaltyPoints, setUseLoyaltyPoints] = useState(false)
  const [profileLoyalty, setProfileLoyalty] = useState<LoyaltyStatus | null>(null)
  const [loyaltyCardOpen, setLoyaltyCardOpen] = useState(false)
  const [loyaltyHistory, setLoyaltyHistory] = useState<LoyaltyHistoryEntry[]>([])

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
    apiFetch(`${API_URL}/api/bookings?client_telegram_id=${clientTelegramId}`)
      .then((r) => r.json())
      // Если сервер ответил ошибкой (например, подпись Telegram не сошлась),
      // в теле придёт объект {error: ...}, а не массив — .map() на нём уронит
      // весь экран клиента, а не просто оставит список записей пустым
      .then((data) => setBookings(Array.isArray(data) ? data : []))

  // История визитов ("Мои записи" → "История") — подгружаем один раз, при
  // первом открытии этой подвкладки, а не сразу при заходе в приложение:
  // раздел не главный, незачем тратить на него запрос, если в него не зашли
  useEffect(() => {
    if (activeTab !== 'bookings' || activeBookingsSubTab !== 'history' || historyLoaded) return
    apiFetch(`${API_URL}/api/bookings/history?client_telegram_id=${clientTelegramId}`)
      .then((r) => r.json())
      .then((data) => setBookingHistory(Array.isArray(data) ? data : []))
      .catch(() => setBookingHistory([]))
      .finally(() => setHistoryLoaded(true))
  }, [activeTab, activeBookingsSubTab, historyLoaded])

  // Карточка лояльности в профиле — не критична для загрузки экрана, поэтому
  // подгружаем отдельно и молча ничего не показываем, если не получилось
  const fetchProfileLoyalty = () =>
    apiFetch(`${API_URL}/api/loyalty/${clientTelegramId}`)
      .then((r) => r.json())
      .then(setProfileLoyalty)
      .catch(() => setProfileLoyalty(null))

  useEffect(() => {
    Promise.all([
      apiFetch(`${API_URL}/api/services`).then((r) => r.json()),
      apiFetch(`${API_URL}/api/masters`).then((r) => r.json()),
      fetchBookings(),
    ])
      .then(([servicesData, mastersData]) => {
        setServices(servicesData)
        setMasters(mastersData)
      })
      .catch(() => setError('Не удалось загрузить данные с сервера'))
      .finally(() => setLoading(false))
    fetchProfileLoyalty()
    // Отдельно и молча — раздел "Вдохновение" необязателен для остального
    // приложения, сбой загрузки не должен мешать записи
    apiFetch(`${API_URL}/api/inspiration-photos`)
      .then((r) => r.json())
      .then(setInspirationPhotos)
      .catch(() => setInspirationPhotos([]))
    apiFetch(`${API_URL}/api/saved-photos/${clientTelegramId}`)
      .then((r) => r.json())
      // Если сервер ответил ошибкой (например, 403), в теле придёт объект
      // {error: ...}, а не массив — .map() на нём уронит весь экран клиента
      .then((data) => setSavedPhotos(Array.isArray(data) ? data : []))
      .catch(() => setSavedPhotos([]))
  }, [])

  useEffect(() => {
    setStartsAt(dateKey && timeSlot ? `${dateKey}T${timeSlot}` : '')
  }, [dateKey, timeSlot])

  // Занятые интервалы выбранного мастера на выбранную дату — чтобы не показывать
  // клиенту слоты, которые уже забронированы (нужны на шаге выбора времени и при переносе)
  useEffect(() => {
    const master = reschedule ? reschedule.master : selectedMaster
    const isTimeStep = reschedule !== null || (flowOrigin != null && FLOW_STEPS[flowOrigin][flowIndex] === 'time')
    if (!master || !dateKey || !isTimeStep) {
      setBusySlots([])
      return
    }
    const excludeParam = reschedule ? `&exclude_booking_id=${reschedule.booking.id}` : ''
    apiFetch(`${API_URL}/api/masters/${master.id}/bookings?date=${dateKey}${excludeParam}`)
      .then((r) => r.json())
      .then(setBusySlots)
      .catch(() => setBusySlots([]))
  }, [selectedMaster, dateKey, flowOrigin, flowIndex, reschedule])

  // На экране подтверждения — подтягиваем баланс баллов клиента и сколько
  // максимум можно ими закрыть за эту услугу (не больше 30% от цены)
  useEffect(() => {
    const isConfirmStep = !reschedule && flowOrigin != null && FLOW_STEPS[flowOrigin][flowIndex] === 'confirm'
    setUseLoyaltyPoints(false)
    if (!isConfirmStep || !selectedService) {
      setLoyaltyStatus(null)
      return
    }
    apiFetch(`${API_URL}/api/loyalty/${clientTelegramId}?service_price=${selectedService.price}`)
      .then((r) => r.json())
      .then(setLoyaltyStatus)
      .catch(() => setLoyaltyStatus(null))
  }, [flowOrigin, flowIndex, selectedService, reschedule])

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

  // "Повторить запись" на карточке визита в "Истории" — то же самое, что и
  // выбор услуги в профиле мастера (bookFromProfile): мастер и услуга уже
  // известны из прошлой записи, сразу переходим к выбору даты и времени.
  // Услугу или мастера могли к этому моменту удалить — тогда просто не даём
  // повторить и объясняем, почему, а не падаем на несуществующих данных
  const repeatBooking = (b: Booking) => {
    const master = masters.find((m) => m.id === b.master_id)
    const service = services.find((s) => s.id === b.service_id)
    if (!master || !service) {
      setError('Эта услуга или мастер больше недоступны — выберите другую запись вручную')
      return
    }
    setOpenHistoryBooking(null)
    bookFromProfile(master, service)
  }

  // Кнопка "Записаться на такое"/"Записаться" в полноэкранном просмотре фото
  // из "Вдохновения" — подставляет мастера (если фото его) и услугу по категории
  const bookFromInspiration = (photo: InspirationPhoto) => {
    const service = matchServiceByCategory(photo.category, services)
    const master = photo.master_id ? masters.find((m) => m.id === photo.master_id) ?? null : null
    setOpenInspirationPhoto(null)
    setReferencePhoto({ id: photo.id, image_url: photo.image_url })
    if (master) {
      apiFetch(`${API_URL}/api/inspiration-photos/${photo.id}/click`, { method: 'POST' }).catch(() => {})
    }
    if (master && service) {
      bookFromProfile(master, service)
      return
    }
    setError(null)
    if (service) setSelectedService(service)
    startFlow('services')
  }

  // Убрать фото из "Сохранённого" — из полноэкранного просмотра и из самого
  // раздела "Сохранённое" в профиле
  const removeSavedPhoto = async (photoId: number) => {
    setSavingPhotoId(photoId)
    try {
      await apiFetch(`${API_URL}/api/saved-photos/${clientTelegramId}/${photoId}`, { method: 'DELETE' })
      setSavedPhotos((prev) => prev.filter((p) => p.photo_id !== photoId))
    } catch {
      // не критично — можно попробовать ещё раз
    } finally {
      setSavingPhotoId(null)
    }
  }

  // Сердечко "Сохранить" в полноэкранном просмотре — добавляет фото в
  // "Сохранённое" в профиле клиента (или убирает, если уже там)
  const toggleSavedPhoto = async (photo: InspirationPhoto) => {
    const alreadySaved = savedPhotos.some((p) => p.photo_id === photo.id)
    if (alreadySaved) {
      await removeSavedPhoto(photo.id)
      return
    }
    setSavingPhotoId(photo.id)
    try {
      await apiFetch(`${API_URL}/api/saved-photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_telegram_id: clientTelegramId, photo_id: photo.id }),
      })
      setSavedPhotos((prev) => [
        {
          photo_id: photo.id,
          saved_at: new Date().toISOString(),
          image_url: photo.image_url,
          category: photo.category,
          tags: photo.tags,
          master_id: photo.master_id,
          master_name: photo.master_name,
          master_photo_url: photo.master_photo_url,
        },
        ...prev,
      ])
    } catch {
      // не критично — можно попробовать ещё раз
    } finally {
      setSavingPhotoId(null)
    }
  }

  const exitFlow = () => {
    setSelectedService(null)
    setSelectedMaster(null)
    setReferencePhoto(null)
    setDateKey('')
    setTimeSlot('')
    setCalendarMonth(startOfMonth(new Date()))
    setError(null)
    setFlowOrigin(null)
    setFlowIndex(0)
  }

  // Фото работ мастера — подгружаем при открытии его профиля
  useEffect(() => {
    setActiveProfileFolder('all')
    if (!masterProfile) {
      setMasterProfilePhotos([])
      setMasterPhotoFolders([])
      return
    }
    apiFetch(`${API_URL}/api/masters/${masterProfile.id}/photos`)
      .then((r) => r.json())
      // folder_ids может отсутствовать, если сервер ещё не обновлён до версии
      // с папками (сайт и сервер деплоятся отдельно) — не даём этому сломать экран
      .then((data: MasterPhoto[]) => setMasterProfilePhotos(data.map((p) => ({ ...p, folder_ids: p.folder_ids ?? [] }))))
      .catch(() => setMasterProfilePhotos([]))
    apiFetch(`${API_URL}/api/masters/${masterProfile.id}/photo-folders`)
      .then((r) => r.json())
      .then(setMasterPhotoFolders)
      .catch(() => setMasterPhotoFolders([]))
  }, [masterProfile])

  // Отзывы мастера (оценки с текстом) — туда же, при открытии профиля
  useEffect(() => {
    setReviewsOpen(false)
    if (!masterProfile) {
      setMasterReviews([])
      return
    }
    apiFetch(`${API_URL}/api/masters/${masterProfile.id}/ratings`)
      .then((r) => r.json())
      .then(setMasterReviews)
      .catch(() => setMasterReviews([]))
  }, [masterProfile])

  // История начислений/списаний баллов — подгружаем при открытии полного
  // экрана карты лояльности (на главном экране показан только итог)
  useEffect(() => {
    if (!loyaltyCardOpen) {
      setLoyaltyHistory([])
      return
    }
    apiFetch(`${API_URL}/api/loyalty/${clientTelegramId}/history`)
      .then((r) => r.json())
      // Как и с записями/историей визитов — если сервер ответил ошибкой,
      // в теле придёт {error: ...}, а не массив
      .then((data) => setLoyaltyHistory(Array.isArray(data) ? data : []))
      .catch(() => setLoyaltyHistory([]))
  }, [loyaltyCardOpen])

  const goBack = () => {
    setError(null)
    if (openHistoryBooking) {
      setOpenHistoryBooking(null)
      return
    }
    if (savedPhotosOpen) {
      setSavedPhotosOpen(false)
      return
    }
    if (loyaltyCardOpen) {
      setLoyaltyCardOpen(false)
      return
    }
    if (reviewsOpen) {
      setReviewsOpen(false)
      return
    }
    if (masterProfile) {
      setMasterProfile(null)
      setOpenPhoto(null)
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

  const startReschedule = (b: Booking) => {
    const master = masters.find((m) => m.id === b.master_id)
    const service = services.find((s) => s.id === b.service_id)
    if (!master || !service) return
    setError(null)
    setReschedule({ booking: b, master, service })
    setDateKey(b.starts_at.slice(0, 10))
    setTimeSlot(b.starts_at.slice(11, 16))
    setCalendarMonth(startOfMonth(new Date(b.starts_at)))
  }

  const exitReschedule = () => {
    setReschedule(null)
    setDateKey('')
    setTimeSlot('')
    setCalendarMonth(startOfMonth(new Date()))
    setError(null)
  }

  const submitReschedule = async () => {
    if (!reschedule || !startsAt) return
    setRescheduling(true)
    setError(null)
    try {
      const res = await apiFetch(`${API_URL}/api/bookings/${reschedule.booking.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_telegram_id: clientTelegramId, starts_at: startsAt }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не удалось перенести запись')
        return
      }
      await fetchBookings()
      exitReschedule()
    } catch {
      setError('Не удалось связаться с сервером')
    } finally {
      setRescheduling(false)
    }
  }

  const cancelBooking = async (id: number) => {
    if (!window.confirm('Отменить эту запись?')) return
    setCancellingId(id)
    try {
      const res = await apiFetch(
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
      const res = await apiFetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_telegram_id: clientTelegramId,
          master_id: selectedMaster.id,
          service_id: selectedService.id,
          starts_at: startsAt,
          client_name: getTelegramUserName(),
          client_username: getTelegramUsername() ?? undefined,
          redeem_points: useLoyaltyPoints ? loyaltyStatus?.max_redeemable ?? 0 : 0,
          reference_photo_id: referencePhoto?.id ?? undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не удалось создать запись')
        return
      }
      await fetchBookings()
      await fetchProfileLoyalty()
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

  if (masterProfile && reviewsOpen) {
    return (
      <motion.div
        className="app"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="topbar">
          <button className="icon-back" onClick={goBack} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
          <div className="topbar-title">Отзывы</div>
        </div>
        <div className="content">
          <div className="review-list">
            {masterReviews.map((r) => (
              <article key={r.id} className="review-card">
                <div className="review-card-top">
                  <span className="review-stars">
                    {'★'.repeat(r.rating)}
                    {'☆'.repeat(5 - r.rating)}
                  </span>
                  <span className="review-date">{formatDateTime(r.created_at)}</span>
                </div>
                <p className="review-comment">{r.comment}</p>
              </article>
            ))}
          </div>
        </div>
      </motion.div>
    )
  }

  if (loyaltyCardOpen && profileLoyalty) {
    const { current, next, pct } = tierProgress(profileLoyalty)
    const card = TIER_CARD_META[current.name] ?? TIER_CARD_META['Новичок']
    return (
      <motion.div
        className="app"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="topbar">
          <button className="icon-back" onClick={goBack} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
          <div className="topbar-title">Моя карта лояльности</div>
        </div>
        <div className="content">
          <article
            className="tier-hero-card"
            style={{ background: card.bg, color: card.text, '--tier-sub': card.sub } as CSSProperties}
          >
            <span className="tier-hero-name">
              <Award size={16} />
              {current.name}
            </span>
            <div className="tier-hero-balance">
              <span className="tier-hero-balance-value">{profileLoyalty.points_balance}</span>
              <span className="tier-hero-balance-label">баллов</span>
            </div>
          </article>

          <article className="loyalty-info-card">
            {next && profileLoyalty.amount_to_next_tier != null ? (
              <>
                <div className="loyalty-card-track">
                  <div className="loyalty-card-track-fill" style={{ width: `${pct}%`, background: card.accent }} />
                </div>
                <p className="loyalty-info-hint">
                  Осталось потратить {profileLoyalty.amount_to_next_tier} € до уровня «{next.name}»
                </p>
              </>
            ) : (
              <div className="tier-maxed">
                <Check size={16} />
                Вы достигли максимального уровня
              </div>
            )}
            <div className="loyalty-cashback-row">
              <span>Кэшбэк на этом уровне</span>
              <strong>{Math.round(profileLoyalty.cashback_rate * 100)}%</strong>
            </div>
          </article>

          <div className="section-title">История начислений</div>
          {loyaltyHistory.length === 0 ? (
            <p className="loyalty-history-empty">Пока ничего не начислялось и не списывалось.</p>
          ) : (
            <div className="loyalty-history-list">
              {loyaltyHistory.map((h) => (
                <div key={h.id} className={`loyalty-history-row${h.reason === 'сгорание' ? ' is-burned' : ''}`}>
                  <div className="loyalty-history-meta">
                    <span className="loyalty-history-label">{loyaltyHistoryLabel(h)}</span>
                    <span className="loyalty-history-date">{formatDateTime(h.created_at)}</span>
                  </div>
                  <span className={`loyalty-history-amount${h.amount < 0 ? ' is-negative' : ''}`}>
                    {h.amount > 0 ? `+${h.amount}` : h.amount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    )
  }

  if (openHistoryBooking) {
    const b = openHistoryBooking
    const historyMaster = masters.find((m) => m.id === b.master_id)
    const canRepeat = masters.some((m) => m.id === b.master_id) && services.some((s) => s.id === b.service_id)
    return (
      <motion.div
        className="app"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="topbar">
          <button className="icon-back" onClick={goBack} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
          <div className="topbar-title">Визит</div>
        </div>
        <div className="content">
          <article className="confirm-card confirm-card-tall">
            {historyMaster?.photo_url ? (
              <img className="confirm-card-photo" src={historyMaster.photo_url} alt={b.master_name} />
            ) : (
              <div className="confirm-card-photo confirm-card-photo-fallback">{initials(b.master_name)}</div>
            )}
            <div className="confirm-card-tall-body">
              <p className="confirm-eyebrow">{b.status === 'no_show' ? 'Не пришли' : 'Выполнена'}</p>
              <h2 className="confirm-title">{b.service_name}</h2>
              <div className="confirm-master-row">
                {historyMaster?.photo_url ? (
                  <img className="avatar-photo" src={historyMaster.photo_url} alt={b.master_name} />
                ) : (
                  <div className="avatar">{initials(b.master_name)}</div>
                )}
                <span className="confirm-master-name">{b.master_name}</span>
              </div>
              <div className="summary-list">
                <div className="summary-row">
                  <span className="summary-label">Дата и время</span>
                  <span className="summary-value">{formatDateTime(b.starts_at)}</span>
                </div>
                <div className="summary-row">
                  <span className="summary-label">Длительность</span>
                  <span className="summary-value">{b.duration_minutes} мин</span>
                </div>
                {b.price != null && (
                  <div className="summary-row">
                    <span className="summary-label">Стоимость</span>
                    <span className="summary-value">{b.price} €</span>
                  </div>
                )}
              </div>
            </div>
          </article>

          <div className="section-title">Ваша оценка</div>
          {b.rating ? (
            <article className="review-card">
              <div className="review-card-top">
                <span className="review-stars">
                  {'★'.repeat(b.rating)}
                  {'☆'.repeat(5 - b.rating)}
                </span>
              </div>
              {b.comment && <p className="review-comment">{b.comment}</p>}
            </article>
          ) : (
            <p className="hub-greeting">
              Вы ещё не оценили этот визит — оценка запрашивается ботом в чате после того, как мастер отметит
              запись выполненной.
            </p>
          )}
        </div>
        <div className="footer">
          <button className="primary" disabled={!canRepeat} onClick={() => repeatBooking(b)}>
            Повторить запись
          </button>
          {!canRepeat && <p className="footer-hint">Эта услуга или мастер больше недоступны</p>}
        </div>
      </motion.div>
    )
  }

  if (savedPhotosOpen) {
    return (
      <motion.div
        className="app"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="topbar">
          <button className="icon-back" onClick={goBack} aria-label="Назад">
            <ArrowLeft size={18} />
          </button>
          <div className="topbar-title">Сохранённое</div>
        </div>
        <div className="content">
          {savedPhotos.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Heart size={26} />
              </div>
              <h2>Пока пусто</h2>
              <p>Сохраняйте понравившиеся фото в разделе «Вдохновение» — они появятся здесь.</p>
            </div>
          ) : (
            <div className="inspiration-grid">
              {savedPhotos.map((p) => (
                <div key={p.photo_id} className="inspiration-card">
                  <img src={p.image_url} alt={p.category} loading="lazy" />
                  <button
                    type="button"
                    className="inspiration-card-remove"
                    disabled={savingPhotoId === p.photo_id}
                    onClick={() => removeSavedPhoto(p.photo_id)}
                    aria-label="Убрать из сохранённого"
                  >
                    ✕
                  </button>
                  {p.master_id && p.master_name && (
                    <div className="inspiration-card-master">
                      {p.master_photo_url ? (
                        <img className="inspiration-card-master-avatar" src={p.master_photo_url} alt={p.master_name} />
                      ) : (
                        <div className="inspiration-card-master-avatar inspiration-card-master-fallback">
                          {initials(p.master_name)}
                        </div>
                      )}
                      <span>{p.master_name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    )
  }

  if (masterProfile) {
    const masterServices = services.filter((s) => masterProfile.service_ids.includes(s.id))
    const filteredProfilePhotos =
      activeProfileFolder === 'all'
        ? masterProfilePhotos
        : masterProfilePhotos.filter((p) => p.folder_ids.includes(activeProfileFolder))
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
            <p className="hero-eyebrow">
              {[
                masterProfile.experience_years != null ? `${pluralizeYears(masterProfile.experience_years)} опыта` : null,
                masterProfile.ratings_count > 0 ? `${masterProfile.avg_rating} ⭐ (${masterProfile.ratings_count})` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <div className="hero-name">{masterProfile.name}</div>
          </div>
        </div>
        <div className="content">
          {error && <p className="error">{error}</p>}
          {masterProfile.bio && <p className="profile-bio">{masterProfile.bio}</p>}
          {masterProfilePhotos.length > 0 && (
            <>
              <div className="section-title">Фото работ</div>
              {masterPhotoFolders.length > 0 && (
                <div className="profile-folder-chips">
                  <button
                    type="button"
                    className={`profile-folder-chip${activeProfileFolder === 'all' ? ' active' : ''}`}
                    onClick={() => setActiveProfileFolder('all')}
                  >
                    Все
                  </button>
                  {masterPhotoFolders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`profile-folder-chip${activeProfileFolder === f.id ? ' active' : ''}`}
                      onClick={() => setActiveProfileFolder(f.id)}
                    >
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="profile-portfolio-grid">
                {filteredProfilePhotos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="profile-portfolio-thumb"
                    onClick={() => setOpenPhoto(p)}
                  >
                    <img src={p.url} alt={p.caption ?? 'Фото работы'} />
                  </button>
                ))}
              </div>
            </>
          )}
          {masterReviews.length > 0 && (
            <>
              <div className="section-title">Отзывы</div>
              <div className="review-list">
                {masterReviews.slice(0, 3).map((r) => (
                  <article key={r.id} className="review-card">
                    <div className="review-card-top">
                      <span className="review-stars">
                        {'★'.repeat(r.rating)}
                        {'☆'.repeat(5 - r.rating)}
                      </span>
                      <span className="review-date">{formatDateTime(r.created_at)}</span>
                    </div>
                    <p className="review-comment">{r.comment}</p>
                  </article>
                ))}
              </div>
              {masterReviews.length > 3 && (
                <button type="button" className="link-button" onClick={() => setReviewsOpen(true)}>
                  Показать все отзывы ({masterReviews.length})
                </button>
              )}
            </>
          )}
          <div className="section-title">Услуги мастера</div>
          <div className="list">
            {masterServices.map((s) => (
              <ServiceRow key={s.id} service={s} onClick={() => bookFromProfile(masterProfile, s)} />
            ))}
          </div>
        </div>
        {openPhoto &&
          createPortal(
            <div className="profile-photo-lightbox" onClick={() => setOpenPhoto(null)}>
              <button
                type="button"
                className="profile-photo-lightbox-close"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenPhoto(null)
                }}
                aria-label="Закрыть"
              >
                ✕
              </button>
              <img src={openPhoto.url} alt={openPhoto.caption ?? 'Фото работы'} />
              {openPhoto.caption && <p className="profile-photo-lightbox-caption">{openPhoto.caption}</p>}
            </div>,
            document.body
          )}
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
  const showChrome = !inFlow && !reschedule

  const flowServices = selectedMaster
    ? services.filter((s) => selectedMaster.service_ids.includes(s.id))
    : services
  const flowMasters = selectedService
    ? masters.filter((m) => m.service_ids.includes(selectedService.id))
    : masters

  const today = startOfDay(new Date())
  const todayKey = dateKeyOf(today)
  const nowHHMM = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
  const timeSlotMaster = reschedule ? reschedule.master : selectedMaster
  const masterTimeSlots = timeSlotMaster
    ? generateTimeSlots(
        timeSlotMaster.work_start_time,
        timeSlotMaster.work_end_time,
        slotStep(timeSlotMaster.buffer_minutes)
      )
    : []
  const availableTimeSlots = (
    dateKey === todayKey ? masterTimeSlots.filter((t) => t > nowHHMM) : masterTimeSlots
  ).filter((t) =>
    isSlotFree(t, selectedService?.duration_minutes ?? 30, busySlots, timeSlotMaster?.buffer_minutes ?? DEFAULT_BUFFER_MINUTES)
  )
  const isCurrentMonth =
    calendarMonth.getFullYear() === today.getFullYear() && calendarMonth.getMonth() === today.getMonth()
  const pickDate = (key: string) => {
    setDateKey(key)
    setTimeSlot('')
  }
  const prevMonth = () => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))
  const nextMonth = () => setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))

  const screenKey = reschedule
    ? 'reschedule'
    : inFlow
      ? `flow-${flowStep}`
      : `tab-${activeTab}${activeTab === 'book' ? `-${activeBookSubTab}` : ''}`
  const isHomeHero = !inFlow && !reschedule && activeTab === 'home'
  const heroBooking = bookings[0] ?? null
  const heroMaster = heroBooking ? masters.find((m) => m.id === heroBooking.master_id) ?? null : null
  const heroPhotoSrc = heroMaster?.photo_url || `${import.meta.env.BASE_URL}images/atelier-header.jpg`

  // "Вдохновение" — доступные категории и теги считаем прямо из того, что
  // реально есть у фото, а не храним отдельным списком где-то ещё
  const savedPhotoIds = new Set(savedPhotos.map((p) => p.photo_id))
  const inspirationCategories = [...new Set(inspirationPhotos.map((p) => p.category))]
  const inspirationTags = [...new Set(inspirationPhotos.flatMap((p) => p.tags))]
  const filteredInspirationPhotos = inspirationPhotos.filter(
    (p) =>
      (activeInspirationCategory === 'all' || p.category === activeInspirationCategory) &&
      (activeInspirationTag === 'all' || p.tags.includes(activeInspirationTag))
  )

  return (
    <div className="app">
      {isHomeHero ? (
        <div className="hero hero-compact">
          {/* Карточка "сливается" с экраном через размытое свечение теми же
              цветами, что и на самом фото (приём из Spotify/Apple Music) —
              не отдельная плашка контрастного цвета, а цветной туман вокруг
              карточки. pointer-events: none — это чисто декоративный слой,
              не должен перехватывать клики у карточки поверх него */}
          <div className="hero-compact-glow" style={{ backgroundImage: `url(${heroPhotoSrc})` }} />
          <div className="hero-compact-media">
            <img className="hero-photo" src={heroPhotoSrc} alt="" />
            <div className="hero-scrim" />
            {isTestUser && <div className="hero-badge">тест</div>}
            <div className="hero-text">
              <p className="hero-eyebrow">{heroBooking ? 'ВАША ЗАПИСЬ' : 'САЛОН КРАСОТЫ'}</p>
              <div className="hero-name">{heroBooking ? heroBooking.service_name : 'Добро пожаловать'}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="topbar">
          {(inFlow || reschedule) && (
            <button className="icon-back" onClick={reschedule ? exitReschedule : goBack} aria-label="Назад">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="topbar-title">
            {reschedule
              ? 'Дата и время'
              : inFlow && flowStep
                ? STEP_TITLES[flowStep]
                : TAB_TITLES[activeTab]}
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
        className={`content${isHomeHero ? ' sheet' : ''}${showChrome ? ' content-with-tabbar' : ''}`}
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -16 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        {error && <p className="error">{error}</p>}

        {isHomeHero && (
          <article className="profile-user-card">
            <div className="avatar">{initials(getTelegramUserName())}</div>
            <div className="profile-user-body">
              <div className="profile-user-name">{getTelegramUserName()}</div>
              <div className="profile-user-contact">
                {getTelegramUsername() ? `@${getTelegramUsername()}` : `Telegram ID: ${clientTelegramId}`}
              </div>
            </div>
          </article>
        )}

        {isHomeHero &&
          profileLoyalty &&
          (() => {
            const { current, next, pct } = tierProgress(profileLoyalty)
            return (
              <button
                type="button"
                className="loyalty-card"
                onClick={() => setLoyaltyCardOpen(true)}
                style={{ '--tier-color': current.color, '--tier-bg': current.bg } as CSSProperties}
              >
                <div className="loyalty-card-top">
                  <span className="loyalty-card-tier">
                    <Award size={15} />
                    {current.name}
                  </span>
                  <span className="loyalty-card-cashback">Кэшбэк {Math.round(profileLoyalty.cashback_rate * 100)}%</span>
                </div>

                <div className="loyalty-card-balance">
                  <span className="loyalty-card-balance-value">{profileLoyalty.points_balance}</span>
                  <span className="loyalty-card-balance-label">баллов на счету</span>
                </div>

                <div className="loyalty-card-track">
                  <div className="loyalty-card-track-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="loyalty-card-track-labels">
                  <span>{current.name}</span>
                  <span>{next ? next.name : 'максимум'}</span>
                </div>

                <p className="loyalty-card-hint">
                  {next && profileLoyalty.amount_to_next_tier != null
                    ? `До уровня «${next.name}» осталось потратить ${profileLoyalty.amount_to_next_tier} €`
                    : 'Вы на максимальном уровне — выше кэшбэка не бывает'}
                </p>
              </button>
            )
          })()}

        {isHomeHero && (
          <button type="button" className="home-saved-row" onClick={() => setSavedPhotosOpen(true)}>
            <span className="home-saved-row-icon">
              <Heart size={16} />
            </span>
            <span className="home-saved-row-body">
              <span className="home-saved-row-name">Сохранённое</span>
              <span className="home-saved-row-count">
                {savedPhotos.length > 0 ? `${savedPhotos.length} фото` : 'Пока пусто'}
              </span>
            </span>
            <ChevronRight size={14} className="home-saved-row-arrow" />
          </button>
        )}

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
                  <button
                    className="text-link"
                    onClick={() => {
                      setActiveBookSubTab('services')
                      setActiveTab('book')
                    }}
                  >
                    Все услуги
                  </button>
                  <button className="text-link" onClick={() => setSavedPhotosOpen(true)}>
                    Сохранённое
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
              <button
                className="link-button"
                onClick={() => {
                  setActiveBookSubTab('services')
                  setActiveTab('book')
                }}
              >
                Смотреть все услуги <Sparkles size={14} />
              </button>
            </>
          ) : (
            <>
              <div className="empty-state empty-state-compact">
                <div className="empty-icon">
                  <CalendarDays size={26} />
                </div>
                <p>У вас пока нет записи</p>
              </div>
              <button
                className="primary"
                onClick={() => {
                  setActiveBookSubTab('services')
                  setActiveTab('book')
                }}
              >
                Записаться
              </button>
            </>
          ))}

        {!inFlow && !reschedule && activeTab === 'book' && (
          <div className="book-subtabs">
            {BOOK_SUB_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`book-subtab${activeBookSubTab === t.key ? ' active' : ''}`}
                onClick={() => setActiveBookSubTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {!inFlow && !reschedule && activeTab === 'book' && activeBookSubTab === 'services' && (
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

        {!inFlow && !reschedule && activeTab === 'book' && activeBookSubTab === 'masters' && (
          // Полный список мастеров (без привязки к заранее выбранной услуге) —
          // тап открывает профиль (био, портфолио, отзывы), а выбор услуги там
          // же, в "Услуги мастера", запускает запись сразу с шага "Дата и время"
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
                  {(m.experience_years != null || m.ratings_count > 0) && (
                    <div className="master-tile-sub">
                      {m.experience_years != null ? `${pluralizeYears(m.experience_years)} опыта` : ''}
                      {m.experience_years != null && m.ratings_count > 0 ? ' · ' : ''}
                      {m.ratings_count > 0 ? `${m.avg_rating} ⭐` : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {!inFlow && !reschedule && activeTab === 'book' && activeBookSubTab === 'inspiration' && (
          <div className="inspiration-section">
            {inspirationCategories.length > 0 && (
              <div className="inspiration-chips">
                <button
                  type="button"
                  className={`inspiration-chip${activeInspirationCategory === 'all' ? ' active' : ''}`}
                  onClick={() => setActiveInspirationCategory('all')}
                >
                  Все
                </button>
                {inspirationCategories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`inspiration-chip${activeInspirationCategory === c ? ' active' : ''}`}
                    onClick={() => setActiveInspirationCategory(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            {inspirationTags.length > 0 && (
              <div className="inspiration-chips inspiration-chips--tags">
                <button
                  type="button"
                  className={`inspiration-chip inspiration-chip--tag${activeInspirationTag === 'all' ? ' active' : ''}`}
                  onClick={() => setActiveInspirationTag('all')}
                >
                  Любой стиль
                </button>
                {inspirationTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`inspiration-chip inspiration-chip--tag${activeInspirationTag === t ? ' active' : ''}`}
                    onClick={() => setActiveInspirationTag(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            {filteredInspirationPhotos.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Images size={26} />
                </div>
                <h2>{inspirationPhotos.length === 0 ? 'Пока пусто' : 'Ничего не нашлось'}</h2>
                <p>
                  {inspirationPhotos.length === 0
                    ? 'Здесь появятся примеры причёсок, ногтей и других работ для вдохновения.'
                    : 'Попробуйте выбрать другую категорию или стиль.'}
                </p>
              </div>
            ) : (
              <div className="inspiration-grid">
                {filteredInspirationPhotos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="inspiration-card"
                    onClick={() => setOpenInspirationPhoto(p)}
                  >
                    <img src={p.image_url} alt={p.category} loading="lazy" />
                    {savedPhotoIds.has(p.id) && (
                      <div className="inspiration-card-saved">
                        <Heart size={13} fill="currentColor" />
                      </div>
                    )}
                    {p.master_id && p.master_name && (
                      <div className="inspiration-card-master">
                        {p.master_photo_url ? (
                          <img className="inspiration-card-master-avatar" src={p.master_photo_url} alt={p.master_name} />
                        ) : (
                          <div className="inspiration-card-master-avatar inspiration-card-master-fallback">
                            {initials(p.master_name)}
                          </div>
                        )}
                        <span>{p.master_name}</span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {openInspirationPhoto &&
          createPortal(
            <div className="inspiration-lightbox" onClick={() => setOpenInspirationPhoto(null)}>
              <button
                type="button"
                className="inspiration-lightbox-close"
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenInspirationPhoto(null)
                }}
                aria-label="Закрыть"
              >
                ✕
              </button>
              <div className="inspiration-lightbox-body" onClick={(e) => e.stopPropagation()}>
                <img src={openInspirationPhoto.image_url} alt={openInspirationPhoto.category} />
                <div className="inspiration-lightbox-info">
                  <div className="inspiration-lightbox-tags">
                    <span className="inspiration-chip inspiration-chip--tag active">{openInspirationPhoto.category}</span>
                    {openInspirationPhoto.tags.map((t) => (
                      <span key={t} className="inspiration-chip inspiration-chip--tag">
                        {t}
                      </span>
                    ))}
                  </div>
                  {openInspirationPhoto.master_id && openInspirationPhoto.master_name && (
                    <div className="inspiration-lightbox-master">
                      {openInspirationPhoto.master_photo_url ? (
                        <img src={openInspirationPhoto.master_photo_url} alt={openInspirationPhoto.master_name} />
                      ) : (
                        <div className="inspiration-card-master-avatar inspiration-card-master-fallback">
                          {initials(openInspirationPhoto.master_name)}
                        </div>
                      )}
                      <span>Работа мастера {openInspirationPhoto.master_name}</span>
                    </div>
                  )}
                </div>
                <div className="inspiration-lightbox-actions">
                  <button
                    type="button"
                    className={`inspiration-lightbox-save${savedPhotoIds.has(openInspirationPhoto.id) ? ' active' : ''}`}
                    disabled={savingPhotoId === openInspirationPhoto.id}
                    onClick={() => toggleSavedPhoto(openInspirationPhoto)}
                  >
                    <Heart size={18} fill={savedPhotoIds.has(openInspirationPhoto.id) ? 'currentColor' : 'none'} />
                    {savedPhotoIds.has(openInspirationPhoto.id) ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <button type="button" className="primary" onClick={() => bookFromInspiration(openInspirationPhoto)}>
                    {openInspirationPhoto.master_id ? 'Записаться на такое' : 'Записаться'}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}

        {!inFlow && !reschedule && activeTab === 'bookings' && (
          <div className="book-subtabs">
            {BOOKINGS_SUB_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`book-subtab${activeBookingsSubTab === t.key ? ' active' : ''}`}
                onClick={() => setActiveBookingsSubTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {!inFlow &&
          !reschedule &&
          activeTab === 'bookings' &&
          activeBookingsSubTab === 'upcoming' &&
          (bookings.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <CalendarDays size={26} />
              </div>
              <h2>Записей пока нет</h2>
              <p>Выберите услугу и найдите удобное время для визита.</p>
              <button
                className="primary"
                onClick={() => {
                  setActiveBookSubTab('services')
                  setActiveTab('book')
                }}
              >
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
                        <div className="booking-tile-actions">
                          <button className="text-link-inline" onClick={() => startReschedule(b)}>
                            Изменить
                          </button>
                          <button
                            className="cancel-link"
                            disabled={cancellingId === b.id}
                            onClick={() => cancelBooking(b.id)}
                          >
                            {cancellingId === b.id ? 'Отменяем…' : 'Отменить'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ))}

        {!inFlow &&
          !reschedule &&
          activeTab === 'bookings' &&
          activeBookingsSubTab === 'history' &&
          (bookingHistory.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <CalendarDays size={26} />
              </div>
              <h2>{historyLoaded ? 'История пока пуста' : 'Загрузка…'}</h2>
              {historyLoaded && <p>Здесь появятся визиты, которые уже прошли.</p>}
            </div>
          ) : (
            <div className="list">
              {bookingHistory.map((b) => {
                const master = masters.find((m) => m.id === b.master_id)
                return (
                  <article
                    key={b.id}
                    className="booking-tile booking-tile--clickable"
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenHistoryBooking(b)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setOpenHistoryBooking(b)
                    }}
                  >
                    {master?.photo_url ? (
                      <img className="booking-tile-photo" src={master.photo_url} alt={master.name} />
                    ) : (
                      <div className="booking-tile-photo booking-tile-photo-fallback">
                        <ServiceIcon name={b.service_name} size={24} />
                      </div>
                    )}
                    <div className="booking-tile-body">
                      <div>
                        <p className="confirm-eyebrow">
                          {b.status === 'no_show' ? 'Не пришли' : 'Выполнена'}
                        </p>
                        <h2 className="confirm-title">{b.service_name}</h2>
                        <p className="booking-tile-master">{b.master_name}</p>
                      </div>
                      <div className="booking-tile-footer">
                        <div className="booking-tile-footer-info">
                          <span className="booking-tile-time">{formatDateTime(b.starts_at)}</span>
                          {b.rating ? (
                            <span className="booking-tile-rating">
                              {'★'.repeat(b.rating)}
                              {'☆'.repeat(5 - b.rating)}
                            </span>
                          ) : null}
                        </div>
                        <button
                          className="text-link-inline"
                          onClick={(e) => {
                            e.stopPropagation()
                            repeatBooking(b)
                          }}
                        >
                          Повторить запись
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
          // Та же плиточная сетка, что раньше была отдельной вкладкой "Мастера" —
          // открывает полный профиль мастера (био, портфолио, отзывы), где выбор
          // услуги из списка "Услуги мастера" (bookFromProfile) и завершает шаг
          <div className="masters-grid">
            {flowMasters.map((m, i) => (
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
                  {(m.experience_years != null || m.ratings_count > 0) && (
                    <div className="master-tile-sub">
                      {m.experience_years != null ? `${pluralizeYears(m.experience_years)} опыта` : ''}
                      {m.experience_years != null && m.ratings_count > 0 ? ' · ' : ''}
                      {m.ratings_count > 0 ? `${m.avg_rating} ⭐` : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {inFlow && flowStep === 'time' && selectedMaster && selectedService && (
          <DateTimePicker
            master={selectedMaster}
            service={selectedService}
            dateKey={dateKey}
            timeSlot={timeSlot}
            calendarMonth={calendarMonth}
            today={today}
            todayKey={todayKey}
            availableTimeSlots={availableTimeSlots}
            isCurrentMonth={isCurrentMonth}
            onPickDate={pickDate}
            onPickTime={setTimeSlot}
            onPrevMonth={prevMonth}
            onNextMonth={nextMonth}
          />
        )}

        {reschedule && (
          <DateTimePicker
            master={reschedule.master}
            service={reschedule.service}
            dateKey={dateKey}
            timeSlot={timeSlot}
            calendarMonth={calendarMonth}
            today={today}
            todayKey={todayKey}
            availableTimeSlots={availableTimeSlots}
            isCurrentMonth={isCurrentMonth}
            onPickDate={pickDate}
            onPickTime={setTimeSlot}
            onPrevMonth={prevMonth}
            onNextMonth={nextMonth}
          />
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
                  <span className="summary-value">{selectedService.price} €</span>
                </div>
                {useLoyaltyPoints && loyaltyStatus?.max_redeemable ? (
                  <div className="summary-row">
                    <span className="summary-label">Баллами</span>
                    <span className="summary-value">−{loyaltyStatus.max_redeemable} €</span>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        )}

        {inFlow && flowStep === 'confirm' && (
          <div className="reference-photo-section">
            <p className="section-title">Фото-референс (необязательно)</p>
            {referencePhoto ? (
              <div className="reference-photo-picked">
                <img src={referencePhoto.image_url} alt="Референс" />
                <button type="button" className="reference-photo-remove" onClick={() => setReferencePhoto(null)}>
                  Убрать
                </button>
              </div>
            ) : savedPhotos.length > 0 ? (
              <div className="reference-photo-picker">
                {savedPhotos.map((p) => (
                  <button
                    key={p.photo_id}
                    type="button"
                    className="reference-photo-option"
                    onClick={() => setReferencePhoto({ id: p.photo_id, image_url: p.image_url })}
                  >
                    <img src={p.image_url} alt={p.category} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="reference-photo-hint">
                Сохраняйте фото в «Вдохновении» — сможете прикрепить их к записи, чтобы мастер точно знал, чего вы хотите.
              </p>
            )}
          </div>
        )}

        {inFlow && flowStep === 'confirm' && loyaltyStatus && loyaltyStatus.points_balance > 0 && (
          <div className="allergy-check">
            <p className="allergy-check-text">
              Баллов на счету: {loyaltyStatus.points_balance}.{' '}
              {loyaltyStatus.max_redeemable
                ? `Можно списать до ${loyaltyStatus.max_redeemable} € на эту запись (не больше 30% от стоимости услуги).`
                : 'На эту услугу баллами оплатить нельзя.'}
            </p>
            {loyaltyStatus.max_redeemable ? (
              <label className="loyalty-check-toggle">
                <input
                  type="checkbox"
                  checked={useLoyaltyPoints}
                  onChange={(e) => setUseLoyaltyPoints(e.target.checked)}
                />
                Списать {loyaltyStatus.max_redeemable} баллов
              </label>
            ) : null}
          </div>
        )}

      </motion.div>
      </AnimatePresence>

      {!inFlow &&
        !reschedule &&
        activeTab === 'bookings' &&
        activeBookingsSubTab === 'upcoming' &&
        bookings.length > 0 && (
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

      {reschedule && (
        <div className="footer">
          <button className="primary" disabled={!startsAt || rescheduling} onClick={submitReschedule}>
            {rescheduling ? 'Переносим…' : 'Перенести'}
          </button>
        </div>
      )}

      {inFlow && flowStep === 'confirm' && (
        <>
          <div className="footer footer-note">
            <button
              className="primary"
              disabled={submitting}
              onClick={submitBooking}
            >
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
