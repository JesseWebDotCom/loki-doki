import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useChatContext } from '@/context/ChatContext'
import { useActiveCompanion, type CompanionRecord } from '@/hooks/useActiveCompanion'
import { useCompanionStream } from '@/hooks/useCompanionStream'
import { useRadio } from '@/context/RadioContext'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { applyPlayDirective } from '@/lib/playDirective'
import { getPlaylist } from '@/lib/music/catalogApi'
import { artUrlForRef } from '@/lib/music/trackRef'
import { useCompanionState, type CaptionStyle } from '@/lib/companionState'
import { useUIContext } from '@/context/UIContextProvider'
import type { Mood } from '@/components/companion/moods'
import type { HandsFreeState } from '@/lib/voice/handsfree-state-machine'
import { useCompanionVoice } from '@/hooks/useCompanionVoice'
import { useEmoteMood } from '@/hooks/useEmoteMood'
import { useMood } from '@/lib/voice/moodStore'
import { useHandsFree, isStopCommand } from '@/hooks/useHandsFree'
import { useVoicePlaying, useCharacterCaption, useStreamingSentenceCaption, stopSpeech, getVoicePlayback } from '@/lib/voice/voicePlaybackStore'
import { useVoiceOwner, setVoiceWants } from '@/lib/voice/voiceOwnership'
import { useDockYield } from '@/lib/voice/dockYield'
import { toast } from '@/lib/toast'
import { matchesScreenIntent } from '@/lib/screenIntent'
import { fetchVisionStatus } from '@/hooks/useVisionStatus'
import type { LucideIcon } from 'lucide-react'

// Injected into uiContext for screen-awareness turns so the model knows the
// attached image IS the user's live screen (uiContext is per-turn: it vanishes
// next turn together with the image, unlike the persisted message history).
const SCREEN_NOTE =
  "[Screen] The attached image is a screenshot of the user's screen, captured just now at their request. " +
  'When they say "this", "here", "my screen", or ask what they are looking at, they mean this screenshot. ' +
  'Describe or answer based on what is actually visible in it.'

// The companion "brain": every placement-independent piece of the old floating
// CompanionOverlay (voice, hands-free, captions, cross-tab ownership, send/stop
// routing, auto-sleep) lives here, mounted ONCE per surface tree. The sidebar
// CompanionDock, the Chat page's static composer, and the mobile BottomTabBar all
// consume the same instance through useCompanionEngine().

// Indicator status vocabulary shared by the dock + tab bar pills.
export type IndicatorState = 'off' | 'on-idle' | 'on-active' | 'on-followup'

export interface CompanionAvatarProps {
  streaming: boolean
  thinking: boolean
  sleeping: boolean
  listening: boolean
  mood: Mood
  audioLipSync: boolean
}

/** A staged action awaiting approval (confirm_action directive): surfaces
 *  render approve/decline buttons from it. */
export interface PendingCompanionAction {
  actionId: string
  summary: string
  approveLabel: string
  declineLabel: string
  /** Optional rich preview (poster + "Title (Year)") for surfaces that can show it. */
  card?: { title: string; subtitle?: string; imageUrl?: string }
  expiresAt: number
}

/** A transient action offered inside a capsule event peek (#17). */
export interface CapsuleEventAction {
  label: string
  run: () => void
}

/** A discrete, self-dismissing event surfaced as a brief capsule peek (#1): an icon,
 *  one line of text, and up to a few inline actions. Independent of conversation state. */
export interface CapsuleEvent {
  icon: LucideIcon
  text: string
  actions?: CapsuleEventAction[]
}

