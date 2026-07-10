// Renders an imported Guitar Pro / MusicXML tab and keeps its cursor in sync with the shared
// StemEngine's playback position - using alphaTab's own PlayerMode.EnabledExternalMedia rather
// than a hand-rolled tick/time mapping: alphaTab's synth stays completely silent (all real audio
// comes from the app's stem mixer), and we just feed it the engine's position every frame via
// an IExternalMediaHandler/output pair. That's what lets muting/soloing stems or slowing the
// tempo down for practice keep the tab in sync, unlike Ultimate Guitar's fixed-video sync.
//
// Display choices (all deliberate, tuned for practice-along rather than print):
//   • Dark-native ink via display.resources - alphaTab defaults to print-black, unreadable on
//     this app's dark surfaces.
//   • Tab staff only by default (fret numbers, StaveProfile.Tab) with a toggle to add standard
//     notation - the default ScoreTab profile stacks both and halves the readable size.
//   • The in-score title/artist block is hidden - the Studio header already shows both.
//   • GP files usually carry several instruments; a chip row picks which single track renders.
//
// A GP file's own written tempo rarely matches a real recording exactly (count-in, rubato, a
// different take's tempo) - `align` supplies two anchors ({startSec, endSec}, real seconds for
// the first/last bar) that get turned into alphaTab's native "backing track sync points" and
// linearly rescaled across every bar, the same affine-transform approach Ultimate Guitar / DAW
// warp markers use for the same problem.
import { useEffect, useRef, useState } from 'react'
import { AlphaTabApi, PlayerMode, StaveProfile, NotationElement, midi } from '@coderline/alphatab'
import type { synth } from '@coderline/alphatab'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import type { StemEngine } from '@/lib/music/stemEngine'
import type { StudioTabAlign } from '@/lib/music/studioApi'

/** The recording's measured timing from the Studio analysis job: detected BPM plus the full
 *  per-beat time grid. Used to lock the tab to THIS audio when no manual anchors are set. */
export interface TabAutoSync { bpm: number | null; beats: { time: number; downbeat?: boolean }[] | null }

/** Detected beats per written quarter note. Beat trackers make octave errors (report half or
 *  double the written pulse), so snap the ratio to x0.5/x1/x2 - a genuine tab/recording tempo
 *  gap is small, an octave gap is not. */
function beatsPerQuarter(gpBpm: number, realBpm: number): number {
  if (!(gpBpm > 0) || !(realBpm > 0)) return 1
  const raw = realBpm / gpBpm
  return [0.5, 1, 2].reduce((best, k) => (Math.abs(k - raw) < Math.abs(best - raw) ? k : best), 1)
}

/** Time of fractional beat index `x` in the recording, off the measured grid; linear between
 *  neighbours, extrapolated past the end at the tail's average beat length (tabs regularly
 *  notate a couple of bars past where the beat tracker gave up in the fade-out). */
function beatTimeAt(beatTimes: number[], x: number): number {
  const n = beatTimes.length
  const last = n - 1
  if (x >= last) {
    const tailSpan = Math.min(8, last)
    const avg = tailSpan > 0 ? (beatTimes[last]! - beatTimes[last - tailSpan]!) / tailSpan : 0.5
    return beatTimes[last]! + (x - last) * avg
  }
  const i = Math.max(0, Math.floor(x))
  const frac = x - i
  return beatTimes[i]! + (beatTimes[i + 1]! - beatTimes[i]!) * frac
}

