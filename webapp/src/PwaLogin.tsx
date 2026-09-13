import { useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch } from './apiFetch'
import InstallPrompt from './InstallPrompt'
import { setStaffSessionToken } from './staffSession'
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
  // Переход по кнопке "Установить приложение" из Telegram помечен ?install=1,
  // а сам код передан прямо в ссылке (?code=...) — здесь код вводить незачем,
  // показываем его для копирования вместе с инструкцией по установке.
  // Тот же код нужно будет ввести один раз — уже на самом значке на домашнем
  // экране при первом открытии
  const params = new URLSearchParams(window.location.search)
  const [showLoginForm, setShowLoginForm] = useState(() => params.get('install') !== '1')
  const installCode = params.get('code')
  const [installCodeCopied, setInstallCodeCopied] = useState(false)

  function copyInstallCode() {
    if (!installCode) return
    navigator.clipboard.writeText(installCode).then(() => {
      setInstallCodeCopied(true)
      setTimeout(() => setInstallCodeCopied(false), 1500)
    })
  }

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
      setStaffSessionToken(data.session_token as string)
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
        <img
          src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
          alt=""
          className="pwa-login-logo"
        />
        <h1 className="pwa-login-title">Салон</h1>
        {showLoginForm ? (
          <>
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
          </>
        ) : (
          <>
            <p className="pwa-login-subtitle">Скопируйте код — он понадобится при первом открытии приложения</p>
            {installCode && (
              <div className="pwa-install-code">
                <span className="pwa-install-code-value">{installCode}</span>
                <button type="button" className="pwa-install-code-copy" onClick={copyInstallCode}>
                  {installCodeCopied ? 'Скопировано' : 'Скопировать'}
                </button>
              </div>
            )}
          </>
        )}
        <InstallPrompt />
        {!showLoginForm && (
          <button type="button" className="pwa-login-link" onClick={() => setShowLoginForm(true)}>
            Уже установили? Войти по коду
          </button>
        )}
      </div>
    </div>
  )
}
