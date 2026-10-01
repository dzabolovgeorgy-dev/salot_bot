import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

interface FaqManageProps {
  telegramId: number
  onBack: () => void
}

interface AdminFaqItem {
  id: number
  question: string
  answer: string
  question_en: string | null
  answer_en: string | null
  display_order: number
  show_route_button: boolean
}

const emptyForm = { question: '', answer: '', questionEn: '', answerEn: '', showRoute: false }

export default function FaqManage({ telegramId, onBack }: FaqManageProps) {
  const [items, setItems] = useState<AdminFaqItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [address, setAddress] = useState('')
  const [locationUrl, setLocationUrl] = useState('')
  const [hours, setHours] = useState('')
  const [hoursEn, setHoursEn] = useState('')
  const [addressSaving, setAddressSaving] = useState(false)
  const [addressSaved, setAddressSaved] = useState(false)

  // null — форма закрыта, 'new' — новый вопрос, число — редактируем вопрос с этим id
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [showTranslation, setShowTranslation] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/staff/faq?telegram_id=${telegramId}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить вопросы')
        setItems(data.items)
        setAddress(data.salon_address ?? '')
        setLocationUrl(data.salon_location_url ?? '')
        setHours(data.working_hours ?? '')
        setHoursEn(data.working_hours_en ?? '')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить вопросы')
      } finally {
        setLoading(false)
      }
    })()
  }, [telegramId])

  async function saveAddress(e: FormEvent) {
    e.preventDefault()
    setAddressSaving(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/salon-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          salon_address: address,
          salon_location_url: locationUrl,
          working_hours: hours,
          working_hours_en: hoursEn,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить адрес')
      setAddress(data.salon_address ?? '')
      setLocationUrl(data.salon_location_url ?? '')
      setHours(data.working_hours ?? '')
      setHoursEn(data.working_hours_en ?? '')
      setAddressSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить адрес')
    } finally {
      setAddressSaving(false)
    }
  }

  function openNew() {
    setEditing('new')
    setForm(emptyForm)
    setShowTranslation(false)
    setError('')
  }

  function openEdit(item: AdminFaqItem) {
    setEditing(item.id)
    setForm({
      question: item.question,
      answer: item.answer,
      questionEn: item.question_en ?? '',
      answerEn: item.answer_en ?? '',
      showRoute: item.show_route_button,
    })
    setShowTranslation(!!(item.question_en || item.answer_en))
    setError('')
  }

  async function submitItem(e: FormEvent) {
    e.preventDefault()
    if (!form.question.trim() || !form.answer.trim() || editing === null) return
    setSaving(true)
    setError('')
    try {
      const isNew = editing === 'new'
      const res = await apiFetch(`${API_URL}/api/staff/faq${isNew ? '' : `/${editing}`}`, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          question: form.question,
          answer: form.answer,
          question_en: form.questionEn,
          answer_en: form.answerEn,
          show_route_button: form.showRoute,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить вопрос')
      setItems((prev) => (isNew ? [...prev, data] : prev.map((it) => (it.id === data.id ? data : it))))
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить вопрос')
    } finally {
      setSaving(false)
    }
  }

  async function deleteItem(id: number) {
    if (!window.confirm('Удалить этот вопрос? Клиенты перестанут его видеть.')) return
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/faq/${id}?telegram_id=${telegramId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось удалить вопрос')
      setItems((prev) => prev.filter((it) => it.id !== id))
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить вопрос')
    }
  }

  // Сдвиг вопроса на одну позицию вверх/вниз. Список на экране меняется сразу,
  // а если сервер не сохранил — возвращаем как было
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= items.length) return
    const before = items
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    setItems(next)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/faq-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, ids: next.map((it) => it.id) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось изменить порядок')
    } catch (err) {
      setItems(before)
      setError(err instanceof Error ? err.message : 'Не удалось изменить порядок')
    }
  }

  const itemForm = (
    <form className="staff-admin-form faq-manage-form" onSubmit={submitItem}>
      <h3>{editing === 'new' ? 'Новый вопрос' : 'Редактирование'}</h3>
      <label>
        Вопрос
        <input
          type="text"
          value={form.question}
          onChange={(e) => setForm({ ...form, question: e.target.value })}
          placeholder="Например: Есть ли у вас парковка?"
          required
        />
      </label>
      <label>
        Ответ
        <textarea
          className="broadcast-textarea"
          rows={4}
          value={form.answer}
          onChange={(e) => setForm({ ...form, answer: e.target.value })}
          required
        />
      </label>
      <label className="staff-checkbox-row">
        <input
          type="checkbox"
          checked={form.showRoute}
          onChange={(e) => setForm({ ...form, showRoute: e.target.checked })}
        />
        Показать адрес и кнопку «Построить маршрут»
      </label>

      {!showTranslation ? (
        <button type="button" className="faq-manage-link" onClick={() => setShowTranslation(true)}>
          + Перевод на английский
        </button>
      ) : (
        <>
          <label>
            Вопрос по-английски
            <input
              type="text"
              value={form.questionEn}
              onChange={(e) => setForm({ ...form, questionEn: e.target.value })}
            />
          </label>
          <label>
            Ответ по-английски
            <textarea
              className="broadcast-textarea"
              rows={3}
              value={form.answerEn}
              onChange={(e) => setForm({ ...form, answerEn: e.target.value })}
            />
          </label>
          <p className="staff-form-hint">Если оставить пустым — англоязычные клиенты увидят русский текст</p>
        </>
      )}

      <div className="staff-form-actions">
        <button type="submit" disabled={saving || !form.question.trim() || !form.answer.trim()}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button type="button" className="staff-cancel-btn" onClick={() => setEditing(null)}>
          Отменить
        </button>
      </div>
      {typeof editing === 'number' && (
        <button type="button" className="faq-manage-delete" onClick={() => deleteItem(editing)}>
          Удалить вопрос
        </button>
      )}
    </form>
  )

  return (
    <section className="staff-admin-form">
      <button type="button" className="staff-back-btn" onClick={onBack}>
        ← Ещё
      </button>
      <h3>Частые вопросы</h3>

      {error && <div className="staff-error">{error}</div>}

      {loading ? (
        <p className="staff-empty">Загрузка…</p>
      ) : (
        <>
          <form className="staff-admin-form faq-manage-form" onSubmit={saveAddress}>
            <h3>Салон: адрес и часы работы</h3>
            <label>
              Адрес
              <input
                type="text"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setAddressSaved(false)
                }}
                placeholder="Город, улица, дом"
              />
            </label>
            <label>
              Ссылка на карту (необязательно)
              <input
                type="url"
                value={locationUrl}
                onChange={(e) => {
                  setLocationUrl(e.target.value)
                  setAddressSaved(false)
                }}
                placeholder="https://maps.app.goo.gl/…"
              />
            </label>
            <p className="staff-form-hint">
              Без ссылки кнопка «Построить маршрут» сама найдёт адрес в Google Maps. Ссылка нужна, если по адресу
              карта находит не то место
            </p>
            <label>
              Часы работы
              <input
                type="text"
                value={hours}
                onChange={(e) => {
                  setHours(e.target.value)
                  setAddressSaved(false)
                }}
                placeholder="Ежедневно 9:00–21:00"
              />
            </label>
            <label>
              Часы работы по-английски (необязательно)
              <input
                type="text"
                value={hoursEn}
                onChange={(e) => {
                  setHoursEn(e.target.value)
                  setAddressSaved(false)
                }}
                placeholder="Daily 9:00–21:00"
              />
            </label>
            <p className="staff-form-hint">
              Клиенты видят адрес, карту и часы работы вверху вкладки FAQ
            </p>
            <div className="staff-form-actions">
              <button type="submit" disabled={addressSaving}>
                {addressSaving ? 'Сохранение…' : addressSaved ? 'Сохранено ✓' : 'Сохранить'}
              </button>
            </div>
          </form>

          <h3 className="faq-manage-subtitle">Вопросы — в том порядке, как их видят клиенты</h3>

          {items.length === 0 ? (
            <p className="staff-empty staff-empty--compact">Пока нет ни одного вопроса</p>
          ) : (
            <ul className="staff-list">
              {items.map((item, index) =>
                editing === item.id ? (
                  <li key={item.id}>{itemForm}</li>
                ) : (
                  <li key={item.id} className="staff-list-item faq-manage-item">
                    <span className="faq-manage-arrows">
                      <button
                        type="button"
                        aria-label="Выше"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="Ниже"
                        disabled={index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                    </span>
                    <button type="button" className="faq-manage-body" onClick={() => openEdit(item)}>
                      <span className="faq-manage-question">{item.question}</span>
                      <span className="faq-manage-answer">{item.answer}</span>
                      {(item.show_route_button || item.question_en) && (
                        <span className="faq-manage-badges">
                          {item.show_route_button && <span>📍 маршрут</span>}
                          {item.question_en && <span>EN</span>}
                        </span>
                      )}
                    </button>
                  </li>
                )
              )}
            </ul>
          )}

          {editing === 'new' ? (
            itemForm
          ) : (
            <button type="button" className="staff-more-menu-item" onClick={openNew}>
              + Добавить вопрос
            </button>
          )}
        </>
      )}
    </section>
  )
}
