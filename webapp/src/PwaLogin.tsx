import { useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch } from './apiFetch'
import type { PwaIdentity } from './types'

const API_URL = import.meta.env.VITE_API_URL ?? ''

interface PwaLoginProps {
  onSuccess: (identity: PwaIdentity) => void
}

// Отдельная страница входа для PWA-версии (открывается не из Telegram, а по
// прямой ссылке в обычном браузере) — вводишь код, который выдал сервер, и
// попадаешь в тот же интерфейс мастера/админа, что и в Telegram
export default function PwaLogin({ onSuccess }: PwaLoginProps) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!code.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`${API_URL}/api/pwa/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не удалось войти')
        return
      }
      onSuccess(data as PwaIdentity)
    } catch {
      setError('Не удалось связаться с сервером, попробуйте ещё раз')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="pwa-login-screen">
      <div className="pwa-login-card">
        <h1 className="pwa-login-title">Салон</h1>
        <p className="pwa-login-subtitle">Вход для мастеров и администраторов</p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            className="pwa-login-input"
            placeholder="Код доступа"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
          />
          {error && <p className="pwa-login-error">{error}</p>}
          <button type="submit" className="pwa-login-submit" disabled={loading || !code.trim()}>
            {loading ? 'Проверяем…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  )
}
