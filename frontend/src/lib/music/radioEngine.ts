// AI Radio playback engine - runs the whole station experience from a global context so it
// survives navigation.
//
//   deck0 / deck1  — ping-pong song players (full songs, streamed audio-only)
//   dj             — Kokoro TTS voice
//
// Both decks and the voice are plain <audio> elements MIXED by animating `.volume` — keep mixing
// off Web Audio; `.volume` is bulletproof. They ARE routed through a read-only Web-Audio analyser
// tap for the EQ visualizer (source → destination + source → analyser); that's safe because the
// decks play same-origin proxied bytes (/api/youtube/stream), not the cross-origin/redirected
// googlevideo URLs that used to render SILENT through createMediaElementSource. See the analyser
// section below.
//
// There is no separate instrumental "bed" — a SONG is always the backing track under the DJ:
//  • The first song starts immediately at a low bed level; the DJ talks over it; then it swells to
//    full. (No DJ-first dead air, no cold-start bed to resolve.)
//  • At each transition the incoming song comes in at bed level under the DJ while the outgoing one
//    fades out, the DJ talks over it, then the incoming song swells to full — always music under
//    the voice. The next song is pre-buffered on the idle deck so the hand-off is instant.

import { search as ytSearch, prewarmStream } from '@/lib/youtube/api'
import { fetchDjSegment, fetchRadioQueue, fetchStationQueue, base64WavToBlob } from '@/lib/music/radio'
import { getOfflineQueue, offlineAudioUrl, prefetchReady, resolveSong, type OfflineQueue } from '@/lib/music/catalogApi'
import { isYouTubeRef, streamSrcForRef, artUrlForRef, trackSource } from '@/lib/music/trackRef'
import { localCompatOverride, resolveLocalCompat } from '@/lib/music/localCompat'
import { ensureMediaGraph, getSharedAnalyser, setLoudnessTrimDb } from '@/lib/mediaAudioGraph'
import { applyStoredDsp } from '@/lib/music/dsp'
import { getAudioFacts, getWaveform } from '@/lib/music/metaApi'
import { getTempo } from '@/lib/music/intelApi'
import type { DjStation } from '@/lib/music/radioStations'

export interface QueuedTrack {
  /** Track ref: bare YouTube id, `local:<id>`, or `plex:<machineId>:<ratingKey>`. Kept named
   *  `videoId` so every queue/history/favorite surface keeps working unchanged. */
  videoId: string
  title: string
  author: string | null
  thumbnail: string
}

/** Thumbnail for any ref (yt → proxied ytimg; local/plex → library art routes). */
const thumbForRef = (ref: string): string => artUrlForRef(ref) ?? ''

// Lightweight junk filter for the legacy preset-station path (raw YouTube results that don't pass
// through the backend station engine). Mirrors backend/src/lib/music/junk.ts — drops sound-effect
// uploads, "type beat" instrumentals, karaoke/tribute re-records, hour-long compilations, and
// generic compilation "artists" whose name is only a vibe ("Lofi Hip-Hop Beats", "Chill Out").
const JUNK_PHRASE = /\b(type ?beat|sound ?effects?|sfx|backing track|karaoke|made famous by|in the style of|originally performed|tribute to|greatest hits band|theme players|theme song library|song library|music band|cover band|lullaby version|rockabye|white noise|brown noise|nature sounds?|rain sounds?|sleep sounds?|asmr|full album|mega ?mix|continuous mix|non[- ]?stop mix|dj mix|chart hits|best selling|top \d{2,}|\d+\s*hours?\b|ringtone|no copyright|copyright[- ]free|royalty[- ]free|\bncs\b|\bbgm\b|\bplaylist\b)\b/i
const GENERIC_TOKENS = new Set(('lofi lo fi beats beat chill chillhop chillout hits hit jazz jazzy music musica sounds sound playlist mix mixes study studying relax relaxing vibes vibe hop hiphop instrumental instrumentals bgm lounge ambient cafe coffee radio top best classic classics smooth deep focus sleep piano soft nation world party downtempo meditation yoga calm peaceful zen muzak background nightcore mood moods bossa nova soul funk groove grooves today todays sad the of and to for a an your my').split(' '))
const isGenericName = (s: string): boolean => {
  const toks = (s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return toks.length >= 2 && toks.every(x => GENERIC_TOKENS.has(x) || /^\d+$/.test(x) || x.length === 1)
}
function isJunkTrack(title: string, artist: string | null): boolean {
  const t = title ?? ''
  if (!t.trim()) return true
  if (JUNK_PHRASE.test(`${t} ${artist ?? ''}`)) return true
  if (isGenericName(artist ?? '')) return true
  if (isGenericName(t)) return true
  return false
}

export type RadioPhase = 'idle' | 'loading' | 'intro' | 'playing' | 'transition' | 'outro'

/** Shuffle: 'off' plays the queue in order; 'random' picks the next song at random each
 *  hand-off; 'bag' walks everything in random order with no repeats until the whole queue
 *  has played (the bag persists per station, so it holds across sessions too). */
export type ShuffleMode = 'off' | 'random' | 'bag'

export interface RadioState {
  active: boolean
  station: DjStation | null
  queue: QueuedTrack[]
  index: number
  currentTrack: QueuedTrack | null
  nextTrack: QueuedTrack | null
  djText: string | null
  djSpeaking: boolean
  phase: RadioPhase
  paused: boolean
  volume: number
  muted: boolean
  loading: boolean
  queueLoading: boolean  // the rest of the queue is still building in the background (Up Next is partial)
  skipping: boolean     // a manual skip was requested and the next song hasn't taken over yet
  positionSec: number   // playback position of the current song (drives synced lyrics)
  durationSec: number   // current song length, when known
  sleepAtMs: number | null  // epoch ms at which the sleep timer stops playback (null = off)
  repeatOne: boolean        // replay the current track instead of advancing
}

export const initialRadioState: RadioState = {
  active: false, station: null, queue: [], index: 0,
  currentTrack: null, nextTrack: null, djText: null, djSpeaking: false,
  phase: 'idle', paused: false, volume: 1, muted: false, loading: false,
  queueLoading: false, skipping: false, positionSec: 0, durationSec: 0, sleepAtMs: null,
  repeatOne: typeof localStorage !== 'undefined' && localStorage.getItem('music.repeatOne') === '1',
}

interface PreparedDj { text: string | null; blobUrl: string | null }

// Levels (relative, 0..1) / timings.
const DEFAULT_FADE = 1300  // default crossfade ramp length (ms)
const INTRO_BED = 0.22  // level a song plays at while it's the backing bed (DJ talks over it)
// First real lyric this close to the start means the DJ speaks FIRST, then the song begins clean.
const IMMEDIATE_LYRICS_THRESHOLD = 4   // seconds

// ── Lyric-timing helpers ─────────────────────────────────────────────────────
interface LyricLine { sec: number; text: string }

// Single-syllable filler lines that don't count as "real" vocals (yeah, ooh, la la, etc.)
const FILLER_RE = /^[^a-z]*(?:yeah+|ooh+|ah+|uh+|oh+|mm+|hm+|hey|la+|na+|ba+|woo+|whoa+)[^a-z]*$/i
function isFillerLine(text: string): boolean {
  const t = text.trim()
  if (!t || t.length < 3) return true
  if (FILLER_RE.test(t)) return true
  // "na na na", "la la la" — all words ≤ 3 chars
  const words = t.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/)
  return words.length > 0 && words.every(w => w.length <= 3)
}

/** Return the timestamp (sec) of the first non-filler lyric for a track, or null if unavailable. */
async function fetchFirstRealLyricSec(track: QueuedTrack): Promise<number | null> {
  if (!track.title) return null
  try {
    const q = new URLSearchParams()
    if (track.author) q.set('artist', track.author)
    q.set('title', track.title)
    const res = await fetch(`/api/music/info/lyrics?${q}`, { credentials: 'include' })
    if (!res.ok) return null
    const { synced } = await res.json() as { synced?: LyricLine[] | null }
    if (!synced?.length) return null
    return synced.find(l => !isFillerLine(l.text))?.sec ?? null
  } catch { return null }
}

