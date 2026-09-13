import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import StaffApp from './StaffApp.tsx'
import PwaLogin from './PwaLogin.tsx'
import { getTelegramUserId, getInitData } from './telegram'
import { apiFetch } from './apiFetch'
import type { StaffRole, PwaIdentity } from './types'

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
    <Root />
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
