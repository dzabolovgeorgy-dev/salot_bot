import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type { Broadcast, Master, SegmentFilter, Service } from './types'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

// Лимиты Telegram: подпись под фото короче обычного сообщения
const MAX_TEXT_LENGTH = 4096
const MAX_CAPTION_LENGTH = 1024

const LOYALTY_TIERS = ['Новичок', 'Серебро', 'Золото', 'Платина']

// Готовые тексты — чтобы не начинать с чистого листа, сразу на двух языках.
// {name} при отправке заменится именем клиента
const TEMPLATES: { label: string; text: string; textEn: string }[] = [
  {
    label: 'Скучаем',
    text: '{name}, мы по вам скучаем! 💐 Давно не виделись — запишитесь на удобное время прямо в приложении.',
    textEn: "{name}, we miss you! 💐 It's been a while — book a convenient time right in the app.",
  },
  {
    label: 'Акция',
    text: '{name}, только на этой неделе — скидка 15% на все услуги! Успейте записаться 🌸',
    textEn: '{name}, this week only — 15% off all services! Book while it lasts 🌸',
  },
  {
    label: 'Новая услуга',
    text: '{name}, у нас новая услуга! ✨ Будем рады видеть вас — запись уже открыта в приложении.',
    textEn: "{name}, we have a new service! ✨ We'd love to see you — booking is already open in the app.",
  },
  {
    label: 'Свободные окна',
    text: '{name}, на завтра освободилось несколько окошек у наших мастеров. Записывайтесь, пока есть время 🕊',
    textEn: '{name}, a few slots have opened up with our specialists for tomorrow. Book while they last 🕊',
  },
]

// Имя, которым показываем {name} в предпросмотре
const PREVIEW_NAME = 'Анна'
const PREVIEW_NAME_EN = 'Anna'

type SegmentKind = 'all' | 'service' | 'master' | 'tier' | 'days'

interface BroadcastFormProps {
  telegramId: number
  services: Service[]
  masters: Master[]
  onCreated: (broadcast: Broadcast) => void
  onCancel: () => void
}

function previewText(text: string, name = PREVIEW_NAME): string {
  return text.replaceAll('{name}', name)
}

