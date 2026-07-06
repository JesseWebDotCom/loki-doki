import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import type { GenerateParams, GenState } from '@/hooks/useImageGen'
import { toast } from '@/lib/toast'

const IDLE: GenState = {
  status: 'idle',
  imageId: null,
  step: 0,
  stepOffset: 0,
  totalSteps: 0,
  elapsedMs: 0,
  error: null,
  previewUrl: null,
}

export interface GenChannel {
  state: GenState
  /** Unix ms when the last generation completed — used for the 60s sidebar badge expiry */
  doneAt: number | null
  /** Whether the current/last generation used adult LoRAs */
  isAdult: boolean
  /** The prompt submitted for the active/last generation — survives page navigation */
  activePrompt: string | null
  /** LoRA IDs used in the active/last generation — survives page navigation */
  activeLoraIds: string[] | null
  generate: (params: GenerateParams, isAdult?: boolean) => Promise<string | null>
  /** Correct the isAdult flag after-the-fact (e.g. after fetching artifact meta) */
  setIsAdult: (v: boolean) => void
  /** Re-attach to a generation that's already running on the server (e.g. after page refresh) */
  reconnect: (imageId: string, steps: number, isAdult: boolean, activePrompt: string | null) => void
  cancel: (imageId: string) => void
  reset: () => void
}

interface Ctx {
  imaging: GenChannel
  video: GenChannel
}

const GenerationContext = createContext<Ctx | null>(null)

// Runs the SSE stream from /api/image/generate and pipes events into setState.
// Stays alive across navigation because it lives in the provider, not a page.
async function runStream(
  params: GenerateParams,
  setState: Dispatch<SetStateAction<GenState>>,
  readerRef: { current: ReadableStreamDefaultReader<Uint8Array> | null },
  onDone: () => void,
  onIsAdult?: (isAdult: boolean) => void,
): Promise<string | null> {
  let res: Response
  try {
    res = await fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      credentials: 'include',
    })
  } catch {
    setState(s => ({ ...s, status: 'error', error: 'Network error — is the server running?' }))
    return null
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    // Prefer the human-readable `message` the backend sends; fall back to the `error` code
    // only when there's no message. (A bare code like "content_blocked" is not a message.)
    try { const d = await res.json() as { error?: string; message?: string }; msg = d.message ?? d.error ?? msg } catch { /* ignore */ }
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

        let d: { imageId?: string; steps?: number; isAdult?: boolean; step?: number; total?: number; elapsedMs?: number; b64?: string; message?: string }
        try { d = JSON.parse(data) } catch { continue } // skip malformed frame

        if (currentEvent === 'start') {
          currentImageId = d.imageId!
          if (d.isAdult !== undefined) onIsAdult?.(d.isAdult)
          setState(s => ({ ...s, imageId: d.imageId!, totalSteps: d.steps!, step: 0, stepOffset: 0 }))
        } else if (currentEvent === 'step') {
          setState(s => {
            const prevRaw = s.step - s.stepOffset
            const newOffset = d.step! < prevRaw ? s.stepOffset + prevRaw : s.stepOffset
            return { ...s, step: Math.min(newOffset + d.step!, s.totalSteps), stepOffset: newOffset, elapsedMs: d.elapsedMs! }
          })
        } else if (currentEvent === 'preview') {
          setState(s => ({ ...s, previewUrl: `data:image/jpeg;base64,${d.b64}` }))
        } else if (currentEvent === 'done') {
          setState(s => ({ ...s, status: 'done', imageId: d.imageId!, step: s.totalSteps, previewUrl: null }))
          onDone()
          return d.imageId!
        } else if (currentEvent === 'error') {
          setState(s => ({ ...s, status: 'error', error: d.message!, previewUrl: null }))
          return null
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      setState(s => ({ ...s, status: 'cancelled' }))
    } else {
      setState(s => ({ ...s, status: 'error', error: 'Stream interrupted' }))
    }
    return null
  } finally {
    readerRef.current = null
  }

  if (currentImageId) {
    setState(s => ({ ...s, status: 'done', imageId: currentImageId }))
    onDone()
    return currentImageId
  }
  setState(s => ({ ...s, status: 'error', error: 'Generation ended unexpectedly' }))
  return null
}

