// Singleton voice playback + React hooks. Module pub/sub (companionState.ts
// pattern) so any component can read playback state and the live viseme/caption
// stream without prop-drilling.

import { useEffect, useRef, useState } from "react";
import { VoicePlayback, type VoicePlaybackOptions } from "@/lib/voice/voice-playback";
import { getCharacterBridge, type SentenceFrame } from "@/lib/voice/tts-character-bridge";
import type { Viseme } from "@/components/companion/visemeMap";
import { stripEmotes } from "@/lib/emoteParser";

let playback: VoicePlayback | null = null
export function getVoicePlayback(): VoicePlayback {
  if (!playback) playback = new VoicePlayback()
  return playback
}

let playing = false
const subs = new Set<() => void>()
const notify = () => subs.forEach((fn) => fn())

// Wire the singleton's state to the store once.
function ensureWired() {
  const pb = getVoicePlayback()
  pb.onStateChange((p) => {
    if (playing === p) return
    playing = p
    notify()
  })
}

/** Speak text now, replacing any current utterance. */
export async function speak(opts: VoicePlaybackOptions): Promise<void> {
  ensureWired()
  await getVoicePlayback().play(opts)
}

/** Append a sentence to the current utterance without interrupting. */
export async function enqueueSpeech(opts: VoicePlaybackOptions): Promise<void> {
  ensureWired()
  await getVoicePlayback().enqueueText(opts)
}

export function stopSpeech(): void {
  getVoicePlayback().stop()
}

export function useVoicePlaying(): boolean {
  const [, force] = useState(0)
  useEffect(() => {
    ensureWired()
    const sub = () => force((n) => n + 1)
    subs.add(sub)
    return () => {
      subs.delete(sub)
    }
  }, [])
  return playing
}

/** Live mouth viseme from the audio bridge (closed when idle). */
export function useCharacterViseme(active: boolean): Viseme {
  const [viseme, setViseme] = useState<Viseme>("closed")
  useEffect(() => {
    if (!active) {
      setViseme("closed")
      return
    }
    const bridge = getCharacterBridge()
    const off = bridge.onViseme(setViseme)
    const offCancel = bridge.onCancel(() => setViseme("closed"))
    return () => {
      off()
      offCancel()
    }
  }, [active])
  return viseme
}

// Each caption stays visible for at least this long before being replaced.
const MIN_CAPTION_MS = 1800

/** Live caption text from audio-aligned sentence frames (lingers until cleared). */
export function useCharacterCaption(active: boolean): string {
  const [text, setText] = useState("")
  useEffect(() => {
    if (!active) {
      setText("")
      return
    }
    const bridge = getCharacterBridge()
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    let lastSetAt = 0

    const showText = (next: string) => {
      const now = performance.now()
      const elapsed = now - lastSetAt
      if (pendingTimer) clearTimeout(pendingTimer)
      if (elapsed >= MIN_CAPTION_MS || lastSetAt === 0) {
        lastSetAt = now
        setText(next)
      } else {
        // Hold the current caption and show the latest pending after the minimum elapses.
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          lastSetAt = performance.now()
          setText(next)
        }, MIN_CAPTION_MS - elapsed)
      }
    }

    const off = bridge.onSentenceFrame((f: SentenceFrame) => {
      if (!("end" in f) || f.end !== true) {
        const t = stripEmotes((f as { text: string }).text)
        if (t) showText(t)
      }
    })
    const offCancel = bridge.onCancel(() => {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
      setText("")
    })
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer)
      off()
      offCancel()
    }
  }, [active])
  return text
}

// Sentence-boundary detector — same pattern as useCompanionVoice.
// Require uppercase or digit after the space so abbreviations (e.g., i.e., R.E.M.)
// don't false-fire as sentence boundaries.
const SENTENCE_RE = /[.!?]+(?=\s+[A-Z0-9]|\s*$)|\n{2,}/g

/** Strip markdown syntax from caption text so it reads as plain speech. */
function stripMarkdown(text: string): string {
  let s = text
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`([^`\n]+)`/g, '$1')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/(?<!\w)\*[^*\n]+\*(?!\w)/g, ' ')
  s = s.replace(/(?<!\w)_[^_\n]+_(?!\w)/g, ' ')
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')
  s = s.replace(/(?<!\w)[*_~]+(?!\w)/g, '')
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s.trim()
}

/**
 * For the TTS-off (text-only) companion path: reveals the streaming reply one
 * completed sentence at a time, each held for at least MIN_CAPTION_MS before
 * advancing. Returns the sentence currently on screen and a `draining` flag
 * that stays true while the queue is being worked through (so the overlay can
 * extend its talkActive signal past the end of streaming).
 */
export function useStreamingSentenceCaption(
  text: string,
  streaming: boolean,
): { caption: string; draining: boolean } {
  const [caption, setCaption] = useState('')
  const [draining, setDraining] = useState(false)

  const r = useRef({
    queue: [] as string[],
    consumed: 0,
    lastSetAt: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    prevStreaming: false,
  })

  useEffect(() => {
    const st = r.current

    const advance = () => {
      st.timer = null
      const next = st.queue.shift()
      if (!next) { setDraining(false); return }
      st.lastSetAt = performance.now()
      setCaption(next)
      schedule()
    }

    const schedule = () => {
      if (st.timer) return
      const elapsed = st.lastSetAt === 0 ? MIN_CAPTION_MS : performance.now() - st.lastSetAt
      st.timer = setTimeout(advance, Math.max(0, MIN_CAPTION_MS - elapsed))
    }

    // New stream started — reset everything.
    if (streaming && !st.prevStreaming) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null }
      st.queue = []
      st.consumed = 0
      st.lastSetAt = 0
      setCaption('')
      setDraining(false)
    }
    st.prevStreaming = streaming

    // Extract newly-completed sentences.
    const pending = text.slice(st.consumed)
    let lastEnd = 0
    SENTENCE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SENTENCE_RE.exec(pending)) !== null) {
      const end = m.index + m[0].length
      // Strip <action>…</action> emote tags — they drive the mood overlay, not
      // the visible caption (a tag-only sentence collapses to empty and is skipped).
      const s = stripMarkdown(stripEmotes(pending.slice(lastEnd, end)))
      if (s) st.queue.push(s)
      lastEnd = end
    }
    st.consumed += lastEnd

    // Flush trailing fragment when generation ends.
    if (!streaming) {
      const rest = stripMarkdown(stripEmotes(text.slice(st.consumed)))
      if (rest) st.queue.push(rest)
      st.consumed = text.length
    }

    if (st.queue.length) { setDraining(true); schedule() }
  }, [text, streaming])

  useEffect(() => () => {
    if (r.current.timer) clearTimeout(r.current.timer)
  }, [])

  return { caption, draining }
}
