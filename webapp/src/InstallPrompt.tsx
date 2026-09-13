import { useEffect, useState } from 'react'

// Событие браузера "можно предложить установку" — есть в основном у Android
// Chrome. TypeScript не знает о нём из коробки, описываем сами
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Os = 'ios' | 'android' | 'other'

function detectOs(): Os {
  const ua = navigator.userAgent
  // Проверяем Android в первую очередь: у iPad на iPadOS 13+ Safari тоже
  // выдаёт себя за настольный Mac (navigator.platform === 'MacIntel') с
  // поддержкой touch — но настоящий Android под эту проверку тоже подходит
  // на некоторых устройствах, поэтому явное упоминание Android в UA важнее
  if (/Android/.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  const isIpad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  if (isIpad) return 'ios'
  return 'other'
}

// Уже открыто как установленное приложение (без адресной строки браузера) —
// значит, устанавливать больше нечего
function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone === true
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone())
  const os = detectOs()

  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    function onInstalled() {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed) return null

  async function handleNativeInstall() {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
  }

  if (deferredPrompt) {
    return (
      <div className="install-prompt">
        <button type="button" className="install-prompt-button" onClick={handleNativeInstall}>
          📲 Установить приложение
        </button>
      </div>
    )
  }

  if (os === 'ios') {
    return (
      <div className="install-prompt">
        <p className="install-prompt-title">Как установить на iPhone</p>
        <ol className="install-prompt-steps">
          <li>Нажмите на значок «Поделиться» внизу экрана (квадрат со стрелкой вверх)</li>
          <li>Прокрутите вниз и нажмите «На экран Домой»</li>
          <li>Нажмите «Добавить»</li>
        </ol>
      </div>
    )
  }

  if (os === 'android') {
    return (
      <div className="install-prompt">
        <p className="install-prompt-title">Как установить на Android</p>
        <ol className="install-prompt-steps">
          <li>Нажмите на меню (три точки в правом верхнем углу)</li>
          <li>Выберите «Добавить на главный экран»</li>
          <li>Нажмите «Добавить»</li>
        </ol>
      </div>
    )
  }

  return null
}
