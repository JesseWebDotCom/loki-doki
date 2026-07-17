import { cn } from '@/lib/cn'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import { NowPlayingChip } from './NowPlayingModule'
import type { NowPlayingInfo } from './useNowPlaying'

// Compact island content. Notched displays: [left wing: companion avatar]
// [notch core: pure black spacer under the physical notch] [right wing:
// now-playing chip, else weather]. Non-notched: one slim pill with the same
// content and no core gap. The SHELL owns the container geometry (widths,
// radius, centering transform); this component just fills the row.

export const WING_L = 44
export const WING_R = 56
export const NOTCH_CORE_W = 200

// The right wing is CONTENT-DRIVEN, SuperIsland style: it exists only while
// media is playing. A standing chip (weather) would permanently overlap the
// menu bar's status items next to the notch (macOS exposes no API to know
// where those sit, so the only defense is a minimal idle footprint). Weather
// lives in the peek row and full panel instead.
export function IslandCompact({ notched, topInset, nowPlaying }: {
  notched: boolean
  topInset: number
  nowPlaying: NowPlayingInfo | null
}) {
  const engine = useCompanionEngine()
  const avatarPx = Math.max(20, (notched ? topInset : 28) - 8)
  const listening = engine.listeningState === 'on-active' || engine.listeningState === 'on-followup' || !!engine.handsFreePartial

  const avatarInner = engine.character ? (
    <CharacterAvatar
      className="pointer-events-none"
      character={engine.character}
      {...engine.avatarProps}
      size={avatarPx}
      suppressOverlays
    />
  ) : (
    <CompanionOrb size={avatarPx} active={!engine.sleeping} />
  )

  // Persistent mic-live indicator so "listening" is unmistakable even in the compact tier
  // (it otherwise only reads in peek/full). A small brand dot on the black island surface.
  const avatar = (
    <span className="relative inline-flex items-center justify-center">
      {avatarInner}
      {listening && (
        // design-ok(adhoc-pulse): the mic-live dot pulses by design, like the peek listening indicator
        <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-brand ring-2 ring-black animate-pulse" />
      )}
    </span>
  )

  const rightChip = nowPlaying ? <NowPlayingChip info={nowPlaying} /> : null

  if (!notched) {
    return (
      <div className="flex h-full items-center justify-between px-2.5">
        <span className="flex items-center">{avatar}</span>
        {rightChip}
      </div>
    )
  }

  return (
    <div className="flex h-full items-center">
      <div style={{ width: WING_L }} className="flex shrink-0 items-center justify-center">
        {avatar}
      </div>
      {/* The physical notch sits over this spacer; nothing may render here. */}
      <div style={{ width: NOTCH_CORE_W }} className="shrink-0" />
      <div
        style={{ width: rightChip ? WING_R : 0 }}
        className={cn('flex shrink-0 items-center justify-center overflow-hidden')}
      >
        {rightChip}
      </div>
    </div>
  )
}
