import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { InventoryItem, InventoryTransaction } from './types'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

interface WarehouseProps {
  telegramId: number
  onBack: () => void
}

const emptyForm = { name: '', unit: '', quantity: '', minThreshold: '' }

type TxDirection = 'in' | 'out'

function formatDateTime(iso: string): string {
  return new Date(iso.replace(' ', 'T')).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function Warehouse({ telegramId, onBack }: WarehouseProps) {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null)
  const [txDirection, setTxDirection] = useState<TxDirection | null>(null)
  const [txAmount, setTxAmount] = useState('')
  const [txReason, setTxReason] = useState('')
  const [txSaving, setTxSaving] = useState(false)

  const [history, setHistory] = useState<InventoryTransaction[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const [lowStockAlert, setLowStockAlert] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)
  const [editForm, setEditForm] = useState(emptyForm)
  const [editSaving, setEditSaving] = useState(false)

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

  async function loadHistory(itemId: number) {
    setHistoryLoading(true)
    try {
      const res = await apiFetch(`${API_URL}/api/staff/inventory-items/${itemId}/transactions?telegram_id=${telegramId}`)
      const data = await res.json()
      if (res.ok) setHistory(data)
    } catch {
      // тихо — карточка просто останется без истории
    } finally {
      setHistoryLoading(false)
    }
  }

  function openItem(item: InventoryItem) {
    setSelectedItem(item)
    setTxDirection(null)
    setTxAmount('')
    setTxReason('')
    setError('')
    setLowStockAlert(null)
    setEditOpen(false)
    loadHistory(item.id)
  }

  function startEditItem() {
    if (!selectedItem) return
    setEditForm({
      name: selectedItem.name,
      unit: selectedItem.unit,
      quantity: String(selectedItem.quantity),
      minThreshold: String(selectedItem.min_threshold),
    })
    setEditOpen(true)
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault()
    if (!selectedItem || !editForm.name.trim() || !editForm.unit.trim()) return
    setEditSaving(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/inventory-items/${selectedItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          name: editForm.name.trim(),
          unit: editForm.unit.trim(),
          min_threshold: editForm.minThreshold ? Number(editForm.minThreshold) : 0,
          quantity: editForm.quantity ? Number(editForm.quantity) : 0,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setSelectedItem(data)
      setItems((prev) => prev.map((i) => (i.id === data.id ? data : i)))
      setEditOpen(false)
      loadHistory(data.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setEditSaving(false)
    }
  }

  async function submitTransaction() {
    if (!selectedItem || !txDirection) return
    const amount = Number(txAmount)
    if (!Number.isInteger(amount) || amount <= 0) {
      setError('Введите целое число больше нуля')
      return
    }
    setTxSaving(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/inventory-items/${selectedItem.id}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          change_amount: txDirection === 'in' ? amount : -amount,
          reason: txReason.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setSelectedItem(data)
      setItems((prev) => prev.map((i) => (i.id === data.id ? data : i)))
      setTxDirection(null)
      setTxAmount('')
      setTxReason('')
      loadHistory(data.id)

      // Предупреждаем именно после списания — поступление, наоборот,
      // может решить проблему, тогда старое предупреждение снимаем
      if (txDirection === 'out' && data.quantity < data.min_threshold) {
        setLowStockAlert(`Заканчивается ${data.name}, осталось ${data.quantity} ${data.unit}`)
      } else {
        setLowStockAlert(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setTxSaving(false)
    }
  }

  if (selectedItem) {
    const low = selectedItem.quantity < selectedItem.min_threshold
    return (
      <section className="staff-admin-form">
        <button type="button" className="staff-back-btn" onClick={() => setSelectedItem(null)}>
          ← Склад
        </button>
        <div className="staff-portfolio-header">
          <h3>{selectedItem.name}</h3>
          {!editOpen && (
            <button type="button" className="staff-cancel-btn" onClick={startEditItem}>
              ✎ Редактировать
            </button>
          )}
        </div>

        {error && <div className="staff-error">{error}</div>}

        {editOpen ? (
          <form className="staff-admin-form" onSubmit={submitEdit}>
            <label>
              Название
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                required
              />
            </label>
            <label>
              Единица измерения
              <input
                type="text"
                value={editForm.unit}
                onChange={(e) => setEditForm({ ...editForm, unit: e.target.value })}
                required
              />
            </label>
            <label>
              Минимальный порог
              <input
                type="number"
                min="0"
                value={editForm.minThreshold}
                onChange={(e) => setEditForm({ ...editForm, minThreshold: e.target.value })}
              />
            </label>
            <label>
              Остаток
              <input
                type="number"
                min="0"
                value={editForm.quantity}
                onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })}
              />
            </label>
            <p className="staff-form-hint">
              Если поменять остаток здесь — это попадёт в историю как «коррекция», отдельно от обычных
              поступлений и списаний.
            </p>
            <div className="staff-form-actions">
              <button type="submit" disabled={editSaving}>
                {editSaving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button type="button" className="staff-cancel-btn" onClick={() => setEditOpen(false)}>
                Отменить
              </button>
            </div>
          </form>
        ) : (
          <>
        <p className="staff-card-line">
          Остаток:{' '}
          <span className={low ? 'inventory-quantity inventory-quantity--low' : 'inventory-quantity'}>
            {selectedItem.quantity} {selectedItem.unit}
          </span>
          {low && <span className="staff-allergy-badge" title="Заканчивается"> ⚠ заканчивается</span>}
        </p>
        <p className="staff-profile-hint">Минимальный порог: {selectedItem.min_threshold} {selectedItem.unit}</p>

        {lowStockAlert && (
          <div className="staff-note-warning">
            <span className="staff-note-warning-label">⚠ Уведомление</span>
            <p>{lowStockAlert}</p>
          </div>
        )}

        {!txDirection ? (
          <div className="staff-form-actions">
            <button type="button" onClick={() => setTxDirection('in')}>
              + Поступление
            </button>
            <button type="button" className="staff-cancel-btn" onClick={() => setTxDirection('out')}>
              − Списание
            </button>
          </div>
        ) : (
          <div className="staff-admin-form">
            <h3>{txDirection === 'in' ? 'Поступление' : 'Списание'}</h3>
            <label>
              Количество ({selectedItem.unit})
              <input
                type="number"
                min="1"
                value={txAmount}
                onChange={(e) => setTxAmount(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              Причина (необязательно)
              <input
                type="text"
                value={txReason}
                onChange={(e) => setTxReason(e.target.value)}
                placeholder={txDirection === 'in' ? 'Например: закупка' : 'Например: списано на визит'}
              />
            </label>
            <div className="staff-form-actions">
              <button type="button" disabled={txSaving} onClick={submitTransaction}>
                {txSaving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button
                type="button"
                className="staff-cancel-btn"
                onClick={() => {
                  setTxDirection(null)
                  setTxAmount('')
                  setTxReason('')
                }}
              >
                Отменить
              </button>
            </div>
          </div>
        )}

        <h3>История изменений</h3>
        {historyLoading ? (
          <p className="staff-empty">Загрузка…</p>
        ) : history.length === 0 ? (
          <p className="staff-empty">Пока нет изменений</p>
        ) : (
          <ul className="staff-list">
            {history.map((tx) => (
              <li key={tx.id} className="staff-list-item">
                <span className="staff-list-body">
                  <span className={tx.change_amount > 0 ? 'inventory-tx-amount inventory-tx-amount--in' : 'inventory-tx-amount'}>
                    {tx.change_amount > 0 ? `+${tx.change_amount}` : tx.change_amount} {selectedItem.unit}
                  </span>
                  {tx.reason && <span className="staff-client-meta">{tx.reason}</span>}
                </span>
                <span className="staff-profile-hint">{formatDateTime(tx.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
          </>
        )}
      </section>
    )
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
              <li
                key={item.id}
                className="staff-list-item staff-list-item--clickable"
                onClick={() => openItem(item)}
              >
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
