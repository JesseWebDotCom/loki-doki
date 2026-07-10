import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Captions, ChevronDown, CircleUser, Ear, Maximize2, Minimize2, Settings, Volume2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useActiveCompanion } from '@/hooks/useActiveCompanion'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CAPTION_STYLES, useCompanionState, type CaptionStyle, type CompanionSize } from '@/lib/companionState'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'

// The companion settings menu: who (avatar + favorites) over how (display size +
// feature tiles). Shared by the web dock (portals it ABOVE the dock, bottom-anchored)
// and the desktop HUD (portals it BELOW the notch capsule, top-anchored). Positioning
// is entirely the caller's job via `style`; the menu itself is placement-agnostic.

// The island's idle size: what it settles back to when nothing is happening.
// Storage values keep their historical names (companion.size); the labels
// describe the actual island states.
export const DISPLAY_MODES: { size: CompanionSize; label: string; desc: string; icon: typeof Minimize2 }[] = [
  { size: 'pill', label: 'Compact', desc: 'Notch bar only', icon: Minimize2 },
  { size: 'collapsed', label: 'Peek', desc: 'Summary row', icon: CircleUser },
  { size: 'expanded', label: 'Full', desc: 'Full panel', icon: Maximize2 },
]

// Feature toggle tile: icon over label, fills in when active.
function Tile({ icon: Icon, label, active, onClick, title }: {
  icon: typeof Ear; label: string; active: boolean; onClick: () => void; title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-1 rounded-control py-2.5 transition-colors',
        active
          ? 'bg-success/15 text-foreground ring-1 ring-inset ring-success/40'
          : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground',
      )}
    >
      <Icon className={cn('size-[18px]', active ? 'text-success' : 'text-muted-foreground/60')} />
      <span className="whitespace-nowrap text-[10px] font-medium leading-none">{label}</span>
    </button>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <div className="px-0.5 pb-1 text-overline text-muted-foreground/70">{children}</div>
}

export function CompanionMenu({ onClose, style, onBrowseCompanions, showDisplaySection }: {
  onClose: () => void
  style: React.CSSProperties
  /** Override for "Browse companions": the desktop HUD must open the MAIN window
   *  (its own window is the tiny capsule), so it passes an openMainWindow bridge
   *  call. Default: in-app navigation. An explicit prop rather than a
   *  window.lokiDesktop feature-detect, because the desktop MAIN window also has
   *  the bridge and should keep navigating in place. */
  onBrowseCompanions?: () => void
  /** Show the Mini/Docked/Max display picker (the HUD's capsule base size). */
  showDisplaySection?: boolean
}) {
  const { companion: character, companions: characters, setCompanion: setCharacter, clearCompanion: clearCharacter, favorites } = useActiveCompanion()
  const { captions, captionStyle, setCaptions, setCaptionStyle, voiceOn, handsFreeOn, setVoice, setHandsFree } = useCompanionEngine()
  const { size, setSize } = useCompanionState()
  const navigate = useNavigate()
  const browse = onBrowseCompanions ?? (() => navigate('/companions'))
  // Quick-switch favorites (excluding whoever's already active), capped at 5 avatar chips.
  const quickFavorites = characters.filter((ch) => favorites.includes(ch.id) && ch.id !== character?.id).slice(0, 5)
  // Close on any pointer-down outside the menu. A document-level listener (instead
  // of a backdrop element) survives transformed ancestors. Attach on the next tick
  // so the click that opened the menu doesn't immediately close it.
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const id = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0)
    return () => { clearTimeout(id); document.removeEventListener('pointerdown', onDown, true) }
  }, [onClose])
  return (
    <div ref={menuRef} style={style} className="w-60 rounded-sheet border border-border bg-popover p-2 shadow-2xl">
      {/* WHO, companion identity + quick switch */}
      <SectionLabel>Companion</SectionLabel>
      <div className="flex items-center gap-2 px-0.5">
        <span className={cn('flex size-8 shrink-0 items-center justify-center', !character && 'overflow-hidden rounded-full bg-muted')}>
          {character ? <CharacterAvatar character={character} size={32} /> : <Bot className="size-4 text-muted-foreground" />}
        </span>
        <span className="flex-1 truncate text-sm font-semibold text-foreground">{character?.name ?? 'No companion'}</span>
        {character && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Turn off companion"
            title="Turn off companion"
            className="text-muted-foreground"
            onClick={() => { clearCharacter(); onClose() }}
          >
            <Bot className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Browse companions"
          title="Browse companions"
          className="text-muted-foreground"
          onClick={() => { browse(); onClose() }}
        >
          <Settings className="size-4" />
        </Button>
      </div>

      {quickFavorites.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 px-0.5">
          {quickFavorites.map((ch) => (
            <button
              key={`fav-${ch.id}`}
              type="button"
              onClick={() => { setCharacter(ch.id); onClose() }}
              title={`Switch to ${ch.name}`}
              className={cn('size-7 shrink-0 opacity-85 transition hover:scale-110 hover:opacity-100')}
            >
              <CharacterAvatar className="pointer-events-none" character={ch} size={28} />
            </button>
          ))}
        </div>
      )}

      <div className="my-2 h-px bg-border" />

      {/* Display size, segmented control: exactly one of Mini / Docked / Max */}
      {showDisplaySection && (
        <>
          <SectionLabel>Display</SectionLabel>
          <div className="mb-2.5 flex rounded-control bg-muted p-0.5">
            {DISPLAY_MODES.map((m) => (
              <button
                key={m.size}
                type="button"
                title={m.desc}
                onClick={() => { setSize(m.size); onClose() }}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-control py-1.5 text-[11px] font-medium transition-colors',
                  size === m.size
                    ? 'bg-brand/20 text-foreground shadow-sm ring-1 ring-inset ring-brand/40'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <m.icon className={cn('size-3.5', size === m.size && 'text-brand')} />
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Feature toggles, independent on/off tiles */}
      <SectionLabel>Interaction</SectionLabel>
      <div className="flex gap-1.5">
        <Tile icon={Volume2} label="Voice" active={voiceOn} onClick={() => setVoice(!voiceOn)} />
        {/* Enabling hands-free implies Voice, the loop advances on TTS playback end. */}
        <Tile icon={Ear} label="Hands-free" active={handsFreeOn} onClick={() => { const next = !handsFreeOn; setHandsFree(next); if (next) setVoice(true) }} />
        <Tile icon={Captions} label="Captions" active={captions} onClick={() => setCaptions(!captions)} />
      </div>

      {/* Caption style, dropdown, only when captions are on */}
      {captions && (
        <div className="mt-2.5">
          <SectionLabel>Caption Style</SectionLabel>
          <div className="relative">
            <select
              value={captionStyle}
              onChange={(e) => setCaptionStyle(e.target.value as CaptionStyle)}
              className="w-full cursor-pointer appearance-none rounded-control bg-muted py-1.5 pl-2.5 pr-7 text-xs capitalize text-foreground ring-1 ring-inset ring-border outline-none transition-colors hover:bg-muted/70 focus:ring-brand/40"
            >
              {CAPTION_STYLES.map((s: CaptionStyle) => (
                <option key={s} value={s} className="bg-popover capitalize text-foreground">{s}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          </div>
        </div>
      )}
    </div>
  )
}
