import { useEffect, useState } from 'react'
import type { BroadcastDetails, BroadcastStatus } from './types'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

interface BroadcastCardProps {
  telegramId: number
  broadcastId: number
  statusLabels: Record<BroadcastStatus, string>
  describeSegment: (b: BroadcastDetails) => string
  onBack: () => void
}

function formatDateTime(iso: string): string {
  return new Date(iso.replace(' ', 'T')).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

export default function BroadcastCard({ telegramId, broadcastId, statusLabels, describeSegment, onBack }: BroadcastCardProps) {
  const [data, setData] = useState<BroadcastDetails | null>(null)
  const [error, setError] = useState('')

  async function load() {
    try {
      const res = await apiFetch(`${API_URL}/api/staff/broadcasts/${broadcastId}?telegram_id=${telegramId}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Не удалось загрузить рассылку')
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить рассылку')
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastId])

  // Пока рассылка отправляется — обновляем цифры раз в 5 секунд
  const sending = data?.status === 'sending'
  useEffect(() => {
    if (!sending) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending])

  const windowOpen = !!data?.conversion_window_end && new Date(data.conversion_window_end) > new Date()

  return (
    <div className="broadcast-card">
      <button type="button" className="staff-back-btn" onClick={onBack}>
        ← Рассылки
      </button>

      {error && <div className="staff-error">{error}</div>}

      {!data ? (
        !error && <p className="staff-empty">Загрузка…</p>
      ) : (
        <>
          <div className="broadcast-item-head">
            <span className={`broadcast-status broadcast-status--${data.status}`}>{statusLabels[data.status]}</span>
            <span className="broadcast-date">создана {formatDateTime(data.created_at)}</span>
          </div>

          <dl className="broadcast-facts">
            <dt>Кому</dt>
            <dd>{describeSegment(data)}</dd>
            {data.scheduled_at && (
              <>
                <dt>{data.status === 'scheduled' ? 'Отправится' : 'Запланирована на'}</dt>
                <dd>{formatDateTime(data.scheduled_at)}</dd>
              </>
            )}
            {data.first_sent_at && (
              <>
                <dt>Начало отправки</dt>
                <dd>{formatDateTime(data.first_sent_at)}</dd>
              </>
            )}
          </dl>

          <div className="broadcast-preview">
            {data.image_url && <img src={data.image_url} alt="" className="broadcast-preview-image" />}
            <p className="broadcast-preview-text">{data.text}</p>
          </div>
          {data.text_en && (
            <div className="broadcast-preview">
              <span className="broadcast-lang-tag">EN</span>
              <p className="broadcast-preview-text">{data.text_en}</p>
            </div>
          )}

          {data.status === 'scheduled' ? (
            <p className="staff-form-hint">Статистика появится после отправки</p>
          ) : (
            <>
              <div className="broadcast-stats-grid">
                <div className="broadcast-stat">
                  <span className="broadcast-stat-value">{data.total}</span>
                  <span className="broadcast-stat-label">всего получателей</span>
                </div>
                <div className="broadcast-stat">
                  <span className="broadcast-stat-value">{data.sent}</span>
                  <span className="broadcast-stat-label">доставлено · {percent(data.sent, data.total)}</span>
                </div>
                <div className="broadcast-stat">
                  <span className={data.errors > 0 ? 'broadcast-stat-value broadcast-failed' : 'broadcast-stat-value'}>
                    {data.errors}
                  </span>
                  <span className="broadcast-stat-label">ошибки отправки</span>
                </div>
                <div className="broadcast-stat">
                  <span className={data.blocked > 0 ? 'broadcast-stat-value broadcast-failed' : 'broadcast-stat-value'}>
                    {data.blocked}
                  </span>
                  <span className="broadcast-stat-label">заблокировали бота</span>
                </div>
              </div>

              <div className="broadcast-audience">
                <span>
                  Записались в течение 7 дней: <strong>{data.booked_within_7d}</strong>
                  {data.sent > 0 && ` из ${data.sent} · ${percent(data.booked_within_7d, data.sent)}`}
                </span>
                <span className="staff-form-hint">
                  {windowOpen && data.conversion_window_end
                    ? `Подсчёт ещё идёт — до ${formatDateTime(data.conversion_window_end)}`
                    : 'Новые записи получателей, сделанные в течение недели после сообщения'}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
