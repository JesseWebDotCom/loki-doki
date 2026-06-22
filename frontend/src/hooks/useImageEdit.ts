import { useState, useCallback, useRef, useEffect } from 'react'

export type EditStatus = 'idle' | 'running' | 'done' | 'error'

export interface EditState {
  status: EditStatus
  imageId: string | null
  step: number
  totalSteps: number
  elapsedMs: number
  error: string | null
  previewUrl: string | null
}

export type EditSource =
  | { imageId: string; file?: never }
  | { file: File; imageId?: never }

export function useImageEdit() {
  const [state, setState] = useState<EditState>({
    status: 'idle',
    imageId: null,
    step: 0,
    totalSteps: 1,
    elapsedMs: 0,
    error: null,
    previewUrl: null,
  })

  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

  // Cancel the in-flight SSE reader on unmount so the read loop stops calling
  // setState after the component is gone.
  useEffect(() => () => { readerRef.current?.cancel().catch(() => {}) }, [])

  const cancel = useCallback(async (imageId: string) => {
    readerRef.current?.cancel().catch(() => {})
    readerRef.current = null
    try {
      await fetch(`/api/image/artifacts/${imageId}/cancel`, { method: 'POST' })
    } catch { /* ignore */ }
    setState(s => ({ ...s, status: 'idle' }))
  }, [])

  const run = useCallback(async (op: string, source: EditSource, options?: { strength?: number; model?: string; fidelity?: number; photoRestoreFaces?: boolean; photoRestoreUpscale?: boolean; blurRadius?: number; brightness?: number; contrast?: number; saturation?: number; sharpness?: number }): Promise<string | null> => {
    setState({ status: 'running', imageId: null, step: 0, totalSteps: 1, elapsedMs: 0, error: null, previewUrl: null })

    const form = new FormData()
    form.append('op', op)
    if (source.file) {
      form.append('file', source.file)
    } else {
      form.append('imageId', source.imageId)
    }
    if (options?.strength            !== undefined) form.append('strength',            String(options.strength))
    if (options?.model               !== undefined) form.append('model',               options.model)
    if (options?.fidelity            !== undefined) form.append('fidelity',            String(options.fidelity))
    if (options?.photoRestoreFaces   !== undefined) form.append('photoRestoreFaces',   String(options.photoRestoreFaces))
    if (options?.photoRestoreUpscale !== undefined) form.append('photoRestoreUpscale', String(options.photoRestoreUpscale))
    if (options?.blurRadius           !== undefined) form.append('blurRadius',           String(options.blurRadius))
    if (options?.brightness          !== undefined) form.append('brightness',          String(options.brightness))
    if (options?.contrast            !== undefined) form.append('contrast',            String(options.contrast))
    if (options?.saturation          !== undefined) form.append('saturation',          String(options.saturation))
    if (options?.sharpness           !== undefined) form.append('sharpness',           String(options.sharpness))

    let res: Response
    try {
      res = await fetch('/api/image/edit', { method: 'POST', body: form })
    } catch {
      setState(s => ({ ...s, status: 'error', error: 'Network error — is the server running?' }))
      return null
    }

    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const d = await res.json() as { message?: string; error?: string }; msg = d.message ?? d.error ?? msg } catch { /* ignore */ }
      setState(s => ({ ...s, status: 'error', error: msg }))
      return null
    }

    const reader = res.body!.getReader()
    readerRef.current = reader
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    let currentImageId: string | null = null

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
          if (!event && !data) continue
          currentEvent = event

          let d: { imageId?: string; steps?: number; step?: number; total?: number; elapsedMs?: number; b64?: string; message?: string }
          try { d = JSON.parse(data) } catch { continue } // skip malformed frame

          if (currentEvent === 'start') {
            currentImageId = d.imageId!
            setState(s => ({ ...s, imageId: d.imageId!, totalSteps: d.steps! }))
          } else if (currentEvent === 'step') {
            setState(s => ({ ...s, step: Math.min(d.step!, s.totalSteps), elapsedMs: d.elapsedMs! }))
          } else if (currentEvent === 'preview') {
            setState(s => ({ ...s, previewUrl: `data:image/jpeg;base64,${d.b64}` }))
          } else if (currentEvent === 'done') {
            setState(s => ({ ...s, status: 'done', imageId: d.imageId!, step: s.totalSteps, previewUrl: null }))
            return d.imageId!
          } else if (currentEvent === 'error') {
            setState(s => ({ ...s, status: 'error', error: d.message!, previewUrl: null }))
            return null
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setState(s => ({ ...s, status: 'idle' }))
      } else {
        setState(s => ({ ...s, status: 'error', error: 'Stream interrupted' }))
      }
      return null
    } finally {
      readerRef.current = null
    }

    if (currentImageId) {
      setState(s => ({ ...s, status: 'done', imageId: currentImageId }))
      return currentImageId
    }
    setState(s => ({ ...s, status: 'error', error: 'Edit ended unexpectedly' }))
    return null
  }, [])

  const reset = useCallback(() => {
    readerRef.current?.cancel().catch(() => {})
    readerRef.current = null
    setState({ status: 'idle', imageId: null, step: 0, totalSteps: 1, elapsedMs: 0, error: null, previewUrl: null })
  }, [])

  const restore = useCallback((imageId: string) => {
    setState({ status: 'done', imageId, step: 1, totalSteps: 1, elapsedMs: 0, error: null, previewUrl: null })
  }, [])

  return { state, run, cancel, reset, restore }
}
