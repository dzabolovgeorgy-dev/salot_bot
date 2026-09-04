import { useEffect, useState } from 'react'
import type { ClientSummary, ClientVisit } from './types'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

const STATUS_LABELS: Record<string, string> = {
  upcoming: 'Предстоит',
  completed: 'Выполнено',
  no_show: 'Не пришёл',
}

function formatDate(iso: string): string {
  return new Date(iso.replace(' ', 'T')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatDateTime(iso: string): string {
  return new Date(iso.replace(' ', 'T')).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface ClientsPanelProps {
  telegramId: number
}

export default function ClientsPanel({ telegramId }: ClientsPanelProps) {
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedClient, setSelectedClient] = useState<ClientSummary | null>(null)
  const [clientVisits, setClientVisits] = useState<ClientVisit[]>([])
  const [clientVisitsLoading, setClientVisitsLoading] = useState(false)

  async function loadClients() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/clients?telegram_id=${telegramId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить')
      setClients(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadClients()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function openClient(c: ClientSummary) {
    setSelectedClient(c)
    setClientVisitsLoading(true)
    setError('')
    try {
      const clientKey = c.client_telegram_id ?? `phone-${c.client_phone}`
      const res = await fetch(`${API_URL}/api/staff/clients/${clientKey}?telegram_id=${telegramId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить')
      setClientVisits(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить')
    } finally {
      setClientVisitsLoading(false)
    }
  }

  function closeClient() {
    setSelectedClient(null)
    setClientVisits([])
  }

  return (
    <div className="staff-admin">
      {error && <div className="staff-error">{error}</div>}

      {!selectedClient && (
        <section>
          {loading ? (
            <p className="staff-empty">Загрузка…</p>
          ) : clients.length === 0 ? (
            <p className="staff-empty">Пока никто не записывался</p>
          ) : (
            <ul className="staff-list">
              {clients.map((c) => (
                <li
                  key={c.client_telegram_id ?? c.client_phone}
                  className="staff-list-item staff-list-item--clickable"
                  onClick={() => openClient(c)}
                >
                  <span className="staff-list-body">
                    {c.name ?? 'Без имени'}
                    <span className="staff-client-meta">
                      {c.visits} {c.visits === 1 ? 'визит' : 'визита'} · последний {formatDate(c.last_visit)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {selectedClient && (
        <section>
          <button type="button" className="staff-back-btn" onClick={closeClient}>
            ← Клиенты
          </button>
          <h3 className="staff-client-name">{selectedClient.name ?? 'Без имени'}</h3>
          {selectedClient.username ? (
            <a
              className="staff-telegram-link"
              href={`https://t.me/${selectedClient.username}`}
              target="_blank"
              rel="noreferrer"
            >
              💬 Написать в Telegram
            </a>
          ) : selectedClient.client_phone ? (
            <a
              className="staff-telegram-link"
              href={`https://wa.me/${selectedClient.client_phone}`}
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
          <div className="staff-client-stats">
            <div>
              <span className="staff-client-stat-value">{selectedClient.visits}</span>
              <span className="staff-client-stat-label">визитов</span>
            </div>
            <div>
              <span className="staff-client-stat-value">{selectedClient.total_spent} ₽</span>
              <span className="staff-client-stat-label">потрачено</span>
            </div>
          </div>

          {clientVisitsLoading ? (
            <p className="staff-empty">Загрузка…</p>
          ) : (
            <ul className="staff-list">
              {clientVisits.map((v) => (
                <li key={v.id} className="staff-list-item">
                  <span className="staff-list-body">
                    {formatDateTime(v.starts_at)}
                    <span className="staff-client-meta">
                      {v.service_name} — {v.master_name}, {v.price} ₽
                      <span
                        className={`staff-status staff-status--${v.status === 'completed' ? 'done' : v.status === 'no_show' ? 'no-show' : ''}`}
                      >
                        {' '}
                        {STATUS_LABELS[v.status]}
                      </span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