// Strip the promo noise YouTube titles are littered with — "(Official Video)", "[OFFICIAL
// VIDEO] [HD]", "| Official Music Video", "(Lyrics)", "(Remastered 2011)", "(4K)", etc. — for
// clean Now-Playing/Up-Next labels and DJ patter. Conservative: only removes BRACKETED groups
// that contain a noise keyword (so "(I Can't Get No)" / "(Live at Wembley)" survive), plus a
// trailing un-bracketed "...- Official [Music] Video" tail (the "official" anchor keeps real
// titles like "Video Games" safe).
const TITLE_NOISE =
  'officia?l|video\\s*oficial|clip\\s*officiel|music\\s*video|lyrics?|lyric\\s*video|visuali[sz]er|audio|hd|hq|uhd|4k|8k|1080p|720p|480p|m\\/?v|remaster(?:ed)?(?:\\s*\\d{4})?|re-?master|explicit|with\\s*lyrics|colou?r\\s*coded|full\\s*(?:song|video|album)|promo|premiere|dolby|atmos|visualiser|hd\\s*upgrade|hq\\s*audio'
function cleanTitle(t: string): string {
  return (t ?? '')
    // bracketed/parenthesized noise groups (any of () [] {})
    .replace(new RegExp(`[([{][^()[\\]{}]*\\b(?:${TITLE_NOISE})\\b[^()[\\]{}]*[)\\]}]`, 'gi'), '')
    // trailing un-bracketed "… - Official Music Video" / "… | Official Audio"
    .replace(/\s*[-–—|·:]\s*officia?l\b[^-–—|·:()[\]]*$/gi, '')
    // trailing bare "… Official Video/Audio" with no separator
    .replace(/\s+officia?l\s+(?:music\s+)?(?:video|audio|lyric\s*video|visuali[sz]er)\s*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—|·]\s*$/, '')
    .trim()
}

// A short silent WAV used to "unlock" media elements inside the user gesture (see unlock()).
function makeSilentWavUrl(): string {
  const rate = 8000, n = Math.floor(rate * 0.15)
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  wr(0, 'RIFF'); v.setUint32(4, 36 + n, true); wr(8, 'WAVE'); wr(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true)
  wr(36, 'data'); v.setUint32(40, n, true)
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128) // 8-bit PCM silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

type ChKey = 'd0' | 'd1' | 'dj'
interface Channel { el: HTMLAudioElement; level: number; ramp?: ReturnType<typeof setInterval> }

export class RadioEngine {
  private ch!: Record<ChKey, Channel>
  private built = false
  private masterVol = 1
  private muted = false
  private silentUrl: string | null = null
  private unlocked = false

  private deck = 0          // index (0/1) of the deck holding the "current" song
  private runId = 0         // bumped on stop/skip-of-session to invalidate stale async loops

  // Offline mode (read from localStorage 'music.mode' at start/playTrack time, like djMode). When
  // on, decks play downloaded files and the DJ comes from the pre-rendered cache — zero network.
  private offline = false
  private offlineDj: OfflineQueue['dj'] | null = null
  private isOfflineMode() { return typeof localStorage !== 'undefined' && localStorage.getItem('music.mode') === 'offline' }
  private skipResolve: (() => void) | null = null
  private resumeEls: HTMLMediaElement[] = []

  // Real-audio analysis + DSP. Each deck is routed through the app-wide media graph
  // (lib/mediaAudioGraph) once - source → loudness trim → EQ → crossfeed → gain →
  // destination, with per-element and shared (mix bus) analysers - and that graph lives
  // for the engine's lifetime (createMediaElementSource may only be called once per
  // element, even across contexts, so it's never torn down). The element's own .volume
  // crossfade still applies to the node, so mixing is unaffected and the DSP chain is
  // never load-bearing. Same-origin proxied bytes (/api/youtube/stream) keep the nodes
  // un-tainted. Graphs are built inside the start()/playTrack() click gesture, eagerly
  // (before any deck plays), so both the station and play-a-song paths light up.
  private dspWired = false

  private state: RadioState = { ...initialRadioState }

  constructor(private emit: (s: RadioState) => void) {}

  private set(patch: Partial<RadioState>) {
    this.state = { ...this.state, ...patch }
    this.emit(this.state)
  }

  private stale(runId: number) { return runId !== this.runId }

  // "Unlock" every element by playing a brief silent clip on each INSIDE the user gesture, so
  // later programmatic play() calls (a deck/voice after their async resolves) aren't blocked by
  // the autoplay policy — the symptom being "loaded but didn't play". Must run synchronously from
  // the click (start() does, before its first await). The silent clip ends on its own (~0.15s), so
  // it never fights the real src set moments later.
  private unlock() {
    if (this.unlocked || !this.built) return
    this.unlocked = true
    if (!this.silentUrl) this.silentUrl = makeSilentWavUrl()
    for (const k of Object.keys(this.ch) as ChKey[]) {
      const el = this.ch[k].el
      try { el.src = this.silentUrl; el.volume = 0; el.play()?.catch(() => {}) } catch { /* noop */ }
    }
  }

  // ── Audio elements + volume mixing ───────────────────────────────────────────
  private ensureAudio() {
    if (this.built) return
    this.built = true
    const mk = (level: number): Channel => {
      const el = new Audio(); el.preload = 'auto'
      return { el, level }
    }
    this.ch = { d0: mk(0), d1: mk(0), dj: mk(1) }
    ;(Object.keys(this.ch) as ChKey[]).forEach(k => this.applyVol(k))
    // Broadcast playback position from whichever deck is currently "the song", throttled to
    // ~1/sec so synced lyrics can track without flooding re-renders.
    ;(['d0', 'd1'] as ChKey[]).forEach((k, i) => {
      this.ch[k].el.ontimeupdate = () => {
        if (this.deck !== i) return
        const el = this.ch[k].el
        const sec = Math.floor(el.currentTime)
        if (sec === this.lastPosSec) return
        this.lastPosSec = sec
        this.set({ positionSec: el.currentTime, durationSec: Number.isFinite(el.duration) ? el.duration : 0 })
      }
    })
  }
  private lastPosSec = -1

  /** Route every deck through the app-wide DSP graph. Call from a user gesture (start /
   *  playTrack) so the shared AudioContext isn't born suspended. Idempotent. */
  private ensureAnalyser() {
    if (this.dspWired || !this.built) return
    try {
      // Wire every deck now, before anything plays - so the immediate-song path (playTrack)
      // is graphed just like the DJ-intro-first path (start). Sources persist for the lifetime.
      ensureMediaGraph(this.ch.d0.el, { kind: 'music' })
      ensureMediaGraph(this.ch.d1.el, { kind: 'music' })
      ensureMediaGraph(this.ch.dj.el, { kind: 'voice' })   // DJ speech: no loudness trim
      applyStoredDsp()                                      // stored EQ/crossfeed/loudness kick in
      this.dspWired = true
    } catch { /* Web Audio unavailable - playback works, just un-EQ'd */ }
  }

  /** The mix-bus AnalyserNode for real-time frequency data, or null when unavailable. */
  getAnalyser(): AnalyserNode | null { return getSharedAnalyser() }

  private deckKey(i: number): ChKey { return i === 0 ? 'd0' : 'd1' }
  private deckEl(i: number) { return this.ch[this.deckKey(i)].el }

  private applyVol(key: ChKey) {
    const c = this.ch[key]
    c.el.muted = this.muted
    c.el.volume = Math.max(0, Math.min(1, c.level * this.masterVol * this.duckFactor))
  }
  private applyAll() { (Object.keys(this.ch) as ChKey[]).forEach(k => this.applyVol(k)) }

  // ── Announcement ducking ───────────────────────────────────────────────────
  // A multiplier UNDER the user's volume (so setVolume/the family cap keep their
  // meaning and the UI slider never moves): companion speech drops it to 0.2, then
  // it ramps back to 1 over ~500ms. Deliberately separate from the crossfade ramps,
  // which own per-channel `level`. See lib/speechDucking.ts.
  private duckFactor = 1
  private duckRamp: ReturnType<typeof setInterval> | null = null

  private rampDuck(to: number, ms: number) {
    if (this.duckRamp) { clearInterval(this.duckRamp); this.duckRamp = null }
    if (!this.built || ms <= 0) { this.duckFactor = to; if (this.built) this.applyAll(); return }
    const from = this.duckFactor
    const steps = Math.max(1, Math.round(ms / 50))
    let i = 0
    this.duckRamp = setInterval(() => {
      i++
      this.duckFactor = from + (to - from) * Math.min(1, i / steps)
      this.applyAll()
      if (i >= steps) { clearInterval(this.duckRamp!); this.duckRamp = null }
    }, 50)
  }

  /** Duck to ~20 percent for a companion announcement. */
  duckForSpeech() { this.rampDuck(0.2, 150) }
  /** Restore over ~half a second once the announcement ends. */
  unduckAfterSpeech() { this.rampDuck(1, 500) }

