import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bot, Captions, ChevronDown, Ear, Settings, Square, Volume2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/shared/StatusDot'
import { useActiveCompanion } from '@/hooks/useActiveCompanion'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { useHeadTilt, type HeadTiltState } from '@/components/companion/useHeadTilt'
import SleepingZs from '@/components/companion/SleepingZs'
import { CAPTION_STYLES, type CaptionStyle } from '@/lib/companionState'
import { CompanionComposer } from './CompanionComposer'
import { useCompanionEngine, type IndicatorState } from './CompanionEngineContext'

// The companion's permanent home at the bottom of the left sidebar (desktop).
// Self-contained: everything comes from useCompanionEngine(). Flyouts (speech
// bubble, composer, menu) render through portals anchored to the dock so the
// sidebar's overflow never clips them.

const FLYOUT_W = 360
const MENU_W = 240

// ── Indicator (toggle pills), ported glow/pulse states on semantic tokens ──────
const INDICATOR_CLASS: Record<IndicatorState, string> = {
  off: 'bg-transparent text-muted-foreground/50',
  'on-idle': 'bg-foreground/10 text-foreground/80 ring-1 ring-foreground/20',
  // design-ok(adhoc-pulse): live-capture indicator pulses by design
  'on-active': 'bg-success/20 text-success ring-1 ring-success shadow-[0_0_18px_var(--success)] animate-pulse',
  // Follow-up window: listening for your reply WITHOUT a wake word. Info pulse so
  // it reads clearly distinct from idle (dim) and active capture (success).
  // design-ok(adhoc-pulse): follow-up window indicator pulses by design
  'on-followup': 'bg-info/20 text-info ring-1 ring-info shadow-[0_0_14px_var(--info)] animate-pulse',
}

function Indicator({ icon: Icon, label, state, onClick }: { icon: typeof Ear; label: string; state: IndicatorState; onClick?: () => void }) {
  const cls = cn('flex size-8 items-center justify-center rounded-full transition-all', INDICATOR_CLASS[state], onClick && 'cursor-pointer hover:brightness-125')
  const aria = `${label}: ${state === 'on-active' ? 'active' : state === 'on-followup' ? 'listening for follow-up' : state === 'on-idle' ? 'on' : 'off'}`
  const titleText = state === 'on-followup' ? 'Listening, reply now, no wake word needed' : `${label}, click to toggle`
  if (onClick) {
    return (
      <button type="button" aria-label={aria} title={titleText} onClick={onClick} className={cls}>
        <Icon className="size-4" />
      </button>
    )
  }
  return (
    <div role="status" aria-label={aria} title={label} className={cls}>
      <Icon className="size-4" />
    </div>
  )
}

// Rightmost indicator doubles as Stop while the companion is generating or
// speaking. Always renders the same <button> node in both states (only its
// icon/class/handler change) so React never unmounts-and-remounts it mid-click —
// a stray click landing exactly as speech ends can't misfire the captions
// toggle underneath it.
function CaptionsOrStop({ busy, karaokeState, captions, setCaptions, onStop }: {
  busy: boolean; karaokeState: IndicatorState; captions: boolean; setCaptions: (on: boolean) => void; onStop: () => void
}) {
  const cls = cn(
    'flex size-8 items-center justify-center rounded-full transition-all cursor-pointer hover:brightness-125',
    busy ? 'bg-destructive/20 text-destructive ring-1 ring-destructive/40' : INDICATOR_CLASS[karaokeState],
  )
  return (
    <button
      type="button"
      aria-label={busy ? 'Stop generating and speaking' : `Captions: ${karaokeState === 'on-active' ? 'active' : karaokeState === 'on-idle' ? 'on' : 'off'}`}
      title={busy ? 'Stop generating and speaking' : 'Captions, click to toggle'}
      onClick={busy ? onStop : () => setCaptions(!captions)}
      className={cls}
    >
      {busy ? <Square className="size-3.5 fill-current" /> : <Captions className="size-4" />}
    </button>
  )
}

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