function applyAlignment(api: AlphaTabApi, align: StudioTabAlign | null, auto: TabAutoSync | null) {
  const score = api.score
  const player = api.player
  if (!score || !player) return
  const points = midi.MidiFileGenerator.generateSyncPoints(score, true)
  if (points.length === 0) return
  if (align) {
    // Manual anchors win: the user told us where the tab's first and last bar really fall.
    const first = points[0]!
    const last = points[points.length - 1]!
    const span = last.synthTime - first.synthTime
    const scale = span > 0 ? (align.endSec * 1000 - align.startSec * 1000) / span : 1
    for (const p of points) p.syncTime = align.startSec * 1000 + (p.synthTime - first.synthTime) * scale
  } else if (auto?.beats && auto.beats.length >= 8) {
    // Lyrics-style lock: pin every sync point to the MEASURED time of its beat in this exact
    // recording (the analysis job's beat grid), not to any tempo number. Written tempo being
    // wrong, a take that drifts, gradual slowdowns - all absorbed, because each bar maps to
    // where its beat actually happens in the audio.
    // Walk the GP timeline converting each point's position to quarter notes from the start
    // (piecewise: tempo is constant between generated sync points), then to a beat index.
    const perQuarter = beatsPerQuarter(points[0]!.synthBpm || score.tempo, auto.bpm ?? 0)
    const beatTimes = auto.beats.map((b) => b.time)
    let quarterNotes = 0
    for (let i = 0; i < points.length; i++) {
      if (i > 0) quarterNotes += ((points[i]!.synthTime - points[i - 1]!.synthTime) * points[i - 1]!.synthBpm) / 60000
      points[i]!.syncTime = beatTimeAt(beatTimes, quarterNotes * perQuarter) * 1000
    }
  } else if (auto?.bpm) {
    // No usable beat grid - fall back to a plain tempo rescale (written vs detected BPM).
    const gpBpm = points[0]!.synthBpm || score.tempo
    const scale = gpBpm > 0 && auto.bpm > 0 ? gpBpm / (auto.bpm * beatsPerQuarter(gpBpm, auto.bpm)) : 1
    for (const p of points) p.syncTime = p.synthTime * (scale >= 0.7 && scale <= 1.4 ? scale : 1)
  } else {
    return
  }
  for (let i = 0; i < points.length; i++) {
    const next = points[i + 1] ?? points[i]!
    points[i]!.updateSyncBpm(next.synthTime, next.syncTime)
  }
  player.updateSyncPoints(points)
}

// design-ok(hex-in-tsx): alphaTab canvas ink - rendered inside SVG, CSS vars don't reach it
const INK = {
  main: '#e4e4e7',        // zinc-200: note heads, fret numbers, stems
  secondary: '#a1a1aa',   // zinc-400: rests, grace notes, deemphasized glyphs
  staffLine: '#4b4b55',
  barSeparator: '#5d5d68',
  barNumber: '#f9861a',   // brand accent - matches the Studio transport
}

