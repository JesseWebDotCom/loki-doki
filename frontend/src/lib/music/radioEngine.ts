// AI Radio playback engine — runs the whole station experience from a global context so it
// survives navigation.
//
//   deck0 / deck1  — ping-pong song players (full music videos, streamed audio-only)
//   bed            — a genre-matched YouTube INSTRUMENTAL (no vocals), looped low under the DJ
//   dj             — Kokoro TTS voice
//
// All four are plain <audio> elements mixed by animating `.volume`. We deliberately do NOT
// route them through Web Audio / createMediaElementSource — live YouTube proxy streams render
// SILENT through it in Chrome (currentTime advances, no sound). That bug cost us a lot; .volume
// is bulletproof for these streams.
//
// Timing model (a real radio DJ talks OVER the music, never instead of it):
//  • The current song starts IMMEDIATELY (only the unavoidable ~3s cold stream resolve), at
//    full volume — not after the DJ. The DJ intro is generated while it plays.
//  • The DJ then talks OVER the song: it ducks, the instrumental bed swells up, the DJ speaks,
//    then the song returns to full.
//  • At a transition the outgoing song's tail (~3s) and the incoming song's head (~5s) play
//    ducked under the DJ; the next song is pre-buffered on the idle deck so it's instant.

import { search as ytSearch, ytImageProxy, proxyStreamUrl, prewarmStream } from '@/lib/youtube/api'
import { fetchDjSegment, fetchRadioQueue, base64WavToBlob } from '@/lib/music/radio'
import type { DjStation } from '@/lib/music/radioStations'

export interface QueuedTrack {
  videoId: string
  title: string
  author: string | null
  thumbnail: string
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
}

export const initialRadioState: RadioState = {
  active: false, station: null, queue: [], index: 0,
  currentTrack: null, nextTrack: null, djText: null, djSpeaking: false,
  phase: 'idle', paused: false, volume: 1, muted: false, loading: false,
}

interface PreparedDj { text: string | null; blobUrl: string | null }

// Levels (relative, 0..1) / timings.
const TAIL = 3       // seconds the outgoing song stays audible (ducked) under the DJ
const HEAD = 5       // seconds the incoming song plays (ducked) under the DJ before it owns the mix
const DUCK = 0.12    // ducked song level while the DJ talks
const BED = 0.16     // instrumental bed level under the DJ (low — it's just a backing wash)
const FADE = 1300    // generic ramp length (ms)

// Resolved bed videoId per station, cached for the page lifetime so re-tuning resolves instantly.
const bedIdCache = new Map<string, string>()

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

type ChKey = 'd0' | 'd1' | 'bed' | 'dj'
interface Channel { el: HTMLAudioElement; level: number; ramp?: ReturnType<typeof setInterval> }

export class RadioEngine {
  private ch!: Record<ChKey, Channel>
  private built = false
  private masterVol = 1
  private muted = false
  private bedReady = false
  private bedWanted = false   // is the bed SUPPOSED to be audible right now (DJ talking)?
  private silentUrl: string | null = null
  private unlocked = false

  private deck = 0          // index (0/1) of the deck holding the "current" song
  private runId = 0         // bumped on stop/skip-of-session to invalidate stale async loops
  private skipResolve: (() => void) | null = null
  private resumeEls: HTMLMediaElement[] = []

  private state: RadioState = { ...initialRadioState }

  constructor(private emit: (s: RadioState) => void) {}

  private set(patch: Partial<RadioState>) {
    this.state = { ...this.state, ...patch }
    this.emit(this.state)
  }

  private stale(runId: number) { return runId !== this.runId }

