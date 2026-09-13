import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string | null
}

// Раньше любая ошибка при отрисовке экрана давала просто белый экран —
// ни пользователь, ни разработчик не понимали, что случилось. Теперь вместо
// этого показывается сообщение с текстом ошибки, которое можно переслать
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Необработанная ошибка в приложении:', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          minHeight: '100dvh',
          padding: 20,
          background: '#fbf7f2',
          color: '#2e2a26',
          fontFamily: 'sans-serif',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Что-то сломалось</h2>
        <p>Сделайте, пожалуйста, скриншот этого экрана (весь текст ниже целиком) и перешлите его.</p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 11,
            background: '#fff',
            padding: 12,
            borderRadius: 8,
            border: '1px solid rgba(46,42,38,0.15)',
          }}
        >
          {error.message}
          {'\n\n'}
          {error.stack}
          {componentStack ? '\n\n--- где именно ---' + componentStack : ''}
        </pre>
      </div>
    )
  }
}
