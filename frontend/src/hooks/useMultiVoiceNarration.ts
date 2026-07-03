// "Cast voices": narrates a piece of text through the multi-voice narration engine
// (backend/src/lib/narration): detected speakers get distinct TTS voices, played
// sequentially through the same streaming pipeline as useArticleNarration (shared
// enqueueSpeech singleton). Generalizes useArticleNarration's batching/resume-point
// pattern from "one voice, N paragraphs" to "N voices, N turns".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  enqueueSpeech, pauseSpeech, resumeSpeech, stopSpeech,
  useVoicePaused, useVoicePlaying, getVoicePlayback,
} from '@/lib/voice/voicePlaybackStore'
import { extractParagraphs } from './useArticleNarration'

const RESUME_KEY = (sessionId: string) => `narration-cast:${sessionId}`

export interface NarrationSpeakerView {
  id: string
  label: string
  voiceId: string
  speechRate: number
  isNarrator: boolean
}

export interface NarrationTurnView {
  speakerId: string
  text: string
}

export interface NarrationSessionView {
  id: string
  title: string
  status: 'detecting' | 'ready' | 'failed'
  detectionMethod: string | null
  speakers: NarrationSpeakerView[]
  turns: NarrationTurnView[]
}

export interface MultiVoiceNarration {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'failed'
  session: NarrationSessionView | null
  /** True once a session has at least one non-narrator speaker (dialogue was detected). */
  hasCast: boolean
  progress: { turn: number; total: number }
  createSession: () => Promise<void>
  updateSpeakerVoice: (speakerId: string, voiceId: string, speechRate?: number) => Promise<void>
  start: (fromTurn?: number) => void
  pause: () => void
  resume: () => void
  stop: () => void
  /** Full MP3/WAV render + browser download, the slow path (contrast with `start()`,
   *  which streams turn-by-turn and never needs a finished file). */
  exportStatus: 'idle' | 'rendering' | 'ready' | 'failed'
  exportAudio: (format?: 'mp3' | 'wav') => Promise<void>
}

const EXPORT_POLL_MS = 2000
const EXPORT_POLL_MAX_ATTEMPTS = 150 // ~5 minutes

interface TurnBatch { speakerId: string; text: string; startTurn: number }

/** Batch consecutive same-speaker turns into one TTS request; never crosses a
 *  speaker boundary within a batch. */
function packBatches(turns: NarrationTurnView[]): TurnBatch[] {
  const batches: TurnBatch[] = []
  turns.forEach((t, i) => {
    const last = batches[batches.length - 1]
    if (last && last.speakerId === t.speakerId) {
      last.text += '\n\n' + t.text
    } else {
      batches.push({ speakerId: t.speakerId, text: t.text, startTurn: i })
    }
  })
  return batches
}

