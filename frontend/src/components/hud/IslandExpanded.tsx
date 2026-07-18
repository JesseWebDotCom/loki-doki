import { Ear, Square } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { Indicator } from '@/components/shell/CompanionDock'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import { PendingActionButtons } from '@/components/companion/PendingActionButtons'
import { NowPlayingRow } from './NowPlayingModule'
import { WeatherChip } from './WeatherChip'
import type { NowPlayingInfo } from './useNowPlaying'

// Peek surface (SuperIsland's 408x88 expanded row). Conversation takes
// priority: while the companion is listening or replying this is the live
// caption row; otherwise it is a media summary row, else an idle glance
// (name + ear + weather).

export function IslandExpanded({ nowPlaying, topInset }: {
  nowPlaying: NowPlayingInfo | null
  /** Notch strip height: content starts below it so the physical notch never
   *  covers the caption/title (the strip itself stays pure black). */
  topInset: number
}) {
  const engine = useCompanionEngine()

  const speaking = engine.thinking || engine.streaming || engine.talkActive || !!engine.captionText || engine.lookingAtScreen || !!engine.pendingAction
  const listening = engine.listeningState === 'on-active' || engine.listeningState === 'on-followup' || !!engine.handsFreePartial
  const conversing = speaking || listening

  const avatar = engine.character ? (
    <CharacterAvatar
      className="pointer-events-none"
      character={engine.character}
      {...engine.avatarProps}
      size={44}
      suppressOverlays
    />
  ) : (
    <CompanionOrb size={44} active={!engine.sleeping} />
  )

  const statusText = engine.lookingAtScreen ? 'Looking at your screen…'
    : engine.thinking ? '…'
    : engine.captionText || engine.handsFreePartial || engine.pendingAction?.summary || ''

  const earToggle = () => {
    const next = !engine.handsFreeOn
    engine.setHandsFree(next)
    if (next) engine.setVoice(true)
  }

  const EventIcon = engine.capsuleEvent?.icon

  return (
    <div className="flex h-full items-center gap-2.5 px-3" style={{ paddingTop: topInset }}>
      <span className="shrink-0">{avatar}</span>
      <Indicator icon={Ear} label="Hands-free (wake word)" state={engine.listeningState} onClick={earToggle} />
      {conversing ? (
        <>
          {statusText ? (
            // design-ok(adhoc-pulse): thinking ellipsis pulses by design, matching the dock's typing indicator
            <span className={cn(
              'min-w-0 flex-1 text-sm leading-snug text-white/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden',
              engine.thinking && 'animate-pulse',
            )}>
              {statusText}
            </span>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-white/50">Listening…</span>
          )}
          {engine.pendingAction && (
            <PendingActionButtons
              action={engine.pendingAction}
              onApprove={engine.approvePendingAction}
              onDecline={engine.declinePendingAction}
              tone="dark"
              className="mt-0 w-52 shrink-0"
            />
          )}
          {/* Peek has no composer, so this is its only stop control; filled so
              it reads as a stop button rather than an empty checkbox. */}
          {engine.busy && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Stop"
              title="Stop"
              onClick={engine.onStop}
              // design-ok(glass-on-plain-bg): sits inside the black island surface
              className="size-8 shrink-0 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
        </>
      ) : engine.capsuleEvent?.nowPlaying && nowPlaying ? (
        // Track-change bloom: show the real player row (cover art + transport)
        // rather than a generic icon + text announcement.
        <NowPlayingRow info={nowPlaying} />
      ) : engine.capsuleEvent ? (
        <>
          {EventIcon && <EventIcon className="size-4 shrink-0 text-white/80" />}
          <span className="min-w-0 flex-1 truncate text-sm text-white/90">{engine.capsuleEvent.text}</span>
          {engine.capsuleEvent.actions?.slice(0, 3).map((a) => (
            <Button
              key={a.label}
              variant="ghost"
              size="sm"
              onClick={() => { a.run(); engine.dismissCapsuleEvent() }}
              // design-ok(glass-on-plain-bg): sits inside the black island surface
              className="h-8 shrink-0 rounded-full px-3 text-xs text-white/85 hover:bg-white/10 hover:text-white"
            >
              {a.label}
            </Button>
          ))}
        </>
      ) : nowPlaying ? (
        <NowPlayingRow info={nowPlaying} />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-sm text-white/70">
            {engine.character ? engine.character.name : 'Loki Doki'}
          </span>
          <WeatherChip />
        </>
      )}
    </div>
  )
}