// Re-attach to an already-running job via GET /api/image/artifacts/:id/stream.
// The server replays buffered events (with a fresh start event containing isAdult).
async function resumeStream(
  imageId: string,
  setState: Dispatch<SetStateAction<GenState>>,
  readerRef: { current: ReadableStreamDefaultReader<Uint8Array> | null },
  onDone: () => void,
  onIsAdult?: (isAdult: boolean) => void,
): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`/api/image/artifacts/${imageId}/stream`, { credentials: 'include' })
  } catch {
    setState(s => ({ ...s, status: 'error', error: 'Network error reconnecting to generation' }))
    return null
  }

  if (!res.ok) {
    if (res.status === 410) {
      // Job already finished — reset to idle so history reloads the completed result
      setState(IDLE)
    } else if (res.status === 503) {
      // Server restarted and lost the job from memory; check if it completed
      setState(IDLE)
    } else {
      setState(s => ({ ...s, status: 'error', error: 'Could not reconnect to generation' }))
    }
    return null
  }

  const reader = res.body!.getReader()
  readerRef.current = reader
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

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

        let d: { imageId?: string; steps?: number; isAdult?: boolean; step?: number; total?: number; elapsedMs?: number; b64?: string; message?: string }
        try { d = JSON.parse(data) } catch { continue } // skip malformed frame

        if (currentEvent === 'start') {
          if (d.isAdult !== undefined) onIsAdult?.(d.isAdult)
          setState(s => ({ ...s, imageId: d.imageId!, totalSteps: d.steps! }))
        } else if (currentEvent === 'step') {
          setState(s => {
            const prevRaw = s.step - s.stepOffset
            const newOffset = d.step! < prevRaw ? s.stepOffset + prevRaw : s.stepOffset
            return { ...s, step: Math.min(newOffset + d.step!, s.totalSteps), stepOffset: newOffset, elapsedMs: d.elapsedMs! }
          })
        } else if (currentEvent === 'preview') {
          setState(s => ({ ...s, previewUrl: `data:image/jpeg;base64,${d.b64}` }))
        } else if (currentEvent === 'done') {
          setState(s => ({ ...s, status: 'done', imageId: d.imageId!, step: s.totalSteps, previewUrl: null }))
          onDone()
          return d.imageId!
        } else if (currentEvent === 'error') {
          setState(s => ({ ...s, status: 'error', error: d.message!, previewUrl: null }))
          return null
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name !== 'AbortError') {
      setState(s => ({ ...s, status: 'error', error: 'Reconnect stream interrupted' }))
    }
    return null
  } finally {
    readerRef.current = null
  }

  setState(s => ({ ...s, status: 'done', imageId }))
  onDone()
  return imageId
}

