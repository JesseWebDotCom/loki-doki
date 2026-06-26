// AI Radio playback engine — runs the whole station experience from a global context so it
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

import { search as ytSearch, ytImageProxy, proxyStreamUrl, prewarmStream } from '@/lib/youtube/api'
import { fetchDjSegment, fetchRadioQueue, fetchStationQueue, base64WavToBlob } from '@/lib/music/radio'
import { getOfflineQueue, offlineAudioUrl, prefetchReady, type OfflineQueue } from '@/lib/music/catalogApi'
import type { DjStation } from '@/lib/music/radioStations'

export interface QueuedTrack {
  videoId: string
  title: string
  author: string | null
  thumbnail: string
}

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
  positionSec: number   // playback position of the current song (drives synced lyrics)
  durationSec: number   // current song length, when known
  sleepAtMs: number | null  // epoch ms at which the sleep timer stops playback (null = off)
}

export const initialRadioState: RadioState = {
  active: false, station: null, queue: [], index: 0,
  currentTrack: null, nextTrack: null, djText: null, djSpeaking: false,
  phase: 'idle', paused: false, volume: 1, muted: false, loading: false,
  positionSec: 0, durationSec: 0, sleepAtMs: null,
}

interface PreparedDj { text: string | null; blobUrl: string | null }