// ── Companion settings menu: who (avatar + favorites) over how (feature tiles) ──
function CompanionMenu({ onClose, style }: { onClose: () => void; style: React.CSSProperties }) {
  const { companion: character, companions: characters, setCompanion: setCharacter, clearCompanion: clearCharacter, favorites } = useActiveCompanion()
  const { captions, captionStyle, setCaptions, setCaptionStyle, voiceOn, handsFreeOn, setVoice, setHandsFree } = useCompanionEngine()
  const navigate = useNavigate()
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
          onClick={() => { navigate('/companions'); onClose() }}
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

function TypingIndicator() {
  return (
    <>
      <style>{`
        @keyframes ld-dot-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.45; }
          30% { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
      <span className="inline-flex items-center gap-[5px] py-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{ animation: `ld-dot-bounce 1.1s ease-in-out ${i * 0.18}s infinite` }}
            className="size-2 rounded-full bg-foreground/70"
          />
        ))}
      </span>
    </>
  )
}

// Typewriter caption reveal. The bubble provides the surface; this renders only
// the styled text (caption style variants ride on the text itself).
function Subtitle({ text, style }: { text: string; style: CaptionStyle }) {
  const [displayed, setDisplayed] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (!text) { setDisplayed(''); return }
    setDisplayed('')
    let i = 0
    timerRef.current = setInterval(() => {
      i += 2
      if (i >= text.length) {
        setDisplayed(text)
        clearInterval(timerRef.current!)
        timerRef.current = null
      } else {
        setDisplayed(text.slice(0, i))
      }
    }, 16)
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
  }, [text])

  if (!displayed) return null
  const styleCls =
    style === 'bold' ? 'text-sm font-bold text-foreground'
    : style === 'enlarge' ? 'text-xl font-medium text-foreground'
    : style === 'underline' ? 'text-sm text-foreground underline decoration-brand decoration-2 underline-offset-2'
    : style === 'accent' ? 'text-sm font-medium text-brand'
    : style === 'highlight' ? 'box-decoration-clone rounded-control bg-brand/15 px-1 py-0.5 text-sm font-medium text-foreground'
    : 'text-sm text-foreground/90'
  return <span className={cn('leading-snug', styleCls)}>{displayed}</span>
}

// Flyout anchor derived from the dock's viewport rect. Flips to the left side
// when the dock sits near the right viewport edge (e.g. the /display kiosk).
interface FlyoutAnchor {
  side: 'right' | 'left'
  x: number
  bottom: number
  menuLeft: number
  menuBottom: number
}

function measureAnchor(el: HTMLElement): FlyoutAnchor {
  const r = el.getBoundingClientRect()
  const side: FlyoutAnchor['side'] = r.right + FLYOUT_W + 24 <= window.innerWidth ? 'right' : 'left'
  return {
    side,
    x: side === 'right' ? r.right + 12 : window.innerWidth - r.left + 12,
    bottom: Math.max(8, window.innerHeight - r.bottom),
    menuLeft: Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8)),
    menuBottom: Math.min(window.innerHeight - 8, window.innerHeight - r.top + 8),
  }
}

export function CompanionDock({ collapsed }: { collapsed?: boolean }) {
  const engine = useCompanionEngine()
  const { character, isLoading, avatarProps, captionText, captionStyle, thinking } = engine
  const { pathname } = useLocation()
  // The Chat page has its own static composer; the dock's flyout composer would
  // just duplicate it there.
  const isOnChat = pathname.startsWith('/chat')

  const dockRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [anchor, setAnchor] = useState<FlyoutAnchor | null>(null)

  // Speech bubble lifecycle: visible while thinking/talking (the engine's caption
  // linger keeps captionText alive briefly after speech ends), then a short fade.
  const bubbleActive = thinking || !!captionText
  const [bubbleShown, setBubbleShown] = useState(false)
  useEffect(() => {
    if (bubbleActive) { setBubbleShown(true); return }
    const id = setTimeout(() => setBubbleShown(false), 200)
    return () => clearTimeout(id)
  }, [bubbleActive])

  // Composer flyout: hover with a forgiving leave delay (the flyout is a portal,
  // so the 250ms window covers the pointer travelling from dock to flyout).
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openComposer = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    if (!isOnChat) setComposerOpen(true)
  }, [isOnChat])
  const scheduleComposerClose = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setComposerOpen(false), 250)
  }, [])
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current) }, [])

  // The global focus shortcut reveals the flyout composer (its focusKey pass-through
  // then focuses the input). On /chat the static chat composer takes the focus instead.
  useEffect(() => {
    if (engine.focusKey > 0 && !isOnChat) setComposerOpen(true)
  }, [engine.focusKey, isOnChat])
  useEffect(() => { if (isOnChat) setComposerOpen(false) }, [isOnChat])

  // Measure the dock whenever any flyout is (or is about to be) on screen.
  const flyoutVisible = menuOpen || composerOpen || bubbleShown
  useLayoutEffect(() => {
    if (!flyoutVisible) return
    const update = () => { if (dockRef.current) setAnchor(measureAnchor(dockRef.current)) }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [flyoutVisible, collapsed])

  // Mirror the tilt state so the sleeping Zs overlay stays in sync with the avatar.
  const overlayTilt: HeadTiltState = engine.sleeping ? 'sleeping' : thinking ? 'thinking' : engine.streaming ? 'speaking' : 'dozing'
  const overlayAnim = useHeadTilt(overlayTilt, null, false)

  if (!character && isLoading) return null

  const ledStatus = thinking ? 'info' as const : engine.streaming ? 'ok' as const : 'off' as const

  // pointer-events-none on the avatar so clicks on the SVG face/paths fall through
  // to the enclosing button (SVG hit-testing only fires on painted regions).
  const avatarNode = (px: number, suppressOverlays = false) =>
    character ? (
      <CharacterAvatar className="pointer-events-none" character={character} {...avatarProps} size={px} suppressOverlays={suppressOverlays} />
    ) : (
      <CompanionOrb size={px} active={!engine.sleeping} />
    )

  // Avatar button opens the companion menu on click or right-click. The companion
  // renders as a free-floating head (no round container, unlike the user avatar), so
  // the button is not clipped. SleepingZs render as a sibling overlay.
  const avatarButton = (px: number) => (
    <div className="relative shrink-0" style={{ width: px, height: px }}>
      <button
        type="button"
        aria-label="Companion menu"
        title={engine.otherTabOwner ? 'Voice is active in another tab. Click this tab to take over.' : 'Companion menu'}
        onClick={() => setMenuOpen(true)}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
        style={{ width: px, height: px }}
      >
        {avatarNode(px, true)}
      </button>
      {engine.sleeping && character && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', containerType: 'size' }}>
          <SleepingZs tiltDeg={overlayAnim.headDeg} grayscale={overlayAnim.grayscale} />
        </div>
      )}
    </div>
  )

  return (
    <>
      <div ref={dockRef} onMouseEnter={openComposer} onMouseLeave={scheduleComposerClose}>
        {collapsed ? (
          <div className="flex justify-center py-1.5">{avatarButton(40)}</div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-control p-2 transition-colors hover:bg-foreground/[0.04]">
            {avatarButton(56)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{character?.name ?? 'Companion'}</span>
                <StatusDot status={ledStatus} pulse={engine.streaming && !thinking} />
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <Indicator icon={Ear} label="Hands-free (wake word)" state={engine.listeningState} onClick={() => { const next = !engine.handsFreeOn; engine.setHandsFree(next); if (next) engine.setVoice(true) }} />
                <Indicator icon={Volume2} label="Voice (read aloud)" state={engine.talkState} onClick={() => engine.setVoice(!engine.voiceOn)} />
                <CaptionsOrStop busy={engine.busy} karaokeState={engine.karaokeState} captions={engine.captions} setCaptions={engine.setCaptions} onStop={engine.onStop} />
              </div>
              {engine.otherTabOwner && (
                <p
                  className="mt-1 truncate text-caption text-warning"
                  title="Another open tab is holding the mic and voice. Click this tab to take over."
                >
                  active in another tab
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Companion menu, portal above the dock */}
      {menuOpen && anchor && createPortal(
        <CompanionMenu
          onClose={() => setMenuOpen(false)}
          style={{ position: 'fixed', left: anchor.menuLeft, bottom: anchor.menuBottom, zIndex: 10001 }}
        />,
        document.body,
      )}

      {/* Speech bubble, flies out over the content edge while thinking/talking */}
      {bubbleShown && anchor && createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: anchor.bottom + (composerOpen && !isOnChat ? 96 : 0),
            zIndex: 9999,
            ...(anchor.side === 'right' ? { left: anchor.x } : { right: anchor.x }),
          }}
          className={cn(
            'pointer-events-none max-w-sm rounded-sheet border border-border bg-popover px-4 py-3 shadow-lg transition-opacity duration-200',
            bubbleActive ? 'opacity-100' : 'opacity-0',
          )}
          role="status"
          aria-label="Companion reply"
        >
          {thinking ? <TypingIndicator /> : <Subtitle text={captionText} style={captionStyle} />}
        </div>,
        document.body,
      )}

      {/* Composer flyout, hover or the focus shortcut; suppressed on /chat */}
      {composerOpen && !isOnChat && !menuOpen && anchor && createPortal(
        <div
          onMouseEnter={openComposer}
          onMouseLeave={scheduleComposerClose}
          style={{
            position: 'fixed',
            bottom: anchor.bottom,
            width: FLYOUT_W,
            zIndex: 10000,
            ...(anchor.side === 'right' ? { left: anchor.x } : { right: anchor.x }),
          }}
          className="duration-200 animate-in fade-in slide-in-from-bottom-1"
        >
          <CompanionComposer
            onSend={(text, files) => { engine.handleSend(text, files); setComposerOpen(false) }}
            onStop={engine.onStop}
            isGenerating={engine.busy}
            isThinking={thinking}
            autoFocus
            focusKey={engine.focusKey}
            placeholder={character ? `Ask ${character.name}…` : 'Message Loki Doki…'}
          />
        </div>,
        document.body,
      )}
    </>
  )
}