export function GenerationProvider({ children }: { children: ReactNode }) {
  const [imagingState, setImagingState] = useState<GenState>(IDLE)
  const imagingReader = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const [imagingDoneAt, setImagingDoneAt] = useState<number | null>(null)
  const [imagingIsAdult, setImagingIsAdult] = useState(false)
  const [imagingActivePrompt, setImagingActivePrompt] = useState<string | null>(null)
  const [imagingActiveLoraIds, setImagingActiveLoraIds] = useState<string[] | null>(null)

  const [videoState, setVideoState] = useState<GenState>(IDLE)
  const videoReader = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const [videoDoneAt, setVideoDoneAt] = useState<number | null>(null)
  const [videoIsAdult, setVideoIsAdult] = useState(false)
  const [videoActivePrompt, setVideoActivePrompt] = useState<string | null>(null)
  const [videoActiveLoraIds, setVideoActiveLoraIds] = useState<string[] | null>(null)

  // ── Imaging channel ──────────────────────────────────────────────────────────

  const imagingGenerate = useCallback(async (params: GenerateParams, isAdult = false): Promise<string | null> => {
    if (imagingReader.current) return null
    setImagingIsAdult(isAdult)
    setImagingActivePrompt(params.prompt ?? null)
    setImagingActiveLoraIds(params.loraWeights ? Object.keys(params.loraWeights) : (params.loraIds ?? null))
    setImagingDoneAt(null)
    setImagingState({
      status: 'generating', imageId: null, step: 0, stepOffset: 0,
      totalSteps: params.steps ?? 20, elapsedMs: 0, error: null, previewUrl: null,
    })
    return runStream(params, setImagingState, imagingReader, () => {
      setImagingDoneAt(Date.now())
      toast.success('Image ready')
    }, setImagingIsAdult)
  }, [])

  const imagingCancel = useCallback(async (imageId: string) => {
    imagingReader.current?.cancel().catch(() => {})
    imagingReader.current = null
    try { await fetch(`/api/image/artifacts/${imageId}/cancel`, { method: 'POST' }) } catch { /* ignore */ }
    setImagingState(s => ({ ...s, status: 'cancelled', previewUrl: null }))
  }, [])

  const imagingReset = useCallback(() => {
    imagingReader.current?.cancel().catch(() => {})
    imagingReader.current = null
    setImagingState(IDLE)
    setImagingDoneAt(null)
    setImagingActivePrompt(null)
    setImagingActiveLoraIds(null)
  }, [])

  // ── Video channel ────────────────────────────────────────────────────────────

  const videoGenerate = useCallback(async (params: GenerateParams, isAdult = false): Promise<string | null> => {
    if (videoReader.current) return null
    setVideoIsAdult(isAdult)
    setVideoActivePrompt(params.prompt ?? null)
    setVideoActiveLoraIds(params.loraIds ?? (params.loraWeights ? Object.keys(params.loraWeights) : null))
    setVideoDoneAt(null)
    setVideoState({
      status: 'generating', imageId: null, step: 0, stepOffset: 0,
      totalSteps: params.steps ?? 20, elapsedMs: 0, error: null, previewUrl: null,
    })
    return runStream(params, setVideoState, videoReader, () => {
      setVideoDoneAt(Date.now())
      toast.success('Video ready')
    }, setVideoIsAdult)
  }, [])

  const videoCancel = useCallback(async (imageId: string) => {
    videoReader.current?.cancel().catch(() => {})
    videoReader.current = null
    try { await fetch(`/api/image/artifacts/${imageId}/cancel`, { method: 'POST' }) } catch { /* ignore */ }
    setVideoState(s => ({ ...s, status: 'cancelled', previewUrl: null }))
  }, [])

  const videoReset = useCallback(() => {
    videoReader.current?.cancel().catch(() => {})
    videoReader.current = null
    setVideoState(IDLE)
    setVideoDoneAt(null)
    setVideoActivePrompt(null)
    setVideoActiveLoraIds(null)
  }, [])

  const imagingReconnect = useCallback((imageId: string, steps: number, isAdult: boolean, activePrompt: string | null) => {
    if (imagingReader.current) return
    setImagingIsAdult(isAdult)
    setImagingActivePrompt(activePrompt)
    setImagingDoneAt(null)
    setImagingState({ status: 'generating', imageId, step: 0, stepOffset: 0, totalSteps: steps, elapsedMs: 0, error: null, previewUrl: null })
    void resumeStream(imageId, setImagingState, imagingReader, () => {
      setImagingDoneAt(Date.now())
      toast.success('Image ready')
    }, setImagingIsAdult)
  }, [])

  const videoReconnect = useCallback((imageId: string, steps: number, isAdult: boolean, activePrompt: string | null) => {
    if (videoReader.current) return
    setVideoIsAdult(isAdult)
    setVideoActivePrompt(activePrompt)
    setVideoDoneAt(null)
    setVideoState({ status: 'generating', imageId, step: 0, stepOffset: 0, totalSteps: steps, elapsedMs: 0, error: null, previewUrl: null })
    void resumeStream(imageId, setVideoState, videoReader, () => {
      setVideoDoneAt(Date.now())
      toast.success('Video ready')
    }, setVideoIsAdult)
  }, [])

  return (
    <GenerationContext.Provider value={{
      imaging: { state: imagingState, doneAt: imagingDoneAt, isAdult: imagingIsAdult, activePrompt: imagingActivePrompt, activeLoraIds: imagingActiveLoraIds, generate: imagingGenerate, setIsAdult: setImagingIsAdult, reconnect: imagingReconnect, cancel: imagingCancel, reset: imagingReset },
      video:   { state: videoState,   doneAt: videoDoneAt,   isAdult: videoIsAdult,   activePrompt: videoActivePrompt,   activeLoraIds: videoActiveLoraIds,   generate: videoGenerate,   setIsAdult: setVideoIsAdult,   reconnect: videoReconnect,   cancel: videoCancel,   reset: videoReset   },
    }}>
      {children}
    </GenerationContext.Provider>
  )
}

export function useGenerationContext() {
  const ctx = useContext(GenerationContext)
  if (!ctx) throw new Error('useGenerationContext must be used inside GenerationProvider')
  return ctx
}
