import { useEffect, useState } from 'react'

// Companion open-size + mode. UI-ephemeral, so kept in localStorage (snappy, no
// round-trip) with a module pub/sub so the desktop overlay and mobile tab-bar
// variant stay in sync. Active character selection is DB-backed separately.

export type CompanionSize = 'pill' | 'collapsed' | 'expanded'
export type CompanionMode = 'mini' | 'docked'
export type CaptionStyle = 'plain' | 'bold' | 'enlarge' | 'underline' | 'accent' | 'highlight'

export const CAPTION_STYLES: CaptionStyle[] = ['highlight', 'bold', 'enlarge', 'underline', 'accent', 'plain']

const SIZE_KEY = 'companion.size'
const MODE_KEY = 'companion.mode'
const CAPTIONS_KEY = 'companion.captions'
const CAPTION_STYLE_KEY = 'companion.captionStyle'
const VOICE_KEY = 'companion.voiceOn'
const HANDSFREE_KEY = 'companion.handsFreeOn'

function read<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T | null) ?? fallback } catch { return fallback }
}

let size: CompanionSize = read<CompanionSize>(SIZE_KEY, 'collapsed')
let mode: CompanionMode = read<CompanionMode>(MODE_KEY, 'mini')
let captions: boolean = read(CAPTIONS_KEY, 'on') === 'on'
let captionStyle: CaptionStyle = read<CaptionStyle>(CAPTION_STYLE_KEY, 'highlight')
// Voice (TTS read-aloud) and hands-free (wakeword/mic) both default OFF — voice
// features must be explicitly enabled (mic permission, audio autoplay).
let voiceOn: boolean = read(VOICE_KEY, 'off') === 'on'
let handsFreeOn: boolean = read(HANDSFREE_KEY, 'off') === 'on'
const subs = new Set<() => void>()
const notify = () => subs.forEach((fn) => fn())

export function setCompanionSize(next: CompanionSize) {
  size = next
  try { localStorage.setItem(SIZE_KEY, next) } catch { /* ignore */ }
  notify()
}
export function setCompanionMode(next: CompanionMode) {
  mode = next
  try { localStorage.setItem(MODE_KEY, next) } catch { /* ignore */ }
  notify()
}
export function setCompanionCaptions(next: boolean) {
  captions = next
  try { localStorage.setItem(CAPTIONS_KEY, next ? 'on' : 'off') } catch { /* ignore */ }
  notify()
}
export function setCompanionCaptionStyle(next: CaptionStyle) {
  captionStyle = next
  try { localStorage.setItem(CAPTION_STYLE_KEY, next) } catch { /* ignore */ }
  notify()
}
export function cycleCaptionStyle() {
  const i = CAPTION_STYLES.indexOf(captionStyle)
  setCompanionCaptionStyle(CAPTION_STYLES[(i + 1) % CAPTION_STYLES.length]!)
}
export function setCompanionVoice(next: boolean) {
  voiceOn = next
  try { localStorage.setItem(VOICE_KEY, next ? 'on' : 'off') } catch { /* ignore */ }
  notify()
}
export function setCompanionHandsFree(next: boolean) {
  handsFreeOn = next
  try { localStorage.setItem(HANDSFREE_KEY, next ? 'on' : 'off') } catch { /* ignore */ }
  notify()
}

const MODE_ORDER: CompanionSize[] = ['pill', 'collapsed', 'expanded']
export function cycleCompanionSize() {
  const i = MODE_ORDER.indexOf(size)
  setCompanionSize(MODE_ORDER[(i + 1) % MODE_ORDER.length]!)
}

export function useCompanionState() {
  const [, force] = useState(0)
  useEffect(() => {
    const sub = () => force((n) => n + 1)
    subs.add(sub)
    return () => { subs.delete(sub) }
  }, [])
  return { size, mode, captions, captionStyle, voiceOn, handsFreeOn, setSize: setCompanionSize, setMode: setCompanionMode, setCaptions: setCompanionCaptions, setCaptionStyle: setCompanionCaptionStyle, cycleCaptionStyle, cycleSize: cycleCompanionSize, setVoice: setCompanionVoice, setHandsFree: setCompanionHandsFree }
}
