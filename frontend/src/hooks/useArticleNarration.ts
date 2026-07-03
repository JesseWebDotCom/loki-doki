// "Listen to this article" — narrates a bookmark's reader view through the shared
// streaming-TTS pipeline (voicePlaybackStore → /api/tts/stream, Kokoro app-default
// voice). Paragraphs come from contentHtml, NOT contentText: stripHtml collapses all
// whitespace server-side, so contentText has zero paragraph structure.
//
// Memory stays bounded on any article length: paragraphs are packed into small batches
// and fed sequentially through enqueueSpeech, whose internal pipeline holds at most two
// TTS fetches in flight. Starting narration replaces any companion speech (shared
// singleton — same as the companion barging in over itself).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  enqueueSpeech, pauseSpeech, resumeSpeech, stopSpeech,
  useVoicePaused, useVoicePlaying, getVoicePlayback,
} from '@/lib/voice/voicePlaybackStore'

const BATCH_TARGET_CHARS = 600
const RESUME_KEY = (id: string) => `bm-narration:${id}`

export interface ArticleNarration {
  status: 'idle' | 'playing' | 'paused'
  available: boolean
  progress: { paragraph: number; total: number }
  hasResumePoint: boolean
  start: (fromParagraph?: number) => void
  pause: () => void
  resume: () => void
  stop: () => void
}

export function extractParagraphs(contentHtml: string): string[] {
  const doc = new DOMParser().parseFromString(contentHtml, 'text/html')
  const nodes = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption')
  const out: string[] = []
  for (const node of nodes) {
    // Skip nested matches (an <li> inside a <blockquote> would otherwise read twice).
    if (node.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption')) continue
    const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    if (text.length >= 3) out.push(text)
  }
  return out
}

/** Pack paragraphs into ~600-char batches; each batch is one /api/tts/stream request
 *  (the server splits further into sentences). Returns batches + each batch's starting
 *  paragraph index for progress display. */
function packBatches(paragraphs: string[]): { text: string; startParagraph: number }[] {
  const batches: { text: string; startParagraph: number }[] = []
  let current = ''
  let start = 0
  paragraphs.forEach((p, i) => {
    if (current && current.length + p.length > BATCH_TARGET_CHARS) {
      batches.push({ text: current, startParagraph: start })
      current = ''
      start = i
    }
    current = current ? `${current}\n\n${p}` : p
  })
  if (current) batches.push({ text: current, startParagraph: start })
  return batches
}

export function useArticleNarration(item: { id: string; contentHtml?: string | null }): ArticleNarration {
  const playing = useVoicePlaying()
  const paused = useVoicePaused()
  const [active, setActive] = useState(false)
  const [paragraph, setParagraph] = useState(0)
  const runIdRef = useRef(0)

  const paragraphs = useMemo(
    () => (item.contentHtml ? extractParagraphs(item.contentHtml) : []),
    [item.contentHtml],
  )
  const batches = useMemo(() => packBatches(paragraphs), [paragraphs])

  const hasResumePoint = useMemo(() => {
    try {
      const saved = Number(localStorage.getItem(RESUME_KEY(item.id)))
      return Number.isFinite(saved) && saved > 0 && saved < paragraphs.length
    } catch { return false }
  }, [item.id, paragraphs.length])

  const stop = useCallback(() => {
    runIdRef.current++
    setActive(false)
    stopSpeech()
  }, [])

  // Leaving the article stops narration (shared singleton — don't keep reading offscreen).
  useEffect(() => () => { runIdRef.current++; stopSpeech() }, [item.id])

  const start = useCallback((fromParagraph?: number) => {
    if (!batches.length) return
    const from = fromParagraph ?? (() => {
      try {
        const saved = Number(localStorage.getItem(RESUME_KEY(item.id)))
        return Number.isFinite(saved) && saved > 0 && saved < paragraphs.length ? saved : 0
      } catch { return 0 }
    })()

    stopSpeech()
    const runId = ++runIdRef.current
    setActive(true)
    const startBatch = Math.max(0, batches.findIndex((b, i) => {
      const next = batches[i + 1]
      return from >= b.startParagraph && (!next || from < next.startParagraph)
    }))
    setParagraph(batches[startBatch]?.startParagraph ?? 0)

    void (async () => {
      for (let i = startBatch; i < batches.length; i++) {
        if (runIdRef.current !== runId) return
        const batch = batches[i]!
        setParagraph(batch.startParagraph)
        try { localStorage.setItem(RESUME_KEY(item.id), String(batch.startParagraph)) } catch { /* private mode */ }
        try {
          // Resolves when this batch's TTS stream has been fully consumed (audio is
          // still draining through the scheduler) — the built-in 2-fetch pipeline keeps
          // the next batch synthesizing while this one plays.
          await enqueueSpeech({ text: batch.text })
        } catch {
          if (runIdRef.current !== runId) return
          // TTS hiccup — stop cleanly rather than skipping content silently.
          setActive(false)
          stopSpeech()
          return
        }
      }
      if (runIdRef.current !== runId) return
      // All batches fed; clear the resume point once playback actually drains.
      const off = getVoicePlayback().onPlaybackEnd(() => {
        off()
        if (runIdRef.current !== runId) return
        try { localStorage.removeItem(RESUME_KEY(item.id)) } catch { /* ignore */ }
        setActive(false)
        setParagraph(0)
      })
    })()
  }, [batches, paragraphs.length, item.id])

  const status: ArticleNarration['status'] = !active ? 'idle' : paused ? 'paused' : 'playing'
  // `active` covers the fetch-lead-in before audio starts; once playing flips false
  // after the last batch, onPlaybackEnd above resets `active`.
  void playing

  return {
    status,
    available: batches.length > 0,
    progress: { paragraph: Math.min(paragraph + 1, paragraphs.length), total: paragraphs.length },
    hasResumePoint,
    start,
    pause: () => { void pauseSpeech() },
    resume: () => { void resumeSpeech() },
    stop,
  }
}