export interface CompanionEngine {
  character: CompanionRecord | null
  companions: CompanionRecord[]
  /** Companion roster still loading; placements usually render nothing yet. */
  isLoading: boolean
  /** Flags to spread onto CharacterAvatar so every placement animates identically. */
  avatarProps: CompanionAvatarProps
  /** Caption/STT text for the speech bubble (already linger-managed and clipped). */
  captionText: string
  captionStyle: CaptionStyle
  setCaptionStyle: (style: CaptionStyle) => void
  /** Raw streamed reply text (mobile sheet renders the full ephemeral reply). */
  replyText: string
  streaming: boolean
  thinking: boolean
  /** True while the reply is audibly/visibly being delivered. */
  talkActive: boolean
  listeningState: IndicatorState
  talkState: IndicatorState
  karaokeState: IndicatorState
  handsFreeState: HandsFreeState
  /** Live STT partial while capturing an utterance. */
  handsFreePartial: string
  /** This tab wants voice but another open tab currently owns mic + audio. */
  otherTabOwner: boolean
  /** The Doki Dock desktop app on this machine owns companion speech; this tab yields. */
  dockYield: boolean
  handleSend: (text: string, attachments?: File[]) => void
  /** Escape hatch from the ephemeral quick-ask: jump to /chat and re-run the given
   *  question there so it lands in a persisted conversation. */
  promoteToChat: (text: string) => void
  onStop: () => void
  /** Screen-awareness turn in flight (desktop shell): capture + vision prefill. */
  lookingAtScreen: boolean
  /** Staged action awaiting approval; off-chat surfaces render buttons from it. */
  pendingAction: PendingCompanionAction | null
  approvePendingAction: () => void
  declinePendingAction: () => void
  /** Generating text OR still speaking audio; the composer shows Stop. */
  busy: boolean
  /** Bumped by focusComposer / the global shortcut; composers focus on change. */
  focusKey: number
  focusComposer: () => void
  voiceOn: boolean
  handsFreeOn: boolean
  captions: boolean
  setVoice: (on: boolean) => void
  setHandsFree: (on: boolean) => void
  setCaptions: (on: boolean) => void
  /** Dormant (no activity for a while, nothing streaming or thinking). */
  sleeping: boolean
  /** A transient capsule event (icon + text + optional actions), or null. Auto-clears. */
  capsuleEvent: CapsuleEvent | null
  /** Surface a transient capsule event for `ttlMs` (default 4000). No-ops if a conversation
   *  is active, so an event peek never fights a live turn. */
  pulseEvent: (evt: CapsuleEvent, ttlMs?: number) => void
  /** Clear the current capsule event immediately (e.g. when an action is taken). */
  dismissCapsuleEvent: () => void
}

const Ctx = createContext<CompanionEngine | null>(null)

export function useCompanionEngine(): CompanionEngine {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCompanionEngine must be used within CompanionEngineProvider')
  return ctx
}

