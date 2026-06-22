import { useCallback, useRef, useState } from 'react'

interface Turn { role: 'user' | 'assistant'; content: string }

// Ephemeral companion chat used OFF the chat app. Streams a reply in place and
// keeps a short client-side history for context — but persists nothing and never
// navigates. (When the chat app is open, the overlay uses the real chat flow,
// which records conversations.)
export function useCompanionStream() {
  const [response, setResponse] = useState('')
  const [streaming, setStreaming] = useState(false)
  const historyRef = useRef<Turn[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
  }, [])

  const submit = useCallback(async (text: string, characterId: string, uiContext?: string | null, images?: string[]) => {
    if ((!text.trim() && (!images || images.length === 0)) || !characterId) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const history = historyRef.current.slice(-6)
    historyRef.current = [...history, { role: 'user', content: text }]
    setResponse('')
    setStreaming(true)

    let acc = ''
    try {
      const res = await fetch('/api/companions/companion', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, message: text, history, uiContext: uiContext ?? null, ...(images && images.length > 0 && { images }) }),
        signal: controller.signal,
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('no stream')
      const dec = new TextDecoder()
      let buf = ''
      let event = 'message'
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            const data = line.slice(line.charAt(5) === ' ' ? 6 : 5)
            if (event === 'token') { acc += data; setResponse(acc) }
          }
        }
      }
      historyRef.current = [...historyRef.current, { role: 'assistant', content: acc }]
    } catch { /* aborted or failed */ }
    finally { setStreaming(false); abortRef.current = null }
  }, [])

  return { response, streaming, submit, cancel }
}