  // "Unlock" every element by playing a brief silent clip on each INSIDE the user gesture, so
  // later programmatic play() calls (the bed/song after their async resolves) aren't blocked by
  // the autoplay policy — the symptom being "loaded but didn't play". Must run synchronously
  // from the click (start() does, before its first await). Silent clip ends on its own (~0.15s),
  // so it never fights the real src set moments later.
  private unlock() {
    if (this.unlocked || !this.built) return
    this.unlocked = true
    if (!this.silentUrl) this.silentUrl = makeSilentWavUrl()
    for (const k of Object.keys(this.ch) as ChKey[]) {
      const el = this.ch[k].el
      // loop=false for the blessing: the bed is created with loop=true, and a LOOPING 0.15s
      // silent clip kept the element perpetually mid-play — so when startBed() later swapped in
      // the real src, Chrome swallowed the new stream's first `playing` event and bedReady never
      // flipped during the intro. startBed() restores loop=true on the bed.
      try { el.loop = false; el.src = this.silentUrl; el.volume = 0; el.play()?.catch(() => {}) } catch { /* noop */ }
    }
  }

  // ── Audio elements + volume mixing ───────────────────────────────────────────
  private ensureAudio() {
    if (this.built) return
    this.built = true
    const mk = (level: number, loop = false): Channel => {
      const el = new Audio(); el.preload = 'auto'; el.loop = loop
      return { el, level }
    }
    this.ch = { d0: mk(0), d1: mk(0), bed: mk(0, true), dj: mk(1) }
    ;(Object.keys(this.ch) as ChKey[]).forEach(k => this.applyVol(k))
  }

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

  // The bed is a DJ-only layer. raiseBed() while the DJ talks; lowerBed() as the song takes
  // over. bedWanted is authoritative so a bed that finishes its cold resolve LATE (mid-song)
  // doesn't bleed in over the music, and the song's fade-in is always matched by a bed fade-out.
  private raiseBed() { this.bedWanted = true; if (this.bedReady) this.ramp('bed', BED, 700) }
  private lowerBed() { this.bedWanted = false; this.ramp('bed', 0, 1200) }