export function CompanionEngineProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const chat = useChatContext()
  const radio = useRadio()
  const youtube = useYoutubePlayback()
  // Staged action awaiting the user's approval (confirm_action directive from
  // an off-chat turn). Dock bubble / island / mobile sheet render buttons from
  // it; on-chat the ChatContext derives a block instead, so this stays null there.
  const [pendingAction, setPendingAction] = useState<PendingCompanionAction | null>(null)
  useEffect(() => {
    if (!pendingAction) return
    const t = setTimeout(() => setPendingAction(null), Math.max(0, pendingAction.expiresAt - Date.now()))
    return () => clearTimeout(t)
  }, [pendingAction])
  // Off-chat companion turns can ask to open a playlist the companion just curated
  // ("make me a dinner playlist"). Navigate to it so the user sees it; only play when
  // the directive opts in (autoplay is false today; curating shouldn't hijack audio).
  const openPlaylist = useCallback(
    async (playlistId: string, opts: { name: string; trackCount: number; autoplay: boolean }) => {
      navigate(`/music/playlist/${playlistId}`)
      if (!opts.autoplay) return
      try {
        const { playlist, tracks } = await getPlaylist(playlistId)
        if (!tracks.length) return
        radio.playPlaylist(
          tracks.map((t) => ({ videoId: t.videoId, title: t.title, author: t.artist, thumbnail: artUrlForRef(t.videoId) ?? '' })),
          0,
          { name: playlist.name, playlistId: playlist.id },
        )
      } catch { /* navigation already happened; playback is best-effort */ }
    },
    [navigate, radio],
  )
  // Off-chat companion turns can ask to start playback ("play heavy metal",
  // "play the Thriller music video"), drive the global mini-player in place.
  const onDirective = useCallback(
    (directive: Parameters<typeof applyPlayDirective>[0]) => {
      if (directive.action === 'confirm_action') {
        setPendingAction({
          actionId: directive.actionId,
          summary: directive.summary,
          approveLabel: directive.approveLabel,
          declineLabel: directive.declineLabel,
          card: directive.card,
          expiresAt: Date.now() + 60_000,
        })
        return
      }
      applyPlayDirective(directive, { playExpanded: youtube.playExpanded, startStation: radio.start, openPlaylist })
    },
    [youtube.playExpanded, radio.start, openPlaylist],
  )
  const companion = useCompanionStream({ onDirective })
  const { companion: character, companions, isLoading } = useActiveCompanion()
  const { captions, captionStyle, voiceOn, handsFreeOn, setVoice, setHandsFree, setCaptions, setCaptionStyle } = useCompanionState()

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
  // Server-arbitrated "dock wins": when the Doki Dock desktop app is connected from
  // this same machine, every web tab here yields speech + mic to it (dockYield can
  // never be true inside the dock itself). See lib/voice/dockYield.ts.
  const dockYield = useDockYield()

  // Hands-free uses the latest handleSend (defined below) via a ref so the hook
  // can be declared here with a stable submit callback.
  const handleSendRef = useRef<(text: string, attachments?: File[]) => void>(() => {})
  const hfSubmit = useCallback((text: string) => handleSendRef.current(text), [])
  const handsFree = useHandsFree({
    enabled: handsFreeOn && !!voiceCharacter && isVoiceOwner && !dockYield,
    characterId: voiceCharacter?.id,
    wakeWordModelId: voiceCharacter?.wakeWordModelId ?? null,
    wakeWordPhrase: voiceCharacter?.wakeWordPhrase ?? null,
    // While a confirmation is pending, hold the wake-word-free follow-up window
    // open longer so a spoken "yes" lands naturally.
    holdFollowUp: !!pendingAction,
    submit: hfSubmit,
    onEngageFailed: (reason) => {
      setHandsFree(false)
      if (reason === 'models-missing') toast.error('Wake word models not installed, enable in Admin > Voice')
      else toast.error('Microphone access denied, check browser permissions')
    },
    onStopCommand: (wasTalking) => {
      // Always abort in-flight generation so the LLM doesn't re-queue more TTS.
      if (isOnChat) chat.stop()
      else companion.cancel()
      // Stop media only when the companion wasn't the one playing audio.
      if (!wasTalking) {
        if (radio.active) radio.stop()
        if (youtube.track) youtube.close()
      }
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
  const voiceMode = (voiceOn || handsFreeOn) && !!voiceCharacter && isVoiceOwner && !dockYield
  useCompanionVoice({ text: replyText, streaming, characterId: voiceCharacter?.id, voiceOn: voiceMode, expressiveness: voiceCharacter?.expressiveness })
  // Losing ownership mid-utterance (user switched to another tab, or a Doki Dock
  // appeared on this machine) cuts the audio here so the handoff is clean and the
  // new owner is the only one talking.
  useEffect(() => { if (!isVoiceOwner || dockYield) stopSpeech() }, [isVoiceOwner, dockYield])
  // Emote > mood overlay (animates eyes/brows while speaking). Visual only, so it
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
    // 'replying' (TTS speaking): keep the mic icon LIT, barge-in is active, you can
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

  const isActualSleeping = sleeping && !streaming && !thinking

  // ⌘/ (Ctrl+/) focuses the companion input from anywhere, the chat-input analogue
  // of ⌘K search. (⌘J would clash with the browser's Downloads shortcut.) Placements
  // watch focusKey: the dock reveals its composer flyout, composers focus their input.
  const [focusKey, setFocusKey] = useState(0)
  // Screen-awareness turn in flight: covers capture + the slow vision prefill
  // window so placements can show an honest "Looking at your screen" status.
  // Cleared on the first reply token; handleSend also resets it per send and on
  // capture failure, and onStop clears it, so it can't go stale across turns.
  const [lookingAtScreen, setLookingAtScreen] = useState(false)
  useEffect(() => {
    if (lookingAtScreen && replyText.length > 0) setLookingAtScreen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyText])
  // Transient capsule events (#1/#17): a discrete, self-dismissing peek independent of
  // conversation. A live turn always preempts it (effect below).
  const [capsuleEvent, setCapsuleEvent] = useState<CapsuleEvent | null>(null)
  const capsuleEventTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissCapsuleEvent = useCallback(() => {
    if (capsuleEventTimer.current) { clearTimeout(capsuleEventTimer.current); capsuleEventTimer.current = null }
    setCapsuleEvent(null)
  }, [])
  const conversingNow =
    thinking || streaming || talkActive || !!captionText || !!pendingAction ||
    listeningState === 'on-active' || listeningState === 'on-followup' || !!handsFree.partial
  const conversingRef = useRef(conversingNow)
  conversingRef.current = conversingNow
  const pulseEvent = useCallback((evt: CapsuleEvent, ttlMs = 4000) => {
    if (conversingRef.current) return // never fight a live turn
    if (capsuleEventTimer.current) clearTimeout(capsuleEventTimer.current)
    setCapsuleEvent(evt)
    capsuleEventTimer.current = setTimeout(() => { capsuleEventTimer.current = null; setCapsuleEvent(null) }, ttlMs)
  }, [])
  // A conversation starting preempts any active event peek.
  useEffect(() => {
    if (conversingNow && capsuleEvent) dismissCapsuleEvent()
  }, [conversingNow, capsuleEvent, dismissCapsuleEvent])
  useEffect(() => () => { if (capsuleEventTimer.current) clearTimeout(capsuleEventTimer.current) }, [])

  const focusComposer = useCallback(() => setFocusKey((k) => k + 1), [])
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setFocusKey((k) => k + 1)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const handleSend = useCallback(async (text: string, attachments?: File[]) => {
    // Any fresh user message supersedes an open confirmation offer's buttons
    // (the server-side staged action still expires on its own TTL; a typed
    // "yes" still resolves it via the turn re-route).
    setPendingAction(null)
    // Intercept stop commands when something is active, never let a bare "stop" reach the LLM.
    if (isStopCommand(text) && (streaming || audioPlaying || radio.active || !!youtube.track)) {
      if (isOnChat) chat.stop()
      else companion.cancel()
      stopSpeech()
      if (radio.active) radio.stop()
      if (youtube.track) youtube.close()
      return
    }
    // Fall back to the first available companion when none is explicitly selected,
    // so every placement always responds off-chat.
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
      // Screen awareness (desktop shell only): when the message references what's
      // on screen and no files were attached, grab a live screenshot and ride the
      // existing vision path. This is the single convergence point for typed AND
      // voice input, which is why the check lives here and not in a page.
      let screenImage: string | undefined
      let uiContext = getContextBlock()
      setLookingAtScreen(false)
      if (
        (!attachments || attachments.length === 0) &&
        window.lokiDesktop?.captureScreen &&
        matchesScreenIntent(text) &&
        (await fetchVisionStatus())?.available
      ) {
        setLookingAtScreen(true)
        const res = await window.lokiDesktop.captureScreen({ maxDim: 1344 })
        if (res.ok) {
          screenImage = res.imageBase64
          uiContext = [uiContext, SCREEN_NOTE].filter(Boolean).join('\n\n')
        } else {
          setLookingAtScreen(false)
          if (res.reason === 'permission') {
            window.lokiDesktop.openScreenRecordingSettings?.()
            toast.error('To see your screen, enable Screen Recording for Loki Doki in System Settings, then relaunch the app.')
          }
          // Never swallow the question: continue text-only.
        }
      }
      if ((attachments && attachments.length > 0) || screenImage) {
        // Convert image files to base64 (no data: prefix) for the vision-capable companion endpoint
        const images = await Promise.all((attachments ?? []).map(file => new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            // Strip the data:image/...;base64, prefix
            resolve(result.split(',')[1] ?? result)
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })))
        if (screenImage) images.unshift(screenImage)
        companion.submit(text, charId, uiContext, images)
      } else {
        companion.submit(text, charId, uiContext)
      }
    }
  }, [character, companions, chat, companion, isOnChat, getContextBlock, voiceMode, pathname, navigate, streaming, audioPlaying, radio, youtube])
  handleSendRef.current = handleSend

  // Quick-ask → real chat handoff: cancel the ephemeral stream, then re-submit the
  // question through the persisted chat flow. chat.submit doesn't depend on the
  // route, so submitting right after navigate() is safe - the reply streams into
  // the conversation view as it mounts.
  const promoteToChat = useCallback((text: string) => {
    const trimmed = text.trim()
    const charId = character?.id ?? companions[0]?.id
    if (!trimmed || !charId) return
    companion.cancel()
    stopSpeech()
    navigate('/chat')
    chat.submit(charId, trimmed)
  }, [character, companions, companion, chat, navigate])

  // The composer shows Stop while EITHER generating text OR still speaking audio,
  // and Stop halts both.
  const busy = streaming || (voiceMode && audioPlaying)
  const onStop = useCallback(() => {
    if (isOnChat) chat.stop()
    else companion.cancel()
    stopSpeech()
    setLookingAtScreen(false)
    setPendingAction(null)
  }, [isOnChat, chat, companion])

  // Button resolution re-enters the turn with canonical text: the confirm
  // pseudo-tool resolves the staged action and the outcome streams (and speaks)
  // like any reply. Clear first so the buttons drop instantly.
  const approvePendingAction = useCallback(() => {
    setPendingAction(null)
    void handleSend('Yes')
  }, [handleSend])
  const declinePendingAction = useCallback(() => {
    setPendingAction(null)
    void handleSend('No')
  }, [handleSend])

  const isListening = handsFree.state === 'capturing' || handsFree.state === 'wake-detected'

  const engine: CompanionEngine = {
    character,
    companions,
    isLoading,
    avatarProps: {
      streaming: voiceMode ? (audioPlaying || speaking) : speaking,
      thinking,
      sleeping: isActualSleeping,
      listening: isListening,
      mood,
      audioLipSync: voiceMode,
    },
    captionText,
    captionStyle,
    setCaptionStyle,
    replyText,
    streaming,
    thinking,
    talkActive,
    listeningState,
    talkState,
    karaokeState,
    handsFreeState: handsFree.state,
    handsFreePartial: handsFree.partial ?? '',
    otherTabOwner: wantsVoice && !isVoiceOwner,
    dockYield,
    handleSend: (text, attachments) => { void handleSend(text, attachments) },
    promoteToChat,
    onStop,
    lookingAtScreen,
    pendingAction,
    approvePendingAction,
    declinePendingAction,
    busy,
    focusKey,
    focusComposer,
    voiceOn,
    handsFreeOn,
    captions,
    setVoice,
    setHandsFree,
    setCaptions,
    sleeping: isActualSleeping,
    capsuleEvent,
    pulseEvent,
    dismissCapsuleEvent,
  }

  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>
}
