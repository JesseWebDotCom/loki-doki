import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bot, Captions, Ear, Volume2, Settings, Minimize2, CircleUser, Maximize2, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useChatContext } from '@/context/ChatContext'
import { useActiveCompanion } from '@/hooks/useActiveCompanion'
import { useCompanionStream } from '@/hooks/useCompanionStream'
import { useCompanionState, CAPTION_STYLES, type CaptionStyle, type CompanionSize } from '@/lib/companionState'
import { useUIContext } from '@/context/UIContextProvider'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { useHeadTilt, type HeadTiltState } from '@/components/companion/useHeadTilt'
import SleepingZs from '@/components/companion/SleepingZs'
import { CompanionComposer } from './CompanionComposer'
import { useCompanionVoice } from '@/hooks/useCompanionVoice'
import { useEmoteMood } from '@/hooks/useEmoteMood'
import { useMood } from '@/lib/voice/moodStore'
import { useHandsFree } from '@/hooks/useHandsFree'
import { useVoicePlaying, useCharacterCaption, useStreamingSentenceCaption, stopSpeech, getVoicePlayback } from '@/lib/voice/voicePlaybackStore'
import { useVoiceOwner, setVoiceWants } from '@/lib/voice/voiceOwnership'
import { toast } from '@/lib/toast'

const ANCHOR = 'pointer-events-auto fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2'

// ── Indicator (status only, non-interactive) — exact v2 glow/pulse states ────────
type IndicatorState = 'off' | 'on-idle' | 'on-active' | 'on-followup'
const INDICATOR_CLASS: Record<IndicatorState, string> = {
  off: 'bg-transparent text-white/35',
  'on-idle': 'bg-white/10 text-white/80 ring-1 ring-white/20 shadow-[0_0_8px_rgba(255,255,255,0.15)]',
  'on-active': 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-400 shadow-[0_0_22px_#34d399] animate-pulse',
  // Follow-up window: listening for your reply WITHOUT a wake word. Sky pulse so it's
  // clearly distinct from idle (white) and active capture (emerald).
  'on-followup': 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-400 shadow-[0_0_18px_#38bdf8] animate-pulse',
}
function Indicator({ icon: Icon, label, state, onClick }: { icon: typeof Ear; label: string; state: IndicatorState; onClick?: () => void }) {
  const cls = cn('flex size-9 items-center justify-center rounded-full transition-all', INDICATOR_CLASS[state], onClick && 'cursor-pointer hover:brightness-125')
  const aria = `${label}: ${state === 'on-active' ? 'active' : state === 'on-followup' ? 'listening for follow-up' : state === 'on-idle' ? 'on' : 'off'}`
  const titleText = state === 'on-followup' ? 'Listening — reply now, no wake word needed' : `${label} — click to toggle`
  if (onClick) {
    return (
      <button type="button" aria-label={aria} title={titleText} onClick={onClick} className={cls}>
        <Icon className="size-[18px]" />
      </button>
    )
  }
  return (
    <div role="status" aria-label={aria} title={label} className={cls}>
      <Icon className="size-[18px]" />
    </div>
  )
}

// Display modes in the user's words: mini (pill), docked (avatar+composer), max (full bar).
const DISPLAY_MODES: { size: CompanionSize; label: string; desc: string; icon: typeof Minimize2 }[] = [
  { size: 'pill', label: 'Mini', desc: 'Tiny pill', icon: Minimize2 },
  { size: 'collapsed', label: 'Docked', desc: 'Avatar + input', icon: CircleUser },
  { size: 'expanded', label: 'Max', desc: 'Full bar', icon: Maximize2 },
]

// Control tile — icon over label, fills in when active. One shape reused for both the
// display-size picker (single-select, violet) and the feature toggles (on/off, emerald),
// so the whole menu reads as one consistent grid instead of mixed switches + chips.
function Tile({ icon: Icon, label, active, accent, onClick, title }: {
  icon: typeof Ear; label: string; active: boolean; accent: 'violet' | 'emerald'; onClick: () => void; title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-1 rounded-xl py-2.5 transition-colors',
        active
          ? accent === 'emerald'
            ? 'bg-emerald-500/15 text-white ring-1 ring-inset ring-emerald-400/40'
            : 'bg-violet-500/20 text-white ring-1 ring-inset ring-violet-400/40'
          : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80',
      )}
    >
      <Icon className={cn('size-[18px]', active ? (accent === 'emerald' ? 'text-emerald-300' : 'text-violet-300') : 'text-white/40')} />
      <span className="whitespace-nowrap text-[10px] font-medium leading-none">{label}</span>
    </button>
  )
}

