import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import StaffApp from './StaffApp.tsx'
import { getTelegramUserId } from './telegram'
import type { StaffRole } from './types'

const API_URL = import.meta.env.VITE_API_URL ?? ''

// Определяет, кто открыл приложение — клиент или сотрудник — и показывает
// нужный экран. Если сервер недоступен или роль не удалось узнать — открываем
// клиентское приложение (чтобы сбой определения роли не ломал запись клиентам)
function Gate() {
  const [role, setRole] = useState<StaffRole | null>(null)

  useEffect(() => {
    const telegramId = getTelegramUserId()
    fetch(`${API_URL}/api/me?telegram_id=${telegramId}`)
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
)
