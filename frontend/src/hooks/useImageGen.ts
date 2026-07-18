import { useState, useCallback, useRef } from 'react'

export interface GenerateParams {
  prompt: string
  originalPrompt?: string   // pre-Auto-enhance wording; backend falls back to it if the enhanced prompt trips the safety filter
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  guidance?: number
  seed?: number
  loraIds?: string[]
  loraWeights?: Record<string, number>
  hires?: boolean            // opt-in 2× finalize pass (ESRGAN + refine) — off = base size, much faster
  // Clean Up (masked SDXL inpaint): remove or replace a painted region
  cleanUp?: boolean
  maskBase64?: string        // inpaint: user-painted mask (white = replace)
  // Video
  videoMode?: boolean        // text-to-video (AnimateDiff)
  i2vMode?: boolean          // image-to-video (SVD)
  imageBase64?: string       // i2v / inpaint: source still
  frames?: number
  fps?: number
  motionBucketId?: number    // i2v: SVD motion amount
  augmentation?: number      // i2v: SVD conditioning noise
  // SVG (vector) output: trace the rendered still into scalable vector paths
  outputFormat?: 'png' | 'svg'
  flatBias?: boolean         // steer generation toward flat vector art (default on)
  svgOptions?: { colorPrecision?: number; filterSpeckle?: number }
}

export type GenStatus = 'idle' | 'generating' | 'done' | 'error' | 'cancelled'

export interface GenState {
  status: GenStatus
  imageId: string | null
  step: number
  stepOffset: number   // cumulative steps from completed KSampler phases
  totalSteps: number
  elapsedMs: number
  error: string | null
  previewUrl: string | null
}

export function useImageGen() {
  const [state, setState] = useState<GenState>({
    status: 'idle',
    imageId: null,
    step: 0,
    stepOffset: 0,
    totalSteps: 0,
    elapsedMs: 0,
    error: null,
    previewUrl: null,
  })

  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

  const cancel = useCallback(async (imageId: string) => {
    readerRef.current?.cancel().catch(() => {})
    readerRef.current = null
    try {
      await fetch(`/api/image/artifacts/${imageId}/cancel`, { method: 'POST' })
    } catch { /* ignore */ }
    setState(s => ({ ...s, status: 'cancelled', previewUrl: null }))
  }, [])

  const generate = useCallback(async (params: GenerateParams): Promise<string | null> => {
    setState({ status: 'generating', imageId: null, step: 0, stepOffset: 0, totalSteps: params.steps ?? 20, elapsedMs: 0, error: null, previewUrl: null })

    let res: Response
    try {
      res = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
    } catch (err) {
      setState(s => ({ ...s, status: 'error', error: 'Network error — is the server running?' }))
      return null
    }

    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      // Prefer the backend's human-readable `message`; the `error` code is only a fallback.
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

          let d: { imageId?: string; steps?: number; step?: number; total?: number; elapsedMs?: number; b64?: string; message?: string }
          try { d = JSON.parse(data) } catch { continue } // skip malformed frame

          if (currentEvent === 'start') {
            currentImageId = d.imageId!
            setState(s => ({ ...s, imageId: d.imageId!, totalSteps: d.steps!, step: 0, stepOffset: 0 }))
          } else if (currentEvent === 'step') {
            setState(s => {
              // Detect KSampler phase transition: ComfyUI resets value to 1 for each new node
              const prevRaw = s.step - s.stepOffset
              const newOffset = d.step! < prevRaw ? s.stepOffset + prevRaw : s.stepOffset
              return {
                ...s,
                step: Math.min(newOffset + d.step!, s.totalSteps),
                stepOffset: newOffset,
                elapsedMs: d.elapsedMs!,
              }
            })
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
        setState(s => ({ ...s, status: 'cancelled' }))
      } else {
        setState(s => ({ ...s, status: 'error', error: 'Stream interrupted' }))
      }
      return null
    } finally {
      readerRef.current = null
    }

    // Stream ended without done/error event
    if (currentImageId) {
      setState(s => ({ ...s, status: 'done', imageId: currentImageId }))
      return currentImageId
    }
    setState(s => ({ ...s, status: 'error', error: 'Generation ended unexpectedly' }))
    return null
  }, [])

  const reset = useCallback(() => {
    setState({ status: 'idle', imageId: null, step: 0, stepOffset: 0, totalSteps: 0, elapsedMs: 0, error: null, previewUrl: null })
  }, [])

  return { state, generate, cancel, reset }
}