export default function BroadcastForm({ telegramId, services, masters, onCreated, onCancel }: BroadcastFormProps) {
  const [text, setText] = useState('')
  // Необязательный английский текст — его получат клиенты с английским языком
  const [textEn, setTextEn] = useState('')
  const [showEn, setShowEn] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [segmentKind, setSegmentKind] = useState<SegmentKind>('all')
  const [serviceId, setServiceId] = useState('')
  const [masterId, setMasterId] = useState('')
  const [tier, setTier] = useState(LOYALTY_TIERS[0])
  const [days, setDays] = useState('60')

  const [audience, setAudience] = useState<number | null>(null)

  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now')
  const [scheduledAt, setScheduledAt] = useState('')

  const [testing, setTesting] = useState(false)
  const [testSent, setTestSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const limit = imageUrl ? MAX_CAPTION_LENGTH : MAX_TEXT_LENGTH
  const tooLong = text.trim().length > limit
  const tooLongEn = textEn.trim().length > limit

  // Условие отбора в том виде, в каком его ждёт сервер. null — "все клиенты";
  // undefined — условие ещё не дозаполнено (например, не выбрана услуга)
  function buildFilter(): SegmentFilter | null | undefined {
    switch (segmentKind) {
      case 'all':
        return null
      case 'service':
        return serviceId ? { service_id: Number(serviceId) } : undefined
      case 'master':
        return masterId ? { master_id: Number(masterId) } : undefined
      case 'tier':
        return { loyalty_tier: tier }
      case 'days':
        return Number(days) > 0 ? { min_days_since_visit: Math.floor(Number(days)) } : undefined
    }
  }

  const filter = buildFilter()
  const filterKey = JSON.stringify(filter ?? null) + String(filter === undefined)

  // Пересчитываем, сколько человек получит рассылку, при каждой смене
  // сегмента — с небольшой паузой, чтобы не спрашивать сервер на каждую
  // набранную цифру в поле "дней"
  useEffect(() => {
    if (filter === undefined) {
      setAudience(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/staff/broadcasts/audience`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telegram_id: telegramId, segment_filter: filter }),
        })
        const data = await res.json()
        if (!cancelled && res.ok) setAudience(data.count)
      } catch {
        // тихо — просто не покажем число
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  async function handleImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('telegram_id', String(telegramId))
      form.append('photo', file)
      const res = await apiFetch(`${API_URL}/api/staff/broadcasts/image`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить фото')
      setImageUrl(data.image_url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить фото')
    } finally {
      setUploading(false)
    }
  }

  async function sendTest() {
    if (!text.trim() || tooLong || tooLongEn) return
    setTesting(true)
    setTestSent(false)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/broadcasts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, text: text.trim(), text_en: textEn.trim(), image_url: imageUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось отправить тест')
      setTestSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить тест')
    } finally {
      setTesting(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || tooLong || tooLongEn || filter === undefined) return
    if (scheduleMode === 'later' && !scheduledAt) {
      setError('Выберите дату и время отправки')
      return
    }
    if (scheduleMode === 'now') {
      const who = audience != null ? `${audience} клиентам` : 'выбранным клиентам'
      if (!window.confirm(`Отправить рассылку ${who} прямо сейчас?`)) return
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/broadcasts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          text: text.trim(),
          text_en: textEn.trim(),
          image_url: imageUrl,
          segment_filter: filter,
          scheduled_at: scheduleMode === 'later' ? scheduledAt : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось создать рассылку')
      onCreated(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать рассылку')
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = !!text.trim() && !tooLong && !tooLongEn && filter !== undefined && !uploading && !submitting

  return (
    <form className="staff-admin-form broadcast-form" onSubmit={submit}>
      <h3>Новая рассылка</h3>

      {error && <div className="staff-error">{error}</div>}

      <div className="broadcast-field">
        <span className="broadcast-label">Шаблоны</span>
        <div className="staff-folder-chips broadcast-chips">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.label}
              type="button"
              className="staff-folder-chip"
              onClick={() => {
                setText(tpl.text)
                setTextEn(tpl.textEn)
                setShowEn(true)
                setTestSent(false)
              }}
            >
              {tpl.label}
            </button>
          ))}
        </div>
      </div>

      <label>
        Текст сообщения
        <textarea
          className="broadcast-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setTestSent(false)
          }}
          rows={5}
          placeholder="Например: {name}, дарим скидку 10% на маникюр до конца месяца!"
        />
        <span className={tooLong ? 'staff-form-hint staff-form-hint--error' : 'staff-form-hint'}>
          {text.trim().length} / {limit}
          {imageUrl && ' (с фото Telegram разрешает не больше 1024 символов)'} · {'{name}'} заменится именем клиента
        </span>
      </label>

      {!showEn ? (
        <button type="button" className="faq-manage-link" onClick={() => setShowEn(true)}>
          + Текст по-английски
        </button>
      ) : (
        <label>
          Текст по-английски (необязательно)
          <textarea
            className="broadcast-textarea"
            value={textEn}
            onChange={(e) => {
              setTextEn(e.target.value)
              setTestSent(false)
            }}
            rows={4}
            placeholder="{name}, 10% off manicure until the end of the month!"
          />
          <span className={tooLongEn ? 'staff-form-hint staff-form-hint--error' : 'staff-form-hint'}>
            {textEn.trim().length} / {limit} · получат клиенты с английским языком. Если пусто — им уйдёт русский
            текст
          </span>
        </label>
      )}

      <div className="broadcast-field">
        <span className="broadcast-label">Фото (необязательно)</span>
        {imageUrl ? (
          <div className="broadcast-image-row">
            <img src={imageUrl} alt="" className="broadcast-image-thumb" />
            <button type="button" className="staff-cancel-btn" onClick={() => setImageUrl(null)}>
              Убрать фото
            </button>
          </div>
        ) : (
          <label className="staff-more-menu-item broadcast-upload">
            {uploading ? 'Загрузка…' : '🖼 Выбрать фото'}
            <input type="file" accept="image/*" hidden onChange={handleImage} disabled={uploading} />
          </label>
        )}
      </div>

      {text.trim() && (
        <div className="broadcast-field">
          <span className="broadcast-label">Так увидит клиент</span>
          <div className="broadcast-preview">
            {imageUrl && <img src={imageUrl} alt="" className="broadcast-preview-image" />}
            <p className="broadcast-preview-text">{previewText(text.trim())}</p>
          </div>
          {textEn.trim() && (
            <div className="broadcast-preview">
              {imageUrl && <img src={imageUrl} alt="" className="broadcast-preview-image" />}
              <span className="broadcast-lang-tag">EN</span>
              <p className="broadcast-preview-text">{previewText(textEn.trim(), PREVIEW_NAME_EN)}</p>
            </div>
          )}
        </div>
      )}

      <label>
        Кому отправить
        <select value={segmentKind} onChange={(e) => setSegmentKind(e.target.value as SegmentKind)}>
          <option value="all">Все клиенты</option>
          <option value="service">По услуге</option>
          <option value="master">По мастеру</option>
          <option value="tier">По уровню лояльности</option>
          <option value="days">Не были больше N дней</option>
        </select>
      </label>

      {segmentKind === 'service' && (
        <label>
          Клиенты, которые были на услуге
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">— выберите услугу —</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {segmentKind === 'master' && (
        <label>
          Клиенты мастера
          <select value={masterId} onChange={(e) => setMasterId(e.target.value)}>
            <option value="">— выберите мастера —</option>
            {masters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {segmentKind === 'tier' && (
        <label>
          Уровень
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {LOYALTY_TIERS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}

      {segmentKind === 'days' && (
        <label>
          Сколько дней не были
          <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
          <span className="staff-form-hint">Клиенты, у которых нет новой записи на будущее</span>
        </label>
      )}

      <div className="broadcast-audience">
        <span>
          Получат: <strong>{audience == null ? '…' : audience}</strong>
        </span>
        <span className="staff-form-hint">Только клиенты, согласившиеся получать рассылки</span>
      </div>

      <div className="broadcast-field">
        <span className="broadcast-label">Когда</span>
        <div className="staff-folder-chips broadcast-chips">
          <button
            type="button"
            className={scheduleMode === 'now' ? 'staff-folder-chip active' : 'staff-folder-chip'}
            onClick={() => setScheduleMode('now')}
          >
            Отправить сейчас
          </button>
          <button
            type="button"
            className={scheduleMode === 'later' ? 'staff-folder-chip active' : 'staff-folder-chip'}
            onClick={() => setScheduleMode('later')}
          >
            Запланировать
          </button>
        </div>
      </div>

      {scheduleMode === 'later' && (
        <label>
          Дата и время отправки
          <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </label>
      )}

      <button
        type="button"
        className="staff-cancel-btn"
        onClick={sendTest}
        disabled={!text.trim() || tooLong || tooLongEn || testing || uploading}
      >
        {testing ? 'Отправка…' : testSent ? 'Тест отправлен ✓ — проверьте Telegram' : 'Отправить тест себе'}
      </button>

      <div className="staff-form-actions">
        <button type="submit" disabled={!canSubmit}>
          {submitting ? 'Сохранение…' : scheduleMode === 'now' ? 'Отправить' : 'Запланировать'}
        </button>
        <button type="button" className="staff-cancel-btn" onClick={onCancel}>
          Отменить
        </button>
      </div>
    </form>
  )
}