export function useMultiVoiceNarration(opts: {
  id: string
  contentHtml?: string | null
  sourceType?: 'bookmark' | 'paste' | 'upload' | 'chat_document'
  sourceRef?: string
}): MultiVoiceNarration {
  const playing = useVoicePlaying()
  void playing
  const paused = useVoicePaused()
  const [session, setSession] = useState<NarrationSessionView | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(false)
  const [turn, setTurn] = useState(0)
  const [exportStatus, setExportStatus] = useState<'idle' | 'rendering' | 'ready' | 'failed'>('idle')
  const runIdRef = useRef(0)

  const text = useMemo(
    () => (opts.contentHtml ? extractParagraphs(opts.contentHtml).join('\n\n') : ''),
    [opts.contentHtml],
  )
  const batches = useMemo(() => (session ? packBatches(session.turns) : []), [session])
  const speakerById = useMemo(() => new Map((session?.speakers ?? []).map((s) => [s.id, s])), [session])
  const hasCast = (session?.speakers ?? []).some((s) => !s.isNarrator);

  const createSession = useCallback(async () => {
    if (!text.trim() || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const res = await fetch('/api/narration/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sourceType: opts.sourceType ?? 'bookmark', sourceRef: opts.sourceRef ?? opts.id }),
      })
      if (!res.ok) throw new Error('request failed')
      const data = (await res.json()) as { session: NarrationSessionView }
      setSession(data.session)
      if (data.session.status !== 'ready') setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [text, loading, opts.sourceType, opts.sourceRef, opts.id])

  const updateSpeakerVoice = useCallback(async (speakerId: string, voiceId: string, speechRate?: number) => {
    if (!session) return
    const res = await fetch(`/api/narration/sessions/${session.id}/speakers/${speakerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId, speechRate }),
    })
    if (res.ok) {
      const data = (await res.json()) as { session: NarrationSessionView }
      setSession(data.session)
    }
  }, [session])

  const stop = useCallback(() => {
    runIdRef.current++
    setActive(false)
    stopSpeech()
  }, [])

  const exportAudio = useCallback(async (format: 'mp3' | 'wav' = 'mp3') => {
    if (!session) return
    setExportStatus('rendering')
    try {
      const res = await fetch(`/api/narration/sessions/${session.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      })
      if (!res.ok) throw new Error('export request failed')

      const statusUrl = `/api/narration/sessions/${session.id}/export/${format}/status`
      for (let attempt = 0; attempt < EXPORT_POLL_MAX_ATTEMPTS; attempt++) {
        const s = await fetch(statusUrl).then((r) => (r.ok ? r.json() : null)) as { status?: string } | null
        if (s?.status === 'ready') {
          setExportStatus('ready')
          const a = document.createElement('a')
          a.href = `/api/narration/sessions/${session.id}/export/${format}/download`
          a.download = `${(session.title || 'narration').replace(/[^\w -]+/g, '').slice(0, 60) || 'narration'}.${format}`
          document.body.appendChild(a)
          a.click()
          a.remove()
          return
        }
        if (s?.status === 'failed') { setExportStatus('failed'); return }
        await new Promise((r) => setTimeout(r, EXPORT_POLL_MS))
      }
      setExportStatus('failed')
    } catch {
      setExportStatus('failed')
    }
  }, [session])

  useEffect(() => () => { runIdRef.current++; stopSpeech() }, [opts.id])

  const start = useCallback((fromTurn?: number) => {
    if (!session || !batches.length) return
    const from = fromTurn ?? (() => {
      try {
        const saved = Number(localStorage.getItem(RESUME_KEY(session.id)))
        return Number.isFinite(saved) && saved > 0 && saved < session.turns.length ? saved : 0
      } catch { return 0 }
    })()

    stopSpeech()
    const runId = ++runIdRef.current
    setActive(true)
    const startBatch = Math.max(0, batches.findIndex((b, i) => {
      const next = batches[i + 1]
      return from >= b.startTurn && (!next || from < next.startTurn)
    }))
    setTurn(batches[startBatch]?.startTurn ?? 0)

    void (async () => {
      for (let i = startBatch; i < batches.length; i++) {
        if (runIdRef.current !== runId) return
        const batch = batches[i]!
        setTurn(batch.startTurn)
        try { localStorage.setItem(RESUME_KEY(session.id), String(batch.startTurn)) } catch { /* private mode */ }
        const speaker = speakerById.get(batch.speakerId)
        try {
          await enqueueSpeech({ text: batch.text, ttsVoice: speaker?.voiceId ?? null })
        } catch {
          if (runIdRef.current !== runId) return
          setActive(false)
          stopSpeech()
          return
        }
      }
      if (runIdRef.current !== runId) return
      const off = getVoicePlayback().onPlaybackEnd(() => {
        off()
        if (runIdRef.current !== runId) return
        try { localStorage.removeItem(RESUME_KEY(session.id)) } catch { /* ignore */ }
        setActive(false)
        setTurn(0)
      })
    })()
  }, [session, batches, speakerById])

  const status: MultiVoiceNarration['status'] =
    failed ? 'failed' : loading ? 'loading' : !active ? 'idle' : paused ? 'paused' : 'playing'

  return {
    status,
    session,
    hasCast,
    progress: { turn: Math.min(turn + 1, session?.turns.length ?? 0), total: session?.turns.length ?? 0 },
    createSession,
    updateSpeakerVoice,
    start,
    pause: () => { void pauseSpeech() },
    resume: () => { void resumeSpeech() },
    stop,
    exportStatus,
    exportAudio,
  }
}