// Small uppercase section header — gives the menu structure without adding weight.
function SectionLabel({ children }: { children: string }) {
  return <div className="px-0.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/35">{children}</div>
}

// ── Companion settings menu: who (avatar + favorites) over how (size + feature tiles) ──
function CompanionMenu({ open, onClose, anchorClass }: { open: boolean; onClose: () => void; anchorClass?: string }) {
  const { companion: character, companions: characters, setCompanion: setCharacter, clearCompanion: clearCharacter, favorites } = useActiveCompanion()
  const navigate = useNavigate()
  // Quick-switch favorites (excluding whoever's already active), capped at 5 avatar chips.
  const quickFavorites = characters.filter((ch) => favorites.includes(ch.id) && ch.id !== character?.id).slice(0, 5)
  const { size, setSize, captions, captionStyle, setCaptions, setCaptionStyle, voiceOn, handsFreeOn, setVoice, setHandsFree } = useCompanionState()
  // Close on any pointer-down outside the menu. A plain `fixed inset-0` backdrop can't be
  // used: an ancestor of the overlay sets `transform` (translate-x centering), which becomes
  // the containing block for fixed descendants, so the backdrop wouldn't actually cover the
  // viewport. A document-level listener is transform-proof. Attach on the next tick so the
  // click that opened the menu doesn't immediately close it.
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const id = setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0)
    return () => { clearTimeout(id); document.removeEventListener('pointerdown', onDown, true) }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={menuRef} className={cn('absolute z-[10001] w-60 rounded-2xl border border-white/10 bg-neutral-900/90 p-2 backdrop-blur-2xl shadow-2xl', anchorClass)}>
        {/* ── WHO — companion identity + quick switch ── */}
        <SectionLabel>Companion</SectionLabel>
        <div className="flex items-center gap-2 px-0.5">
          <span className={cn('flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10', character && 'ring-1 ring-violet-400/60')}>
            {character ? <CharacterAvatar character={character} size={32} /> : <Bot className="size-4 text-white/55" />}
          </span>
          <span className="flex-1 truncate text-sm font-semibold text-white">{character?.name ?? 'No companion'}</span>
          {character && (
            <button
              type="button"
              onClick={() => { clearCharacter(); onClose() }}
              title="Turn off companion"
              className="flex size-7 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Bot className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => { navigate('/companions'); onClose() }}
            title="Browse companions"
            className="flex size-7 items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Settings className="size-4" />
          </button>
        </div>

        {quickFavorites.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 px-0.5">
            {quickFavorites.map((ch) => (
              <button
                key={`fav-${ch.id}`}
                type="button"
                onClick={() => { setCharacter(ch.id); onClose() }}
                title={`Switch to ${ch.name}`}
                className="size-7 shrink-0 overflow-hidden rounded-full bg-white/10 opacity-85 transition hover:scale-110 hover:opacity-100 hover:ring-1 hover:ring-violet-400/60"
              >
                <CharacterAvatar className="pointer-events-none" character={ch} size={28} />
              </button>
            ))}
          </div>
        )}

        <div className="my-2 h-px bg-white/[0.07]" />

        {/* ── Display — connected segmented control: exactly one size at a time ── */}
        <SectionLabel>Display</SectionLabel>
        <div className="flex rounded-lg bg-black/40 p-0.5">
          {DISPLAY_MODES.map((m) => (
            <button
              key={m.size}
              type="button"
              onClick={() => { setSize(m.size); onClose() }}
              title={m.desc}
              className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors', size === m.size ? 'bg-violet-500/30 text-white shadow-sm ring-1 ring-inset ring-violet-400/40' : 'text-white/50 hover:text-white/80')}
            >
              <m.icon className={cn('size-3.5', size === m.size && 'text-violet-200')} />
              {m.label}
            </button>
          ))}
        </div>

        {/* ── Feature toggles — independent on/off tiles ── */}
        <div className="mt-2.5">
          <SectionLabel>Interaction</SectionLabel>
          <div className="flex gap-1.5">
            <Tile icon={Volume2} label="Voice" active={voiceOn} accent="emerald" onClick={() => setVoice(!voiceOn)} />
            {/* Enabling hands-free implies Voice — the loop advances on TTS playback end. */}
            <Tile icon={Ear} label="Hands-free" active={handsFreeOn} accent="emerald" onClick={() => { const next = !handsFreeOn; setHandsFree(next); if (next) setVoice(true) }} />
            <Tile icon={Captions} label="Captions" active={captions} accent="emerald" onClick={() => setCaptions(!captions)} />
          </div>
        </div>

        {/* Caption style — dropdown, only when captions are on */}
        {captions && (
          <div className="mt-2.5">
            <SectionLabel>Caption Style</SectionLabel>
            <div className="relative">
              <select
                value={captionStyle}
                onChange={(e) => setCaptionStyle(e.target.value as CaptionStyle)}
                className="w-full cursor-pointer appearance-none rounded-lg bg-white/[0.06] py-1.5 pl-2.5 pr-7 text-xs capitalize text-white/90 ring-1 ring-inset ring-white/10 transition-colors outline-none hover:bg-white/10 focus:ring-violet-400/40"
              >
                {CAPTION_STYLES.map((s: CaptionStyle) => (
                  <option key={s} value={s} className="bg-neutral-900 capitalize text-white">{s}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-white/40" />
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
      <div className="pointer-events-none mb-2 flex w-full justify-center">
        <span className="inline-flex items-center gap-[5px] rounded-2xl bg-black/70 px-4 py-2.5 shadow-xl backdrop-blur-xl">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{ animation: `ld-dot-bounce 1.1s ease-in-out ${i * 0.18}s infinite` }}
              className="size-2 rounded-full bg-white/80"
            />
          ))}
        </span>
      </div>
    </>
  )
}

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
  const base = 'max-w-md rounded-2xl px-3.5 py-1.5 text-center leading-snug shadow-xl backdrop-blur-xl'
  const styleCls =
    style === 'bold' ? 'bg-black/70 text-sm font-bold text-white'
    : style === 'enlarge' ? 'bg-black/70 text-xl font-medium text-white'
    : style === 'underline' ? 'bg-black/70 text-sm text-white underline decoration-cyan-400 decoration-2 underline-offset-2'
    : style === 'accent' ? 'bg-black/70 text-sm font-medium text-cyan-300'
    : style === 'highlight' ? 'border border-cyan-400/30 bg-cyan-500/25 text-sm font-medium text-white'
    : 'bg-black/70 text-sm text-white/95'
  return (
    <div className="pointer-events-none mb-2 flex w-full justify-center">
      <span className={cn(base, styleCls)}>{displayed}</span>
    </div>
  )
}