// Levels (relative, 0..1) / timings.
const TAIL = 3          // seconds before a song's end at which we start the transition
const INTRO_BED = 0.22  // level a song plays at while it's the backing bed (DJ talks over it)
const FADE = 1300       // generic ramp length (ms)

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

  // Real-audio analysis. Each deck is routed through Web Audio once — source → destination
  // (audio) + source → analyser (read tap) — and that graph lives for the engine's lifetime
  // (createMediaElementSource may only be called once per element, even across contexts, so we
  // never tear it down). The element's own .volume crossfade still applies to the node, so mixing
  // is unaffected. The old "this silences the stream" fear was stale: it only happened with
  // cross-origin/redirected googlevideo URLs. The decks now play same-origin proxied bytes
  // (/api/youtube/stream), which are not CORS-tainted, so the node carries real samples. The
  // context is created + resumed inside the start()/playTrack() click gesture, and we tap eagerly
  // there (before any deck plays) so both the station and the play-a-song paths light up.
  private actx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private tapped = new WeakSet<HTMLMediaElement>()

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

  /** Lazily build the shared AudioContext + AnalyserNode. Call from a user gesture (start)
   *  so the context isn't born suspended. */
  private ensureAnalyser() {
    if (this.analyser || !this.built) return
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.actx = new Ctor()
      this.analyser = this.actx.createAnalyser()
      this.analyser.fftSize = 512          // 256 bins → finer frequency resolution
      this.analyser.smoothingTimeConstant = 0.55  // less internal smoothing → transients (kick/snare/hat) read
      this.analyser.minDecibels = -85      // widen the dB window so loud music isn't bunched at the
      this.analyser.maxDecibels = -12      // ceiling — gives real dynamic range / contrast between bands
      void this.actx.resume?.()            // we're inside the start()/playTrack() click gesture
      // Wire every deck up now, before anything plays — so the immediate-song path (playTrack)
      // is tapped just like the DJ-intro-first path (start). Sources persist for the lifetime.
      ;(['d0', 'd1', 'dj'] as ChKey[]).forEach(k => this.tap(this.ch[k].el))
    } catch { this.actx = null; this.analyser = null }
  }

  /** Route an element through Web Audio: source → destination (audio) + source → analyser (tap).
   *  Idempotent per element (createMediaElementSource throws on a second call). Connecting to
   *  destination keeps it audible the moment the (gesture-resumed) context starts running. */
  private tap(el: HTMLMediaElement) {
    if (!this.analyser || !this.actx || this.tapped.has(el)) return
    try {
      const src = this.actx.createMediaElementSource(el)
      src.connect(this.actx.destination) // keep it audible
      src.connect(this.analyser)          // parallel read tap
      this.tapped.add(el)
    } catch { /* already sourced or unsupported */ }
  }

  /** The live AnalyserNode for real-time frequency data, or null if analysis isn't available. */
  getAnalyser(): AnalyserNode | null { return this.analyser }

  private deckKey(i: number): ChKey { return i === 0 ? 'd0' : 'd1' }
  private deckEl(i: number) { return this.ch[this.deckKey(i)].el }

  private applyVol(key: ChKey) {
    const c = this.ch[key]
    c.el.muted = this.muted
    c.el.volume = Math.max(0, Math.min(1, c.level * this.masterVol))
  }
  private applyAll() { (Object.keys(this.ch) as ChKey[]).forEach(k => this.applyVol(k)) }

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
  private async loadQueue(st: DjStation): Promise<QueuedTrack[]> {
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
          thumbnail: ytImageProxy(`https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`),
        }))
      } catch { return [] }
    }

    // AI station → station engine (saved id, prompt, or artist/song seed). The engine already
    // orders the queue, so we don't shuffle its result.
    const isAi = !!(st.stationId || st.aiPrompt || st.seedValue)
    if (isAi) {
      try {
        const res = await fetchStationQueue({
          stationId: st.stationId, aiPrompt: st.aiPrompt, seedType: st.seedType,
          seedValue: st.seedValue, name: st.label, count: 12,
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
      if (!v.videoId || seen.has(v.videoId)) continue
      if (isJunkTrack(v.title, v.author ?? null)) continue
      const title = cleanTitle(v.title) || v.title
      const t = normKey(title)
      const songKey = t ? (v.author ? `${normKey(v.author)}~${t}` : t) : ''
      if (songKey && seenSongs.has(songKey)) continue
      seen.add(v.videoId)
      if (songKey) seenSongs.add(songKey)
      tracks.push({
        videoId: v.videoId, title, author: v.author ?? null,
        thumbnail: ytImageProxy(`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`),
      })
    }
    if (shuffle) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!]
      }
    }
    return tracks.slice(0, 30)
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
    el.src = (this.offline || forceLocal) ? offlineAudioUrl(videoId) : proxyStreamUrl(videoId, 'audio')
    el.load()
    this.ramp(this.deckKey(deck), 0, 0)
  }
  private async playDeck(deck: number, attempt = 0): Promise<void> {
    const el = this.deckEl(deck)
    void this.actx?.resume?.()   // nudge the context to running so the first song is analysed too
    try { await el.play(); this.tap(el) }
    catch (e) {
      // A 502 from a transient resolve failure surfaces as a load/format error. Reload (which
      // re-requests the stream → re-resolves on the backend) and retry a couple of times.
      if (e instanceof DOMException && e.name === 'AbortError') return // intentional pause/skip
      if (attempt < 2 && el.error) {
        await new Promise(r => setTimeout(r, 1500))
        el.load()
        return this.playDeck(deck, attempt + 1)
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
      el.play().then(() => this.tap(el)).catch(fin)
    })
    URL.revokeObjectURL(dj.blobUrl)
  }

  // Intro: the first song is ALREADY playing on `deck` at INTRO_BED level (its own bed). The DJ
  // talks over it, then the song fades up to full and owns the mix.
  private async introOverSong(runId: number, deck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })
    await this.speak(dj)                          // DJ talks over the bedding song
    if (this.stale(runId)) return
    this.ramp(this.deckKey(deck), 1, FADE)        // fade the song up to full
  }

  // Talk OVER the currently-playing song (used for the outro): duck the song to bed level, speak,
  // then bring it back to full. No deck switch.
  private async talkOver(runId: number, deck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })
    this.ramp(this.deckKey(deck), INTRO_BED, 700)   // duck to bed level (audible backing)
    await this.speak(dj)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(deck), 1, FADE)
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
        if (isFinite(d) && d > 0 && el.currentTime >= d - TAIL) return finish('tail')
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
  private async transition(runId: number, fromDeck: number, toDeck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })

    // Bring the incoming song in at bed level; fade the outgoing one out under it.
    await this.playDeck(toDeck)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(toDeck), INTRO_BED, 900)
    this.ramp(this.deckKey(fromDeck), 0, 1200)
    setTimeout(() => { if (!this.stale(runId)) { try { this.deckEl(fromDeck).pause() } catch { /* noop */ } } }, 1300)

    // Let the outgoing song fade out and the bed settle for a beat before the DJ comes in.
    await new Promise(r => setTimeout(r, 1300))
    if (this.stale(runId)) return

    // DJ talks over the bedding song, then it fades up to full.
    await this.speak(dj)
    if (this.stale(runId)) return
    this.ramp(this.deckKey(toDeck), 1, FADE)
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
    })

    const songs = await this.loadQueue(station)
    if (this.stale(runId)) return
    if (!songs.length) { this.stop(); return }

    this.deck = 0
    this.set({ queue: songs, loading: false, phase: 'intro', index: 0, currentTrack: null, nextTrack: songs[0]! })

    this.cueSrc(0, songs[0]!.videoId)            // src + ramp to 0
    await this.playDeck(0)                        // start it (retries on transient errors)
    if (this.stale(runId)) return

    if (silentIntro || this.effectiveDjMode() === 'silent') {
      // Skip DJ intro — song opens at full volume immediately.
      this.ramp(this.deckKey(0), 1, 900)
      this.set({ currentTrack: songs[0]!, djSpeaking: false, djText: null })
    } else {
      // The first song is its own bed: DJ talks over it, then it swells to full.
      this.ramp(this.deckKey(0), INTRO_BED, 900)
      const intro = await this.prepareDj({ station, track: songs[0]!, position: 'intro' })
      if (this.stale(runId)) return
      await this.introOverSong(runId, 0, intro)
      if (this.stale(runId)) return
      this.set({ currentTrack: songs[0]!, djSpeaking: false, djText: null })
    }

    await this.playFrom(runId, station, songs)
  }

  // Run the transition loop over `songs`, assuming songs[0] is ALREADY playing on `this.deck`.
  // Shared by start() (after its DJ intro) and playTrack() (after its instant first song).
  private async playFrom(runId: number, station: DjStation, songs: QueuedTrack[]) {
    for (let i = 0; i < songs.length; i++) {
      if (this.stale(runId)) return
      const cur = songs[i]!
      const next = songs[i + 1] ?? null
      this.set({ index: i, currentTrack: cur, nextTrack: next, phase: 'playing' })

      const otherDeck = this.deck === 0 ? 1 : 0
      let preparedNext: Promise<PreparedDj> | null = null
      if (next) {
        if (!this.offline) prewarmStream(next.videoId, 'audio')   // prewarm is a network call
        this.cueSrc(otherDeck, next.videoId)   // pre-buffer so the hand-off is instant
        preparedNext = this.prepareDj({ station, track: cur, next, position: 'transition', sayStation: Math.random() < 0.34 })
      }

      await this.waitTail(runId, this.deck)
      if (this.stale(runId)) return

      if (next) {
        this.set({ phase: 'transition' })
        const dj = await (preparedNext ?? Promise.resolve({ text: null, blobUrl: null }))
        if (this.stale(runId)) return
        await this.transition(runId, this.deck, otherDeck, dj)
        this.deck = otherDeck
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
      thumbnail: track.thumbnail || ytImageProxy(`https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`),
    }
    const station: DjStation = {
      id: `track:${track.videoId}`, label: first.title, emoji: '🎵', color: '#6d28d9', colorDark: '#a78bfa',
      seedType: 'song', seedValue: `${first.author ?? ''} ${first.title}`.trim(),
      djMode: this.djOverride ?? 'full',
    }
    this.set({
      active: true, station, phase: 'playing', loading: false, paused: false,
      queue: [first], index: 0, currentTrack: first, nextTrack: null, djText: null, djSpeaking: false,
    })
    this.deck = 0
    // Prefer a locally prefetched file (the video→audio handoff downloads the current song's audio
    // ahead of time) so the cold start is gapless online; fall back to streaming.
    let firstLocal = this.offline
    if (!firstLocal) { try { firstLocal = (await prefetchReady([first.videoId], 'audio')).includes(first.videoId) } catch { firstLocal = false } }
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
    if (this.offline) { this.set({ queue: [first] }); await this.playFrom(runId, station, [first]); return }
    try {
      const res = await fetchStationQueue({ seedVideoId: first.videoId, count: 14 })
      mix = res.tracks
        .filter(t => t.videoId !== first.videoId)
        .map(v => ({ videoId: v.videoId, title: cleanTitle(v.title) || v.title, author: v.author ?? null, thumbnail: ytImageProxy(`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`) }))
    } catch { /* play the single song; loop ends after it */ }
    if (this.stale(runId)) return
    const songs = [first, ...mix]
    this.set({ queue: songs })
    await this.playFrom(runId, station, songs)
  }

  skip() { this.skipResolve?.() }

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
      currentTrack: null, nextTrack: null, djText: null, djSpeaking: false, paused: false, loading: false,
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
