import { useEffect, useState } from 'react'
import { apiFetch } from './apiFetch'
import { openPwaExternally } from './telegram'

const API_URL = import.meta.env.VITE_API_URL ?? ''

// Экран "Вход на телефоне": сотрудник нажимает кнопку и получает одноразовый
// код. Личность подтверждает сама подпись Telegram (или уже открытая PWA),
// поэтому чужой человек такой код получить не может. Код действует 10 минут
// и сгорает при первом использовании
export default function PwaAccess() {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!expiresAt) return
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left === 0) setCode(null)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  async function requestCode() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`${API_URL}/api/pwa/login-code`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Не удалось получить код')
        return
      }
      setCode(data.code as string)
      setExpiresAt(new Date(data.expires_at as string).getTime())
    } catch {
      setError('Не удалось связаться с сервером, попробуйте ещё раз')
    } finally {
      setLoading(false)
    }
  }

  function copyCode() {
    if (!code) return
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = String(secondsLeft % 60).padStart(2, '0')

  return (
    <div className="pwa-access">
      <p className="pwa-access-text">
        Чтобы войти в приложение на телефоне или компьютере без Telegram, получите одноразовый код и введите его на
        странице входа. Код действует 10 минут и работает один раз.
      </p>

      {code ? (
        <div className="pwa-access-code-box">
          <span className="pwa-access-code">{code}</span>
          <span className="pwa-access-timer">Осталось {minutes}:{seconds}</span>
          <button type="button" className="pwa-access-btn" onClick={copyCode}>
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        </div>
      ) : null}

      {error && <p className="pwa-access-error">{error}</p>}

      <button type="button" className="pwa-access-btn" onClick={requestCode} disabled={loading}>
        {loading ? 'Получаем…' : code ? 'Получить новый код' : 'Получить код'}
      </button>
      <button type="button" className="pwa-access-btn pwa-access-btn--secondary" onClick={() => openPwaExternally()}>
        Открыть страницу установки
      </button>
    </div>
  )
}