export function CompanionOverlay() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const chat = useChatContext()
  const companion = useCompanionStream()
  const { companion: character, companions, isLoading } = useActiveCompanion()
  const { size, captions, captionStyle, voiceOn, handsFreeOn, setVoice, setHandsFree, setCaptions } = useCompanionState()

  const isOnChat = pathname.startsWith('/chat')
  const { getContextBlock } = useUIContext()

  // Voice/hands-free fall back to the first available companion when none is
  // explicitly selected, matching handleSend's behaviour so voice always has a
  // character to route to. Rendering (avatar, name) still uses the explicit selection.
  const voiceCharacter = character ?? companions[0] ?? null

  // Cross-tab voice ownership (focus-follows-tab): only the tab the user is
  // looking at holds the mic + plays TTS. Declare this tab's intent, then gate
  // both the mic (hands-free `enabled`) and read-aloud (`voiceMode`) on owning it
  // so multiple open tabs never listen or talk over each other.
  const wantsVoice = !!voiceCharacter && (handsFreeOn || voiceOn)
  useEffect(() => { setVoiceWants(wantsVoice) }, [wantsVoice])
  const isVoiceOwner = useVoiceOwner()

  // Hands-free uses the latest handleSend (defined below) via a ref so the hook
  // can be declared here with a stable submit callback.
  const handleSendRef = useRef<(text: string, attachments?: File[]) => void>(() => {})
  const hfSubmit = useCallback((text: string) => handleSendRef.current(text), [])
  const handsFree = useHandsFree({
    enabled: handsFreeOn && !!voiceCharacter && isVoiceOwner,
    characterId: voiceCharacter?.id,
    wakeWordModelId: voiceCharacter?.wakeWordModelId ?? null,
    wakeWordPhrase: voiceCharacter?.wakeWordPhrase ?? null,
    submit: hfSubmit,
    onEngageFailed: (reason) => {
      setHandsFree(false)
      if (reason === 'models-missing') toast.error('Wake word models not installed — enable in Admin → Voice')
      else toast.error('Microphone access denied — check browser permissions')
    },
  })

  // Effective talk/think signals (chat records; companion stream is ephemeral).
  const last = chat.messages[chat.messages.length - 1]
  const chatAssistant = last?.role === 'assistant' ? (last?.content ?? '') : ''

  // Only mirror the chat's assistant reply to the companion's voice / emote / caption
  // pipelines when it was produced by a *live* generation this session. Loading an old
  // conversation swaps a historical assistant message into `messages` with no active
  // stream; feeding that to useCompanionVoice would speak the old reply aloud (its
  // trailing-flush fires on any text change while not streaming). Track the reply only
  // while generating, plus a one-shot capture of the final flushed text when it ends.
  const [liveChatReply, setLiveChatReply] = useState('')
  const sawLiveGen = useRef(false)
  useEffect(() => {
    if (!isOnChat) return
    if (chat.isGenerating) {
      sawLiveGen.current = true
      setLiveChatReply(chatAssistant)
    } else if (sawLiveGen.current) {
      sawLiveGen.current = false
      setLiveChatReply(chatAssistant)
    }
  }, [isOnChat, chat.isGenerating, chatAssistant])

  const replyText = isOnChat ? liveChatReply : companion.response
  const streaming = isOnChat ? chat.isGenerating : companion.streaming
  const speaking = streaming && replyText.length > 0
  const thinking = streaming && replyText.length === 0

  // Read-aloud: stream completed sentences to TTS when Voice OR hands-free is on
  // (hands-free always speaks its replies so the loop can advance on playback end).
  // Only the owning tab speaks; a non-owner stays silent even if it generated text.
  const voiceMode = (voiceOn || handsFreeOn) && !!voiceCharacter && isVoiceOwner
  useCompanionVoice({ text: replyText, streaming, characterId: voiceCharacter?.id, voiceOn: voiceMode })
  // Layer-config diagnostic (plans/voice-rebuild.md): logs voice + wakeword/hands-free
  // state so it's always clear which layer is active during testing.
  useEffect(() => {
    const wake = voiceCharacter?.wakeWordPhrase?.trim() || voiceCharacter?.wakeWordModelId || 'none'
    console.log(`[VOICE-STATE] app=${pathname} voiceOn=${voiceOn} handsFree=${handsFreeOn} voiceMode=${voiceMode} owner=${isVoiceOwner} wakeword="${wake}" hfState=${handsFree.state}`)
  }, [pathname, voiceOn, handsFreeOn, voiceMode, isVoiceOwner, voiceCharacter, handsFree.state])
  // Losing ownership mid-utterance (user switched to another tab) cuts the audio
  // here so the handoff is clean and the new owner is the only one talking.
  useEffect(() => { if (!isVoiceOwner) stopSpeech() }, [isVoiceOwner])
  // Emote → mood overlay (animates eyes/brows while speaking). Visual only, so it
  // runs regardless of whether voice is on.
  useEmoteMood({ text: replyText, streaming })
  const mood = useMood()
  const audioPlaying = useVoicePlaying()
  const bridgeCaption = useCharacterCaption(voiceMode)
  // TTS-off: reveal sentences one at a time at a readable pace.
  const { caption: sentenceCaption, draining: sentenceDraining } = useStreamingSentenceCaption(replyText, streaming)

  // When Voice is on, the talk indicator + lip-sync + captions follow REAL audio
  // playback; otherwise they follow the sentence-reveal cadence (TTS-off fallback).
  const talkActive = voiceMode ? audioPlaying : (speaking || sentenceDraining)
  const listeningState: IndicatorState =
    !handsFreeOn ? 'off'
    : handsFree.state === 'capturing' || handsFree.state === 'wake-detected' ? 'on-active'
    : handsFree.state === 'post-reply-listen' ? 'on-followup'   // speak without the wake word
    // 'replying' (TTS speaking): keep the mic icon LIT — barge-in is active, you can
    // talk over it. (It used to fall through to 'off', which looked like you couldn't.)
    : handsFree.state === 'idle' || handsFree.state === 'engaging' || handsFree.state === 'suspended' || handsFree.state === 'replying' ? 'on-idle'
    : 'off'
  // Indicators double as toggles: dim = off, lit = enabled, pulsing = active.
  const talkState: IndicatorState = !voiceOn ? 'off' : talkActive ? 'on-active' : 'on-idle'
  const karaokeState: IndicatorState = !captions ? 'off' : talkActive ? 'on-active' : 'on-idle'

  const captionSource = voiceMode ? bridgeCaption : sentenceCaption
  // How long the last caption stays on screen after talking stops.
  const CAPTION_LINGER_MS = 1200
  const [linger, setLinger] = useState('')
  useEffect(() => {
    if (talkActive) { setLinger(captionSource); return }
    if (!talkActive && linger) {
      const id = setTimeout(() => setLinger(''), CAPTION_LINGER_MS)
      return () => clearTimeout(id)
    }
  }, [talkActive, captionSource, linger])
  // While capturing a spoken utterance, surface the live STT partial; otherwise
  // show the spoken/streamed caption (when captions are on).
  const captionText =
    handsFree.state === 'capturing' && handsFree.partial
      ? handsFree.partial.slice(-200)
      : captions
        ? (talkActive ? captionSource : linger).slice(-200)
        : ''

  // Auto-sleep: go dormant after 3 min of no user activity while idle.
  const [sleeping, setSleeping] = useState(false)
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const SLEEP_MS = 3 * 60 * 1000

  const wake = useCallback(() => {
    setSleeping(false)
    if (sleepTimer.current) clearTimeout(sleepTimer.current)
    sleepTimer.current = setTimeout(() => setSleeping(true), SLEEP_MS)
  }, [])

  // Wake whenever the AI becomes active
  useEffect(() => { if (streaming || thinking || audioPlaying) wake() }, [streaming, thinking, audioPlaying, wake])

  // Reset timer on user input events
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'touchstart', 'pointerdown']
    events.forEach((e) => document.addEventListener(e, wake, { passive: true }))
    // Start the initial countdown
    sleepTimer.current = setTimeout(() => setSleeping(true), SLEEP_MS)
    return () => {
      events.forEach((e) => document.removeEventListener(e, wake))
      if (sleepTimer.current) clearTimeout(sleepTimer.current)
    }
  }, [wake])

  // Mirror the tilt state so overlays rendered outside overflow-hidden stay in sync.
  const isActualSleeping = sleeping && !streaming && !thinking
  const overlayTilt: HeadTiltState = isActualSleeping ? 'sleeping' : thinking ? 'thinking' : streaming ? 'speaking' : 'dozing'
  const overlayAnim = useHeadTilt(overlayTilt, null, false)

  const [menuOpen, setMenuOpen] = useState(false)

  // Shown when this tab wants voice but another open tab currently owns the mic +
  // audio (focus-follows-tab). Surfaced in every display mode so a silent tab is
  // never mistaken for a broken one.
  const otherTabHint = wantsVoice && !isVoiceOwner ? (
    <div className="pointer-events-none mb-1 flex w-full justify-center">
      <span
        className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300/80"
        title="Another open tab is holding the mic and voice. Click this tab to take over."
      >
        active in another tab
      </span>
    </div>
  ) : null

  // Mini-mode hover: reveal a composer ABOVE the stationary pill (the pill is
  // anchored at the bottom and never moves, so it stays clickable). Auto-hides on
  // mouse-leave and after sending — the v2 hover-to-type-then-minimize flow.
  const [pillHovered, setPillHovered] = useState(false)
  const pillLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onPillEnter = () => { if (pillLeaveTimer.current) clearTimeout(pillLeaveTimer.current); setPillHovered(true) }
  const onPillLeave = () => { pillLeaveTimer.current = setTimeout(() => setPillHovered(false), 250) }
  useEffect(() => () => { if (pillLeaveTimer.current) clearTimeout(pillLeaveTimer.current) }, [])

  // ⌘/ (Ctrl+/) focuses the companion input from anywhere — the chat-input analogue
  // of ⌘K search. (⌘J would clash with the browser's Downloads shortcut.) If minimized
  // to the pill, it first reveals the pill's composer.
  const [focusKey, setFocusKey] = useState(0)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPillHovered(true)
        setFocusKey((k) => k + 1)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  // Clicking the avatar opens the companion menu (same as right-click). The avatar
  // never moves between modes, so the click is always reliable; display modes are
  // switched from the menu's picker.
  const openMenu = useCallback(() => setMenuOpen(true), [])

  const handleSend = useCallback(async (text: string, attachments?: File[]) => {
    // Fall back to the first available companion when none is explicitly selected,
    // matching BottomTabBar behaviour so the bar always responds off-chat.
    const charId = character?.id ?? companions[0]?.id
    // Resume the AudioContext now, inside the user gesture, so the first spoken
    // chunk doesn't pay resume() latency after the reply has already started.
    // (Browsers only allow resume() from a gesture; submit is one.)
    if (voiceMode) void getVoicePlayback().prime()
    if (isOnChat) {
      // On a chat sub-page (project landing / browse lists) the message stream isn't
      // mounted. Jump to the conversation view so the reply is visible as it streams.
      if (pathname !== '/chat' && !chat.conversationId) navigate('/chat')
      chat.submit(charId, text)
    } else if (charId) {
      if (attachments && attachments.length > 0) {
        // Convert image files to base64 (no data: prefix) for the vision-capable companion endpoint
        const images = await Promise.all(attachments.map(file => new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            // Strip the data:image/...;base64, prefix
            resolve(result.split(',')[1] ?? result)
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })))
        companion.submit(text, charId, getContextBlock(), images)
      } else {
        companion.submit(text, charId, getContextBlock())
      }
    }
  }, [character, companions, chat, companion, isOnChat, getContextBlock, voiceMode, pathname, navigate])
  handleSendRef.current = handleSend

  // The composer shows Stop while EITHER generating text OR still speaking audio,
  // and Stop halts both.
  const busy = streaming || (voiceMode && audioPlaying)
  const onStop = () => {
    if (isOnChat) chat.stop()
    else companion.cancel()
    stopSpeech()
  }

  if (!character && isLoading) return null

  const ledClass = thinking ? 'bg-sky-400' : streaming ? 'animate-pulse bg-emerald-400' : 'bg-white/40'
  const isListening = handsFree.state === 'capturing' || handsFree.state === 'wake-detected'

  // pointer-events-none on the avatar so clicks on the SVG face/paths fall through
  // to the enclosing button (SVG hit-testing only fires on painted regions).
  const orbActive = !isActualSleeping
  const avatarNode = (px: number, suppressOverlays = false) =>
    character ? (
      <CharacterAvatar className="pointer-events-none" character={character} streaming={voiceMode ? (audioPlaying || speaking) : speaking} thinking={thinking} sleeping={sleeping && !streaming && !thinking} listening={isListening} size={px} audioLipSync={voiceMode} mood={mood} suppressOverlays={suppressOverlays} />
    ) : (
      <CompanionOrb size={px} active={orbActive} />
    )

  // Stationary avatar button → reliably opens the menu on click or right-click.
  // SleepingZs rendered as sibling outside the overflow-hidden button so the
  // circle doesn't clip them. ThinkingDots show in the caption slot above instead.
  const avatarButton = (px: number) => (
    <div className="relative shrink-0" style={{ width: px, height: px }}>
      <button
        type="button"
        aria-label="Companion menu"
        onClick={openMenu}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
        className="overflow-hidden rounded-full"
        style={{ width: px, height: px }}
      >
        {avatarNode(px, true)}
      </button>
      {isActualSleeping && character && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', containerType: 'size' }}>
          <SleepingZs tiltDeg={overlayAnim.headDeg} grayscale={overlayAnim.grayscale} />
        </div>
      )}
      <CompanionMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorClass="bottom-full left-0 mb-2" />
    </div>
  )

  const composer = (autoFocus: boolean) => (
    <CompanionComposer
      onSend={handleSend}
      onStop={onStop}
      isGenerating={busy}
      isThinking={thinking}
      autoFocus={autoFocus}
      focusKey={focusKey}
      placeholder={character ? `Ask ${character.name}…` : 'Message LokiDoki…'}
    />
  )

  // ── Mini (pill) — hover reveals a composer above the stationary pill ────────────
  if (size === 'pill') {
    return (
      <div
        className="pointer-events-auto fixed bottom-3 left-1/2 z-[9999] hidden -translate-x-1/2 md:block"
        onMouseEnter={onPillEnter}
        onMouseLeave={onPillLeave}
      >
        <div className="flex flex-col items-center">
          {thinking ? <TypingIndicator /> : <Subtitle text={captionText} style={captionStyle} />}
          {otherTabHint}
          {pillHovered && !menuOpen && (
            <div className="mb-2 w-[340px] duration-200 animate-in fade-in slide-in-from-bottom-1">
              <CompanionComposer
                onSend={(t, files) => { handleSend(t, files); setPillHovered(false) }}
                onStop={onStop}
                isGenerating={busy}
                isThinking={thinking}
                autoFocus
                focusKey={focusKey}
                placeholder={character ? `Ask ${character.name}…` : 'Message LokiDoki…'}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                aria-label="Companion menu"
                onClick={openMenu}
                onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 shadow-2xl backdrop-blur-xl transition-transform hover:scale-105"
              >
                <span className="flex size-6 items-center justify-center overflow-hidden rounded-full">{avatarNode(24)}</span>
                <span className={cn('size-1.5 shrink-0 rounded-full', ledClass)} />
              </button>
              <CompanionMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorClass="bottom-full left-0 mb-2" />
            </div>
            <button
              type="button"
              aria-label="Companion settings"
              title="Companion settings"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
              className="flex size-8 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white/50 shadow-2xl backdrop-blur-xl transition-colors hover:text-white"
            >
              <Settings className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Docked (avatar + composer) ────────────────────────────────────────────────
  if (size === 'collapsed') {
    return (
      <div className={cn(ANCHOR, 'hidden w-full max-w-md px-4 md:block')}>
        {thinking ? <TypingIndicator /> : <Subtitle text={captionText} style={captionStyle} />}
        {otherTabHint}
        <div className="flex items-center gap-2">
          {avatarButton(64)}
          <div className="min-w-0 flex-1">{composer(false)}</div>
          <button
            type="button"
            aria-label="Companion settings"
            title="Companion settings"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-black/50 backdrop-blur-sm text-white/50 shadow-md transition-colors hover:bg-black/65 hover:text-white"
          >
            <Settings className="size-[18px]" />
          </button>
        </div>
      </div>
    )
  }

  // ── Max (avatar + composer + indicators/settings) ─────────────────────────────
  return (
    <div className={cn(ANCHOR, 'hidden w-full max-w-xl px-4 md:block')}>
      {thinking ? <TypingIndicator /> : <Subtitle text={captionText} style={captionStyle} />}
      <div className="flex items-end gap-2">
        {avatarButton(88)}
        <div className="min-w-0 flex-1">
          {composer(true)}
          {/* Bottom row: status indicators (left) + settings (right) */}
          <div className="mt-1.5 flex items-center rounded-full bg-black/55 px-2 backdrop-blur-sm shadow-lg">
            <div className="flex items-center gap-1.5">
              <Indicator icon={Ear} label="Hands-free (wake word)" state={listeningState} onClick={() => { const next = !handsFreeOn; setHandsFree(next); if (next) setVoice(true) }} />
              <Indicator icon={Volume2} label="Voice (read aloud)" state={talkState} onClick={() => setVoice(!voiceOn)} />
              <Indicator icon={Captions} label="Captions" state={karaokeState} onClick={() => setCaptions(!captions)} />
            </div>
            {wantsVoice && !isVoiceOwner && (
              <span className="ml-2 text-[10px] text-amber-300/70" title="Another open tab is holding the mic and voice. Click this tab to take over.">
                active in another tab
              </span>
            )}

            <button
              type="button"
              aria-label="Companion settings"
              title="Companion settings"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
              className="ml-auto flex size-9 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Settings className="size-[18px]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