export function AlphaTabView({ fileUrl, engine, align, autoSync = null }: {
  fileUrl: string
  engine: StemEngine
  align: StudioTabAlign | null
  autoSync?: TabAutoSync | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<AlphaTabApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<{ index: number; name: string }[]>([])
  const [activeTrack, setActiveTrack] = useState(0)
  const [showNotation, setShowNotation] = useState(false)
  const alignRef = useRef(align)
  alignRef.current = align
  const autoSyncRef = useRef(autoSync)
  autoSyncRef.current = autoSync

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let cancelled = false
    setError(null)
    setTracks([])
    setActiveTrack(0)

    const api = new AlphaTabApi(el, {
      core: { fontDirectory: '/alphatab/font/', useWorkers: false },
      display: {
        staveProfile: StaveProfile.Tab,
        resources: {
          mainGlyphColor: INK.main,
          secondaryGlyphColor: INK.secondary,
          staffLineColor: INK.staffLine,
          barSeparatorColor: INK.barSeparator,
          barNumberColor: INK.barNumber,
          scoreInfoColor: INK.main,
        },
      },
      // Title/artist/copyright block is redundant here (the Studio header shows the song) and
      // eats half a screen; tuning stays since it's practice-relevant.
      notation: {
        elements: new Map<NotationElement, boolean>([
          [NotationElement.ScoreTitle, false], [NotationElement.ScoreSubTitle, false],
          [NotationElement.ScoreArtist, false], [NotationElement.ScoreAlbum, false],
          [NotationElement.ScoreWords, false], [NotationElement.ScoreMusic, false],
          [NotationElement.ScoreWordsAndMusic, false], [NotationElement.ScoreCopyright, false],
          [NotationElement.TrackNames, false],
        ]),
      },
      player: { playerMode: PlayerMode.EnabledExternalMedia, scrollElement: el },
    })
    apiRef.current = api

    api.error.on((e) => { if (!cancelled) setError((e as Error)?.message || 'Could not render this tab file') })

    api.scoreLoaded.on((score) => {
      if (cancelled) return
      setTracks(score.tracks.map((t) => ({ index: t.index, name: t.name || `Track ${t.index + 1}` })))
      setActiveTrack(0)
      // Sync points need BOTH the parsed score and the ready player, and either event can fire
      // first (the file is fetched+parsed async while the player boots) - applying from both
      // callbacks guarantees the one that runs last actually lands the sync map. Missing this
      // from scoreLoaded left playback on alphaTab's identity timeline (the file's written
      // tempo), which ran visibly faster than the real recording.
      applyAlignment(api, alignRef.current, autoSyncRef.current)
    })

    // play/pause are deliberately no-ops: this view never renders alphaTab's own transport
    // controls, so the only caller of these is alphaTab syncing its assumed initial state on
    // startup (it defaults to "paused") - forwarding that to the engine would silently stop
    // playback just from opening this tab. seekTo stays wired up since clicking a note in the
    // rendered notation to jump there is a real, wanted interaction.
    const handler: synth.IExternalMediaHandler = {
      get backingTrackDuration() { return (engine.getDuration() || 0) * 1000 },
      playbackRate: 1,
      masterVolume: 1,
      seekTo: (time: number) => engine.seek(time / 1000),
      play: () => {},
      pause: () => {},
    }

    api.playerReady.on(() => {
      const player = api.player
      if (!player) return
      const output = player.output as unknown as synth.IExternalMediaSynthOutput
      output.handler = handler
      applyAlignment(api, alignRef.current, autoSyncRef.current)
    })

    fetch(fileUrl).then((r) => r.arrayBuffer()).then((buf) => { if (!cancelled) api.load(new Uint8Array(buf)) })
      .catch(() => { if (!cancelled) setError('Could not load this tab file') })

    return () => { cancelled = true; api.destroy() }
  }, [fileUrl, engine])

  // Re-apply alignment if it changes (e.g. the user just saved a new sync range, or the
  // analysis finished and the beat grid arrived) without reloading the whole file.
  useEffect(() => {
    const api = apiRef.current
    if (api?.score && api.player) applyAlignment(api, align, autoSync)
  }, [align, autoSync?.bpm, autoSync?.beats?.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drive the cursor from the shared engine's position every frame - this is the whole sync
  // mechanism; alphaTab does the tick math and cursor/auto-scroll internally from here.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const output = apiRef.current?.player?.output as unknown as synth.IExternalMediaSynthOutput | undefined
      if (output) output.updatePosition(engine.getPosition() * 1000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  function selectTrack(index: number) {
    const api = apiRef.current
    const track = api?.score?.tracks[index]
    if (!api || !track) return
    setActiveTrack(index)
    api.renderTracks([track])
  }

  function toggleNotation() {
    const api = apiRef.current
    if (!api) return
    const next = !showNotation
    setShowNotation(next)
    api.settings.display.staveProfile = next ? StaveProfile.ScoreTab : StaveProfile.Tab
    api.updateSettings()
    api.render()
  }

  return (
    <div className="space-y-2">
      {(tracks.length > 1 || tracks.length === 1) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {tracks.length > 1 && tracks.map((t) => (
            <Button key={t.index} size="sm" variant={t.index === activeTrack ? 'default' : 'outline'} onClick={() => selectTrack(t.index)}>
              {t.name}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={toggleNotation}
            className={cn('ml-auto text-muted-foreground', showNotation && 'text-foreground')}>
            {showNotation ? 'Hide notation' : 'Show notation'}
          </Button>
        </div>
      )}

      <div className="alphatab-host rounded-card border border-border/60 bg-card/40 p-2">
        {/* Cursor + note-highlight styling: alphaTab injects .at-cursor-bar/.at-cursor-beat divs
            and .at-highlight glyph classes; they're only themeable via CSS.
            design-ok(hex-in-tsx): alphaTab SVG glyph fill - CSS vars don't reach its renderer */}
        <style>{`
          .alphatab-host .at-cursor-bar { background: rgba(249, 134, 26, 0.08); }
          .alphatab-host .at-cursor-beat { background: rgba(249, 134, 26, 0.75); width: 2px; }
          .alphatab-host .at-highlight * { fill: #f9861a; stroke: #f9861a; }
        `}</style>
        {error && <p className="p-2 text-sm text-destructive">{error}</p>}
        <div ref={containerRef} className="overflow-auto" />
      </div>
    </div>
  )
}
