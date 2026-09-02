import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Master, Service } from './types'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

type Section = 'menu' | 'masters' | 'services' | 'staff'
type MasterView = 'list' | 'quick' | 'edit'

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

const emptyMasterForm = { name: '', bio: '', experience_years: '', photo_url: '', accessTelegramId: '' }
const emptyServiceForm = { name: '', duration_minutes: '', price: '' }

export default function AdminManage({ telegramId }: AdminManageProps) {
  const [section, setSection] = useState<Section>('menu')
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

  const staffByMasterId = useMemo(() => {
    const map = new Map<number, StaffMember>()
    staff.forEach((s) => {
      if (s.role === 'master' && s.master_id != null) map.set(s.master_id, s)
    })
    return map
  }, [staff])

  // ===== Мастера =====
  const [masterView, setMasterView] = useState<MasterView>('list')
  const [editingMasterId, setEditingMasterId] = useState<number | null>(null)
  const [masterForm, setMasterForm] = useState(emptyMasterForm)
  const [masterServiceIds, setMasterServiceIds] = useState<number[]>([])
  const [masterSaving, setMasterSaving] = useState(false)
  const [quickName, setQuickName] = useState('')
  const [quickTelegramId, setQuickTelegramId] = useState('')

  function openMasterList() {
    setMasterView('list')
    setError('')
  }

  function openQuickAdd() {
    setQuickName('')
    setQuickTelegramId('')
    setMasterView('quick')
    setError('')
  }

  function startEditMaster(m: Master) {
    setEditingMasterId(m.id)
    setMasterForm({
      name: m.name,
      bio: m.bio ?? '',
      experience_years: m.experience_years?.toString() ?? '',
      photo_url: m.photo_url ?? '',
      accessTelegramId: staffByMasterId.get(m.id)?.telegram_id?.toString() ?? '',
    })
    setMasterServiceIds(m.service_ids)
    setMasterView('edit')
    setError('')
  }

  async function submitQuickAdd(e: FormEvent) {
    e.preventDefault()
    if (!quickName) return
    setMasterSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/masters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          name: quickName,
          access_telegram_id: quickTelegramId ? Number(quickTelegramId) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      await loadAll()
      if (data.warning) {
        setError(data.warning)
      }
      openMasterList()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setMasterSaving(false)
    }
  }

  async function submitMasterEdit(e: FormEvent) {
    e.preventDefault()
    if (!masterForm.name || !editingMasterId) return
    setMasterSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/masters/${editingMasterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          name: masterForm.name,
          bio: masterForm.bio || undefined,
          experience_years: masterForm.experience_years ? Number(masterForm.experience_years) : undefined,
          photo_url: masterForm.photo_url || undefined,
          access_telegram_id: masterForm.accessTelegramId ? Number(masterForm.accessTelegramId) : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')

      await fetch(`${API_URL}/api/masters/${editingMasterId}/services`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, service_ids: masterServiceIds }),
      })

      await loadAll()
      if (data.warning) {
        setError(data.warning)
      } else {
        openMasterList()
      }
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
      await loadAll()
      openMasterList()
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

  // ===== Персонал (только администраторы — доступ мастерам выдаётся на вкладке «Мастера») =====
  const [newAdminId, setNewAdminId] = useState('')
  const [staffSaving, setStaffSaving] = useState(false)
  const admins = staff.filter((s) => s.role === 'admin')

  async function submitAdmin(e: FormEvent) {
    e.preventDefault()
    if (!newAdminId) return
    setStaffSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          target_telegram_id: Number(newAdminId),
          role: 'admin',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось добавить')
      setNewAdminId('')
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

  function openSection(s: Section) {
    setSection(s)
    setError('')
    if (s === 'masters') setMasterView('list')
  }

  return (
    <div className="staff-admin">
      {error && <div className="staff-error">{error}</div>}

      {section === 'menu' && (
        <ul className="staff-menu">
          <li>
            <button type="button" className="staff-menu-row" onClick={() => openSection('masters')}>
              <span>Мастера</span>
              <span className="staff-menu-count">{masters.length} →</span>
            </button>
          </li>
          <li>
            <button type="button" className="staff-menu-row" onClick={() => openSection('services')}>
              <span>Услуги</span>
              <span className="staff-menu-count">{services.length} →</span>
            </button>
          </li>
          <li>
            <button type="button" className="staff-menu-row" onClick={() => openSection('staff')}>
              <span>Персонал</span>
              <span className="staff-menu-count">{admins.length} →</span>
            </button>
          </li>
        </ul>
      )}

      {section === 'masters' && masterView === 'list' && (
        <section>
          <button type="button" className="staff-back-btn" onClick={() => openSection('menu')}>
            ← Управление
          </button>
          <ul className="staff-list">
            {masters.map((m) => {
              const hasAccess = staffByMasterId.has(m.id)
              return (
                <li key={m.id} className="staff-list-item staff-list-item--clickable" onClick={() => startEditMaster(m)}>
                  <span className="staff-list-body">
                    {m.name}
                    <span className={`staff-access-badge${hasAccess ? '' : ' staff-access-badge--off'}`}>
                      {hasAccess ? 'есть доступ' : 'нет доступа'}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
          <button type="button" className="staff-add-btn" onClick={openQuickAdd}>
            + Добавить мастера
          </button>
        </section>
      )}

      {section === 'masters' && masterView === 'quick' && (
        <section>
          <button type="button" className="staff-back-btn" onClick={openMasterList}>
            ← Мастера
          </button>
          <form className="staff-admin-form" onSubmit={submitQuickAdd}>
            <h3>Новый мастер</h3>
            <p className="staff-form-hint">
              Достаточно имени и Telegram ID — мастер сразу появится в списке и получит доступ к своей панели. Фото,
              описание и услуги можно добавить позже, открыв его карточку.
            </p>
            <label>
              Имя
              <input type="text" value={quickName} onChange={(e) => setQuickName(e.target.value)} required autoFocus />
            </label>
            <label>
              Telegram ID (необязательно)
              <input
                type="number"
                value={quickTelegramId}
                onChange={(e) => setQuickTelegramId(e.target.value)}
                placeholder="Узнать можно через @userinfobot"
              />
            </label>
            <button type="submit" disabled={masterSaving}>
              {masterSaving ? 'Сохранение…' : 'Добавить'}
            </button>
          </form>
        </section>
      )}

      {section === 'masters' && masterView === 'edit' && editingMasterId && (
        <section>
          <button type="button" className="staff-back-btn" onClick={openMasterList}>
            ← Мастера
          </button>
          <form className="staff-admin-form" onSubmit={submitMasterEdit}>
            <h3>{masterForm.name}</h3>
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
              Telegram ID (доступ к панели)
              <input
                type="number"
                value={masterForm.accessTelegramId}
                onChange={(e) => setMasterForm({ ...masterForm, accessTelegramId: e.target.value })}
                placeholder="Пусто — доступа нет"
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
                {masterSaving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button type="button" className="staff-cancel-btn" onClick={() => deleteMaster(editingMasterId)}>
                Удалить мастера
              </button>
            </div>
          </form>
        </section>
      )}

      {section === 'services' && (
        <section>
          <button type="button" className="staff-back-btn" onClick={() => openSection('menu')}>
            ← Управление
          </button>
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

      {section === 'staff' && (
        <section>
          <button type="button" className="staff-back-btn" onClick={() => openSection('menu')}>
            ← Управление
          </button>
          <p className="staff-form-hint">
            Доступ мастеров выдаётся на вкладке «Мастера». Здесь — только администраторы.
          </p>
          <ul className="staff-list">
            {admins.map((s) => (
              <li key={s.id} className="staff-list-item">
                <span className="staff-list-body">{s.telegram_id} — Администратор</span>
                <button type="button" className="staff-remove-btn" onClick={() => deleteStaff(s.id)}>
                  Убрать
                </button>
              </li>
            ))}
          </ul>

          <form className="staff-admin-form" onSubmit={submitAdmin}>
            <h3>Сделать администратором</h3>
            <label>
              Telegram ID
              <input type="number" value={newAdminId} onChange={(e) => setNewAdminId(e.target.value)} required />
            </label>
            <button type="submit" disabled={staffSaving}>
              {staffSaving ? 'Сохранение…' : 'Добавить'}
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
