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

// Ключ дня для группировки клиентов в "папки" — по дате последнего визита
function dayKey(iso: string): string {
  return iso.replace(' ', 'T').slice(0, 10)
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
  // "Папки" по дню последнего визита — чтобы длинный список клиентов не был
  // одной сплошной кучей. Открыта по умолчанию только самая свежая
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())

  const [selectedClient, setSelectedClient] = useState<ClientSummary | null>(null)
  const [clientVisits, setClientVisits] = useState<ClientVisit[]>([])
  const [clientVisitsLoading, setClientVisitsLoading] = useState(false)
  const [clientNote, setClientNote] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [commentSaving, setCommentSaving] = useState(false)

  async function loadClients() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/clients?telegram_id=${telegramId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить')
      setClients(data)
      if (data.length > 0) setOpenDays(new Set([dayKey(data[0].last_visit)]))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить')
    } finally {
      setLoading(false)
    }
  }

  function toggleDay(key: string) {
    setOpenDays((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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

    try {
      const noteUrl = c.client_telegram_id
        ? `${API_URL}/api/client-notes/${c.client_telegram_id}`
        : `${API_URL}/api/client-notes/by-phone/${c.client_phone}`
      const noteRes = await fetch(noteUrl)
      const noteData = await noteRes.json()
      setClientNote(noteData.note)
      setComment(noteData.admin_comment ?? '')
    } catch {
      // тихо — заметка/комментарий необязательны для показа карточки
    }
  }

  function closeClient() {
    setSelectedClient(null)
    setClientVisits([])
    setClientNote(null)
    setComment('')
  }

  async function saveComment() {
    if (!selectedClient) return
    setCommentSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/client-comment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          client_telegram_id: selectedClient.client_telegram_id ?? undefined,
          client_phone: selectedClient.client_telegram_id ? undefined : selectedClient.client_phone,
          comment: comment.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setCommentSaving(false)
    }
  }

  // Группируем клиентов в "папки" по дню последнего визита — сами папки
  // по возрастанию даты (как страницы календаря), но самая свежая всё равно
  // открыта по умолчанию (см. loadClients)
  const dayGroups: { key: string; label: string; clients: ClientSummary[] }[] = []
  clients.forEach((c) => {
    const key = dayKey(c.last_visit)
    const group = dayGroups.find((g) => g.key === key)
    if (group) group.clients.push(c)
    else dayGroups.push({ key, label: formatDate(c.last_visit), clients: [c] })
  })
  dayGroups.reverse()

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
            <div className="staff-day-folders">
              {dayGroups.map((group) => {
                const isOpen = openDays.has(group.key)
                return (
                  <div key={group.key} className="staff-day-folder">
                    <button type="button" className="staff-day-folder-header" onClick={() => toggleDay(group.key)}>
                      <span>
                        {isOpen ? '📂' : '📁'} {group.label}
                      </span>
                      <span className="staff-day-folder-count">{group.clients.length}</span>
                    </button>
                    {isOpen && (
                      <ul className="staff-list">
                        {group.clients.map((c) => (
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
                  </div>
                )
              })}
            </div>
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

          {clientNote && (
            <div className="staff-note-warning">
              <span className="staff-note-warning-label">⚠ Аллергии/особенности</span>
              <p>{clientNote}</p>
            </div>
          )}

          <label className="staff-comment-label">
            Комментарий администратора
            <textarea
              className="staff-note-textarea"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: VIP-клиент, предпочитает утренние часы…"
              rows={3}
            />
          </label>
          <button type="button" className="staff-add-btn" disabled={commentSaving} onClick={saveComment}>
            {commentSaving ? 'Сохранение…' : 'Сохранить комментарий'}
          </button>

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
