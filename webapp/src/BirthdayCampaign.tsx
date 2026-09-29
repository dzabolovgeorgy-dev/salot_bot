import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch } from './apiFetch'
import './StaffApp.css'

const API_URL = import.meta.env.VITE_API_URL ?? ''

type GiftType = 'discount' | 'points' | 'free_service'

interface Settings {
  enabled: boolean
  message_template: string
  gift_type: GiftType
  gift_value: string
}

interface BirthdayCampaignProps {
  telegramId: number
  onBack: () => void
}

const GIFT_LABELS: Record<GiftType, { label: string; valueLabel: string; placeholder: string }> = {
  discount: { label: 'Скидка', valueLabel: 'Размер скидки, %', placeholder: '10' },
  points: { label: 'Баллы лояльности', valueLabel: 'Сколько баллов начислить', placeholder: '50' },
  free_service: { label: 'Бесплатная услуга', valueLabel: 'Какая услуга', placeholder: 'Например: маникюр' },
}

// Тот же текст подарка, что подставляет сервер вместо {gift} (birthday.ts)
function describeGift(type: GiftType, value: string): string {
  const v = value.trim() || '…'
  if (type === 'discount') return `скидка ${v}% на любую услугу`
  if (type === 'points') return `${v} баллов на ваш счёт`
  return `бесплатная услуга «${v}»`
}

function previewGreeting(s: Settings): string {
  const gift = describeGift(s.gift_type, s.gift_value)
  const text = s.message_template.includes('{gift}')
    ? s.message_template.replaceAll('{gift}', gift)
    : `${s.message_template}\n\n🎁 Ваш подарок: ${gift}`
  return text.replaceAll('{name}', 'Анна')
}

export default function BirthdayCampaign({ telegramId, onBack }: BirthdayCampaignProps) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testSent, setTestSent] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await apiFetch(`${API_URL}/api/staff/birthday-campaign?telegram_id=${telegramId}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить настройки')
        setSettings(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Не удалось загрузить настройки')
      }
    })()
  }, [telegramId])

  function update(patch: Partial<Settings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    setSaved(false)
    setTestSent(false)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!settings) return
    setSaving(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/birthday-campaign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, ...settings }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Не удалось сохранить')
      setSettings(data)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    if (!settings) return
    setTesting(true)
    setError('')
    try {
      const res = await apiFetch(`${API_URL}/api/staff/birthday-campaign/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, ...settings }),
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

  const gift = settings ? GIFT_LABELS[settings.gift_type] : null

  return (
    <section className="staff-admin-form">
      <button type="button" className="staff-back-btn" onClick={onBack}>
        ← Ещё
      </button>
      <h3>Поздравления с днём рождения</h3>

      {error && <div className="staff-error">{error}</div>}

      {!settings ? (
        !error && <p className="staff-empty">Загрузка…</p>
      ) : (
        <form className="staff-admin-form broadcast-form" onSubmit={save}>
          <label className="staff-checkbox-row birthday-toggle">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
            Автоматически поздравлять клиентов
          </label>
          <p className="staff-form-hint">
            Каждый день с 10:00 бот поздравляет именинников в Telegram — только тех, кто согласился получать
            рассылки и у кого указана дата рождения.
          </p>

          <label>
            Текст поздравления
            <textarea
              className="broadcast-textarea"
              rows={4}
              value={settings.message_template}
              onChange={(e) => update({ message_template: e.target.value })}
            />
            <span className="staff-form-hint">
              {'{name}'} — имя клиента, {'{gift}'} — подарок. Если {'{gift}'} не написать, подарок добавится в конце
            </span>
          </label>

          <label>
            Подарок
            <select
              value={settings.gift_type}
              onChange={(e) => update({ gift_type: e.target.value as GiftType, gift_value: '' })}
            >
              {(Object.keys(GIFT_LABELS) as GiftType[]).map((type) => (
                <option key={type} value={type}>
                  {GIFT_LABELS[type].label}
                </option>
              ))}
            </select>
          </label>

          {gift && (
            <label>
              {gift.valueLabel}
              <input
                type={settings.gift_type === 'free_service' ? 'text' : 'number'}
                min="1"
                value={settings.gift_value}
                onChange={(e) => update({ gift_value: e.target.value })}
                placeholder={gift.placeholder}
              />
              {settings.gift_type === 'points' && (
                <span className="staff-form-hint">Баллы начислятся на счёт клиента сами, в момент поздравления</span>
              )}
            </label>
          )}

          <div className="broadcast-field">
            <span className="broadcast-label">Так увидит клиент</span>
            <div className="broadcast-preview">
              <p className="broadcast-preview-text">{previewGreeting(settings)}</p>
            </div>
          </div>

          <button type="button" className="staff-cancel-btn" onClick={sendTest} disabled={testing}>
            {testing ? 'Отправка…' : testSent ? 'Тест отправлен ✓ — проверьте Telegram' : 'Отправить тест себе'}
          </button>

          <div className="staff-form-actions">
            <button type="submit" disabled={saving}>
              {saving ? 'Сохранение…' : saved ? 'Сохранено ✓' : 'Сохранить'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
