import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import StaffApp from './StaffApp.tsx'
import PwaLogin from './PwaLogin.tsx'
import ErrorBoundary from './ErrorBoundary.tsx'
import { getTelegramUserId, getInitData } from './telegram'
import { apiFetch } from './apiFetch'
import type { StaffRole, PwaIdentity } from './types'

// Подстраховка на случай ошибки вне React (например, в обработчике события) —
// ErrorBoundary такое не ловит. Показываем текст ошибки полоской сверху,
// не закрывая весь экран, чтобы было что переслать вместо "не отображается"
function showFatalErrorBanner(message: string) {
  if (document.getElementById('fatal-error-banner')) return
  const banner = document.createElement('div')
  banner.id = 'fatal-error-banner'
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#f4e3df;color:#7a352b;' +
    'padding:10px 14px;font:12px sans-serif;white-space:pre-wrap;word-break:break-word;' +
    'border-bottom:1px solid #a34a3d;max-height:40vh;overflow:auto'
  banner.textContent = 'Ошибка: ' + message
  document.body.prepend(banner)
}

window.addEventListener('error', (e) => {
  const stack = e.error instanceof Error ? e.error.stack : undefined
  showFatalErrorBanner(`${e.message}\n${e.filename}:${e.lineno}:${e.colno}${stack ? '\n' + stack : ''}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  const text = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
  showFatalErrorBanner(text)
})

const API_URL = import.meta.env.VITE_API_URL ?? ''

// Открыто ли приложение по-настоящему внутри Telegram — initData есть только
// когда его показал сам Telegram, у обычной ссылки в браузере такого не будет
function isInsideTelegram(): boolean {
  return getInitData() !== ''
}

// Экран для PWA-версии (открыта не через Telegram): сперва проверяем, нет ли
// уже сохранённой сессии (cookie после прошлого входа по коду), и только если
// её нет — показываем форму ввода кода
function PwaRoot() {
  const [identity, setIdentity] = useState<PwaIdentity | null>(null)
  const [checkedSession, setCheckedSession] = useState(false)

  useEffect(() => {
    apiFetch(`${API_URL}/api/pwa/session`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: PwaIdentity | null) => setIdentity(data))
      .catch(() => setIdentity(null))
      .finally(() => setCheckedSession(true))
  }, [])

  function handleLogout() {
    apiFetch(`${API_URL}/api/pwa/logout`, { method: 'POST' }).catch(() => {})
    setIdentity(null)
  }

  if (!checkedSession) {
    return <div className="loading-screen">Загрузка…</div>
  }

  if (!identity) {
    return <PwaLogin onSuccess={setIdentity} />
  }

  if (identity.role === 'master') {
    return (
      <StaffApp
        telegramId={identity.telegram_id}
        role="master"
        masterId={identity.master_id}
        masterName={identity.master_name}
        onLogout={handleLogout}
      />
    )
  }

  return <StaffApp telegramId={identity.telegram_id} role="admin" onLogout={handleLogout} />
}

// Определяет, кто открыл приложение — клиент или сотрудник — и показывает
// нужный экран. Если сервер недоступен или роль не удалось узнать — открываем
// клиентское приложение (чтобы сбой определения роли не ломал запись клиентам)
function Gate() {
  const [role, setRole] = useState<StaffRole | null>(null)

  useEffect(() => {
    const telegramId = getTelegramUserId()
    apiFetch(`${API_URL}/api/me?telegram_id=${telegramId}`)
      .then((r) => r.json())
      .then((data: StaffRole) => setRole(data))
      .catch(() => setRole({ role: 'client' }))
  }, [])

  if (!role) {
    return <div className="loading-screen">Загрузка…</div>
  }

  if (role.role === 'master') {
    return (
      <StaffApp
        telegramId={getTelegramUserId()}
        role="master"
        masterId={role.master_id}
        masterName={role.master_name}
      />
    )
  }

  if (role.role === 'admin') {
    return <StaffApp telegramId={getTelegramUserId()} role="admin" />
  }

  return <App />
}

function Root() {
  return isInsideTelegram() ? <Gate /> : <PwaRoot />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
)

// Регистрация service worker — без него браузер не предложит установить PWA
// на телефон. import.meta.env.BASE_URL — это путь, из которого реально отдаётся
// сайт (например "/salot_bot/"), чтобы service-worker.js искался там же, где
// лежит сам сайт, а не в корне домена
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`).catch(() => {})
  })
}
