import { useCallback, useRef, useState } from 'react'
import { parsePlayDirective, type Directive } from '@/lib/playDirective'
import { appendToken as appendArtifactToken, finishStreaming as finishArtifactStreaming } from '@/lib/canvas/artifactStore'

interface Turn { role: 'user' | 'assistant'; content: string }

/** The companion's wordless "what am I doing" signal during a tool turn. `null`
 *  when not processing a tool. Drives the ambient working state, never spoken.
 *  `retrying` = the backend hit a dead end and is making one more attempt. */
export type CompanionPhase = 'working' | 'searching' | 'retrying' | null

interface CompanionStreamOptions {
  /** Fired when the companion turn emits a playback/narration directive (e.g.
   *  "play heavy metal" or "read this with character voices"). The caller drives
   *  the global mini-player / TTS playback. */
  onDirective?: (directive: Directive) => void
  /** Fired at most once per turn, and ONLY when the backend genuinely changed
   *  approach after a dead end ("Hmm, let me try that a different way."). The
   *  caller speaks it on voice surfaces; text surfaces ignore it. This is the only
   *  thing the companion ever says about its own processing — never a task
   *  announcement. */
  onSpokenCue?: (text: string) => void
}

// Ephemeral companion chat used OFF the chat app. Streams a reply in place and
// keeps a short client-side history for context — but persists nothing and never
// navigates. (When the chat app is open, the overlay uses the real chat flow,
// which records conversations.)
export function useCompanionStream(options?: CompanionStreamOptions) {
  const [response, setResponse] = useState('')
  const [streaming, setStreaming] = useState(false)
  // Wordless processing signal (Phase 2): set while a tool runs, cleared the moment
  // real reply text starts or the turn ends. The overlay/dock use it to show an
  // "on it" state instead of an undifferentiated "thinking" spinner.
  const [phase, setPhase] = useState<CompanionPhase>(null)
  const historyRef = useRef<Turn[]>([])
  const abortRef = useRef<AbortController | null>(null)
  // Server-side generation id for the in-flight turn. Generation is decoupled
  // from the connection (genQueue), so aborting the fetch alone no longer stops
  // the GPU — cancel() must also hit the cancel endpoint.
  const genIdRef = useRef<string | null>(null)
  // Keep the latest callback in a ref so `submit` stays stable (the hands-free
  // loop calls it through a ref) without re-creating on every render.
  const onDirectiveRef = useRef(options?.onDirective)
  onDirectiveRef.current = options?.onDirective
  const onSpokenCueRef = useRef(options?.onSpokenCue)
  onSpokenCueRef.current = options?.onSpokenCue

  const cancelServerGen = useCallback(() => {
    const genId = genIdRef.current
    genIdRef.current = null
    if (genId) {
      void fetch(`/api/chat/stream/${genId}/cancel`, { method: 'POST', credentials: 'include' }).catch(() => {})
    }
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    cancelServerGen()
    setStreaming(false)
  }, [cancelServerGen])

  const submit = useCallback(async (text: string, characterId: string, uiContext?: string | null, images?: string[]) => {
    if ((!text.trim() && (!images || images.length === 0)) || !characterId) return
    if (import.meta.env.DEV) console.log('[COMPANION] you:', JSON.stringify(text))
    abortRef.current?.abort()
    cancelServerGen() // a new utterance interrupts the previous generation server-side too
    const controller = new AbortController()
    abortRef.current = controller

    const history = historyRef.current.slice(-6)
    historyRef.current = [...history, { role: 'user', content: text }]
    setResponse('')
    setPhase(null)
    setStreaming(true)

    let acc = ''
    let sawError = false
    try {
      const res = await fetch('/api/companions/companion', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, message: text, history, uiContext: uiContext ?? null, clientTz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null } catch { return null } })(), ...(images && images.length > 0 && { images }) }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // A 403 consent rejection / 429 queue limit / 500 used to be silently
        // parsed as an SSE body and produce dead air.
        let detail = ''
        try { detail = ((await res.json()) as { message?: string; error?: string }).message ?? '' } catch { /* not json */ }
        throw new Error(detail || `request failed (${res.status})`)
      }
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
            if (event === 'token') {
              const wasEmpty = acc.length === 0
              acc += data; setResponse(acc)
              // First real reply text → processing is over; drop the working cue.
              if (wasEmpty && data) setPhase(null)
            }
            else if (event === 'status') {
              // Wordless "working"/"searching" cue while a tool runs. Never spoken.
              try { const s = JSON.parse(data) as { phase?: CompanionPhase }; setPhase(s.phase ?? null) } catch { /* malformed */ }
            }
            else if (event === 'spoken_cue') {
              // A real change of approach — the one line worth saying out loud.
              try { const c = JSON.parse(data) as { text?: string }; if (c.text) onSpokenCueRef.current?.(c.text) } catch { /* malformed */ }
            }
            else if (event === 'gen') {
              try { genIdRef.current = (JSON.parse(data) as { genId?: string }).genId ?? null } catch { /* ignore */ }
            }
            else if (event === 'directive') {
              try {
                const directive = parsePlayDirective(JSON.parse(data))
                if (directive) onDirectiveRef.current?.(directive)
              } catch { /* malformed directive */ }
            }
            else if (event === 'artifact_token') {
              // Canvas body streams into the pane (opened by the open_artifact
              // directive above), NOT the spoken/typed companion reply.
              try { const a = JSON.parse(data) as { artifactId: string; token: string }; appendArtifactToken(a.artifactId, a.token) } catch { /* malformed */ }
            }
            else if (event === 'artifact_done') {
              try { const a = JSON.parse(data) as { artifactId: string; content: string }; finishArtifactStreaming(a.artifactId, a.content) } catch { /* malformed */ }
            }
            else if (event === 'error') {
              // Mid-stream failure: surface it through the normal reply channel so
              // voice/captions say something instead of leaving dead air.
              sawError = true
              if (!acc) { acc = 'Sorry — I hit a snag with that one. Mind trying again?'; setResponse(acc) }
              if (import.meta.env.DEV) console.warn('[COMPANION] stream error:', data)
            }
            else if (event === 'routing' && import.meta.env.DEV) console.log('[COMPANION] routing:', data)
          }
        }
      }
      // Errored turns don't join history — the fallback line isn't the companion's.
      if (!sawError) historyRef.current = [...historyRef.current, { role: 'assistant', content: acc }]
      if (import.meta.env.DEV) console.log(`[COMPANION] reply (${acc.length} chars):`, JSON.stringify(acc))
    } catch (e) {
      if (import.meta.env.DEV) console.log(`[COMPANION] reply ABORTED/failed at ${acc.length} chars:`, JSON.stringify(acc), String(e))
      // Real failures (not user aborts) speak up instead of going silent.
      if (!controller.signal.aborted && !acc) {
        setResponse('Sorry — I hit a snag with that one. Mind trying again?')
      }
    }
    finally { setStreaming(false); setPhase(null); abortRef.current = null; genIdRef.current = null }
  }, [cancelServerGen])

  return { response, streaming, phase, submit, cancel }
}
