import { useEffect, useState } from 'react'
import type { Broadcast, BroadcastStatus, Master, SegmentFilter, Service } from './types'
import BroadcastForm from './BroadcastForm'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

interface BroadcastsProps {
  telegramId: number
  onBack: () => void
}

const STATUS_LABELS: Record<BroadcastStatus, string> = {
  draft: 'Черновик',
  scheduled: 'Запланирована',
  sending: 'Отправляется',
  completed: 'Завершена',
}

function formatDateTime(iso: string): string {
  return new Date(iso.replace(' ', 'T')).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Кому адресована рассылка — человеческим языком. Названия услуг/мастеров
// подставляются, когда они уже загружены, иначе показываем просто номер
export function describeSegment(
  filter: SegmentFilter | null,
  names: { services?: Map<number, string>; masters?: Map<number, string> } = {}
): string {
  if (!filter || Object.keys(filter).length === 0) return 'Все клиенты'
  if (filter.service_id) return `Услуга: ${names.services?.get(filter.service_id) ?? `№${filter.service_id}`}`
  if (filter.master_id) return `Мастер: ${names.masters?.get(filter.master_id) ?? `№${filter.master_id}`}`
  if (filter.loyalty_tier) return `Уровень лояльности: ${filter.loyalty_tier}`
  if (filter.min_days_since_visit) return `Не были больше ${filter.min_days_since_visit} дн.`
  return 'Все клиенты'
}

export default function Broadcasts({ telegramId, onBack }: BroadcastsProps) {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [services, setServices] = useState<Service[]>([])
  const [masters, setMasters] = useState<Master[]>([])

  async function loadBroadcasts() {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/broadcasts?telegram_id=${telegramId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить рассылки')
      setBroadcasts(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить рассылки')
    } finally {
      setLoading(false)
    }
  }

  // Услуги и мастера — для выбора сегмента в форме и для подписи
  // "Услуга: Маникюр" в списке вместо голого номера
  async function loadCatalog() {
    try {
      const [servicesRes, mastersRes] = await Promise.all([
        apiFetch(`${API_URL}/api/services`),
        apiFetch(`${API_URL}/api/masters`),
      ])
      if (servicesRes.ok) setServices(await servicesRes.json())
      if (mastersRes.ok) setMasters(await mastersRes.json())
    } catch {
      // тихо — в списке останутся номера, форма покажет пустые списки
    }
  }

  useEffect(() => {
    loadBroadcasts()
    loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Пока какая-то рассылка отправляется — тихо обновляем список раз в
  // 5 секунд, чтобы было видно, как растёт число отправленных
  const hasSending = broadcasts.some((b) => b.status === 'sending')
  useEffect(() => {
    if (!hasSending) return
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/staff/broadcasts?telegram_id=${telegramId}`)
        if (res.ok) setBroadcasts(await res.json())
      } catch {
        // тихо — попробуем в следующий раз
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [hasSending, telegramId])

  const names = {
    services: new Map(services.map((s) => [s.id, s.name])),
    masters: new Map(masters.map((m) => [m.id, m.name])),
  }

  return (
    <section className="staff-admin-form">
      <button type="button" className="staff-back-btn" onClick={onBack}>
        ← Ещё
      </button>
      <h3>Рассылки</h3>

      {error && <div className="staff-error">{error}</div>}

      {!creating ? (
        <button type="button" className="staff-more-menu-item" onClick={() => setCreating(true)}>
          + Новая рассылка
        </button>
      ) : (
        <BroadcastForm
          telegramId={telegramId}
          services={services}
          masters={masters}
          onCreated={(created) => {
            setBroadcasts((prev) => [created, ...prev])
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {loading ? (
        <p className="staff-empty">Загрузка…</p>
      ) : broadcasts.length === 0 ? (
        <p className="staff-empty">Рассылок пока не было</p>
      ) : (
        <ul className="staff-list">
          {broadcasts.map((b) => {
            const failed = b.errors + b.blocked
            return (
              <li key={b.id} className="staff-list-item broadcast-item">
                <div className="broadcast-item-head">
                  <span className={`broadcast-status broadcast-status--${b.status}`}>{STATUS_LABELS[b.status]}</span>
                  <span className="broadcast-date">
                    {b.status === 'scheduled' && b.scheduled_at
                      ? `на ${formatDateTime(b.scheduled_at)}`
                      : formatDateTime(b.created_at)}
                  </span>
                </div>
                <p className="broadcast-text">
                  {b.image_url && '🖼 '}
                  {b.text}
                </p>
                <div className="broadcast-meta">
                  <span>{describeSegment(b.segment_filter, names)}</span>
                  {b.total > 0 && (
                    <span className="broadcast-stats">
                      дошло {b.sent}
                      {failed > 0 && <span className="broadcast-failed"> · не дошло {failed}</span>}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
