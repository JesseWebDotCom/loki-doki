import { Mic, Volume2, VolumeX, Loader2, Pause, Play, SkipForward } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { DJ_STATIONS, type DjStation } from '@/lib/music/radioStations'

function WaveBar({ active, color }: { active: boolean; color: string }) {
  return (
    <div className={cn('flex items-end gap-[2px] transition-opacity', active ? 'opacity-100' : 'opacity-0')}>
      {[3, 5, 4, 6, 3, 5, 3].map((h, i) => (
        <div key={i} className="w-[2.5px] rounded-full"
          style={{ height: `${h * 2}px`, background: color,
            animation: active ? `wave 0.8s ease-in-out ${i * 0.1}s infinite alternate` : 'none' }} />
      ))}
      <style>{`@keyframes wave{from{transform:scaleY(0.3)}to{transform:scaleY(1)}}`}</style>
    </div>
  )
}

export function RadioTab() {
  const radio = useRadio()
  const pb = useYoutubePlayback()

  const { station, queue, index, currentTrack, djText, djSpeaking, phase, paused, volume, muted } = radio
  const isActive = radio.active
  const loadingTracks = phase === 'loading'
  // During the DJ intro nothing is "Now Playing" yet — the first song sits at the top of
  // Up Next while the DJ introduces the show. After that, Up Next is what follows the current.
  const upNext = phase === 'intro' ? queue.slice(0, 5) : queue.slice(index + 1, index + 6)

  function startStation(st: DjStation) {
    pb.close()           // radio takes over audio — clear any docked YouTube player
    radio.start(st)
  }

  return (
    <div className="space-y-6">
      {/* Station grid (idle state) */}
      {!isActive && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold tracking-tight">AI Radio Stations</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Your companion hosts — talks over the breaks with quick facts, music humming underneath.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {DJ_STATIONS.map((st) => (
              <button key={st.id} type="button"
                onClick={() => startStation(st)}
                disabled={loadingTracks}
                className="group relative flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl p-4 transition-transform hover:scale-[1.03] active:scale-[0.98] disabled:opacity-60"
                style={{ background: `linear-gradient(135deg, ${st.color}, ${st.colorDark})` }}>
                <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                <span className="relative text-4xl drop-shadow-sm">{st.emoji}</span>
                <span className="relative font-bold text-white text-sm drop-shadow">{st.label}</span>
                {loadingTracks && station?.id === st.id && (
                  <Loader2 className="absolute bottom-3 right-3 size-4 animate-spin text-white/70" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active station player */}
      {isActive && station && (
        <div className="space-y-4">
          {/* Hero card */}
          <div className="relative overflow-hidden rounded-2xl"
            style={{ background: `linear-gradient(135deg, ${station.color}, ${station.colorDark})` }}>
            <div className="absolute inset-0 bg-black/20" />

            {/* On Air bar */}
            <div className="relative flex items-center justify-between px-4 pt-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex size-2 animate-pulse rounded-full bg-white" />
                <span className="text-xs font-bold uppercase tracking-widest text-white/80">On Air</span>
              </div>
              <button type="button" onClick={radio.stop}
                className="rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors">
                Stop
              </button>
            </div>

            {/* Main content */}
            <div className="relative flex items-center gap-4 p-4">
              <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-5xl">
                {station.emoji}
              </div>
              <div className="min-w-0 flex-1 text-white">
                <p className="text-xl font-bold leading-tight">{station.label}</p>
                <p className="text-sm capitalize text-white/60">{station.genre}</p>
                {loadingTracks && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-white/70">
                    <Loader2 className="size-3.5 animate-spin" /> Tuning in…
                  </div>
                )}
                {phase === 'playing' && !paused && <WaveBar active color="rgba(255,255,255,0.9)" />}
              </div>
            </div>

            {/* DJ speaking */}
            {djSpeaking && (
              <div className="relative mx-4 mb-4 rounded-xl bg-black/20 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Mic className="size-3.5 text-white/80" />
                  <span className="text-xs font-bold text-white/80">DJ on the mic…</span>
                </div>
                {djText && <p className="text-xs italic leading-relaxed text-white/70">&ldquo;{djText}&rdquo;</p>}
              </div>
            )}

            {/* Current track */}
            {currentTrack && (phase === 'playing' || phase === 'transition') && (
              <div className="relative mx-4 mb-4 flex items-center gap-3 rounded-xl bg-black/20 p-3">
                <img src={currentTrack.thumbnail} alt={currentTrack.title}
                  className="h-14 w-[88px] shrink-0 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-white/50 mb-0.5">Now Playing</p>
                  <p className="truncate text-sm font-semibold text-white">{currentTrack.title}</p>
                  {currentTrack.author && <p className="truncate text-xs text-white/60">{currentTrack.author}</p>}
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="relative flex items-center gap-3 px-4 pb-4">
              <button type="button" onClick={radio.toggleMute} className="text-white/70 hover:text-white transition-colors">
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                onChange={(e) => radio.setVolume(Number(e.target.value))}
                className="h-1 flex-1 accent-white opacity-80" />
              <button type="button" onClick={radio.togglePause}
                className="flex items-center gap-1.5 rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors">
                {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} {paused ? 'Resume' : 'Pause'}
              </button>
              <button type="button" onClick={radio.skip} disabled={phase !== 'playing'}
                className="flex items-center gap-1.5 rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40">
                <SkipForward className="size-3.5" /> Skip
              </button>
            </div>
          </div>

          {/* Queue */}
          {queue.length > 0 && (
            <div className="rounded-2xl border border-border bg-card/40 overflow-hidden">
              <p className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Up Next</p>
              <div className="max-h-52 overflow-y-auto">
                {upNext.map((t, i) => (
                  <div key={t.videoId} className="flex items-center gap-3 border-t border-border/40 px-4 py-2.5">
                    <span className="w-4 shrink-0 text-center text-xs text-muted-foreground/60">{i + 1}</span>
                    <img src={t.thumbnail} alt="" className="h-9 w-[56px] shrink-0 rounded-lg object-cover" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{t.title}</p>
                      {t.author && <p className="truncate text-[11px] text-muted-foreground">{t.author}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Change station */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Change Station</p>
            <div className="flex flex-wrap gap-2">
              {DJ_STATIONS.filter(s => s.id !== station.id).map((st) => (
                <button key={st.id} type="button" onClick={() => startStation(st)}
                  className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-transparent hover:text-white"
                  style={{ ['--hover-bg' as string]: st.color }}>
                  <span>{st.emoji}</span> {st.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
