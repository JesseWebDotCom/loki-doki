import { ChevronLeft, ChevronRight, Ear } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useRadio } from '@/context/RadioContext'
import { AudioVisualizer, useVisualizerPref } from '@/components/shared/AudioVisualizer'
import { useArtPalette } from '@/lib/artPalette'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { CompanionComposer } from '@/components/shell/CompanionComposer'
import { Indicator } from '@/components/shell/CompanionDock'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import { PendingActionButtons } from '@/components/companion/PendingActionButtons'
import { useVisionStatus } from '@/hooks/useVisionStatus'
import { IslandTopBar, ISLAND_TABS, type IslandTab } from './IslandTopBar'
import { IslandPageHome } from './pages/IslandPageHome'
import { IslandPageMusic } from './pages/IslandPageMusic'
import { IslandPageWeather } from './pages/IslandPageWeather'
import { IslandPageCalendar } from './pages/IslandPageCalendar'
import { IslandPageShelf } from './pages/IslandPageShelf'
import { IslandPageFocus } from './pages/IslandPageFocus'
import { IslandPageSettings } from './pages/IslandPageSettings'
import type { NowPlayingInfo } from './useNowPlaying'

// Full panel (SuperIsland's fullExpanded): toolbar with module tabs over the
// active page, side chevrons cycling pages, and the companion row + composer
// pinned at the bottom so conversation coexists with any page.

export function IslandFullExpanded({ nowPlaying, tab, setTab, onOpenMenu, topInset }: {
  nowPlaying: NowPlayingInfo | null
  tab: IslandTab
  setTab: (t: IslandTab) => void
  onOpenMenu: () => void
  /** Notch strip height: the top bar fills it (shoulder layout) so everything
   *  below is clear of the physical notch cutout. */
  topInset: number
}) {
  const engine = useCompanionEngine()
  const visionStatus = useVisionStatus()
  const radio = useRadio()
  const stripVariant = useVisualizerPref()
  const palette = useArtPalette(nowPlaying?.artUrl)
  // The ambient strip mirrors NowPlayingOverlay's: only for tier-1 radio (the
  // Web Audio analyser lives in this window), behind all panel content.
  const showStrip = radio.visualizerEnabled && nowPlaying?.tier === 1 && nowPlaying.source === 'radio'

  const cycleTab = (dir: 1 | -1) => {
    const i = ISLAND_TABS.indexOf(tab)
    const next = i === -1 ? 0 : (i + dir + ISLAND_TABS.length) % ISLAND_TABS.length
    setTab(ISLAND_TABS[next]!)
  }

  const avatar = engine.character ? (
    <CharacterAvatar
      className="pointer-events-none"
      character={engine.character}
      {...engine.avatarProps}
      size={40}
      suppressOverlays
    />
  ) : (
    <CompanionOrb size={40} active={!engine.sleeping} />
  )

  const statusText = engine.lookingAtScreen ? 'Looking at your screen…'
    : engine.thinking ? '…'
    : engine.captionText || engine.handsFreePartial || engine.pendingAction?.summary || ''

  const earToggle = () => {
    const next = !engine.handsFreeOn
    engine.setHandsFree(next)
    if (next) engine.setVoice(true)
  }

  return (
    <div className="relative flex flex-col gap-2 px-3 pb-3">
      {/* Top bar + page share a stacking scope so the ambient visualizer strip
          can sit behind the PAGE content specifically. Anchored to this
          wrapper's bottom, it ends where the companion row begins, instead of
          disappearing behind the opaque composer. */}
      <div className="relative isolate">
        {showStrip && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-36 overflow-hidden">
            <AudioVisualizer
              variant={stripVariant}
              mode="strip"
              active={!radio.paused}
              getAnalyser={radio.getAnalyser}
              palette={palette}
              opacity={0.4}
              fade
            />
          </div>
        )}
        <IslandTopBar tab={tab} setTab={setTab} topInset={topInset} />

        {/* Active page; keyed so tab changes crossfade. Fixed height so swaps
            never resize the island. */}
        <div key={tab} className="island-swap h-[268px] overflow-y-auto px-6 py-1">
          {tab === 'home' && <IslandPageHome nowPlaying={nowPlaying} />}
          {tab === 'music' && <IslandPageMusic onStarted={() => setTab('home')} />}
          {tab === 'weather' && <IslandPageWeather />}
          {tab === 'calendar' && <IslandPageCalendar />}
          {tab === 'shelf' && <IslandPageShelf />}
          {tab === 'focus' && <IslandPageFocus />}
          {tab === 'settings' && <IslandPageSettings />}
        </div>
      </div>

      {/* Side chevrons cycle the module pages (SuperIsland gutter arrows) */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous page"
        onClick={() => cycleTab(-1)}
        // design-ok(glass-on-plain-bg): sits inside the black island surface
        className="absolute left-1 top-1/2 size-7 -translate-y-1/2 rounded-full text-white/40 hover:bg-white/10 hover:text-white"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next page"
        onClick={() => cycleTab(1)}
        // design-ok(glass-on-plain-bg): sits inside the black island surface
        className="absolute right-1 top-1/2 size-7 -translate-y-1/2 rounded-full text-white/40 hover:bg-white/10 hover:text-white"
      >
        <ChevronRight className="size-4" />
      </Button>

      {/* Companion row: always mounted, so conversation overlays any page */}
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Open Loki Doki"
          title="Open Loki Doki (right-click for companion menu)"
          className="shrink-0"
          onClick={() => window.lokiDesktop?.openMainWindow()}
          onContextMenu={(e) => { e.preventDefault(); onOpenMenu() }}
        >
          {avatar}
        </button>
        <Indicator icon={Ear} label="Hands-free (wake word)" state={engine.listeningState} onClick={earToggle} />
        {statusText ? (
          // design-ok(adhoc-pulse): thinking ellipsis pulses by design, matching the dock's typing indicator
          <span className={cn(
            'min-w-0 flex-1 text-sm leading-snug text-white/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden',
            engine.thinking && 'animate-pulse',
          )}>
            {statusText}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-white/60">
            {engine.character ? engine.character.name : 'Loki Doki'}
          </span>
        )}
        {/* No Stop button here: the composer's send control below already
            morphs into Stop while generating; two stops read as clutter. */}
      </div>

      {/* Confirmation offer */}
      {engine.pendingAction && (
        <PendingActionButtons
          action={engine.pendingAction}
          onApprove={engine.approvePendingAction}
          onDecline={engine.declinePendingAction}
          tone="dark"
          className="mt-0"
        />
      )}

      {/* Typed input */}
      <CompanionComposer
        onSend={(text, files) => engine.handleSend(text, files)}
        onStop={engine.onStop}
        isGenerating={engine.busy}
        isThinking={engine.thinking}
        focusKey={engine.focusKey}
        visionAvailable={visionStatus?.available ?? true}
        placeholder={engine.character ? `Ask ${engine.character.name}…` : 'Message Loki Doki…'}
      />
    </div>
  )
}
