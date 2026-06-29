import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function useBrowserSession() {
  const navigate = useNavigate()

  useEffect(() => {
    const es = new EventSource('/api/browser-session', { withCredentials: true })

    es.addEventListener('command', (e: MessageEvent) => {
      try {
        const cmd = JSON.parse(e.data as string) as Record<string, unknown>
        switch (cmd.type) {
          case 'navigate':
            if (typeof cmd.path === 'string') navigate(cmd.path)
            break
          case 'open_url':
            if (typeof cmd.url === 'string') window.open(cmd.url, '_blank', 'noopener')
            break
          case 'app_action':
            window.dispatchEvent(new CustomEvent('stream-deck:action', { detail: cmd }))
            break
          case 'stream_deck_page_jump':
            window.dispatchEvent(new CustomEvent('stream-deck:page-jump', { detail: cmd }))
            break
        }
      } catch { /* malformed */ }
    })

    // EventSource handles reconnect automatically on error
    es.onerror = () => {}

    return () => es.close()
  }, [navigate])
}
