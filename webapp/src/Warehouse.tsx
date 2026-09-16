import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { InventoryItem } from './types'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

interface WarehouseProps {
  telegramId: number
  onBack: () => void
}

const emptyForm = { name: '', unit: '', quantity: '', minThreshold: '' }

export default function Warehouse({ telegramId, onBack }: WarehouseProps) {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  async function loadItems() {
    setLoading(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/inventory-items?telegram_id=${telegramId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить склад')
      setItems(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить склад')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadItems()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submitAdd(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.unit.trim()) return
    setSaving(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/inventory-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          name: form.name.trim(),
          unit: form.unit.trim(),
          quantity: form.quantity ? Number(form.quantity) : 0,
          min_threshold: form.minThreshold ? Number(form.minThreshold) : 0,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось добавить материал')
      setItems((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name, 'ru')))
      setForm(emptyForm)
      setAddOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить материал')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="staff-admin-form">
      <button type="button" className="staff-back-btn" onClick={onBack}>
        ← Ещё
      </button>
      <h3>Склад</h3>

      {error && <div className="staff-error">{error}</div>}

      {loading ? (
        <p className="staff-empty">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="staff-empty">Пока нет ни одного материала</p>
      ) : (
        <ul className="staff-list">
          {items.map((item) => {
            const low = item.quantity < item.min_threshold
            return (
              <li key={item.id} className="staff-list-item">
                <span className="staff-list-body">
                  {item.name}
                  {low && <span className="staff-allergy-badge" title="Заканчивается"> ⚠</span>}
                </span>
                <span className={low ? 'inventory-quantity inventory-quantity--low' : 'inventory-quantity'}>
                  {item.quantity} {item.unit}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {!addOpen ? (
        <button type="button" className="staff-more-menu-item" onClick={() => setAddOpen(true)}>
          + Добавить материал
        </button>
      ) : (
        <form className="staff-admin-form" onSubmit={submitAdd}>
          <h3>Новый материал</h3>
          <label>
            Название
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например: краска для волос 60 мл"
              required
            />
          </label>
          <label>
            Единица измерения
            <input
              type="text"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              placeholder="мл / г / шт"
              required
            />
          </label>
          <label>
            Начальное количество
            <input
              type="number"
              min="0"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              placeholder="0"
            />
          </label>
          <label>
            Минимальный порог (когда предупреждать)
            <input
              type="number"
              min="0"
              value={form.minThreshold}
              onChange={(e) => setForm({ ...form, minThreshold: e.target.value })}
              placeholder="0"
            />
          </label>
          <div className="staff-form-actions">
            <button type="submit" disabled={saving}>
              {saving ? 'Сохранение…' : 'Добавить'}
            </button>
            <button
              type="button"
              className="staff-cancel-btn"
              onClick={() => {
                setAddOpen(false)
                setForm(emptyForm)
              }}
            >
              Отменить
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
