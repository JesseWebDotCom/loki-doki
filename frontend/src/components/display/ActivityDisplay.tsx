// ActivityDisplay — rich now-playing display for the Pod 'activity' view.
// Shows music/YouTube (from the nowPlaying store) or Plex poster + progress.
// Falls back to a "Nothing playing" idle state when both are absent.

import type { UserPresence, NowPlaying, PlexActivity } from '@/lib/presence'
import { Card } from '@/components/ui/card'
import { StatusDot } from '@/components/shared/StatusDot'

interface Props {
  presence: UserPresence | null
}

// ── Shared progress bar ──────────────────────────────────────────────────────────
function ProgressBar({ progress, playing }: { progress: number; playing?: boolean }) {
  return (
    <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-1000 ${playing ? 'bg-white' : 'bg-white/50'}`}
        style={{ width: `${Math.round(progress * 100)}%` }}
      />
    </div>
  )
}

// ── Music / YouTube now-playing ─────────────────────────────────────────────────
function MusicView({ np }: { np: NowPlaying }) {
  const progress = np.durationSec > 0 ? Math.min(1, np.positionSec / np.durationSec) : 0

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0a0a12] select-none">
      {/* Blurred art background */}
      {np.cover && (
        <div
          className="absolute inset-0 bg-cover bg-center opacity-30 scale-110 blur-2xl"
          style={{ backgroundImage: `url(${np.cover})` }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

      {/* Main layout: art left, info right */}
      <div className="relative flex flex-row items-center h-full px-16 gap-12">
        {/* Album art */}
        {np.cover ? (
          <img
            src={np.cover}
            alt={np.title}
            className="w-64 h-64 rounded-card shadow-2xl object-cover flex-shrink-0"
          />
        ) : (
          <Card variant="flat" className="w-64 h-64 flex items-center justify-center flex-shrink-0">
            <span className="text-8xl">🎵</span>
          </Card>
        )}

        {/* Track info + progress */}
        <div className="flex flex-col gap-4 flex-1 min-w-0">
          {/* Playing indicator */}
          <div className="flex items-center gap-3">
            <StatusDot status={np.playing ? 'ok' : 'off'} pulse={np.playing} className="size-3" />
            <span className="text-white/60 text-2xl font-medium tracking-widest uppercase">
              {np.stationId ? 'AI Radio' : np.videoId ? 'YouTube' : 'Music'}
            </span>
          </div>

          {/* Title */}
          <div className="text-white font-bold text-5xl leading-tight truncate drop-shadow-lg">
            {np.title || 'Unknown Track'}
          </div>

          {/* Artist */}
          {np.artist && (
            <div className="text-white/70 text-3xl font-medium truncate">
              {np.artist}
            </div>
          )}

          {/* Progress */}
          {np.durationSec > 0 && (
            <div className="mt-4">
              <ProgressBar progress={progress} playing={np.playing} />
              <div className="flex justify-between text-white/50 text-xl mt-2 font-mono">
                <span>{formatTime(np.positionSec)}</span>
                <span>{formatTime(np.durationSec)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Plex poster view ─────────────────────────────────────────────────────────────
function PlexView({ plex }: { plex: PlexActivity }) {
  const isPlaying = plex.state === 'playing'
  const thumbUrl = plex.thumb ? `/api/plex/img?path=${encodeURIComponent(plex.thumb)}&w=600` : null

  return (
    <div className="fixed inset-0 flex flex-row bg-[#0a0a12] select-none">
      {/* Blurred poster background */}
      {thumbUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center opacity-20 scale-110 blur-2xl"
          style={{ backgroundImage: `url(${thumbUrl})` }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/40 to-transparent" />

      {/* Poster */}
      <div className="relative flex-shrink-0 h-full flex items-center pl-12">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={plex.title}
            className="h-[85%] rounded-card shadow-2xl object-cover"
            style={{ aspectRatio: plex.type === 'movie' ? '2/3' : '16/9' }}
          />
        ) : (
          <Card variant="flat" className="h-[85%] w-56 flex items-center justify-center">
            <span className="text-8xl">{plex.type === 'movie' ? '🎬' : '📺'}</span>
          </Card>
        )}
      </div>

      {/* Info */}
      <div className="relative flex flex-col justify-center flex-1 px-14 gap-5">
        {/* Plex badge */}
        <div className="flex items-center gap-3">
          <StatusDot status={isPlaying ? 'warn' : 'off'} pulse={isPlaying} className="size-3" />
          <span className="text-white/60 text-2xl font-medium tracking-widest uppercase">
            {plex.type === 'movie' ? 'Movie' : 'Series'} · Plex
          </span>
        </div>

        {/* Show title (for episodes) */}
        {plex.showTitle && (
          <div className="text-white/70 text-3xl font-medium truncate">{plex.showTitle}</div>
        )}

        {/* Episode/Movie title */}
        <div className="text-white font-bold text-5xl leading-tight">
          {plex.title}
        </div>

        {/* Playback state */}
        <div className="text-white/50 text-2xl font-medium capitalize">
          {isPlaying ? '▶ Playing' : '⏸ Paused'}
        </div>

        {/* Progress */}
        {plex.progress != null && (
          <div className="mt-2">
            <ProgressBar progress={plex.progress} playing={isPlaying} />
            <div className="text-white/40 text-xl mt-2 font-mono">
              {Math.round(plex.progress * 100)}%
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Idle / nothing playing ────────────────────────────────────────────────────────
function IdleView() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-[#0a0a12] select-none gap-6">
      <div className="text-[8rem] leading-none opacity-30">🎵</div>
      <div className="text-white/30 text-4xl font-medium tracking-wide">Nothing playing</div>
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────────
export function ActivityDisplay({ presence }: Props) {
  const np = presence?.nowPlaying ?? null
  const plex = presence?.plexActivity ?? null

  // Plex takes priority (video > audio)
  if (plex) return <PlexView plex={plex} />
  if (np) return <MusicView np={np} />
  return <IdleView />
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
