import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Master, Service } from './types'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

type SubTab = 'masters' | 'services' | 'staff'

interface StaffMember {
  id: number
  telegram_id: string | number
  role: 'master' | 'admin'
  master_id: number | null
  master_name: string | null
}

interface AdminManageProps {
  telegramId: number
}

const emptyMasterForm = { name: '', bio: '', experience_years: '', photo_url: '' }
const emptyServiceForm = { name: '', duration_minutes: '', price: '' }
const emptyStaffForm = { target_telegram_id: '', role: 'master' as 'master' | 'admin', master_id: '' }

export default function AdminManage({ telegramId }: AdminManageProps) {
  const [subTab, setSubTab] = useState<SubTab>('masters')
  const [masters, setMasters] = useState<Master[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [error, setError] = useState('')

  async function loadAll() {
    try {
      const [mRes, sRes, stRes] = await Promise.all([
        fetch(`${API_URL}/api/masters`),
        fetch(`${API_URL}/api/services`),
        fetch(`${API_URL}/api/staff?telegram_id=${telegramId}`),
      ])
      setMasters(await mRes.json())
      setServices(await sRes.json())
      setStaff(await stRes.json())
    } catch {
      setError('Не удалось загрузить данные')
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== Мастера =====
  const [editingMasterId, setEditingMasterId] = useState<number | null>(null)
  const [masterForm, setMasterForm] = useState(emptyMasterForm)
  const [masterServiceIds, setMasterServiceIds] = useState<number[]>([])
  const [masterSaving, setMasterSaving] = useState(false)

  function startEditMaster(m: Master) {
    setEditingMasterId(m.id)
    setMasterForm({
      name: m.name,
      bio: m.bio ?? '',
      experience_years: m.experience_years?.toString() ?? '',
      photo_url: m.photo_url ?? '',
    })
    setMasterServiceIds(m.service_ids)
  }

  function startNewMaster() {
    setEditingMasterId(null)
    setMasterForm(emptyMasterForm)
    setMasterServiceIds([])
  }

  async function submitMaster(e: FormEvent) {
    e.preventDefault()
    if (!masterForm.name) return
    setMasterSaving(true)
    setError('')
    try {
      const body = {
        telegram_id: telegramId,
        name: masterForm.name,
        bio: masterForm.bio || undefined,
        experience_years: masterForm.experience_years ? Number(masterForm.experience_years) : undefined,
        photo_url: masterForm.photo_url || undefined,
      }
      const res = await fetch(
        editingMasterId ? `${API_URL}/api/masters/${editingMasterId}` : `${API_URL}/api/masters`,
        {
          method: editingMasterId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')

      const masterId = editingMasterId ?? data.id
      await fetch(`${API_URL}/api/masters/${masterId}/services`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, service_ids: masterServiceIds }),
      })

      startNewMaster()
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setMasterSaving(false)
    }
  }

  async function deleteMaster(id: number) {
    if (!window.confirm('Удалить мастера? Это возможно, только если у него нет записей.')) return
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/masters/${id}?telegram_id=${telegramId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось удалить')
      if (editingMasterId === id) startNewMaster()
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить')
    }
  }

  function toggleMasterService(serviceId: number) {
    setMasterServiceIds((ids) =>
      ids.includes(serviceId) ? ids.filter((id) => id !== serviceId) : [...ids, serviceId]
    )
  }

  // ===== Услуги =====
  const [editingServiceId, setEditingServiceId] = useState<number | null>(null)
  const [serviceForm, setServiceForm] = useState(emptyServiceForm)
  const [serviceSaving, setServiceSaving] = useState(false)

  function startEditService(s: Service) {
    setEditingServiceId(s.id)
    setServiceForm({
      name: s.name,
      duration_minutes: s.duration_minutes.toString(),
      price: s.price.toString(),
    })
  }

  function startNewService() {
    setEditingServiceId(null)
    setServiceForm(emptyServiceForm)
  }

  async function submitService(e: FormEvent) {
    e.preventDefault()
    if (!serviceForm.name || !serviceForm.duration_minutes || !serviceForm.price) return
    setServiceSaving(true)
    setError('')
    try {
      const body = {
        telegram_id: telegramId,
        name: serviceForm.name,
        duration_minutes: Number(serviceForm.duration_minutes),
        price: Number(serviceForm.price),
      }
      const res = await fetch(
        editingServiceId ? `${API_URL}/api/services/${editingServiceId}` : `${API_URL}/api/services`,
        {
          method: editingServiceId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      startNewService()
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setServiceSaving(false)
    }
  }

  async function deleteService(id: number) {
    if (!window.confirm('Удалить услугу? Это возможно, только если она не используется в записях.')) return
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/services/${id}?telegram_id=${telegramId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось удалить')
      if (editingServiceId === id) startNewService()
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить')
    }
  }

  // ===== Персонал =====
  const [staffForm, setStaffForm] = useState(emptyStaffForm)
  const [staffSaving, setStaffSaving] = useState(false)

  async function submitStaff(e: FormEvent) {
    e.preventDefault()
    if (!staffForm.target_telegram_id || (staffForm.role === 'master' && !staffForm.master_id)) return
    setStaffSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          target_telegram_id: Number(staffForm.target_telegram_id),
          role: staffForm.role,
          master_id: staffForm.role === 'master' ? Number(staffForm.master_id) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось добавить')
      setStaffForm(emptyStaffForm)
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить')
    } finally {
      setStaffSaving(false)
    }
  }

  async function deleteStaff(id: number) {
    if (!window.confirm('Забрать доступ у этого сотрудника?')) return
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff/${id}?telegram_id=${telegramId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось удалить')
      await loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить')
    }
  }

  return (
    <div className="staff-admin">
      <nav className="staff-subtabs">
        <button type="button" className={subTab === 'masters' ? 'active' : ''} onClick={() => setSubTab('masters')}>
          Мастера
        </button>
        <button type="button" className={subTab === 'services' ? 'active' : ''} onClick={() => setSubTab('services')}>
          Услуги
        </button>
        <button type="button" className={subTab === 'staff' ? 'active' : ''} onClick={() => setSubTab('staff')}>
          Персонал
        </button>
      </nav>

      {error && <div className="staff-error">{error}</div>}

      {subTab === 'masters' && (
        <section>
          <ul className="staff-list">
            {masters.map((m) => (
              <li key={m.id} className="staff-list-item staff-list-item--clickable" onClick={() => startEditMaster(m)}>
                <span className="staff-list-body">{m.name}</span>
                <button
                  type="button"
                  className="staff-remove-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteMaster(m.id)
                  }}
                >
                  Удалить
                </button>
              </li>
            ))}
          </ul>

          <form className="staff-admin-form" onSubmit={submitMaster}>
            <h3>{editingMasterId ? 'Изменить мастера' : 'Новый мастер'}</h3>
            <label>
              Имя
              <input
                type="text"
                value={masterForm.name}
                onChange={(e) => setMasterForm({ ...masterForm, name: e.target.value })}
                required
              />
            </label>
            <label>
              Описание
              <input
                type="text"
                value={masterForm.bio}
                onChange={(e) => setMasterForm({ ...masterForm, bio: e.target.value })}
              />
            </label>
            <label>
              Опыт (лет)
              <input
                type="number"
                min="0"
                value={masterForm.experience_years}
                onChange={(e) => setMasterForm({ ...masterForm, experience_years: e.target.value })}
              />
            </label>
            <label>
              Ссылка на фото
              <input
                type="text"
                value={masterForm.photo_url}
                onChange={(e) => setMasterForm({ ...masterForm, photo_url: e.target.value })}
                placeholder="https://…"
              />
            </label>
            <div className="staff-checkbox-group">
              <span className="staff-checkbox-label">Услуги</span>
              {services.map((s) => (
                <label key={s.id} className="staff-checkbox-row">
                  <input
                    type="checkbox"
                    checked={masterServiceIds.includes(s.id)}
                    onChange={() => toggleMasterService(s.id)}
                  />
                  {s.name}
                </label>
              ))}
            </div>
            <div className="staff-form-actions">
              <button type="submit" disabled={masterSaving}>
                {masterSaving ? 'Сохранение…' : editingMasterId ? 'Сохранить' : 'Добавить'}
              </button>
              {editingMasterId && (
                <button type="button" className="staff-cancel-btn" onClick={startNewMaster}>
                  Отменить
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      {subTab === 'services' && (
        <section>
          <ul className="staff-list">
            {services.map((s) => (
              <li key={s.id} className="staff-list-item staff-list-item--clickable" onClick={() => startEditService(s)}>
                <span className="staff-list-body">
                  {s.name} — {s.duration_minutes} мин, {s.price} ₽
                </span>
                <button
                  type="button"
                  className="staff-remove-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteService(s.id)
                  }}
                >
                  Удалить
                </button>
              </li>
            ))}
          </ul>

          <form className="staff-admin-form" onSubmit={submitService}>
            <h3>{editingServiceId ? 'Изменить услугу' : 'Новая услуга'}</h3>
            <label>
              Название
              <input
                type="text"
                value={serviceForm.name}
                onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })}
                required
              />
            </label>
            <label>
              Длительность (мин)
              <input
                type="number"
                min="1"
                value={serviceForm.duration_minutes}
                onChange={(e) => setServiceForm({ ...serviceForm, duration_minutes: e.target.value })}
                required
              />
            </label>
            <label>
              Цена (₽)
              <input
                type="number"
                min="0"
                value={serviceForm.price}
                onChange={(e) => setServiceForm({ ...serviceForm, price: e.target.value })}
                required
              />
            </label>
            <div className="staff-form-actions">
              <button type="submit" disabled={serviceSaving}>
                {serviceSaving ? 'Сохранение…' : editingServiceId ? 'Сохранить' : 'Добавить'}
              </button>
              {editingServiceId && (
                <button type="button" className="staff-cancel-btn" onClick={startNewService}>
                  Отменить
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      {subTab === 'staff' && (
        <section>
          <ul className="staff-list">
            {staff.map((s) => (
              <li key={s.id} className="staff-list-item">
                <span className="staff-list-body">
                  {s.telegram_id} — {s.role === 'admin' ? 'Администратор' : `Мастер: ${s.master_name}`}
                </span>
                <button type="button" className="staff-remove-btn" onClick={() => deleteStaff(s.id)}>
                  Убрать
                </button>
              </li>
            ))}
          </ul>

          <form className="staff-admin-form" onSubmit={submitStaff}>
            <h3>Добавить сотрудника</h3>
            <label>
              Telegram ID
              <input
                type="number"
                value={staffForm.target_telegram_id}
                onChange={(e) => setStaffForm({ ...staffForm, target_telegram_id: e.target.value })}
                required
              />
            </label>
            <label>
              Роль
              <select
                value={staffForm.role}
                onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value as 'master' | 'admin' })}
              >
                <option value="master">Мастер</option>
                <option value="admin">Администратор</option>
              </select>
            </label>
            {staffForm.role === 'master' && (
              <label>
                Мастер
                <select
                  value={staffForm.master_id}
                  onChange={(e) => setStaffForm({ ...staffForm, master_id: e.target.value })}
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
            )}
            <button type="submit" disabled={staffSaving}>
              {staffSaving ? 'Сохранение…' : 'Добавить'}
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