  // ── Fetch helpers ────────────────────────────────────────────────────────────
  private async loadQueue(st: DjStation): Promise<QueuedTrack[]> {
    const q = st.ytQueries[Math.floor(Math.random() * st.ytQueries.length)]!
    let raw: Array<{ videoId: string; title: string; author: string | null }> = []
    let shuffle = false
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

    const seen = new Set<string>()
    const tracks: QueuedTrack[] = []
    for (const v of raw) {
      if (!v.videoId || seen.has(v.videoId)) continue
      seen.add(v.videoId)
      tracks.push({
        videoId: v.videoId, title: cleanTitle(v.title) || v.title, author: v.author ?? null,
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

  private async resolveBed(st: DjStation): Promise<string | null> {
    const cached = bedIdCache.get(st.id)
    if (cached) { prewarmStream(cached, 'audio'); return cached }
    try {
      const data = await ytSearch(st.bedQuery, null, 'videos')
      const results = data.results ?? []
      // The bed only needs to cover a ~20s DJ break (it loops), so pick the SHORTEST real clip
      // (≥45s) — never the 1–10 hour compilations that rank first and are slow/heavy for yt-dlp.
      const candidates = results.filter(v => v.durationSec != null && v.durationSec >= 45)
      const pick = candidates.length
        ? candidates.reduce((a, b) => (b.durationSec! < a.durationSec! ? b : a))
        : (results.find(v => !/\b\d+\s*hours?\b/i.test(v.title)) ?? results[0])
      const id = pick?.videoId ?? null
      if (id) { bedIdCache.set(st.id, id); prewarmStream(id, 'audio') }
      return id
    } catch { return null }
  }

  // Resolve + start the looping genre instrumental at silent gain; mark ready when audio
  // actually begins. Logged so a silent bed is diagnosable instead of a mystery.
  private async startBed(runId: number, station: DjStation, attempt = 0) {
    if (attempt === 0) this.bedReady = false
    const bedId = await this.resolveBed(station)
    if (this.stale(runId)) return
    if (!bedId) { console.warn('[radio] no instrumental bed found for', station.bedQuery); return }
    const el = this.ch.bed.el
    el.loop = true   // restore the loop the autoplay-unlock turned off

    // Mark the bed ready (and raise it if it's wanted) the moment it's ACTUALLY producing audio.
    // We key off BOTH `playing` and `timeupdate` (currentTime advancing past the silent-clip
    // length): Chrome can swallow the first `playing` event when we reassign src on the element
    // the unlock left mid-play, and that single missed event used to leave bedReady stuck false
    // for the whole first intro — `timeupdate` can't be swallowed, so it's the reliable signal.
    const markReady = () => {
      if (this.bedReady || this.stale(runId)) return
      this.bedReady = true
      console.info('[radio] bed ready', bedId)
      if (this.bedWanted) this.ramp('bed', BED, 700)   // raise now if the DJ is still talking
    }
    el.onplaying = markReady
    el.ontimeupdate = () => { if (el.currentTime > 0.2) markReady() }
    el.onerror = () => {
      console.warn('[radio] bed stream error', bedId, el.error?.message)
      // Transient 502 from a cold resolve — re-request (re-resolves) and retry a couple times.
      if (attempt < 2 && !this.stale(runId)) setTimeout(() => { void this.startBed(runId, station, attempt + 1) }, 1500)
    }
    this.ramp('bed', 0, 0)                  // start silent (raised only when wanted)
    el.src = proxyStreamUrl(bedId, 'audio')
    el.load()
    prewarmStream(bedId, 'audio')
    try { await el.play() } catch (e) { console.warn('[radio] bed play() rejected', e) }
  }

  private waitForBed(ms: number): Promise<void> {
    if (this.bedReady) return Promise.resolve()
    return new Promise(res => {
      const start = Date.now()
      const iv = setInterval(() => {
        if (this.bedReady || Date.now() - start > ms) { clearInterval(iv); res() }
      }, 100)
    })
  }

  private async prepareDj(args: {
    station: DjStation; track: QueuedTrack | null; next?: QueuedTrack | null
    position: 'intro' | 'transition' | 'outro'
  }): Promise<PreparedDj> {
    const seg = await fetchDjSegment({
      genre: args.station.genre,
      trackName: args.track?.title,
      artistName: args.track?.author ?? undefined,
      nextTrackName: args.next?.title,
      nextArtistName: args.next?.author ?? undefined,
      position: args.position,
    })
    if (!seg) return { text: null, blobUrl: null }
    let blobUrl: string | null = null
    if (seg.audio) blobUrl = URL.createObjectURL(base64WavToBlob(seg.audio, seg.audioMime))
    return { text: seg.text, blobUrl }
  }

  // ── Low-level deck control ───────────────────────────────────────────────────
  private cueSrc(deck: number, videoId: string) {
    const el = this.deckEl(deck)
    el.src = proxyStreamUrl(videoId, 'audio')
    el.load()
    this.ramp(this.deckKey(deck), 0, 0)
  }
  private async playDeck(deck: number, attempt = 0): Promise<void> {
    const el = this.deckEl(deck)
    try { await el.play() }
    catch (e) {
      // A 502 from a transient resolve failure surfaces as a load/format error. Reload (which
      // re-requests the stream → re-resolves on the backend) and retry a couple of times.
      if (attempt < 2 && el.error) {
        await new Promise(r => setTimeout(r, 1500))
        el.load()
        return this.playDeck(deck, attempt + 1)
      }
      console.warn('[radio] deck play() rejected', deck, e)
    }
  }

  private onMeta(el: HTMLMediaElement): Promise<void> {
    return new Promise(res => {
      if (el.readyState >= 1) return res()
      const h = () => { el.removeEventListener('loadedmetadata', h); res() }
      el.addEventListener('loadedmetadata', h)
      setTimeout(res, 3000)
    })
  }

  // Play a DJ blob over the bed; resolves when the voice finishes (or on error/no-audio).
  private async speak(dj: PreparedDj): Promise<void> {
    if (!dj.blobUrl) { await new Promise(r => setTimeout(r, 2400)); return }
    const el = this.ch.dj.el
    el.src = dj.blobUrl
    this.ramp('dj', 1, 0)
    await new Promise<void>(res => {
      const fin = () => { el.onended = null; el.onerror = null; res() }
      el.onended = fin; el.onerror = fin
      el.play().catch(fin)
    })
    URL.revokeObjectURL(dj.blobUrl)
  }

  // Intro: the DJ opens the show over the instrumental bed (no song playing yet — the first
  // song sits at the top of Up Next), then the song slides in for the DJ's final HEAD seconds
  // and takes over full. `toDeck` is cued but NOT yet playing on entry.
  private async introSegment(runId: number, toDeck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })
    this.raiseBed()

    if (!dj.blobUrl) {
      await new Promise(r => setTimeout(r, 2400))
      if (this.stale(runId)) return
    } else {
      const el = this.ch.dj.el
      el.src = dj.blobUrl
      this.ramp('dj', 1, 0)
      await this.onMeta(el)
      const djDur = isFinite(el.duration) && el.duration > 0 ? el.duration : 4
      const headDelay = Math.max(0, djDur - HEAD) * 1000
      setTimeout(async () => {
        if (this.stale(runId)) return
        await this.playDeck(toDeck)
        this.ramp(this.deckKey(toDeck), DUCK + 0.05, 1000)
      }, headDelay)
      await this.speak(dj)
      if (this.stale(runId)) return
    }

    // Hand off: fade the bed out exactly as the song fades in.
    this.lowerBed()
    await this.playDeck(toDeck)
    this.ramp(this.deckKey(toDeck), 1, FADE)
  }

  // Talk OVER the currently-playing song (used for the outro): duck the song, swell the
  // instrumental bed, speak, then bring the song back to full. No deck switch.
  private async talkOver(runId: number, deck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })
    this.raiseBed()
    this.ramp(this.deckKey(deck), DUCK, 700)
    await this.speak(dj)
    if (this.stale(runId)) return
    this.lowerBed()
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

  // Transition: DJ over the outgoing song's tail + the incoming song's head, bed underneath.
  private async transition(runId: number, fromDeck: number, toDeck: number, dj: PreparedDj) {
    this.set({ djText: dj.text, djSpeaking: true })
    this.raiseBed()
    this.ramp(this.deckKey(fromDeck), DUCK, FADE)

    if (!dj.blobUrl) {
      await new Promise(r => setTimeout(r, 2400))
      if (this.stale(runId)) return
      return this.finishTransition(runId, fromDeck, toDeck)
    }

    const el = this.ch.dj.el
    el.src = dj.blobUrl
    this.ramp('dj', 1, 0)
    await this.onMeta(el)
    const djDur = isFinite(el.duration) && el.duration > 0 ? el.duration : 4

    // Outgoing song's tail fades out after its TAIL seconds.
    setTimeout(() => {
      if (this.stale(runId)) return
      this.ramp(this.deckKey(fromDeck), 0, 1000)
      setTimeout(() => { if (!this.stale(runId)) this.deckEl(fromDeck).pause() }, 1100)
    }, TAIL * 1000)
    // Incoming song's head comes in (ducked) for the DJ's final HEAD seconds.
    const headDelay = Math.max(0, djDur - HEAD) * 1000
    setTimeout(async () => {
      if (this.stale(runId)) return
      await this.playDeck(toDeck)
      this.ramp(this.deckKey(toDeck), DUCK + 0.05, 1000)
    }, headDelay)

    await this.speak(dj)
    if (this.stale(runId)) return
    await this.finishTransition(runId, fromDeck, toDeck)
  }

  private async finishTransition(runId: number, fromDeck: number, toDeck: number) {
    this.lowerBed()
    this.ramp(this.deckKey(fromDeck), 0, 400)
    setTimeout(() => { if (!this.stale(runId)) this.deckEl(fromDeck).pause() }, 450)
    await this.playDeck(toDeck)
    this.ramp(this.deckKey(toDeck), 1, FADE)
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  async start(station: DjStation) {
    this.stop()
    this.ensureAudio()
    this.unlock()   // synchronous — must happen inside the click gesture
    const runId = ++this.runId

    this.set({
      active: true, station, phase: 'loading', loading: true, paused: false,
      queue: [], index: 0, currentTrack: null, nextTrack: null, djText: null, djSpeaking: false,
    })

    // Resolve the genre instrumental bed FIRST, and give it exclusive use of the yt-dlp slots
    // during the intro. On a cold start the bed and the first song used to resolve at the same
    // instant; the bed usually lost that race (or 502'd on the burst and needed a retry), so its
    // first `playing` event landed AFTER the DJ intro had already handed off — meaning the bed
    // was silent for the whole intro and only appeared from the second song on. We defer the
    // first song's resolve until the bed is actually playing.
    void this.startBed(runId, station)

    const queue = await this.loadQueue(station)
    if (this.stale(runId)) return
    if (!queue.length) { this.stop(); return }
    // DJ-first intro: nothing is "Now Playing" yet (currentTrack stays null) — the first song
    // sits at the top of Up Next while the DJ introduces the show over the bed.
    this.set({ queue, loading: false, phase: 'intro', index: 0, currentTrack: null, nextTrack: queue[0] })
    this.deck = 0

    // Generate the intro voice in parallel with the bed coming up — both take a few seconds, so
    // they overlap and neither alone gates the start.
    const introP = this.prepareDj({ station, track: queue[0], position: 'intro' })

    // Hold the intro until the bed is actually playing so the DJ ALWAYS opens over it (the cold
    // first resolve, including a possible 502 + retry, can take several seconds). Generous cap so
    // a genuinely dead bed still doesn't hang the station.
    await this.waitForBed(8000)
    if (this.stale(runId)) return

    // Bed is up (or gave up) — only now resolve/pre-buffer the first song, with the slots free.
    prewarmStream(queue[0].videoId, 'audio')
    this.cueSrc(0, queue[0].videoId)

    const intro = await introP
    if (this.stale(runId)) return
    await this.introSegment(runId, 0, intro)
    if (this.stale(runId)) return
    // Now the first song owns the mix → it becomes Now Playing.
    this.set({ currentTrack: queue[0], djSpeaking: false, djText: null })

    for (let i = 0; i < queue.length; i++) {
      if (this.stale(runId)) return
      const cur = queue[i]!
      const next = queue[i + 1] ?? null
      this.set({ index: i, currentTrack: cur, nextTrack: next, phase: 'playing' })

      const otherDeck = this.deck === 0 ? 1 : 0
      let preparedNext: Promise<PreparedDj> | null = null
      if (next) {
        prewarmStream(next.videoId, 'audio')
        this.cueSrc(otherDeck, next.videoId)   // pre-buffer so the head-overlap is instant
        preparedNext = this.prepareDj({ station, track: cur, next, position: 'transition' })
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

  skip() { this.skipResolve?.() }

  stop() {
    this.runId++
    this.skipResolve = null
    this.bedReady = false
    this.bedWanted = false
    if (this.built) {
      (Object.keys(this.ch) as ChKey[]).forEach(k => {
        const c = this.ch[k]
        if (c.ramp) { clearInterval(c.ramp); c.ramp = undefined }
        try { c.el.pause() } catch { /* noop */ }
      })
      this.ramp('d0', 0, 0); this.ramp('d1', 0, 0); this.ramp('bed', 0, 0); this.ramp('dj', 1, 0)
    }
    this.set({
      active: false, station: null, phase: 'idle', queue: [], index: 0,
      currentTrack: null, nextTrack: null, djText: null, djSpeaking: false, paused: false, loading: false,
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

  destroy() { this.stop() }
}
