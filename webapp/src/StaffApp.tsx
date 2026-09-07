import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Master, Service, Booking, BlockedSlot, MasterPhoto } from './types'
import { isWorkDay, generateTimeSlots } from './schedule'
import { MONTH_NAMES, WEEKDAY_LABELS, dateKeyOf, startOfMonth, buildMonthCells } from './calendar'
import AdminManage from './AdminManage'
import ClientsPanel from './ClientsPanel'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

type StaffTab = 'profile' | 'today' | 'week' | 'schedule' | 'block' | 'clients' | 'manage' | 'myschedule' | 'more'

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

function formatSelectedDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

function normalizePhoneForLink(phone: string): string {
  return phone.replace(/\D/g, '')
}

export default function StaffApp({ telegramId, role, masterId, masterName }: StaffAppProps) {
  const [activeTab, setActiveTabRaw] = useState<StaffTab>(role === 'master' ? 'today' : 'schedule')

  // Карточка открытой записи (selectedBooking) общая для «Мой день» и «Неделя» —
  // без сброса при переключении вкладки она "зависала" бы поверх другой вкладки,
  // даже если запись принадлежит другому дню
  function setActiveTab(tab: StaffTab) {
    setActiveTabRaw(tab)
    setSelectedBooking(null)
    setNotePromptBooking(null)
  }
  const [date, setDate] = useState(todayKey())
  const [masters, setMasters] = useState<Master[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [scheduleMode, setScheduleMode] = useState<'none' | 'weekdays' | 'cycle'>('none')
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([])
  const [scheduleAnchorInput, setScheduleAnchorInput] = useState(todayKey())
  const [workDaysInput, setWorkDaysInput] = useState('2')
  const [offDaysInput, setOffDaysInput] = useState('2')
  const [workStartInput, setWorkStartInput] = useState('09:00')
  const [workEndInput, setWorkEndInput] = useState('20:00')
  const [schedulePreviewMonth, setSchedulePreviewMonth] = useState(() => startOfMonth(new Date()))
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleSaved, setScheduleSaved] = useState(false)
  const [bioInput, setBioInput] = useState('')
  const [bioSaving, setBioSaving] = useState(false)
  const [bioSaved, setBioSaved] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [profilePhotos, setProfilePhotos] = useState<MasterPhoto[]>([])
  const [photosLoading, setPhotosLoading] = useState(true)
  const [portfolioUploading, setPortfolioUploading] = useState(false)
  const [photoPreview, setPhotoPreview] = useState<MasterPhoto | null>(null)
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
  const [, setMonthLoading] = useState(true)

  const [blockMasterId, setBlockMasterId] = useState<number | ''>(role === 'master' ? masterId ?? '' : '')
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [blockNote, setBlockNote] = useState('')
  const [blockAllDay, setBlockAllDay] = useState(false)
  const [blockSubmitting, setBlockSubmitting] = useState(false)

  const [showNewBooking, setShowNewBooking] = useState(false)
  const [newBookingMasterId, setNewBookingMasterId] = useState<number | ''>('')
  const [newBookingServiceId, setNewBookingServiceId] = useState<number | ''>('')
  const [newBookingTime, setNewBookingTime] = useState('')
  const [newBookingClientName, setNewBookingClientName] = useState('')
  const [newBookingContact, setNewBookingContact] = useState<'phone' | 'telegram'>('phone')
  const [newBookingPhone, setNewBookingPhone] = useState('')
  const [newBookingTelegramId, setNewBookingTelegramId] = useState('')
  const [newBookingNote, setNewBookingNote] = useState('')
  const [newBookingSaving, setNewBookingSaving] = useState(false)
  const [whatsappConfirmLink, setWhatsappConfirmLink] = useState<{ url: string; clientName: string } | null>(null)

  const newBookingService = services.find((s) => s.id === newBookingServiceId)
  const newBookingMaster = masters.find((m) => m.id === newBookingMasterId)

  // Видно сразу по ходу заполнения формы, а не только после отказа сервера:
  // выходной у мастера, прошедшее время, занятой слот
  const newBookingMasterOffDuty = newBookingMaster ? !isWorkDay(date, newBookingMaster) : false

  const newBookingIsPast = newBookingTime ? new Date(`${date}T${newBookingTime}`).getTime() < Date.now() : false

  // Занят ли мастер в это время — используется и для сетки слотов (какие
  // кнопки disabled), и для итоговой проверки перед отправкой
  function isTimeTakenForNewBooking(time: string): boolean {
    if (!newBookingMasterId || !newBookingService) return false
    const start = new Date(`${date}T${time}`).getTime()
    const end = start + newBookingService.duration_minutes * 60000
    const bookingHit = bookings.some((b) => {
      if (b.master_id !== newBookingMasterId) return false
      const bStart = new Date(b.starts_at).getTime()
      const bEnd = bStart + b.duration_minutes * 60000
      return start < bEnd && bStart < end
    })
    if (bookingHit) return true
    return blocks.some((bl) => {
      if (bl.master_id !== newBookingMasterId) return false
      return start < new Date(bl.ends_at).getTime() && new Date(bl.starts_at).getTime() < end
    })
  }

  const newBookingConflict = newBookingTime ? isTimeTakenForNewBooking(newBookingTime) : false

  const newBookingBlockReason = newBookingIsPast
    ? 'Нельзя записать на прошедшее время'
    : newBookingMasterOffDuty
      ? 'У мастера выходной в этот день'
      : newBookingConflict
        ? 'Это время уже занято, выберите другое'
        : null

  // Услуга с риском аллергии — подтягиваем существующую заметку о клиенте,
  // если она уже есть (чтобы админ не перезаписал её вслепую)
  async function checkExistingNoteForNewBooking() {
    if (!newBookingService?.requires_allergy_check) return
    const url =
      newBookingContact === 'telegram' && newBookingTelegramId.trim()
        ? `${API_URL}/api/client-notes/${newBookingTelegramId.trim()}`
        : newBookingContact === 'phone' && newBookingPhone.trim()
          ? `${API_URL}/api/client-notes/by-phone/${encodeURIComponent(newBookingPhone.trim())}`
          : null
    if (!url) return
    try {
      const res = await fetch(url)
      const data = await res.json()
      if (data.note) setNewBookingNote(data.note)
    } catch {
      // тихо — необязательное удобство, не мешает записи
    }
  }

  useEffect(() => {
    fetch(`${API_URL}/api/masters`)
      .then((r) => r.json())
      .then(setMasters)
      .catch(() => {})
    fetch(`${API_URL}/api/services`)
      .then((r) => r.json())
      .then(setServices)
      .catch(() => {})
  }, [])

  const myMaster = role === 'master' ? masters.find((m) => m.id === masterId) : undefined

  // Подтягиваем текущий график мастера в форму, как только список мастеров загрузился
  useEffect(() => {
    if (!myMaster) return
    setScheduleMode(myMaster.schedule_type ?? 'none')
    setSelectedWeekdays(myMaster.work_weekdays ?? [])
    setScheduleAnchorInput(myMaster.schedule_anchor ?? todayKey())
    setWorkDaysInput(myMaster.work_days ? String(myMaster.work_days) : '2')
    setOffDaysInput(myMaster.off_days ? String(myMaster.off_days) : '2')
    setWorkStartInput(myMaster.work_start_time ?? '09:00')
    setWorkEndInput(myMaster.work_end_time ?? '20:00')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    myMaster?.schedule_type,
    myMaster?.schedule_anchor,
    myMaster?.work_days,
    myMaster?.off_days,
    myMaster?.work_weekdays,
    myMaster?.work_start_time,
    myMaster?.work_end_time,
  ])

  function toggleWeekday(day: number) {
    setSelectedWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()))
    setScheduleSaved(false)
  }

  async function saveMySchedule(e: FormEvent) {
    e.preventDefault()
    setScheduleSaving(true)
    setScheduleSaved(false)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/my-schedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          schedule_type: scheduleMode,
          schedule_anchor: scheduleMode === 'cycle' ? scheduleAnchorInput : null,
          work_days: scheduleMode === 'cycle' ? Number(workDaysInput) : null,
          off_days: scheduleMode === 'cycle' ? Number(offDaysInput) : null,
          work_weekdays: scheduleMode === 'weekdays' ? selectedWeekdays : null,
          work_start_time: workStartInput,
          work_end_time: workEndInput,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setMasters((prev) =>
        prev.map((m) =>
          m.id === masterId
            ? {
                ...m,
                schedule_type: data.schedule_type,
                schedule_anchor: data.schedule_anchor,
                work_days: data.work_days,
                off_days: data.off_days,
                work_weekdays: data.work_weekdays,
                work_start_time: data.work_start_time,
                work_end_time: data.work_end_time,
              }
            : m
        )
      )
      setScheduleSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setScheduleSaving(false)
    }
  }

  // Подтягиваем текущее описание "о себе" в форму, как только мастер загрузился
  useEffect(() => {
    if (myMaster) setBioInput(myMaster.bio ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myMaster?.bio])

  async function saveBio(e: FormEvent) {
    e.preventDefault()
    setBioSaving(true)
    setBioSaved(false)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/my-profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, bio: bioInput }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setMasters((prev) => prev.map((m) => (m.id === masterId ? { ...m, bio: data.bio } : m)))
      setBioSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setBioSaving(false)
    }
  }

  async function uploadAvatar(file: File) {
    setAvatarUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('telegram_id', String(telegramId))
      form.append('photo', file)
      const res = await fetch(`${API_URL}/api/staff/my-avatar`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить фото')
      setMasters((prev) => prev.map((m) => (m.id === masterId ? { ...m, photo_url: data.photo_url } : m)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить фото')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function loadProfilePhotos() {
    if (role !== 'master' || !masterId) return
    setPhotosLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/masters/${masterId}/photos`)
      setProfilePhotos(await res.json())
    } catch {
      // тихо — сетка просто останется пустой
    } finally {
      setPhotosLoading(false)
    }
  }

  useEffect(() => {
    loadProfilePhotos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, masterId])

  async function uploadPortfolioPhoto(file: File) {
    setPortfolioUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('telegram_id', String(telegramId))
      form.append('photo', file)
      const res = await fetch(`${API_URL}/api/staff/portfolio-photos`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить фото')
      setProfilePhotos((prev) => [data, ...prev])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить фото')
    } finally {
      setPortfolioUploading(false)
    }
  }

  async function deletePortfolioPhoto(id: number) {
    try {
      const res = await fetch(`${API_URL}/api/staff/portfolio-photos/${id}?telegram_id=${telegramId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Не удалось удалить фото')
      setProfilePhotos((prev) => prev.filter((p) => p.id !== id))
      setPhotoPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить фото')
    }
  }

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

  const [notePromptBooking, setNotePromptBooking] = useState<Booking | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteSaving, setNoteSaving] = useState(false)

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
      await Promise.all([loadToday(), loadWeek()])

      // После "Выполнена" — предложить добавить/обновить заметку о клиенте.
      // Заметка уже пришла вместе с записью (client_note) — отдельный запрос не нужен
      if (status === 'completed' && (selectedBooking?.client_telegram_id || selectedBooking?.client_phone)) {
        const booking = selectedBooking
        setSelectedBooking(null)
        setNotePromptBooking(booking)
        setNoteText(booking.client_note ?? '')
      } else {
        setSelectedBooking(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setStatusSaving(false)
    }
  }

  async function saveNote() {
    const booking = notePromptBooking
    if (!booking?.client_telegram_id && !booking?.client_phone) return
    if (!noteText.trim()) {
      setNotePromptBooking(null)
      return
    }
    setNoteSaving(true)
    setError('')
    try {
      const url = booking.client_telegram_id
        ? `${API_URL}/api/client-notes/${booking.client_telegram_id}`
        : `${API_URL}/api/client-notes/by-phone/${booking.client_phone}`
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteText.trim() }),
      })
      if (!res.ok) throw new Error('Не удалось сохранить заметку')
      setNotePromptBooking(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить заметку')
    } finally {
      setNoteSaving(false)
    }
  }

  function skipNote() {
    setNotePromptBooking(null)
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

  // Админ записывает клиента вручную — тот позвонил или написал в WhatsApp,
  // а не открывал Mini App сам
  async function submitNewBooking(e: FormEvent) {
    e.preventDefault()
    if (!newBookingMasterId || !newBookingServiceId || !newBookingTime || !newBookingClientName.trim()) return
    if (newBookingContact === 'phone' && !newBookingPhone.trim()) return
    if (newBookingContact === 'telegram' && !newBookingTelegramId.trim()) return
    if (newBookingBlockReason) return

    setNewBookingSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          master_id: newBookingMasterId,
          service_id: newBookingServiceId,
          starts_at: `${date}T${newBookingTime}`,
          client_name: newBookingClientName.trim(),
          client_phone: newBookingContact === 'phone' ? newBookingPhone.trim() : undefined,
          client_telegram_id: newBookingContact === 'telegram' ? Number(newBookingTelegramId) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')

      if (newBookingNote.trim()) {
        const noteUrl =
          newBookingContact === 'telegram'
            ? `${API_URL}/api/client-notes/${newBookingTelegramId.trim()}`
            : `${API_URL}/api/client-notes/by-phone/${encodeURIComponent(newBookingPhone.trim())}`
        fetch(noteUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: newBookingNote.trim() }),
        }).catch(() => {})
      }

      if (newBookingContact === 'phone') {
        const masterName = masters.find((m) => m.id === newBookingMasterId)?.name ?? ''
        const message = `Здравствуйте, ${newBookingClientName.trim()}! Вы записаны в салон: ${newBookingService?.name ?? ''}, ${formatSelectedDate(date)} в ${newBookingTime}, мастер ${masterName}. Ждём вас!`
        setWhatsappConfirmLink({
          url: `https://wa.me/${normalizePhoneForLink(newBookingPhone)}?text=${encodeURIComponent(message)}`,
          clientName: newBookingClientName.trim(),
        })
      } else {
        setWhatsappConfirmLink(null)
      }

      setShowNewBooking(false)
      setNewBookingMasterId('')
      setNewBookingServiceId('')
      setNewBookingTime('')
      setNewBookingClientName('')
      setNewBookingPhone('')
      setNewBookingTelegramId('')
      setNewBookingContact('phone')
      setNewBookingNote('')
      await loadSchedule()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setNewBookingSaving(false)
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

  const schedulePreviewMaster = myMaster
    ? {
        ...myMaster,
        schedule_type: scheduleMode === 'none' ? null : scheduleMode,
        schedule_anchor: scheduleMode === 'cycle' ? scheduleAnchorInput : null,
        work_days: scheduleMode === 'cycle' ? Number(workDaysInput) || null : null,
        off_days: scheduleMode === 'cycle' ? Number(offDaysInput) || null : null,
        work_weekdays: scheduleMode === 'weekdays' ? selectedWeekdays : null,
      }
    : null

  const scheduleTodayIsWorkDay = schedulePreviewMaster ? isWorkDay(todayKey(), schedulePreviewMaster) : true

  return (
    <div className="staff-app">
      <header className="staff-header">
        <h1>Персонал</h1>
        <span className="staff-role-badge">{role === 'admin' ? 'Администратор' : `Мастер: ${masterName}`}</span>
      </header>

      <nav className="staff-tabs">
        {role === 'master' && (
          <button
            type="button"
            className={activeTab === 'today' || activeTab === 'week' ? 'active' : ''}
            onClick={() => {
              if (activeTab !== 'today' && activeTab !== 'week') setActiveTab('today')
            }}
          >
            📅 Расписание
          </button>
        )}
        {role === 'master' && (
          <button
            type="button"
            className={activeTab === 'profile' ? 'active' : ''}
            onClick={() => setActiveTab('profile')}
          >
            👤 Профиль
          </button>
        )}
        {role === 'master' && (
          <button
            type="button"
            className={activeTab === 'more' || activeTab === 'myschedule' || activeTab === 'block' ? 'active' : ''}
            onClick={() => setActiveTab('more')}
          >
            ⚙️ Ещё
          </button>
        )}
        {role === 'admin' && (
          <button
            type="button"
            className={activeTab === 'schedule' ? 'active' : ''}
            onClick={() => setActiveTab('schedule')}
          >
            Расписание
          </button>
        )}
        {role === 'admin' && (
          <button type="button" className={activeTab === 'block' ? 'active' : ''} onClick={() => setActiveTab('block')}>
            Заблокировать время
          </button>
        )}
        {role === 'admin' && (
          <button type="button" className={activeTab === 'clients' ? 'active' : ''} onClick={() => setActiveTab('clients')}>
            Клиенты
          </button>
        )}
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

      {role === 'master' && (activeTab === 'today' || activeTab === 'week') && !selectedBooking && !notePromptBooking && (
        <div className="staff-mode-toggle staff-schedule-toggle">
          <button type="button" className={activeTab === 'today' ? 'active' : ''} onClick={() => setActiveTab('today')}>
            Сегодня
          </button>
          <button type="button" className={activeTab === 'week' ? 'active' : ''} onClick={() => setActiveTab('week')}>
            Неделя
          </button>
        </div>
      )}

      {role === 'master' && activeTab === 'more' && (
        <section className="staff-more-menu">
          <button type="button" className="staff-more-menu-item" onClick={() => setActiveTab('myschedule')}>
            🗓 Мой график
          </button>
          <button type="button" className="staff-more-menu-item" onClick={() => setActiveTab('block')}>
            🚫 Заблокировать время
          </button>
        </section>
      )}

      {activeTab === 'today' && !selectedBooking && !notePromptBooking && (
        <section className="staff-schedule">
          {todayLoading ? (
            <p className="staff-empty">Загрузка…</p>
          ) : todayBookings.length === 0 ? (
            <p className="staff-empty">На сегодня записей нет</p>
          ) : (
            <ul className="staff-list">
              {todayBookings.map((b) => (
                <li key={b.id} className={`staff-list-item staff-list-item--clickable${b.status === 'completed' ? ' staff-list-item--completed' : ''}${b.status === 'no_show' ? ' staff-list-item--no-show' : ''}`} onClick={() => setSelectedBooking(b)}>
                  <span className="staff-list-time">{formatTime(b.starts_at)}</span>
                  <span className="staff-list-body">
                    {b.client_name ?? 'Клиент'} — {b.service_name}
                    {b.client_note && <span className="staff-allergy-badge" title={b.client_note}> ⚠ есть заметка</span>}
                    {b.status === 'completed' && <span className="staff-status staff-status--done"> ✓ выполнено</span>}
                    {b.status === 'no_show' && <span className="staff-status staff-status--no-show"> ✕ не пришёл</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(activeTab === 'today' || activeTab === 'week') && selectedBooking && (
        <section className="staff-booking-card">
          <button type="button" className="staff-back-btn" onClick={() => setSelectedBooking(null)}>
            ← Назад
          </button>
          <h2>{selectedBooking.client_name ?? 'Клиент'}</h2>
          <p className="staff-card-line">{selectedBooking.service_name}</p>
          <p className="staff-card-line">{formatTime(selectedBooking.starts_at)}</p>
          {selectedBooking.client_username ? (
            <a
              className="staff-telegram-link"
              href={`https://t.me/${selectedBooking.client_username}`}
              target="_blank"
              rel="noreferrer"
            >
              💬 Написать в Telegram
            </a>
          ) : selectedBooking.client_phone ? (
            <a
              className="staff-telegram-link"
              href={`https://wa.me/${selectedBooking.client_phone}`}
              target="_blank"
              rel="noreferrer"
            >
              💬 Написать в WhatsApp
            </a>
          ) : (
            <p className="staff-telegram-link staff-telegram-link--disabled">
              Написать клиенту нельзя — нет контакта в Telegram
            </p>
          )}
          {selectedBooking.client_note && (
            <div className="staff-note-warning">
              <span className="staff-note-warning-label">⚠ Заметка о клиенте</span>
              <p>{selectedBooking.client_note}</p>
            </div>
          )}
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

      {(activeTab === 'today' || activeTab === 'week') && notePromptBooking && (
        <section className="staff-booking-card">
          <h2>Добавить заметку о клиенте?</h2>
          <p className="staff-card-line">{notePromptBooking.client_name ?? 'Клиент'} — необязательно</p>
          <textarea
            className="staff-note-textarea"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Например: аллергия на аммиак, чувствительная кожа головы…"
            rows={4}
          />
          <div className="staff-card-actions">
            <button type="button" className="staff-card-done" disabled={noteSaving} onClick={saveNote}>
              {noteSaving ? 'Сохранение…' : 'Сохранить'}
            </button>
            <button type="button" className="staff-card-no-show" disabled={noteSaving} onClick={skipNote}>
              Пропустить
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
          ) : selectedBooking || notePromptBooking ? null : (
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
                        <li
                          key={b.id}
                          className={`staff-list-item staff-list-item--clickable${b.status === 'completed' ? ' staff-list-item--completed' : ''}${b.status === 'no_show' ? ' staff-list-item--no-show' : ''}`}
                          onClick={() => setSelectedBooking(b)}
                        >
                          <span className="staff-list-time">{formatTime(b.starts_at)}</span>
                          <span className="staff-list-body">
                            {b.client_name ?? 'Клиент'} — {b.service_name}
                            {b.client_note && <span className="staff-allergy-badge" title={b.client_note}> ⚠</span>}
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

          {role === 'admin' && masters.length > 0 && (
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
          <button type="button" className="staff-add-btn" onClick={() => setShowNewBooking((v) => !v)}>
            {showNewBooking ? 'Отмена' : '+ Новая запись'}
          </button>

          {showNewBooking && (
            <form className="staff-admin-form staff-new-booking-form" onSubmit={submitNewBooking}>
              <h3>Новая запись на {formatSelectedDate(date)}</h3>
              <p className="staff-form-hint">Для клиента, который позвонил или написал в WhatsApp, а не в Mini App.</p>
              <label>
                Услуга
                <select
                  value={newBookingServiceId}
                  onChange={(e) => {
                    setNewBookingServiceId(Number(e.target.value))
                    setNewBookingMasterId('')
                    setNewBookingTime('')
                  }}
                  required
                >
                  <option value="" disabled>
                    Выберите услугу
                  </option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.price} ₽
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Мастер
                <select
                  value={newBookingMasterId}
                  onChange={(e) => {
                    setNewBookingMasterId(Number(e.target.value))
                    setNewBookingTime('')
                  }}
                  disabled={!newBookingServiceId}
                  required
                >
                  <option value="" disabled>
                    {newBookingServiceId ? 'Выберите мастера' : 'Сначала выберите услугу'}
                  </option>
                  {masters
                    .filter((m) => m.service_ids.includes(newBookingServiceId as number))
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
              {newBookingMasterOffDuty && (
                <p className="staff-error">У мастера выходной {formatSelectedDate(date)} — выберите другого мастера или дату</p>
              )}
              {newBookingMasterId && !newBookingMasterOffDuty && (
                <div>
                  <span className="staff-checkbox-label">Время</span>
                  <div className="staff-time-grid">
                    {generateTimeSlots(
                      newBookingMaster?.work_start_time ?? '09:00',
                      newBookingMaster?.work_end_time ?? '20:00'
                    ).map((t) => {
                      const past = new Date(`${date}T${t}`).getTime() < Date.now()
                      const taken = !past && isTimeTakenForNewBooking(t)
                      return (
                        <button
                          key={t}
                          type="button"
                          className={`staff-time-slot${newBookingTime === t ? ' active' : ''}`}
                          disabled={past || taken}
                          title={taken ? 'Уже занято' : past ? 'Уже прошло' : undefined}
                          onClick={() => setNewBookingTime(t)}
                        >
                          {t}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {!newBookingMasterOffDuty && newBookingBlockReason && <p className="staff-error">{newBookingBlockReason}</p>}
              <label>
                Имя клиента
                <input
                  type="text"
                  value={newBookingClientName}
                  onChange={(e) => setNewBookingClientName(e.target.value)}
                  required
                />
              </label>
              <div className="staff-checkbox-group">
                <span className="staff-checkbox-label">Как связаться с клиентом</span>
                <label className="staff-checkbox-row">
                  <input
                    type="radio"
                    name="new-booking-contact"
                    checked={newBookingContact === 'phone'}
                    onChange={() => setNewBookingContact('phone')}
                  />
                  Телефон (звонок / WhatsApp)
                </label>
                <label className="staff-checkbox-row">
                  <input
                    type="radio"
                    name="new-booking-contact"
                    checked={newBookingContact === 'telegram'}
                    onChange={() => setNewBookingContact('telegram')}
                  />
                  Telegram ID (если известен)
                </label>
              </div>
              {newBookingContact === 'phone' ? (
                <label>
                  Телефон
                  <input
                    type="tel"
                    value={newBookingPhone}
                    onChange={(e) => setNewBookingPhone(e.target.value)}
                    onBlur={checkExistingNoteForNewBooking}
                    placeholder="+7 999 123-45-67"
                    required
                  />
                </label>
              ) : (
                <label>
                  Telegram ID
                  <input
                    type="number"
                    value={newBookingTelegramId}
                    onChange={(e) => setNewBookingTelegramId(e.target.value)}
                    onBlur={checkExistingNoteForNewBooking}
                    placeholder="Узнать можно через @userinfobot"
                    required
                  />
                </label>
              )}
              {newBookingService?.requires_allergy_check && (
                <label>
                  Заметка о клиенте (аллергии/особенности) — необязательно
                  <textarea
                    className="staff-note-textarea"
                    value={newBookingNote}
                    onChange={(e) => setNewBookingNote(e.target.value)}
                    placeholder="Например: аллергия на аммиак, чувствительная кожа головы…"
                    rows={3}
                  />
                </label>
              )}
              <button type="submit" disabled={newBookingSaving || !!newBookingBlockReason}>
                {newBookingSaving ? 'Сохранение…' : 'Записать'}
              </button>
            </form>
          )}

          {whatsappConfirmLink && (
            <div className="staff-confirm-callout">
              <p>Запись для «{whatsappConfirmLink.clientName}» создана. Продублировать детали клиенту?</p>
              <div className="staff-confirm-callout-actions">
                <a
                  className="staff-telegram-link"
                  href={whatsappConfirmLink.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setWhatsappConfirmLink(null)}
                >
                  💬 Отправить подтверждение в WhatsApp
                </a>
                <button type="button" className="staff-confirm-dismiss" onClick={() => setWhatsappConfirmLink(null)}>
                  Не сейчас
                </button>
              </div>
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
                      {entry.booking.client_name && (
                        <span className="staff-client-meta">{entry.booking.client_name}</span>
                      )}
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
          {role === 'master' && (
            <button type="button" className="staff-back-btn" onClick={() => setActiveTab('more')}>
              ← Ещё
            </button>
          )}
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

          {blocks.length > 0 && (
            <ul className="staff-list staff-block-existing">
              {blocks.map((b) => (
                <li key={b.id} className="staff-list-item staff-list-item--block">
                  <span className="staff-list-time">{formatTime(b.starts_at)}</span>
                  <span className="staff-list-body">
                    {role === 'admin' ? `${b.master_name}` : 'Заблокировано'}
                    {b.note ? ` — ${b.note}` : ''}
                  </span>
                  <button type="button" className="staff-remove-btn" onClick={() => removeBlock(b.id)}>
                    Убрать
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === 'profile' && myMaster && (
        <section className="staff-admin-form staff-profile">
          <div className="staff-profile-avatar-row">
            <label className="staff-avatar-upload">
              {myMaster.photo_url ? (
                <img src={myMaster.photo_url} alt={myMaster.name} className="staff-avatar-img" />
              ) : (
                <span className="staff-avatar-placeholder">{myMaster.name.charAt(0)}</span>
              )}
              <span className="staff-avatar-edit-badge">{avatarUploading ? '…' : '✎'}</span>
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={avatarUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) uploadAvatar(file)
                  e.target.value = ''
                }}
              />
            </label>
            <div>
              <h3>{myMaster.name}</h3>
              <span className="staff-profile-hint">Нажмите на фото, чтобы поменять</span>
            </div>
          </div>

          <form onSubmit={saveBio} className="staff-profile-bio-form">
            <label>
              О себе
              <textarea
                rows={4}
                value={bioInput}
                placeholder="Расскажите клиентам о себе: специализация, опыт, стиль работы…"
                onChange={(e) => {
                  setBioInput(e.target.value)
                  setBioSaved(false)
                }}
              />
            </label>
            <button type="submit" disabled={bioSaving}>
              {bioSaving ? 'Сохранение…' : 'Сохранить описание'}
            </button>
            {bioSaved && <p className="staff-form-hint">Сохранено ✓</p>}
          </form>

          <div className="staff-portfolio">
            <div className="staff-portfolio-header">
              <span className="staff-checkbox-label">Фото работ</span>
              <label className="staff-portfolio-add">
                {portfolioUploading ? 'Загрузка…' : '+ Добавить фото'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={portfolioUploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) uploadPortfolioPhoto(file)
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
            {photosLoading ? (
              <p className="staff-empty">Загрузка…</p>
            ) : profilePhotos.length === 0 ? (
              <p className="staff-empty">Пока нет ни одного фото — добавьте примеры своих работ</p>
            ) : (
              <div className="staff-portfolio-grid">
                {profilePhotos.map((p) => (
                  <button key={p.id} type="button" className="staff-portfolio-thumb" onClick={() => setPhotoPreview(p)}>
                    <img src={p.url} alt="Фото работы" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {photoPreview && (
            <div className="staff-photo-lightbox" onClick={() => setPhotoPreview(null)}>
              <img src={photoPreview.url} alt="Фото работы" onClick={(e) => e.stopPropagation()} />
              <button
                type="button"
                className="staff-photo-lightbox-delete"
                onClick={(e) => {
                  e.stopPropagation()
                  deletePortfolioPhoto(photoPreview.id)
                }}
              >
                Удалить фото
              </button>
            </div>
          )}
        </section>
      )}

      {activeTab === 'myschedule' && myMaster && (
        <section className="staff-admin-form">
          <button type="button" className="staff-back-btn" onClick={() => setActiveTab('more')}>
            ← Ещё
          </button>
          <h3>Мой график работы</h3>

          <div className="staff-shift-row">
            <span className={`staff-shift-chip${scheduleTodayIsWorkDay ? '' : ' staff-shift-chip--off'}`}>
              Сегодня
              <span className="staff-shift-dot" />
              {scheduleTodayIsWorkDay ? 'рабочий день' : 'выходной'}
            </span>
          </div>

          {schedulePreviewMaster && (
            <div className="staff-month-calendar">
              <div className="staff-month-nav">
                <button
                  type="button"
                  className="staff-month-arrow"
                  onClick={() => setSchedulePreviewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                  aria-label="Предыдущий месяц"
                >
                  ‹
                </button>
                <span className="staff-month-label">
                  {MONTH_NAMES[schedulePreviewMonth.getMonth()]} {schedulePreviewMonth.getFullYear()}
                </span>
                <button
                  type="button"
                  className="staff-month-arrow"
                  onClick={() => setSchedulePreviewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
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
                {buildMonthCells(schedulePreviewMonth).map((d, i) => {
                  if (!d) return <span key={`empty-${i}`} className="staff-month-day staff-month-day-empty" />
                  const working = isWorkDay(dateKeyOf(d), schedulePreviewMaster)
                  return (
                    <span key={dateKeyOf(d)} className={`staff-month-day${working ? '' : ' staff-month-day--off'}`}>
                      {d.getDate()}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          <form onSubmit={saveMySchedule}>
            <label>
              Начало рабочего дня
              <input
                type="time"
                value={workStartInput}
                onChange={(e) => {
                  setWorkStartInput(e.target.value)
                  setScheduleSaved(false)
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
                  setScheduleSaved(false)
                }}
                required
              />
            </label>

            <span className="staff-checkbox-label">Какие дни работаю</span>
            <div className="staff-mode-toggle">
              <button
                type="button"
                className={scheduleMode === 'none' ? 'active' : ''}
                onClick={() => {
                  setScheduleMode('none')
                  setScheduleSaved(false)
                }}
              >
                Всегда
              </button>
              <button
                type="button"
                className={scheduleMode === 'weekdays' ? 'active' : ''}
                onClick={() => {
                  setScheduleMode('weekdays')
                  setScheduleSaved(false)
                }}
              >
                По дням недели
              </button>
              <button
                type="button"
                className={scheduleMode === 'cycle' ? 'active' : ''}
                onClick={() => {
                  setScheduleMode('cycle')
                  setScheduleSaved(false)
                }}
              >
                Скользящий
              </button>
            </div>

            {scheduleMode === 'weekdays' && (
              <div>
                <span className="staff-checkbox-label">Рабочие дни</span>
                <div className="staff-time-grid">
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

            {scheduleMode === 'cycle' && (
              <>
                <label>
                  Работаю подряд (дней)
                  <input
                    type="number"
                    min={1}
                    value={workDaysInput}
                    onChange={(e) => {
                      setWorkDaysInput(e.target.value)
                      setScheduleSaved(false)
                    }}
                    required
                  />
                </label>
                <label>
                  Потом выходной (дней)
                  <input
                    type="number"
                    min={1}
                    value={offDaysInput}
                    onChange={(e) => {
                      setOffDaysInput(e.target.value)
                      setScheduleSaved(false)
                    }}
                    required
                  />
                </label>
                <label>
                  Начиная с даты (в этот день — рабочий)
                  <input
                    type="date"
                    value={scheduleAnchorInput}
                    onChange={(e) => {
                      setScheduleAnchorInput(e.target.value)
                      setScheduleSaved(false)
                    }}
                    required
                  />
                </label>
              </>
            )}

            <button type="submit" disabled={scheduleSaving}>
              {scheduleSaving ? 'Сохранение…' : 'Сохранить график'}
            </button>
          </form>
          {scheduleSaved && <p className="staff-form-hint">Сохранено ✓ — видно клиентам и в вашем расписании сразу</p>}
        </section>
      )}

      {activeTab === 'clients' && <ClientsPanel telegramId={telegramId} />}

      {activeTab === 'manage' && <AdminManage telegramId={telegramId} />}
    </div>
  )
}
