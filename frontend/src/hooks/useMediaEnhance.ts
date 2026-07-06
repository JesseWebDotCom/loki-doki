import { useState, useCallback, useRef, useEffect } from 'react'

// SSE client for POST /api/image/enhance-media — the manual "Enhance" feature (images AND video).
// Mirrors useImageEdit's fetch→ReadableStream→SSE-frame parsing, but tracks a 0–100 progress
// percentage (not diffusion steps) and a text note, and resolves to a downloadable result URL.

export type EnhanceStatus = 'idle' | 'running' | 'done' | 'error'
export type EnhanceMode = 'clarity' | 'ai-upscale' | 'interpolate'

export interface MediaEnhanceState {
  status: EnhanceStatus
  pct: number
  note: string
  media: 'image' | 'video' | null
  resultUrl: string | null
  error: string | null
}

const IDLE: MediaEnhanceState = { status: 'idle', pct: 0, note: '', media: null, resultUrl: null, error: null }

export interface EnhanceOptions {
  /** ai-upscale (video): Real-CUGAN blend strength 0..1. */
  strength?: number
  /** interpolate (video): target frame rate. */
  fps?: number
}

export function useMediaEnhance() {
  const [state, setState] = useState<MediaEnhanceState>(IDLE)
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

  // Stop the read loop if the component unmounts mid-stream.
  useEffect(() => () => { readerRef.current?.cancel().catch(() => {}) }, [])

  const reset = useCallback(() => {
    readerRef.current?.cancel().catch(() => {})
    readerRef.current = null
    setState(IDLE)
  }, [])

  const run = useCallback(async (file: File, mode: EnhanceMode, opts?: EnhanceOptions): Promise<string | null> => {
    setState({ ...IDLE, status: 'running' })

    const form = new FormData()
    form.append('file', file)
    form.append('mode', mode)
    if (opts?.strength !== undefined) form.append('strength', String(opts.strength))
    if (opts?.fps !== undefined) form.append('fps', String(opts.fps))

    let res: Response
    try {
      res = await fetch('/api/image/enhance-media', { method: 'POST', body: form })
    } catch {
      setState(s => ({ ...s, status: 'error', error: 'Network error — is the server running?' }))
      return null
    }
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`
      try { const d = await res.json() as { message?: string; error?: string }; msg = d.message ?? d.error ?? msg } catch { /* ignore */ }
      setState(s => ({ ...s, status: 'error', error: msg }))
      return null
    }

    const reader = res.body.getReader()
    readerRef.current = reader
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          let event = ''
          let data = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim()
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (!event) continue

          if (event === 'progress') {
            try { const d = JSON.parse(data) as { pct?: number; note?: string }; setState(s => ({ ...s, pct: d.pct ?? s.pct, note: d.note ?? s.note })) } catch { /* skip */ }
          } else if (event === 'done') {
            try {
              const d = JSON.parse(data) as { url?: string; media?: 'image' | 'video' }
              setState(s => ({ ...s, status: 'done', pct: 100, note: '', resultUrl: d.url ?? null, media: d.media ?? null }))
              return d.url ?? null
            } catch { setState(s => ({ ...s, status: 'error', error: 'Malformed result' })); return null }
          } else if (event === 'error') {
            // genQueue emits the raw Error string; the route's messages are user-facing.
            let msg = data
            try { const d = JSON.parse(data) as { message?: string }; if (d.message) msg = d.message } catch { /* raw string */ }
            setState(s => ({ ...s, status: 'error', error: msg.replace(/^Error:\s*/, '') }))
            return null
          }
          // 'start' / 'queue' events are ignored.
        }
      }
    } catch {
      setState(s => ({ ...s, status: 'error', error: 'Stream interrupted' }))
      return null
    } finally {
      readerRef.current = null
    }

    setState(s => (s.status === 'running' ? { ...s, status: 'error', error: 'Enhance ended unexpectedly' } : s))
    return null
  }, [])

  return { state, run, reset }
}