  private ramp(key: ChKey, to: number, ms: number) {
    const c = this.ch[key]
    if (c.ramp) { clearInterval(c.ramp); c.ramp = undefined }
    if (ms <= 0) { c.level = to; this.applyVol(key); return }
    const from = c.level
    const steps = Math.max(1, Math.round(ms / 50))
    let i = 0
    c.ramp = setInterval(() => {
      i++
      c.level = from + (to - from) * Math.min(1, i / steps)
      this.applyVol(key)
      if (i >= steps) { clearInterval(c.ramp!); c.ramp = undefined }
    }, 50)
  }

  // ── Fetch helpers ────────────────────────────────────────────────────────────
  // opts.fast → resolve just enough to START PLAYING (the first track); opts.exclude drops ids
  // already playing so the background "rest of the queue" build doesn't repeat them.
  private async loadQueue(st: DjStation, opts?: { fast?: boolean; exclude?: string[] }): Promise<QueuedTrack[]> {
    const fast = opts?.fast ?? false
    const excludeIds = new Set(opts?.exclude ?? [])
    let raw: Array<{ videoId: string; title: string; author: string | null }> = []
    let shuffle = false

    // Offline: serve the frozen, pre-downloaded tracklist + pre-rendered DJ from local storage —
    // no network. Only saved stations (with a stationId) can play offline.
    if (this.offline && st.stationId) {
      this.offlineDj = null
      try {
        const res = await getOfflineQueue(st.stationId)
        this.offlineDj = res.dj
        return res.tracks.map(t => ({
          videoId: t.videoId, title: t.title, author: t.author || null,
          thumbnail: thumbForRef(t.videoId),
        }))
      } catch { return [] }
    }

    // AI station → station engine (saved id, prompt, artist/song seed, or a personal
    // history-driven station). The engine already orders the queue, so we don't shuffle.
    const isAi = !!(st.stationId || st.aiPrompt || st.seedValue || st.personal || st.adventure)
    if (isAi) {
      try {
        const res = await fetchStationQueue({
          stationId: st.stationId, aiPrompt: st.aiPrompt, seedType: st.seedType,
          seedValue: st.seedValue, personal: st.personal, adventure: st.adventure,
          name: st.label, count: fast ? 3 : 12,
          fast, excludeVideoIds: opts?.exclude,
        })
        raw = res.tracks
        shuffle = false
      } catch { /* fall through to empty */ }
    } else {
      // Legacy preset station → YouTube Music radio mix off a random search query.
      const q = st.ytQueries?.[Math.floor(Math.random() * st.ytQueries.length)] ?? st.genre ?? st.label
      try {
        const res = await fetchRadioQueue(q)
        raw = res.tracks
        shuffle = res.source !== 'ytmusic'
      } catch { /* fall through */ }

      if (!raw.length) {
        try {
          const data = await ytSearch(q, null, 'videos')
          raw = (data.results ?? []).map(v => ({ videoId: v.videoId, title: v.title, author: v.author ?? null }))
          shuffle = true
        } catch { raw = [] }
      }
    }

    // Dedupe by videoId AND by song identity (normalized title+author), so the same recording
    // uploaded under different videoIds can't appear twice in one station.
    const seen = new Set<string>()
    const seenSongs = new Set<string>()
    const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const tracks: QueuedTrack[] = []
    for (const v of raw) {
      if (!v.videoId || seen.has(v.videoId) || excludeIds.has(v.videoId)) continue
      // Junk heuristics target raw YouTube search noise - owned-library refs are trusted.
      if (isYouTubeRef(v.videoId) && isJunkTrack(v.title, v.author ?? null)) continue
      const title = cleanTitle(v.title) || v.title
      const t = normKey(title)
      const songKey = t ? (v.author ? `${normKey(v.author)}~${t}` : t) : ''
      if (songKey && seenSongs.has(songKey)) continue
      seen.add(v.videoId)
      if (songKey) seenSongs.add(songKey)
      tracks.push({
        videoId: v.videoId, title, author: v.author ?? null,
        thumbnail: thumbForRef(v.videoId),
      })
    }
    if (shuffle) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!]
      }
    }
    return tracks.slice(0, fast ? 3 : 30)
  }

  private async prepareDj(args: {
    station: DjStation; track: QueuedTrack | null; next?: QueuedTrack | null
    position: 'intro' | 'transition' | 'outro'; sayStation?: boolean
  }): Promise<PreparedDj> {
    // Honour the effective DJ mode (persisted override > station default): silent never speaks;
    // minimal speaks on every segment but only to announce the song (no banter/asides).
    const djMode = this.effectiveDjMode()
    if (djMode === 'silent') return { text: null, blobUrl: null }
    const minimal = djMode === 'minimal'

    // Offline: pull the matching pre-rendered segment instead of generating one live.
    if (this.offline) {
      if (!this.offlineDj) return { text: null, blobUrl: null }
      const pre = args.position === 'intro' ? this.offlineDj.intro
        : args.position === 'outro' ? this.offlineDj.outro
          : (args.track ? this.offlineDj.transitions[args.track.videoId] ?? null : null)
      if (!pre) return { text: null, blobUrl: null }
      try {
        const resp = await fetch(pre.audioUrl, { credentials: 'include' })
        if (!resp.ok) return { text: pre.text, blobUrl: null }
        return { text: pre.text, blobUrl: URL.createObjectURL(await resp.blob()) }
      } catch { return { text: pre.text, blobUrl: null } }
    }

    const seg = await fetchDjSegment({
      genre: args.station.genre,
      stationName: args.station.label,
      // Name the station only on the intro; in minimal mode keep transitions song-only.
      sayStation: minimal ? args.position === 'intro' : (args.sayStation ?? args.position === 'intro'),
      trackName: args.track?.title,
      artistName: args.track?.author ?? undefined,
      nextTrackName: args.next?.title,
      nextArtistName: args.next?.author ?? undefined,
      position: args.position,
      style: minimal ? 'minimal' : 'full',
    })
    if (!seg) return { text: null, blobUrl: null }
    let blobUrl: string | null = null
    if (seg.audio) blobUrl = URL.createObjectURL(base64WavToBlob(seg.audio, seg.audioMime))
    return { text: seg.text, blobUrl }
  }

  // ── Low-level deck control ───────────────────────────────────────────────────
  private cueSrc(deck: number, videoId: string, forceLocal = false) {
    const el = this.deckEl(deck)
    // Offline/downloaded playback only exists for YouTube refs - local files stream from
    // their own route regardless of mode (they ARE local), plex refs stream live.
    // Local refs with a known compat rendition (ALAC/opus/APE the browser can't decode,
    // transcoded server-side on a previous error) cue that rendition directly.
    el.src = (this.offline || forceLocal) && isYouTubeRef(videoId)
      ? offlineAudioUrl(videoId)
      : localCompatOverride(videoId) ?? streamSrcForRef(videoId)
    this.armLocalCompat(deck)
    this.deckRefs[deck] = videoId
    el.load()
    this.ramp(this.deckKey(deck), 0, 0)
    this.resetDeckRate(deck)
    this.applyLoudnessTrim(deck, videoId)
    this.analyzeOutro(deck, videoId)
    this.lookupTempo(deck, videoId)
  }

  // A deck erroring on a LOCAL file is usually a codec the browser can't decode:
  // kick off the on-demand transcode and, if the deck is still on that track when the
  // rendition lands, re-cue it in place. (waitTail may advance the station first on a
  // slow encode; the override is remembered, so the track plays fine from then on.)
  // addEventListener, not onerror: waitTail owns the onerror property.
  private compatArmed = [false, false]
  private armLocalCompat(deck: number) {
    if (this.compatArmed[deck]) return
    this.compatArmed[deck] = true
    const el = this.deckEl(deck)
    el.addEventListener('error', () => {
      const ref = this.deckRefs[deck]
      if (!ref || trackSource(ref) !== 'local') return
      void resolveLocalCompat(ref).then((url) => {
        if (!url || this.deckRefs[deck] !== ref) return
        const at = el.currentTime || 0
        el.src = url
        el.load()
        el.currentTime = at
        void el.play().catch(() => { /* paused deck stays paused */ })
      })
    })
  }

  // ── AutoMix: beat-matched transitions ────────────────────────────────────────────
  // Per-deck BPM from the analysis layer (music_track_features; local-file analysis only,
  // stream-only tracks simply have none). When both the outgoing and incoming BPM are
  // known and within 15 percent, the hand-off lands on a beat boundary of the outgoing
  // song and the incoming deck micro-adjusts playbackRate (max 4 percent) during the
  // overlap to align tempo, easing back to 1.0 after the blend.
  private deckBpm: (number | null)[] = [null, null]
  private rateRamps: (ReturnType<typeof setInterval> | null)[] = [null, null]

  private lookupTempo(deck: number, ref: string) {
    this.deckBpm[deck] = null
    void getTempo(ref).then(t => {
      if (this.deckRefs[deck] !== ref) return   // deck re-cued while we looked up
      this.deckBpm[deck] = t?.bpm && t.bpm > 0 ? t.bpm : null
    }).catch(() => { /* tempo is optional */ })
  }

  private resetDeckRate(deck: number) {
    const ramp = this.rateRamps[deck]
    if (ramp) { clearInterval(ramp); this.rateRamps[deck] = null }
    const el = this.deckEl(deck)
    try {
      el.playbackRate = 1
      if ('preservesPitch' in el) el.preservesPitch = true
    } catch { /* rate is cosmetic */ }
  }

  /** The incoming deck's tempo-match rate for this hand-off, or null when AutoMix doesn't
   *  apply (toggle off, unknown BPM on either side, or tempos too far apart). */
  private autoMixRate(fromDeck: number, toDeck: number): number | null {
    if (!this.autoMix) return null
    const out = this.deckBpm[fromDeck]
    const inc = this.deckBpm[toDeck]
    if (!out || !inc) return null
    // Fold half/double-time detections into the same octave before comparing.
    let ratio = out / inc
    if (ratio > 1.6) ratio /= 2
    else if (ratio < 0.625) ratio *= 2
    if (ratio < 0.85 || ratio > 1.15) return null
    const rate = Math.max(0.96, Math.min(1.04, ratio))
    return Math.abs(rate - 1) < 0.002 ? null : rate
  }

  /** Ease the deck's playbackRate back to 1.0 (after the overlap has blended). */
  private easeRateBack(deck: number, runId: number, delayMs: number) {
    const startRef = this.deckRefs[deck]
    setTimeout(() => {
      if (this.stale(runId) || this.deckRefs[deck] !== startRef) return
      const el = this.deckEl(deck)
      const from = el.playbackRate
      if (from === 1) return
      const steps = 20   // ~2s at 100ms per step
      let i = 0
      const prev = this.rateRamps[deck]
      if (prev) clearInterval(prev)
      this.rateRamps[deck] = setInterval(() => {
        i++
        if (this.stale(runId) || this.deckRefs[deck] !== startRef || i >= steps) {
          try { el.playbackRate = 1 } catch { /* noop */ }
          const ramp = this.rateRamps[deck]
          if (ramp) { clearInterval(ramp); this.rateRamps[deck] = null }
          return
        }
        try { el.playbackRate = from + (1 - from) * (i / steps) } catch { /* noop */ }
      }, 100)
    }, Math.max(0, delayMs))
  }

  // ── Sweet Fades (Plexamp): find where each track's outro actually begins ────────
  // From the server loudness envelope, locate the last sustained-energy point (fade-out
  // start) and the last audible point (end of trailing silence), as track fractions.
  // waitTail() then overlaps the next song at the fade-out instead of a fixed offset -
  // long quiet outros and trailing silence never leave the station hanging.
  private deckOutro: ({ lastLoudFrac: number; lastSoundFrac: number } | null)[] = [null, null]
  private analyzeOutro(deck: number, ref: string) {
    this.deckOutro[deck] = null   // reset instantly so the previous track's outro never leaks
    void getWaveform(ref).then(peaks => {
      if (this.deckRefs[deck] !== ref || !peaks?.length) return   // deck re-cued / unscanned
      let max = 0
      for (const v of peaks) if (v > max) max = v
      if (max < 16) return   // essentially silent scan - trust the fixed tail instead
      // 3-bucket smoothing so one stray sample doesn't count as "still loud".
      const smooth = (i: number) => Math.max(peaks[i - 1] ?? 0, peaks[i]!, peaks[i + 1] ?? 0)
      let lastLoud = -1, lastSound = -1
      for (let i = peaks.length - 1; i >= 0; i--) {
        const v = smooth(i)
        if (lastSound < 0 && v >= max * 0.05) lastSound = i
        if (v >= max * 0.18) { lastLoud = i; break }
      }
      if (lastLoud < 0 || this.deckRefs[deck] !== ref) return
      this.deckOutro[deck] = {
        lastLoudFrac: (lastLoud + 1) / peaks.length,
        lastSoundFrac: (Math.max(lastSound, lastLoud) + 1) / peaks.length,
      }
    }).catch(() => { /* the envelope is optional */ })
  }

  // Loudness normalization: aim the track at -14 LUFS using the server's scan, capped by
  // true-peak headroom (never boost into clipping) and clamped to a musical -12..+6 dB.
  // Fire-and-forget - a cue never waits on the lookup; unscanned tracks play at 0 dB (the
  // scan queues server-side on the 404, so coverage converges with listening).
  private applyLoudnessTrim(deck: number, ref: string) {
    const el = this.deckEl(deck)
    setLoudnessTrimDb(el, 0)   // reset instantly so the previous track's trim never leaks
    void getAudioFacts(ref).then(facts => {
      if (this.deckRefs[deck] !== ref) return          // deck was re-cued while we looked up
      if (!facts || facts.lufs == null) return
      let trim = Math.max(-12, Math.min(6, -14 - facts.lufs))
      if (facts.truePeakDb != null) trim = Math.min(trim, -1 - facts.truePeakDb)  // -1 dBTP headroom
      setLoudnessTrimDb(el, Math.max(-12, trim))
    }).catch(() => { /* facts are optional */ })
  }

  // The ref each deck was last cued with - lets the play-failure path identify a dead
  // local/plex ref (file deleted, server swapped) and self-heal to YouTube mid-session.
  private deckRefs: (string | null)[] = [null, null]
  private async playDeck(deck: number, attempt = 0): Promise<void> {
    const el = this.deckEl(deck)
    // Re-ensure inside this (gesture-adjacent) play: builds the graph if start() couldn't,
    // and nudges the shared context out of 'suspended'.
    try { ensureMediaGraph(el, { kind: 'music' }) } catch { /* optional */ }
    try { await el.play() }
    catch (e) {
      // A 502 from a transient resolve failure surfaces as a load/format error. Reload (which
      // re-requests the stream → re-resolves on the backend) and retry a couple of times.
      if (e instanceof DOMException && e.name === 'AbortError') return // intentional pause/skip
      if (attempt < 2 && el.error) {
        await new Promise(r => setTimeout(r, 1500))
        el.load()
        return this.playDeck(deck, attempt + 1)
      }
      // Dead owned-library ref (file deleted since scan, Plex server replaced): re-resolve the
      // song by title/artist to a YouTube stream and swap the queue entry so the session heals.
      const ref = this.deckRefs[deck]
      if (ref && !isYouTubeRef(ref) && attempt < 3) {
        const track = this.state.queue.find(t => t.videoId === ref)
          ?? (this.state.currentTrack?.videoId === ref ? this.state.currentTrack : null)
        if (track) {
          try {
            const resolved = await resolveSong({ title: track.title, artist: track.author ?? '' })
            if (resolved?.videoId) {
              track.videoId = resolved.videoId
              track.thumbnail = thumbForRef(resolved.videoId)
              this.cueSrc(deck, resolved.videoId)
              return this.playDeck(deck, attempt + 1)
            }
          } catch { /* fall through to the warn below */ }
        }
      }
      console.warn('[radio] deck play() rejected', deck, e)
    }
  }

  // Play a DJ blob over the song; resolves when the voice finishes (or on error/no-audio).
  private async speak(dj: PreparedDj): Promise<void> {
    // Hard gate: if the user has silenced the DJ, never play voice — even a segment that was
    // pre-generated for this transition before they toggled. Don't pause either; just continue.
    if (this.effectiveDjMode() === 'silent') { if (dj.blobUrl) URL.revokeObjectURL(dj.blobUrl); return }
    if (!dj.blobUrl) { await new Promise(r => setTimeout(r, 2400)); return }
    const el = this.ch.dj.el
    el.src = dj.blobUrl
    this.ramp('dj', 1, 0)
    await new Promise<void>(res => {
      const fin = () => { el.onended = null; el.onerror = null; res() }
      el.onended = fin; el.onerror = fin
      el.play().then(() => { try { ensureMediaGraph(el, { kind: 'voice' }) } catch { /* optional */ } }).catch(fin)
    })
    URL.revokeObjectURL(dj.blobUrl)
  }

  // Talk OVER the currently-playing song (used for the intro + outro): duck the song to bed level, speak,
  // then bring it back to full. No deck switch.
  private async talkOver(runId: number, deck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })
    this.ramp(this.deckKey(deck), INTRO_BED, 700)   // duck to bed level (audible backing)
    await this.speak(dj)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(deck), 1, this.fadeMs())
    this.set({ djSpeaking: false, djText: null })
  }

  // Wait until the current song reaches its final TAIL seconds, ends, errors, stalls, or is
  // skipped — anything that should advance the station (never hang silently in "playing").
  private waitTail(runId: number, deck: number): Promise<'tail' | 'end' | 'skip'> {
    return new Promise(resolve => {
      const el = this.deckEl(deck)
      let done = false, lastT = -1, stuck = 0
      const finish = (r: 'tail' | 'end' | 'skip') => {
        if (done) return
        done = true
        clearInterval(iv); el.onended = null; el.onerror = null; this.skipResolve = null
        resolve(r)
      }
      const iv = setInterval(() => {
        if (this.stale(runId)) return finish('skip')
        if (el.error) return finish('end')
        const d = el.duration
        if (isFinite(d) && d > 0 && el.currentTime >= d - this.handOffTailSec(deck, d)) return finish('tail')
        if (!el.paused) {
          if (el.currentTime === lastT) { if (++stuck > 48) return finish('end') } // ~12s stalled
          else { stuck = 0; lastT = el.currentTime }
        }
      }, 250)
      el.onended = () => finish('end')
      el.onerror = () => finish('end')
      this.skipResolve = () => finish('skip')
    })
  }

  // Transition: same shape as the intro. The INCOMING song comes in at bed level as the backing
  // track, the outgoing one fades out, the DJ talks over the bed, then the incoming song swells to
  // full. Guarantees there's always music under the DJ between songs.
  //
  // firstRealLyricSec: timestamp of the first non-filler lyric in the incoming track (or null).
  //   • null / >= IMMEDIATE_LYRICS_THRESHOLD → normal bed path; swell is timed to the lyric.
  //   • < IMMEDIATE_LYRICS_THRESHOLD → DJ-first: outgoing song fades under the DJ, then the
  //     incoming song starts clean from the top so the vocal enters at full volume.
  private async transition(runId: number, fromDeck: number, toDeck: number, dj: PreparedDj, display: Partial<RadioState>, quick = false, firstRealLyricSec: number | null = null) {
    this.set({ djText: dj.text })

    // AutoMix: when both songs' BPM are known and close, the incoming deck plays slightly
    // fast/slow (max 4 percent) during the overlap so the tempos align, then eases back
    // to 1.0 once the outgoing song is gone.
    const mixRate = this.autoMixRate(fromDeck, toDeck)
    if (mixRate !== null) {
      try { this.deckEl(toDeck).playbackRate = mixRate } catch { /* rate is cosmetic */ }
    }

    // QUICK path (manual skip): no DJ, no bed — a fast crossfade straight to the next song at full
    // volume, so a skip feels immediate.
    if (quick) {
      await this.playDeck(toDeck)
      if (this.stale(runId)) return
      this.deck = toDeck
      const el = this.deckEl(toDeck)
      this.lastPosSec = Math.floor(el.currentTime)
      this.ramp(this.deckKey(toDeck), 1, 450)
      this.ramp(this.deckKey(fromDeck), 0, 450)
      setTimeout(() => { if (!this.stale(runId)) { try { this.deckEl(fromDeck).pause() } catch { /* noop */ } } }, 500)
      if (mixRate !== null) this.easeRateBack(toDeck, runId, 700)
      this.set({ ...display, positionSec: el.currentTime, durationSec: Number.isFinite(el.duration) ? el.duration : 0, djSpeaking: false, skipping: false })
      return
    }

    // IMMEDIATE LYRICS path: the next track's vocals start within a few seconds of the beginning, so
    // there's no safe instrumental gap to talk over. Fade the outgoing song under the DJ, then start
    // the incoming track from position 0 at full volume once the DJ finishes — no bleed-in bed.
    if (firstRealLyricSec !== null && firstRealLyricSec <= IMMEDIATE_LYRICS_THRESHOLD) {
      // No overlap on this path (the incoming song starts clean after the DJ), so there's
      // nothing to beat-match - undo the AutoMix rate before the song starts.
      if (mixRate !== null) this.resetDeckRate(toDeck)
      // Fade the outgoing song while the DJ speaks; the incoming deck stays silent (pre-buffered).
      this.ramp(this.deckKey(fromDeck), 0, 1200)
      setTimeout(() => { if (!this.stale(runId)) { try { this.deckEl(fromDeck).pause() } catch { /* noop */ } } }, 1300)

      await new Promise(r => setTimeout(r, 400))   // give the fade a moment to start
      if (this.stale(runId)) return

      this.deck = toDeck
      this.set({ ...display, djSpeaking: true, skipping: false })
      await this.speak(dj)
      if (this.stale(runId)) return

      // Start the incoming track now — it was pre-buffered at 0 so play() is instant.
      await this.playDeck(toDeck)
      if (this.stale(runId)) return
      const el = this.deckEl(toDeck)
      this.lastPosSec = 0
      this.set({ positionSec: 0, durationSec: Number.isFinite(el.duration) ? el.duration : 0 })
      this.ramp(this.deckKey(toDeck), 1, 600)
      return
    }

    // NORMAL BED path: bring the incoming song in at bed level; fade the outgoing one out under it.
    await this.playDeck(toDeck)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(toDeck), INTRO_BED, 900)
    this.ramp(this.deckKey(fromDeck), 0, 1200)
    setTimeout(() => { if (!this.stale(runId)) { try { this.deckEl(fromDeck).pause() } catch { /* noop */ } } }, 1300)

    // Let the outgoing song fade out and the bed settle for a beat before the DJ comes in.
    await new Promise(r => setTimeout(r, 1300))
    if (this.stale(runId)) return

    // DJ is about to speak: flip EVERYTHING to the incoming song at this exact moment — active deck
    // (so positionSec/synced-lyrics track it), the displayed track, and djSpeaking. The page
    // hero/lyrics/info and the mini-player all change in sync with the DJ's voice — not early (when
    // the bed started) and not late (after the DJ finishes).
    this.deck = toDeck
    const el = this.deckEl(toDeck)
    this.lastPosSec = Math.floor(el.currentTime)
    this.set({ ...display, positionSec: el.currentTime, durationSec: Number.isFinite(el.duration) ? el.duration : 0, djSpeaking: true, skipping: false })

    // DJ talks over the bedding song.
    await this.speak(dj)
    if (this.stale(runId)) return

    // If we know when the first vocal line hits, hold the bed until just before it so the swell
    // lands right as the song kicks in vocally. Skip the wait if the DJ already ran past that point.
    if (firstRealLyricSec !== null) {
      const remaining = firstRealLyricSec - el.currentTime - this.fadeMs() / 1000
      if (remaining > 0.2) await new Promise(r => setTimeout(r, remaining * 1000))
      if (this.stale(runId)) return
    }
    this.ramp(this.deckKey(toDeck), 1, this.fadeMs())
    // The overlap has blended - ease the tempo nudge back to natural speed.
    if (mixRate !== null) this.easeRateBack(toDeck, runId, this.fadeMs() + 200)
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  async start(station: DjStation, { silentIntro = false }: { silentIntro?: boolean } = {}) {
    this.stop()
    this.ensureAudio()
    this.unlock()   // synchronous — must happen inside the click gesture
    this.ensureAnalyser()   // build/resume the AudioContext while we still have the gesture
    const runId = ++this.runId
    this.offline = this.isOfflineMode()
    this.offlineDj = null
    // A saved global DJ preference overrides the station's own mode (and shows in the UI).
    if (this.djOverride) station = { ...station, djMode: this.djOverride }

    this.set({
      active: true, station, phase: 'loading', loading: true, paused: false,
      queue: [], index: 0, currentTrack: null, nextTrack: null, djText: null, djSpeaking: false,
      queueLoading: false,
    })

    // Resolve just the FIRST track (fast) so playback starts almost immediately; the rest of the
    // queue is built in the background while this song plays. Offline (frozen local list) and
    // legacy preset stations (already return a full list) load everything at once.
    const isAi = !!(station.stationId || station.aiPrompt || station.seedValue)
    const useFast = !this.offline && isAi
    const head = await this.loadQueue(station, useFast ? { fast: true } : undefined)
    if (this.stale(runId)) return
    if (!head.length) { this.stop(); return }

    this.deck = 0
    this.set({ queue: head, loading: false, queueLoading: useFast, phase: 'intro', index: 0, currentTrack: head[0]!, nextTrack: head[1] ?? null })

    this.cueSrc(0, head[0]!.videoId)             // src + ramp to 0
    await this.playDeck(0)                        // start it (retries on transient errors)
    if (this.stale(runId)) return

    this.set({ currentTrack: head[0]!, djText: null, djSpeaking: false })

    // Build the rest of the queue concurrently with the DJ intro, off the critical path.
    const restPromise: Promise<QueuedTrack[]> = useFast
      ? this.loadQueue(station, { exclude: head.map(t => t.videoId) }).catch(() => [])
      : Promise.resolve([])

    if (!silentIntro && this.effectiveDjMode() !== 'silent') {
      // Peek at lyrics first (fast) so we know whether to go bed-first or DJ-first. Adds ~200ms
      // of latency only on the very first song of a station — invisible against DJ gen time.
      const firstRealLyricSec = await fetchFirstRealLyricSec(head[0]!)
      if (this.stale(runId)) return

      const immediateStart = firstRealLyricSec !== null && firstRealLyricSec <= IMMEDIATE_LYRICS_THRESHOLD

      // Only ramp to bed if there's a safe instrumental gap to talk over.
      if (!immediateStart) this.ramp(this.deckKey(0), INTRO_BED, 900)

      const intro = await this.prepareDj({ station, track: head[0]!, position: 'intro' })
      if (this.stale(runId)) return
      const deck0El = this.deckEl(0)

      this.set({ djText: intro.text, djSpeaking: true })
      await this.speak(intro)
      if (this.stale(runId)) return

      if (immediateStart) {
        // No intro gap — song was buffering silently while the DJ spoke. Seek back to 0 so the
        // vocals enter from the very beginning (not mid-phrase after the silent buffering window).
        deck0El.currentTime = 0
        this.ramp(this.deckKey(0), 1, 600)
      } else {
        // Timed swell: hold the bed until just before the first real lyric so the full-volume
        // moment lands with the vocal. If the DJ already ran past that point, swell immediately.
        if (firstRealLyricSec !== null) {
          const remaining = firstRealLyricSec - deck0El.currentTime - this.fadeMs() / 1000
          if (remaining > 0.2) await new Promise(r => setTimeout(r, remaining * 1000))
          if (this.stale(runId)) return
        }
        this.ramp(this.deckKey(0), 1, this.fadeMs())
      }
      this.set({ djSpeaking: false, djText: null })
    } else {
      this.ramp(this.deckKey(0), 1, 900)            // no DJ → straight to full
    }
    // The intro is over (or skipped) — mark 'playing' now (even though the rest of the queue is
    // still building) so the "tuning in" overlay doesn't flash back during the rest-await.
    this.set({ phase: 'playing' })

    const rest = await restPromise
    if (this.stale(runId)) return
    const headIds = new Set(head.map(t => t.videoId))
    const songs = [...head, ...rest.filter(t => !headIds.has(t.videoId))]
    this.set({ queue: songs, nextTrack: songs[1] ?? null, queueLoading: false })

    await this.playFrom(runId, station, songs)
  }

  // The LIVE queue array the transition loop iterates. Queue edits (drag-reorder, play-now)
  // must splice this array in place - reassigning state.queue alone would edit a dead copy
  // the loop never looks at again.
  private songsRef: QueuedTrack[] | null = null

  /** Move an Up Next item (absolute queue index) to another Up Next position. */
  reorderQueue(from: number, to: number) {
    const songs = this.songsRef
    const min = this.state.index + 1
    if (!songs || from === to) return
    if (from < min || to < min || from >= songs.length || to >= songs.length) return
    const [moved] = songs.splice(from, 1)
    if (!moved) return
    songs.splice(to, 0, moved)
    this.set({ queue: songs.slice(), nextTrack: songs[this.state.index + 1] ?? null })
  }

  /** Append a track to the end of Up Next. Splices the LIVE array (like reorderQueue)
   *  so the running transition loop picks it up; a no-op when nothing is playing, since
   *  there is no queue to append to yet. Used by the Family Jam host to pull the shared
   *  queue's head into its own playback. */
  enqueueTrack(track: QueuedTrack) {
    const songs = this.songsRef
    if (!songs || !this.state.active) return
    songs.push(track)
    this.set({ queue: songs.slice(), nextTrack: songs[this.state.index + 1] ?? null })
  }

  /** How many tracks are still queued after the current one. Lets the jam host know
   *  when to pull the next shared item without reaching into queue internals. */
  upNextCount(): number {
    const songs = this.songsRef
    if (!songs) return 0
    return Math.max(0, songs.length - this.state.index - 1)
  }

  /** Play an Up Next item NOW: pull it to the front of Up Next, then skip into it. */
  jumpTo(index: number) {
    const songs = this.songsRef
    const min = this.state.index + 1
    if (!songs || index < min || index >= songs.length) return
    if (index !== min) this.reorderQueue(index, min)
    this.skip()
  }

  // Run the transition loop over `songs`, assuming songs[0] is ALREADY playing on `this.deck`.
  // Shared by start() (after its DJ intro) and playTrack() (after its instant first song).
  private async playFrom(runId: number, station: DjStation, songs: QueuedTrack[]) {
    this.songsRef = songs
    for (let i = 0; i < songs.length; i++) {
      if (this.stale(runId)) return
      const cur = songs[i]!
      // Shuffle: pick what plays after this song BEFORE the next deck is pre-cued, so the
      // whole transition pipeline (prewarm, DJ prep, lyrics peek) targets the right track.
      if (this.shuffleMode !== 'off') this.pickShuffleNext(songs, i)
      if (this.shuffleMode === 'bag') this.addToBag(cur.videoId)
      const next = songs[i + 1] ?? null
      this.set({ index: i, currentTrack: cur, nextTrack: next, phase: 'playing', skipping: false })

      const otherDeck = this.deck === 0 ? 1 : 0
      let preparedNext: Promise<PreparedDj> | null = null
      let lyricsFetch: Promise<number | null> | null = null
      if (next) {
        // Prewarm resolves the upstream googlevideo URL ahead of play - YouTube-only; local
        // and Plex streams have no resolver latency to hide.
        if (!this.offline && isYouTubeRef(next.videoId)) prewarmStream(next.videoId, 'audio')
        this.cueSrc(otherDeck, next.videoId)   // pre-buffer so the hand-off is instant
        preparedNext = this.prepareDj({ station, track: cur, next, position: 'transition', sayStation: Math.random() < 0.34 })
        lyricsFetch = fetchFirstRealLyricSec(next)   // parallel — resolves long before the song ends
      }

      const reason = await this.waitTail(runId, this.deck)
      if (this.stale(runId)) return

      // Repeat-one: replay the current song from the top instead of advancing (a manual skip
      // still moves on). Restart the deck in place; skip if the element errored.
      if (this.repeatOne && reason !== 'skip') {
        const el = this.deckEl(this.deck)
        if (!el.error) {
          try { el.currentTime = 0; await el.play() } catch { /* fall through to advance */ }
          if (!el.paused && !this.stale(runId)) { this.ramp(this.deckKey(this.deck), 1, 0); this.set({ phase: 'playing' }); i--; continue }
        }
      }

      if (next) {
        this.set({ phase: 'transition' })
        // Manual skip → fast crossfade, no DJ (the listener wants the next song NOW). Drop the
        // prepared DJ segment (and free its audio) instead of waiting on / playing it.
        let quick = reason === 'skip'
        // The queue was edited while this song played (drag-reorder / play-now) and a
        // DIFFERENT track is up next than the one pre-cued at iteration start: re-cue the
        // incoming deck and go quick - the prepared DJ segment introduces the wrong song.
        let effNext = next
        if (songs[i + 1] && songs[i + 1] !== next) {
          effNext = songs[i + 1]!
          this.cueSrc(otherDeck, effNext.videoId)
          quick = true
        }
        if (quick) { void preparedNext?.then(d => { if (d.blobUrl) URL.revokeObjectURL(d.blobUrl) }) }
        const [dj, firstRealLyricSec] = await Promise.all([
          quick ? Promise.resolve({ text: null, blobUrl: null }) : (preparedNext ?? Promise.resolve({ text: null, blobUrl: null })),
          quick ? Promise.resolve(null) : (lyricsFetch ?? Promise.resolve(null)),
        ])
        if (this.stale(runId)) return
        // The display flip (currentTrack/index/nextTrack) happens INSIDE transition() the moment
        // the incoming song starts under the DJ — so the page's hero/lyrics/info update as the DJ
        // introduces it, not after the DJ finishes. transition() also swaps this.deck.
        await this.transition(runId, this.deck, otherDeck, dj, { index: i + 1, currentTrack: effNext, nextTrack: songs[i + 2] ?? null }, quick, quick ? null : firstRealLyricSec)
        this.set({ djSpeaking: false, djText: null })
      } else {
        this.set({ phase: 'outro' })
        const outro = await this.prepareDj({ station, track: cur, position: 'outro' })
        if (this.stale(runId)) return
        await this.talkOver(runId, this.deck, outro)
      }
    }
    if (!this.stale(runId)) this.stop()
  }

  // Play a KNOWN song immediately (we already have the videoId) — cue + play right away, like
  // clicking a YouTube video, with no LLM/queue build. The continuation mix is fetched in the
  // background so the station keeps going after the first song.
  async playTrack(track: { videoId: string; title: string; author?: string | null; thumbnail?: string }, resumeSec = 0) {
    this.stop()
    this.ensureAudio()
    this.unlock()
    this.ensureAnalyser()   // build/resume the AudioContext while we still have the gesture
    const runId = ++this.runId
    this.offline = this.isOfflineMode()
    this.offlineDj = null
    const first: QueuedTrack = {
      videoId: track.videoId,
      title: cleanTitle(track.title) || track.title,
      author: track.author ?? null,
      thumbnail: track.thumbnail || thumbForRef(track.videoId),
    }
    const station: DjStation = {
      id: `track:${track.videoId}`, label: first.title, emoji: '🎵', color: '#6d28d9', colorDark: '#a78bfa',
      seedType: 'song', seedValue: `${first.author ?? ''} ${first.title}`.trim(),
      djMode: this.djOverride ?? 'full',
    }
    this.set({
      active: true, station, phase: 'playing', loading: false, paused: false,
      queue: [first], index: 0, currentTrack: first, nextTrack: null, djText: null, djSpeaking: false,
      queueLoading: !this.offline,   // continuation mix builds in the background (online only)
    })
    this.deck = 0
    // Prefer a locally prefetched file (the video→audio handoff downloads the current song's audio
    // ahead of time) so the cold start is gapless online; fall back to streaming.
    let firstLocal = this.offline
    // The prefetch cache only exists for YouTube refs - local/plex refs stream from their own routes.
    if (!firstLocal && isYouTubeRef(first.videoId)) {
      try { firstLocal = (await prefetchReady([first.videoId], 'audio')).includes(first.videoId) } catch { firstLocal = false }
    }
    if (this.stale(runId)) return
    this.cueSrc(0, first.videoId, firstLocal)
    await this.playDeck(0)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(0), 1, 250)   // straight to full volume — instant, no DJ bed

    // Resume at a handoff position (e.g. switching from the video player to audio mid-song).
    if (resumeSec > 0) {
      const el = this.deckEl(0)
      const apply = () => {
        const d = el.duration
        if (Number.isFinite(d) && d > 0) { try { el.currentTime = Math.min(resumeSec, d) } catch { /* not seekable yet */ } this.set({ positionSec: el.currentTime }) }
      }
      if (el.readyState >= 1) apply()
      else el.addEventListener('loadedmetadata', apply, { once: true })
    }

    // Background: build the continuation mix off this exact video (fast YT Music radio, no LLM).
    // Offline has no continuation (nothing more is downloaded) — just play the one song.
    let mix: QueuedTrack[] = []
    if (this.offline) { this.set({ queue: [first], queueLoading: false }); await this.playFrom(runId, station, [first]); return }
    try {
      // A YouTube ref rides the fast YT-Music radio mix off the exact video. Owned-library
      // refs can't seed that - fall back to a song seed (artist + title), which the station
      // engine resolves itself.
      const res = isYouTubeRef(first.videoId)
        ? await fetchStationQueue({ seedVideoId: first.videoId, count: 14 })
        : await fetchStationQueue({ seedType: 'song', seedValue: station.seedValue ?? first.title, count: 14 })
      mix = res.tracks
        .filter(t => t.videoId !== first.videoId)
        .map(v => ({ videoId: v.videoId, title: cleanTitle(v.title) || v.title, author: v.author ?? null, thumbnail: thumbForRef(v.videoId) }))
    } catch { /* play the single song; loop ends after it */ }
    if (this.stale(runId)) return
    const songs = [first, ...mix]
    this.set({ queue: songs, queueLoading: false })
    await this.playFrom(runId, station, songs)
  }

  // Play a FIXED, ordered track list (a playlist) start-to-finish, then stop — unlike playTrack(),
  // never builds a continuation mix. Reuses the same playFrom() transition/DJ loop, just seeded
  // directly with the caller's track list instead of one that fetchStationQueue would extend.
  async playPlaylist(tracks: QueuedTrack[], startIndex = 0, opts?: { name?: string; playlistId?: string }) {
    this.stop()
    this.ensureAudio()
    this.unlock()
    this.ensureAnalyser()
    const runId = ++this.runId
    this.offline = this.isOfflineMode()
    this.offlineDj = null
    const songs = tracks.slice(Math.max(0, startIndex))
    if (!songs.length) { this.stop(); return }
    const first = songs[0]!
    const station: DjStation = {
      id: `playlist:${opts?.playlistId ?? first.videoId}`, label: opts?.name ?? 'Playlist',
      emoji: '🎧', color: '#6d28d9', colorDark: '#a78bfa',
      seedType: 'song', djMode: this.djOverride ?? 'full',
    }
    this.set({
      active: true, station, phase: 'playing', loading: false, paused: false,
      queue: songs, index: 0, currentTrack: first, nextTrack: songs[1] ?? null,
      djText: null, djSpeaking: false, queueLoading: false,
    })
    this.deck = 0
    let firstLocal = this.offline
    // The prefetch cache only exists for YouTube refs - local/plex refs stream from their own routes.
    if (!firstLocal && isYouTubeRef(first.videoId)) {
      try { firstLocal = (await prefetchReady([first.videoId], 'audio')).includes(first.videoId) } catch { firstLocal = false }
    }
    if (this.stale(runId)) return
    this.cueSrc(0, first.videoId, firstLocal)
    await this.playDeck(0)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(0), 1, 250)
    await this.playFrom(runId, station, songs)
  }

  skip() {
    // Immediate UI feedback so the listener knows the click registered (the actual hand-off takes a
    // beat to cue + crossfade). Cleared when the next song takes over.
    if (this.state.phase === 'playing' && this.skipResolve) this.set({ skipping: true })
    this.skipResolve?.()
  }

  // Adjustable crossfade (persisted like djMode). fadeMs drives every song-to-song ramp;
  // the transition kicks off tailSec before a song ends so the fade completes in time.
  private crossfadeMs: number = (() => {
    try {
      const raw = localStorage.getItem('music.crossfadeMs')
      if (raw == null) return DEFAULT_FADE
      const v = Number(raw)
      return Number.isFinite(v) && v >= 0 ? Math.min(v, 12000) : DEFAULT_FADE
    } catch { return DEFAULT_FADE }
  })()
  private fadeMs(): number { return Math.max(250, this.crossfadeMs) }
  private tailSec(): number { return Math.max(2, this.crossfadeMs / 1000 + 1.5) }
  getCrossfadeMs(): number { return this.crossfadeMs }
  setCrossfadeMs(ms: number) {
    this.crossfadeMs = Math.max(0, Math.min(12000, Math.round(ms)))
    try { localStorage.setItem('music.crossfadeMs', String(this.crossfadeMs)) } catch { /* quota */ }
  }

  // Sweet Fades: overlap the next song where this one's outro begins (per-track loudness
  // analysis from analyzeOutro) instead of a fixed tail. On by default, persisted.
  private sweetFades = typeof localStorage !== 'undefined' && localStorage.getItem('music.sweetFades') !== '0'
  getSweetFades(): boolean { return this.sweetFades }
  setSweetFades(on: boolean) {
    this.sweetFades = on
    try { localStorage.setItem('music.sweetFades', on ? '1' : '0') } catch { /* quota */ }
  }
  // The tail to hand off at: at least the crossfade's own tail; with Sweet Fades, all of
  // the track's trailing silence plus up to 12s of its fade-out - but never more than half
  // the song (a defensive clamp against a degenerate envelope).
  private effectiveTailSec(deck: number, durationSec: number): number {
    const base = this.tailSec()
    const o = this.deckOutro[deck]
    if (!this.sweetFades || !o) return base
    const silence = Math.max(0, (1 - o.lastSoundFrac) * durationSec)
    const fade = Math.max(0, (o.lastSoundFrac - o.lastLoudFrac) * durationSec)
    const sweet = silence + Math.min(12, fade)
    return Math.min(Math.max(base, sweet), Math.max(base, durationSec * 0.5))
  }

  // AutoMix: when this hand-off is beat-matchable, snap the transition start to the
  // outgoing track's beat grid (beat phase assumed from t=0; a sub-beat nudge at most)
  // so the incoming song's downbeat lands on a beat boundary instead of mid-beat.
  private handOffTailSec(deck: number, durationSec: number): number {
    const tail = this.effectiveTailSec(deck, durationSec)
    const other = deck === 0 ? 1 : 0
    if (this.autoMixRate(deck, other) === null) return tail
    const bpm = this.deckBpm[deck]
    if (!bpm) return tail
    const beat = 60 / bpm
    const start = durationSec - tail
    const snapped = Math.ceil(start / beat) * beat
    if (snapped >= durationSec - Math.max(1, this.fadeMs() / 1000)) return tail
    return durationSec - snapped
  }

  // AutoMix: persisted like crossfade/sweet-fades. Off by default - beat matching bends
  // pitchless tempo by up to 4 percent, which some listeners will always notice.
  private autoMix = typeof localStorage !== 'undefined' && localStorage.getItem('music.autoMix') === '1'
  getAutoMix(): boolean { return this.autoMix }
  setAutoMix(on: boolean) {
    this.autoMix = on
    try { localStorage.setItem('music.autoMix', on ? '1' : '0') } catch { /* quota */ }
  }

  // ── Shuffle modes ──────────────────────────────────────────────────────────────────
  // 'random' swaps a random Up Next track into the next slot at every hand-off; 'bag'
  // does the same but only from tracks that haven't played yet this cycle (the bag is
  // persisted per station, so "no repeats until everything has played" holds across
  // sessions). Manual queue edits still win - they happen after the pick.
  private shuffleMode: ShuffleMode = (() => {
    try {
      const raw = localStorage.getItem('music.shuffleMode')
      return raw === 'random' || raw === 'bag' ? raw : 'off'
    } catch { return 'off' }
  })()
  getShuffleMode(): ShuffleMode { return this.shuffleMode }
  setShuffleMode(mode: ShuffleMode) {
    this.shuffleMode = mode
    try { localStorage.setItem('music.shuffleMode', mode) } catch { /* quota */ }
  }

  private bagKey(): string {
    const st = this.state.station
    return `music.shuffleBag.${st?.stationId ?? st?.id ?? 'queue'}`
  }
  private loadBag(): Set<string> {
    try {
      const raw = localStorage.getItem(this.bagKey())
      const arr = raw ? JSON.parse(raw) as unknown : []
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
    } catch { return new Set() }
  }
  private saveBag(bag: Set<string>) {
    try { localStorage.setItem(this.bagKey(), JSON.stringify([...bag].slice(-400))) } catch { /* quota */ }
  }
  private addToBag(ref: string) {
    const bag = this.loadBag()
    bag.add(ref)
    this.saveBag(bag)
  }

  /** Swap the shuffle-picked track into the next slot (index i+1). Runs at the top of
   *  each playFrom iteration, before the next deck is pre-cued. */
  private pickShuffleNext(songs: QueuedTrack[], i: number) {
    const first = i + 1
    const remaining = songs.length - first
    if (remaining <= 1) return
    let pool: number[] = []
    if (this.shuffleMode === 'bag') {
      const bag = this.loadBag()
      for (let j = first; j < songs.length; j++) if (!bag.has(songs[j]!.videoId)) pool.push(j)
      if (!pool.length) {
        // Everything has played once - reset the cycle and shuffle the full queue again.
        this.saveBag(new Set())
        pool = Array.from({ length: remaining }, (_, n) => first + n)
      }
    } else {
      pool = Array.from({ length: remaining }, (_, n) => first + n)
    }
    const j = pool[Math.floor(Math.random() * pool.length)]!
    if (j === first) return
    ;[songs[first], songs[j]] = [songs[j]!, songs[first]!]
  }

  // Repeat-one: when on, the current song replays from the top instead of advancing to the
  // next queue entry (a manual skip still moves on). Persisted per device.
  private repeatOne = typeof localStorage !== 'undefined' && localStorage.getItem('music.repeatOne') === '1'
  getRepeatOne(): boolean { return this.repeatOne }
  setRepeatOne(on: boolean) {
    this.repeatOne = on
    try { localStorage.setItem('music.repeatOne', on ? '1' : '0') } catch { /* quota */ }
    this.set({ repeatOne: on })
  }

  /** Jump forward/back by `delta` seconds, clamped to the track (e.g. skip a podcast ad). */
  seekBy(delta: number) {
    this.seek(this.state.positionSec + delta)
  }

  // Persisted, station-independent DJ preference. Once the user picks a mode it sticks across
  // songs, station changes, and reloads — so "Silent" stays silent until they change it. The
  // override (when set) wins over each station's own djMode.
  private djOverride: 'full' | 'minimal' | 'silent' | null =
    (typeof localStorage !== 'undefined'
      ? (localStorage.getItem('music.djMode') as 'full' | 'minimal' | 'silent' | null)
      : null)
  private effectiveDjMode(): 'full' | 'minimal' | 'silent' {
    return this.djOverride ?? this.state.station?.djMode ?? 'full'
  }
  setDjMode(mode: 'full' | 'minimal' | 'silent') {
    this.djOverride = mode
    try { localStorage.setItem('music.djMode', mode) } catch { /* quota */ }
    if (this.state.station) this.set({ station: { ...this.state.station, djMode: mode } })
  }

  // Sleep timer: stop playback after N minutes (0/null cancels). sleepAtMs feeds a countdown.
  private sleepTimeout: ReturnType<typeof setTimeout> | null = null
  setSleep(minutes: number | null) {
    if (this.sleepTimeout) { clearTimeout(this.sleepTimeout); this.sleepTimeout = null }
    if (!minutes || minutes <= 0) { this.set({ sleepAtMs: null }); return }
    const at = Date.now() + minutes * 60_000
    this.sleepTimeout = setTimeout(() => { this.sleepTimeout = null; this.stop() }, minutes * 60_000)
    this.set({ sleepAtMs: at })
  }

  stop() {
    this.runId++
    this.skipResolve = null
    this.songsRef = null
    if (this.sleepTimeout) { clearTimeout(this.sleepTimeout); this.sleepTimeout = null }
    if (this.built) {
      (Object.keys(this.ch) as ChKey[]).forEach(k => {
        const c = this.ch[k]
        if (c.ramp) { clearInterval(c.ramp); c.ramp = undefined }
        try { c.el.pause() } catch { /* noop */ }
      })
      this.ramp('d0', 0, 0); this.ramp('d1', 0, 0); this.ramp('dj', 1, 0)
    }
    this.set({
      active: false, station: null, phase: 'idle', queue: [], index: 0,
      currentTrack: null, nextTrack: null, djText: null, djSpeaking: false, paused: false, loading: false, queueLoading: false, skipping: false,
      sleepAtMs: null,
    })
  }

  togglePause() {
    if (!this.state.active || !this.built) return
    const paused = !this.state.paused
    if (paused) {
      this.resumeEls = (Object.keys(this.ch) as ChKey[]).map(k => this.ch[k].el).filter(e => !e.paused)
      this.resumeEls.forEach(e => e.pause())
    } else {
      this.resumeEls.forEach(e => { void e.play().catch(() => {}) })
      this.resumeEls = []
    }
    this.set({ paused })
  }

  /** Scrub the currently-playing song to an absolute position (seconds). No-op during DJ
   *  talk segments / before a song is live — seeking only makes sense on the active deck. */
  seek(sec: number) {
    if (!this.state.active || !this.built) return
    const el = this.deckEl(this.deck)
    const d = el.duration
    if (!Number.isFinite(d) || d <= 0) return
    const t = Math.max(0, Math.min(sec, d))
    try { el.currentTime = t } catch { return }
    this.lastPosSec = Math.floor(t)
    this.set({ positionSec: t })
  }

  setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v))
    this.masterVol = vol
    if (vol > 0) this.muted = false
    this.set({ volume: vol, muted: this.muted })
    if (this.built) this.applyAll()
  }

  // Relative step for remote "volume up/down" (controller buttons, voice). Reads the
  // engine's own master volume so callers never need the current level.
  nudgeVolume(delta: number) {
    this.setVolume(this.masterVol + delta)
  }

  toggleMute() {
    this.muted = !this.muted
    this.set({ muted: this.muted })
    if (this.built) this.applyAll()
  }

  // Keep the Web Audio graph intact across teardown/revival: createMediaElementSource can't be
  // re-run on an element, so closing the context would permanently break analysis (and could
  // strand the elements on a dead context). The engine instance is reused, so the graph persists.
  destroy() { this.stop() }
}
