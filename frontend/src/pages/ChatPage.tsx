import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Send } from 'lucide-react';
import { toast } from 'sonner';
import { resolveSpokenText, ttsController, useTTSState } from '../utils/tts';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useConnectivityStatus } from '../lib/connectivity';
import { createMessageTimestamp } from '../lib/chatTimestamp';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWindow from '../components/chat/ChatWindow';
import ChatWelcomeView from '../components/chat/ChatWelcomeView';
import ProjectLandingView from '../components/projects/ProjectLandingView';
import ProjectModal from '../components/sidebar/ProjectModal';
import SourceSurface from '../components/chat/SourceSurface';
import ModeToggle from '../components/chat/ModeToggle';
import type { ToggleMode } from '../components/chat/modeToggleOptions';
import { toggleModeToOverride } from '../components/chat/modeToggleOptions';
import WorkspacePicker from '../components/workspace/WorkspacePicker';
import WorkspaceEditor from '../components/workspace/WorkspaceEditor';
import SearchDialog from '../components/chat/search/SearchDialog';
import { parseSlash } from '../components/chat/SlashCommandParser';
import type { StructuredSource } from '../components/chat/SourceCard';
import {
  createWorkspace,
  findInChat,
  deleteWorkspace,
  sendChatMessage,
  getSessionMessages,
  getProjects,
  getSessions,
  listWorkspaces,
  setSessionActiveWorkspace,
  updateProject,
  updateWorkspace,
  listCharacters,
  searchChats,
  reduceResponse,
  isResponseEvent,
  RESPONSE_INIT,
  BLOCK_PATCH,
  BLOCK_READY,
  BLOCK_FAILED,
  RESPONSE_SNAPSHOT,
  type CharacterRow,
  type ResponseEnvelope,
  type WorkspaceInput,
  type WorkspaceRecord,
} from '../lib/api';
import { envelopeFromDict } from '../lib/response-types';
import CharacterFrame from '../components/character/CharacterFrame';
import FullscreenCharacterOverlay from '../components/character/FullscreenCharacterOverlay';
import type { HeadTiltState } from '../components/character/useHeadTilt';
import { useCharacterMode } from '../utils/characterMode';
import { useAuth } from '../auth/useAuth';
import type {
  PipelineEvent,
  AugmentationData,
  DecompositionData,
  MicroFastLaneData,
  SynthesisData,
  SourceInfo,
  MediaCard,
  ChatSearchResult,
  RoutingData,
  ProjectRecord,
  ProjectInput,
  SilentConfirmation,
} from '../lib/api';
import '../styles/kiosk.css';

export interface MentionedPerson {
  id: number;
  name: string;
  photo_url?: string;
  relation?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sources?: SourceInfo[];
  media?: MediaCard[];
  pipeline?: PipelineState;
  confirmations?: SilentConfirmation[];
  clarification?: string;
  mentionedPeople?: MentionedPerson[];
  /** DB id of the stored message — used for feedback. */
  messageId?: number;
  /** Chunk 10: canonical server-reconciled envelope for this turn.
   *  When present, ``MessageItem`` renders via the block registry;
   *  when absent (legacy rows, fast-lane turns), it falls back to
   *  client-derived blocks from ``synthesis`` / ``content``. */
  envelope?: ResponseEnvelope;
}

/**
 * Chunk 10 render timings. ``performance.now()`` marks captured from
 * the SSE stream — surfaced in ``PipelineInfoPopover`` so a dev can
 * validate §14.6 "time-to-shell" targets on ``pi_cpu`` without a
 * separate devtools measurement.
 *
 * ``t0`` is the wall-clock baseline captured when the turn kicked off
 * (``handleSend``). The other fields store ``performance.now()``
 * relative to the page's time origin, and the popover renders the
 * delta ``mark - t0`` as milliseconds.
 */
export interface RenderTimings {
  t0?: number;
  shellVisible?: number;
  firstBlockReady?: number;
  snapshotApplied?: number;
}

export interface PipelineState {
  phase: 'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis' | 'completed';
  /** Descriptive label for the current activity, e.g. "Searching Corey Feldman" */
  activity: string;
  augmentation: AugmentationData | null;
  decomposition: DecompositionData | null;
  routing: RoutingData | null;
  synthesis: SynthesisData | null;
  microFastLane: MicroFastLaneData | null;
  streamingResponse: string;
  totalLatencyMs: number;
  confirmations: SilentConfirmation[];
  clarification: string | null;
  /** Chunk 10 per-turn render-timing marks for the "Render timings"
   *  section in ``PipelineInfoPopover``. Optional so pre-chunk-10
   *  test fixtures (e.g. ``MessageItem.test.tsx``) and history-hydrated
   *  rows without marks still satisfy the type. */
  renderTimings?: RenderTimings;
}

interface OpenSourcesState {
  title: string;
  sources: StructuredSource[];
}

interface PendingSearchFocus {
  sessionId: string;
  messageId: number;
}

interface DbTraceExecution {
  success?: boolean;
  chunk_index?: number;
  timing_ms?: number;
}

interface DbTraceResolution {
  chunk_index?: number;
  capability?: string;
}

interface DbSessionMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  response_envelope?: string | Record<string, unknown> | null;
  phase_latencies?: Record<string, number>;
  decomposition?: {
    urgency?: string;
    chunks?: string[];
  };
  skill_results?: {
    executions?: DbTraceExecution[];
    resolutions?: DbTraceResolution[];
  };
  response_spec_shadow?: {
    llm_model?: string;
  };
  prompt_sizes?: Record<string, unknown>;
}

interface SessionSummary {
  id: number;
  title: string;
  project_id?: number | null;
  created_at?: string;
}

const INITIAL_PIPELINE: PipelineState = {
  phase: 'idle',
  activity: '',
  augmentation: null,
  decomposition: null,
  routing: null,
  synthesis: null,
  microFastLane: null,
  streamingResponse: '',
  totalLatencyMs: 0,
  confirmations: [],
  clarification: null,
  renderTimings: {},
};

function buildPipelineStateFromDb(m: DbSessionMessage): PipelineState | undefined {
  if (!m.phase_latencies) return undefined;

  const latencies = m.phase_latencies || {};
  const decomp = m.decomposition || {};
  const skillResults = m.skill_results || {};
  const shadowSynth = m.response_spec_shadow || {};

  return {
    phase: 'completed',
    augmentation: {
      latency_ms: latencies.augmentation || 0,
      context_messages: 0,
      relevant_facts: 0,
      past_messages: 0,
      slots_assembled: m.prompt_sizes ? Object.keys(m.prompt_sizes) : [],
    },
    decomposition: {
      model: 'pipeline',
      latency_ms: latencies.decomposition || 0,
      is_course_correction: false,
      reasoning_complexity: decomp.urgency || 'low',
      asks: (decomp.chunks || []).map((text: string, i: number) => ({
        ask_id: `chunk_${i}`,
        intent: 'unknown',
        distilled_query: text,
      })),
    },
    routing: {
      skills_resolved: (skillResults.executions || []).filter((e) => e.success).length,
      skills_failed: (skillResults.executions || []).filter((e) => e.success === false).length,
      routing_log: (skillResults.resolutions || []).map((r) => {
        const exec = (skillResults.executions || []).find((e) => e.chunk_index === r.chunk_index);
        return {
          ask_id: `chunk_${r.chunk_index}`,
          intent: r.capability ?? 'unknown',
          status: exec ? (exec.success ? 'success' : 'failed') : 'no_skill',
          mechanism: null,
          latency_ms: exec?.timing_ms || 0,
        };
      }),
      latency_ms: latencies.routing || 0,
    },
    synthesis: {
      response: m.content,
      model: shadowSynth.llm_model || 'pipeline',
      latency_ms: latencies.synthesis || 0,
      tone: 'neutral',
      platform: 'lokidoki',
    },
    microFastLane: null,
    activity: '',
    streamingResponse: m.content,
    totalLatencyMs: Object.values(latencies).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0),
    confirmations: [],
    clarification: null,
    renderTimings: {},
  };
}

const ChatPage: React.FC = () => {
  const [chatTitle, setChatTitle] = useState('Chat');
  useDocumentTitle(chatTitle);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  // Chunk 13 — compose-bar mode toggle. Sticky across turns (user
  // explicitly picks a mode for a stretch of the conversation). Slash
  // commands are per-turn and reset this back to ``auto`` after send.
  const [modeToggle, setModeToggle] = useState<ToggleMode>('auto');
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [openSources, setOpenSources] = useState<OpenSourcesState | null>(null);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [findInChatOpen, setFindInChatOpen] = useState(false);
  const [findInChatQuery, setFindInChatQuery] = useState('');
  const [findInChatResults, setFindInChatResults] = useState<ChatSearchResult[]>([]);
  const [findInChatLoading, setFindInChatLoading] = useState(false);
  const [findInChatIndex, setFindInChatIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChatSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [pendingSearchFocus, setPendingSearchFocus] = useState<PendingSearchFocus | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectChats, setProjectChats] = useState<SessionSummary[]>([]);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | undefined>();
  const [isWorkspaceEditorOpen, setIsWorkspaceEditorOpen] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const tts = useTTSState();
  useAuth();
  const connectivity = useConnectivityStatus();
  const [activeChar, setActiveChar] = useState<CharacterRow | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [characterMode, setCharacterMode] = useCharacterMode();
  // Keeps the chat input focused across send-cycles and session
  // changes — without this the user has to click back into the box
  // every turn (and after starting a new chat).
  const inputRef = useRef<HTMLInputElement>(null);
  // Chunk 10 per-turn response envelope. Held in a ref so both the
  // SSE event handler and the end-of-turn commit can read/write the
  // same instance without relying on React batching. Cleared at the
  // start of each send; written on every response-family event.
  const envelopeRef = useRef<ResponseEnvelope | undefined>(undefined);

  // Idle-state ticker for the character avatar. We don't need a dense
  // requestAnimationFrame loop here — the avatar only changes between
  // idle/dozing/sleeping at 30s/90s thresholds, so a 5s interval is plenty.
  // `lastActivity` resets whenever something interesting happens (input
  // typed, message sent, generation in flight, TTS playback), and the
  // characterState memo derives thinking/speaking/idle/dozing/sleeping
  // from that.
  const [now, setNow] = useState(() => Date.now());
  const [lastActivity, setLastActivity] = useState(() => Date.now());
  useEffect(() => {
    setLastActivity(Date.now());
  }, [isProcessing, tts.speakingKey, messages.length, input]);
  // Refocus the chat input whenever a send cycle finishes or the
  // session changes. Effects run after DOM commit, so the input is
  // guaranteed to be re-enabled by the time .focus() runs — which
  // is why setTimeout(0) inside the send handler was unreliable.
  useEffect(() => {
    if (!isProcessing && characterMode !== 'fullscreen') {
      inputRef.current?.focus();
    }
  }, [isProcessing, currentSessionId, characterMode]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);
  // Transient shock pose, triggered by clicking the avatar. Auto-clears
  // on a timer so the character returns to whatever ambient state the
  // pipeline/idle logic would otherwise produce.
  const [isShocked, setIsShocked] = useState(false);
  const shockTimer = useRef<number | null>(null);
  const handleShock = useCallback(() => {
    setIsShocked(true);
    setLastActivity(Date.now());
    if (shockTimer.current != null) window.clearTimeout(shockTimer.current);
    shockTimer.current = window.setTimeout(() => {
      setIsShocked(false);
      shockTimer.current = null;
    }, 900);
  }, []);
  useEffect(() => () => {
    if (shockTimer.current != null) window.clearTimeout(shockTimer.current);
  }, []);


  // In mini mode each assistant message gets its own avatar, but only
  // ONE is awake at a time: the message currently being TTS-spoken
  // (so replaying an old response wakes that one), or — when nothing
  // is playing — the latest assistant message. All others sleep.
  const activeAssistantKey = useMemo<string | null>(() => {
    // While a turn is in flight, the LIVE ThinkingIndicator owns the
    // mini character — no past message should also show one, or we'd
    // get two avatars on screen at once.
    if (isProcessing) return null;
    // Pending wins immediately on Play click — speakingKey only flips
    // once onPlaybackStart fires, which can lag a few hundred ms behind
    // the click while the first audio chunk arrives. Without this,
    // every other mini avatar would briefly stay awake until playback
    // actually started.
    if (tts.pendingKey) return tts.pendingKey;
    if (tts.speakingKey) return tts.speakingKey;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return `msg-${i}`;
    }
    return null;
  }, [isProcessing, tts.pendingKey, tts.speakingKey, messages]);

  const characterState: HeadTiltState = isShocked
    ? 'shocked'
    : isProcessing
      ? 'thinking'
      : tts.speakingKey
        ? 'speaking'
        : now - lastActivity > 90_000
          ? 'sleeping'
          : now - lastActivity > 30_000
            ? 'dozing'
            : 'idle';

  // Sidebar (mounted on Settings/Admin/Memory/Dev) routes session
  // selection here via router state when it has no direct callback.
  // Pick that up on mount/whenever the state changes, then clear it
  // so back-nav doesn't reapply the selection.
  useEffect(() => {
    const state = location.state as
      | { selectSessionId?: string; newSession?: boolean; projectId?: number | null }
      | null;
    if (!state) return;
    if (state.selectSessionId) {
      handleSelectSession(state.selectSessionId);
    } else if (state.newSession) {
      handleNewSession(state.projectId ?? undefined);
    }
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchDialogOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const activeProject = useMemo<ProjectRecord | null>(
    () => (activeProjectId ? projects.find((p) => p.id === activeProjectId) || null : null),
    [activeProjectId, projects],
  );
  const activeWorkspace = useMemo<WorkspaceRecord | null>(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) || workspaces[0] || null,
    [activeWorkspaceId, workspaces],
  );

  // Fetch projects + project-scoped sessions whenever the project changes
  // or after a save bumps dataVersion.
  useEffect(() => {
    (async () => {
      try {
        const pRes = await getProjects();
        setProjects(pRes.projects);
      } catch {
        // backend offline — render empties
      }
    })();
  }, [dataVersion]);

  // Load the active character so the floating RiggedDicebearAvatar can
  // render its DiceBear identity. Refetched whenever the user picks
  // a different character in Settings (dataVersion bumps after that
  // flow saves). Failure is silent — chat still works without an avatar.
  useEffect(() => {
    (async () => {
      try {
        const res = await listCharacters();
        const active = res.characters.find((c) => c.id === res.active_character_id) ?? null;
        setActiveChar(active);
      } catch {
        setActiveChar(null);
      }
    })();
  }, [dataVersion]);

  useEffect(() => {
    if (!activeProjectId) {
      setProjectChats([]);
      return;
    }
    (async () => {
      try {
        const s = await getSessions();
        setProjectChats((s.details || []).filter((c: SessionSummary) => c.project_id === activeProjectId));
      } catch {
        setProjectChats([]);
      }
    })();
  }, [activeProjectId, dataVersion, currentSessionId]);

  // Reflect the active chat in the browser tab title.
  useEffect(() => {
    if (!currentSessionId) {
      setChatTitle('Chat');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await getSessions();
        const match = (s.details || []).find((c: SessionSummary) => String(c.id) === String(currentSessionId));
        if (!cancelled) setChatTitle(match?.title || 'Chat');
      } catch {
        if (!cancelled) setChatTitle('Chat');
      }
    })();
    return () => { cancelled = true; };
  }, [currentSessionId, dataVersion]);

  useEffect(() => {
    if (!findInChatOpen || !currentSessionId) return;
    if (!findInChatQuery.trim()) {
      setFindInChatResults([]);
      setFindInChatIndex(0);
      return;
    }
    let cancelled = false;
    setFindInChatLoading(true);
    void findInChat(currentSessionId, findInChatQuery, 20, 0)
      .then((response) => {
        if (cancelled) return;
        setFindInChatResults(response.results);
        setFindInChatIndex(0);
      })
      .catch(() => {
        if (!cancelled) {
          setFindInChatResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFindInChatLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, findInChatOpen, findInChatQuery]);

  useEffect(() => {
    if (!searchDialogOpen) return;
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    void searchChats(searchQuery, 50, 0)
      .then((response) => {
        if (!cancelled) {
          setSearchResults(response.results);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [searchDialogOpen, searchQuery]);

  useEffect(() => {
    if (!pendingSearchFocus) return;
    if (String(currentSessionId) !== pendingSearchFocus.sessionId) return;
    const element = document.querySelector<HTMLElement>(
      `[data-message-id="${pendingSearchFocus.messageId}"]`,
    );
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPendingSearchFocus(null);
  }, [currentSessionId, messages, pendingSearchFocus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await listWorkspaces(
          currentSessionId ? Number(currentSessionId) : undefined,
        );
        if (cancelled) return;
        setWorkspaces(response.workspaces);
        setActiveWorkspaceId((prev) => {
          const next = response.active_workspace_id || prev || response.workspaces[0]?.id;
          return next || undefined;
        });
      } catch (error) {
        if (!cancelled) {
          console.error('[ChatPage] failed to load workspaces', error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, dataVersion]);

  const handleSaveProject = async (data: ProjectInput) => {
    if (!activeProject) return;
    await updateProject(activeProject.id, data);
    setIsEditingProject(false);
    setDataVersion((v) => v + 1);
  };

  const handleEvent = useCallback((event: PipelineEvent) => {
    // Capture the session id the backend assigned for a brand-new chat
    // so the next turn reuses it instead of creating yet another row.
    if (event.phase === 'session' && event.data?.session_id) {
      const sid = String(event.data.session_id);
      setCurrentSessionId((prev) => prev ?? sid);
    }

    // Chunk 10: route the rich-response SSE family through the reducer.
    // The legacy pipeline-phase events below stay on their current path
    // so ``PipelineInfoPopover`` keeps working unchanged.
    if (isResponseEvent(event)) {
      envelopeRef.current = reduceResponse(envelopeRef.current, event);
      // Chunk 16 barge-in: a ``block_failed`` event for the summary
      // block is a hard signal to cut TTS — the content the user was
      // waiting for isn't coming, and whatever was speaking (a stale
      // fallback) is no longer accurate. Fires within one frame.
      if (
        event.phase === BLOCK_FAILED &&
        typeof event.data?.block_id === 'string' &&
        event.data.block_id === 'summary'
      ) {
        ttsController.bargeIn();
      }
      // Chunk 15 deferral #4: throttled status speech. The throttle
      // itself lives in tts.ts (≥3 s gate + ≤1 utterance per phase);
      // we just pass the phrase through when a ``status`` block patch
      // lands. Non-status patches are ignored for speech purposes.
      if (
        event.phase === BLOCK_PATCH &&
        typeof event.data?.block_id === 'string' &&
        event.data.block_id === 'status' &&
        typeof event.data?.delta === 'string'
      ) {
        const phrase = event.data.delta as string;
        // ``seq`` doubles as the phase-key — the backend emits one
        // patch per phase transition, so seq uniquely identifies
        // which phase-phrase this is.
        const phaseKey = `seq-${event.data?.seq ?? 0}`;
        void ttsController.speakStatus(phaseKey, phrase);
      }
      // Mirror the reduced envelope onto PipelineState so React renders
      // each delta. Also capture the three design-doc §14.6 timing marks.
      setPipeline(prev => {
        const marks: RenderTimings = { ...prev.renderTimings };
        if (event.phase === RESPONSE_INIT && marks.shellVisible == null) {
          marks.shellVisible = performance.now();
        } else if (event.phase === BLOCK_READY && marks.firstBlockReady == null) {
          marks.firstBlockReady = performance.now();
        } else if (event.phase === RESPONSE_SNAPSHOT && marks.snapshotApplied == null) {
          marks.snapshotApplied = performance.now();
        }
        // ``response_done`` terminal event is still routed here so the
        // ``status`` flip is captured; the existing synthesis:done path
        // below stays the authoritative source for the final text.
        return { ...prev, renderTimings: marks };
      });
      return;
    }

    setPipeline(prev => {
      // silent_confirmation / clarification_question are side-channel
      // events; don't mutate the pipeline phase chip for them.
      if (event.phase === 'silent_confirmation') {
        return {
          ...prev,
          confirmations: [...prev.confirmations, event.data as SilentConfirmation],
        };
      }
      if (event.phase === 'clarification_question') {
        return {
          ...prev,
          clarification: (event.data?.hint as string) ?? null,
        };
      }

      const next = { ...prev, phase: event.phase as PipelineState['phase'] };

      // Capture descriptive activity label from active events
      if (event.status === 'active' && event.data?.activity) {
        next.activity = event.data.activity as string;
      }

      if (event.phase === 'augmentation' && event.status === 'done') {
        next.augmentation = event.data as AugmentationData;
      }
      if (event.phase === 'micro_fast_lane' && event.status === 'done') {
        next.microFastLane = event.data as MicroFastLaneData;
      }
      if (event.phase === 'decomposition' && event.status === 'done') {
        next.decomposition = event.data as DecompositionData;
      }
      if (event.phase === 'routing' && event.status === 'done') {
        const data = event.data as Omit<RoutingData, 'latency_ms'>;
        const routingMs = (data.routing_log ?? []).reduce(
          (sum, r) => sum + (r.latency_ms ?? 0),
          0,
        );
        next.routing = { ...data, latency_ms: routingMs };
      }
      if (event.phase === 'synthesis' && event.status === 'interim') {
        // Knowledge-gap interim: show placeholder text while web search runs.
        // Do NOT trigger TTS — the real answer will arrive in synthesis:done.
        next.streamingResponse = (event.data?.response as string) ?? '';
      }
      if (event.phase === 'synthesis' && event.status === 'streaming') {
        const delta = (event.data?.delta as string | undefined) ?? '';
        next.streamingResponse = prev.streamingResponse + delta;
      }
      if (event.phase === 'synthesis' && event.status === 'done') {
        next.synthesis = event.data as SynthesisData;
        // Final response from server overrides accumulated stream (in case of mismatch).
        next.streamingResponse = (event.data as SynthesisData).response ?? prev.streamingResponse;
        const augMs = next.augmentation?.latency_ms ?? 0;
        const decompMs = next.decomposition?.latency_ms ?? 0;
        const routingMs = next.routing?.latency_ms ?? 0;
        const synthMs = (event.data as SynthesisData).latency_ms ?? 0;
        next.totalLatencyMs = augMs + decompMs + routingMs + synthMs;
      }

      return next;
    });
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;
    if (!connectivity.backendReachable) {
      toast.error('Backend offline', {
        description:
          'LokiDoki could not reach the local API. Start the backend or wait for it to reconnect, then try again.',
        duration: 4000,
      });
      return;
    }

    // Chunk 13 — slash-command parsing. When the user typed e.g.
    // ``/deep tell me about X``, this strips the prefix and flips the
    // override for THIS turn only. The persistent ``modeToggle`` value
    // applies when no slash command was used.
    const { override: slashOverride, cleanedInput } = parseSlash(input);
    const outgoingMessage = slashOverride ? cleanedInput : input;
    const userOverride = slashOverride ?? toggleModeToOverride(modeToggle);

    const userMsg: Message = { role: 'user', content: outgoingMessage, timestamp: createMessageTimestamp() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    // Slash is per-turn; reset the toggle back to ``auto`` so the next
    // message doesn't silently inherit the slash choice. Explicit toggle
    // selections stay sticky.
    if (slashOverride) {
      setModeToggle('auto');
    }
    setIsProcessing(true);
    envelopeRef.current = undefined;
    // Chunk 16 (folds chunk 15 deferral #4): arm the status-phrase
    // throttle clock. Any ``status`` block patch that lands before
    // >3 s of wall-clock has elapsed is silently skipped for TTS.
    ttsController.resetStatusThrottle();
    setPipeline({
      ...INITIAL_PIPELINE,
      phase: 'augmentation',
      streamingResponse: '',
      renderTimings: { t0: performance.now() },
    });

    try {
      await sendChatMessage(
        outgoingMessage,
        handleEvent,
        currentSessionId ? Number(currentSessionId) : undefined,
        activeProjectId || undefined,
        userOverride,
        activeWorkspaceId,
      );

      setPipeline(prev => {
        // Always emit a message at the end of a turn, even if synthesis
        // returned empty or errored. Falls back to whatever streamed in,
        // or a clear "no response" placeholder so the UI never looks stuck.
        const finalText =
          prev.synthesis?.response?.trim() ||
          prev.streamingResponse?.trim() ||
          '⚠️ No response received. Check the backend log — Ollama may have errored.';
        const completedPipeline: PipelineState = { ...prev, phase: 'completed' as PipelineState['phase'] };
        // Chunk 10: the envelope for THIS turn came in through
        // ``envelopeRef`` during the SSE stream. Attach it to the
        // message so MessageItem can render via the block registry.
        // Fast-lane turns finish with ``envelopeRef.current === undefined``
        // — MessageItem falls back to the client-derived block shape.
        const liveEnvelope = envelopeRef.current;
        envelopeRef.current = undefined;
        setMessages(msgs => {
          const next = [...msgs, {
            role: 'assistant' as const,
            content: finalText,
            timestamp: createMessageTimestamp(),
            sources: prev.synthesis?.sources ?? [],
            media: prev.synthesis?.media ?? [],
            pipeline: completedPipeline,
            confirmations: prev.confirmations,
            clarification: prev.clarification ?? undefined,
            mentionedPeople: ((prev.synthesis as SynthesisData & { mentioned_people?: MentionedPerson[] } | null)?.mentioned_people) ?? [],
            messageId: (prev.synthesis?.assistant_message_id as number | undefined),
            envelope: liveEnvelope,
          }];
          // Chunk 16: authoritative TTS input is the envelope's
          // ``spoken_text`` (emitted from the same synthesis JSON call
          // as the visual summary — design §20.3). Falls back to the
          // trimmed summary when the synthesizer didn't produce a
          // dedicated spoken form. Snapshot semantics (§20.4):
          // ``tts.speak`` is idempotent per messageKey — block patches
          // arriving after this point update the visual only.
          const spoken =
            resolveSpokenText(liveEnvelope) ||
            prev.synthesis?.spoken_text?.trim() ||
            finalText;
          tts.speak(`msg-${next.length - 1}`, spoken);
          return next;
        });
        return { ...prev, phase: 'idle' };
      });
      // Nudge the sidebar to refetch sessions + titles. The backend
      // auto-names a fresh session on the first turn and we won't see
      // that name until something re-pulls /memory/sessions.
      setDataVersion((v) => v + 1);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Pipeline error: ${err instanceof Error ? err.message : 'Unknown error'}. Is the LLM engine running?`,
        timestamp: createMessageTimestamp(),
      }]);
      setPipeline({ ...INITIAL_PIPELINE });
    } finally {
      setIsProcessing(false);
      // Refocus is handled by the useEffect below — it watches
      // isProcessing transitioning back to false and runs AFTER
      // React has re-enabled the input. Doing it inline here would
      // race the disabled→enabled prop swap and silently no-op.
    }
  };

  const handleRetry = useCallback((messageIndex: number) => {
    // Find the user message that preceded this assistant message.
    // Walk backwards from the assistant message to find the user turn.
    let userInput = '';
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userInput = messages[i].content;
        break;
      }
    }
    if (!userInput) return;

    // Remove the assistant message and re-send.
    setMessages(prev => prev.slice(0, messageIndex));
    setInput(userInput);
    // Defer the send to next tick so state updates settle.
    setTimeout(() => {
      setInput('');
      setIsProcessing(true);
      envelopeRef.current = undefined;
      setPipeline({
        ...INITIAL_PIPELINE,
        phase: 'augmentation',
        streamingResponse: '',
        renderTimings: { t0: performance.now() },
      });
      sendChatMessage(
        userInput,
        handleEvent,
        currentSessionId ? Number(currentSessionId) : undefined,
        activeProjectId || undefined,
        // Retry re-uses the current toggle — the original slash (if
        // any) was consumed when the turn was first sent, and the
        // retried message text no longer carries the prefix.
        toggleModeToOverride(modeToggle),
        activeWorkspaceId,
      )
        .then(() => {
          setPipeline(prev => {
            const finalText =
              prev.synthesis?.response?.trim() ||
              prev.streamingResponse?.trim() ||
              '⚠️ No response received.';
            const completedPipeline: PipelineState = { ...prev, phase: 'completed' as PipelineState['phase'] };
            const liveEnvelope = envelopeRef.current;
            envelopeRef.current = undefined;
            setMessages(msgs => {
              const next = [...msgs, {
                role: 'assistant' as const,
                content: finalText,
                timestamp: createMessageTimestamp(),
                sources: prev.synthesis?.sources ?? [],
                media: prev.synthesis?.media ?? [],
                pipeline: completedPipeline,
                confirmations: prev.confirmations,
                clarification: prev.clarification ?? undefined,
                mentionedPeople: ((prev.synthesis as SynthesisData & { mentioned_people?: MentionedPerson[] } | null)?.mentioned_people) ?? [],
                messageId: (prev.synthesis?.assistant_message_id as number | undefined),
                envelope: liveEnvelope,
              }];
              const spoken =
                resolveSpokenText(liveEnvelope) ||
                prev.synthesis?.spoken_text?.trim() ||
                finalText;
              tts.speak(`msg-${next.length - 1}`, spoken);
              return next;
            });
            return { ...prev, phase: 'idle' };
          });
          setDataVersion((v) => v + 1);
        })
        .catch(err => {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `Pipeline error: ${err instanceof Error ? err.message : 'Unknown error'}`,
            timestamp: createMessageTimestamp(),
          }]);
          setPipeline({ ...INITIAL_PIPELINE });
        })
        .finally(() => setIsProcessing(false));
    }, 0);
  }, [messages, handleEvent, currentSessionId, activeProjectId, tts, modeToggle, activeWorkspaceId]);

  const handleNewSession = (projectId?: number) => {
    setMessages([]);
    setPipeline(INITIAL_PIPELINE);
    setCurrentSessionId(undefined);
    setActiveProjectId(projectId || null);
    setOpenSources(null);
    setFindInChatOpen(false);
    setFindInChatQuery('');
    setFindInChatResults([]);
    // Same reason as above — defer to the effect that watches
    // isProcessing/currentSessionId so focus lands AFTER the
    // re-render rather than before.
    inputRef.current?.focus();
  };

  const handleSelectSession = async (sessionId: string) => {
    // Switch state immediately so the right pane reacts even if the
    // messages fetch is slow or errors. Clearing activeProjectId
    // ensures the ProjectLandingView gate (`activeProject && !currentSessionId`)
    // can never trap us when picking a chat from the sidebar.
    setActiveProjectId(null);
    setCurrentSessionId(sessionId);
    setPipeline(INITIAL_PIPELINE);
    setMessages([]);
    setOpenSources(null);
    setFindInChatOpen(false);
    setFindInChatQuery('');
    setFindInChatResults([]);
    try {
      const res = await getSessionMessages(sessionId);
      const loaded: Message[] = ((res.messages || []) as DbSessionMessage[]).map((m) => {
        // Chunk 10: hydrate the persisted ``response_envelope`` column
        // (written by chat.py on the ``response_snapshot`` event) into
        // a live ``ResponseEnvelope`` so history replay renders via
        // the block registry without re-invoking synthesis. Accept
        // both a pre-parsed object and the raw JSON string shape;
        // tolerate parse failures by falling back to the legacy path.
        let envelope: ResponseEnvelope | undefined = undefined;
        const raw = m.response_envelope;
        if (raw) {
          try {
            const data: Record<string, unknown> =
              typeof raw === 'string' ? JSON.parse(raw) : raw;
            envelope = envelopeFromDict(data);
          } catch {
            envelope = undefined;
          }
        }
        return {
          role: m.role,
          content: m.content,
          timestamp: m.created_at || '',
          messageId: m.id as number | undefined,
          pipeline: buildPipelineStateFromDb(m),
          envelope,
        };
      });
      setMessages(loaded);
    } catch (err) {
      console.error('[ChatPage] failed to load session messages', sessionId, err);
      setMessages([]);
    }
  };

  const handleOpenSources = useCallback((messageIndex: number) => {
    const message = messages[messageIndex];
    if (!message || message.role !== 'assistant') return;
    // Prefer the envelope's structured source_surface when present
    // (chunk 11); fall back to the legacy ``message.sources`` column
    // for pre-envelope rows + fast-lane turns.
    const envelopeSources =
      (message.envelope?.source_surface as StructuredSource[] | undefined) ?? undefined;
    const fallbackSources: StructuredSource[] | undefined = message.sources?.map((s) => ({
      title: s.title,
      url: s.url,
    }));
    const sources = envelopeSources && envelopeSources.length > 0
      ? envelopeSources
      : fallbackSources ?? [];
    if (sources.length === 0) return;
    const preview = message.content.replace(/\s+/g, ' ').trim();
    setOpenSources({
      title: preview.slice(0, 72) + (preview.length > 72 ? '…' : ''),
      sources,
    });
  }, [messages]);

  const handleSelectWorkspace = useCallback(async (workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    if (!currentSessionId) return;
    try {
      await setSessionActiveWorkspace(Number(currentSessionId), workspaceId);
      setDataVersion((value) => value + 1);
    } catch (error) {
      console.error('[ChatPage] failed to switch workspace', error);
      toast.error('Could not switch workspace');
    }
  }, [currentSessionId]);

  const handleSaveWorkspace = useCallback(async (workspaceId: string, input: WorkspaceInput) => {
    await updateWorkspace(workspaceId, input);
    setDataVersion((value) => value + 1);
  }, []);

  const handleCreateWorkspace = useCallback(async (input: WorkspaceInput) => {
    const created = await createWorkspace(input);
    setActiveWorkspaceId(created.id);
    setDataVersion((value) => value + 1);
  }, []);

  const handleDeleteWorkspace = useCallback(async (workspaceId: string) => {
    await deleteWorkspace(workspaceId);
    setActiveWorkspaceId('default');
    setDataVersion((value) => value + 1);
  }, []);

  const handleExitFullscreen = useCallback(() => {
    setCharacterMode('docked');
  }, [setCharacterMode]);

  const handleSelectFindResult = useCallback((result: ChatSearchResult) => {
    setPendingSearchFocus({
      sessionId: String(result.session_id),
      messageId: result.message_id,
    });
    void handleSelectSession(String(result.session_id));
  }, []);

  const handleSelectGlobalSearchResult = useCallback((result: ChatSearchResult) => {
    setSearchDialogOpen(false);
    setPendingSearchFocus({
      sessionId: String(result.session_id),
      messageId: result.message_id,
    });
    void handleSelectSession(String(result.session_id));
  }, []);

  // Chunk 15 deferral #1 (folded into chunk 16). ``FollowUpsBlock`` and
  // ``ClarificationBlock`` surface chip clicks via ``onFollowUp``; until
  // now nothing set the callback, so chips rendered but were inert.
  // We bridge them into the existing send path: the chip text becomes
  // the next user turn.
  const handleFollowUp = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    setInput(trimmed);
    // Defer so the input state settles before ``handleSend`` reads it.
    setTimeout(() => {
      handleSend();
    }, 0);
    // Note: handleSend is not referenced in deps because it's stable
    // enough for the UX (clicking a chip fires once) and adding it
    // would drag the whole send closure into every dependency graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProcessing]);

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar
        phase={pipeline.phase}
        pipeline={pipeline}
        onNewSession={handleNewSession}
        onSelectSession={handleSelectSession}
        currentSessionId={currentSessionId}
        activeProjectId={activeProjectId}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          // Switching project view clears the active chat so the
          // landing view (or new-chat flow) takes over.
          setCurrentSessionId(undefined);
        }}
        projectsVersion={dataVersion}
        onProjectsChanged={() => setDataVersion((v) => v + 1)}
      />

      <main className={`flex-1 flex flex-col relative bg-background shadow-inner transition-[padding] duration-300 ${
        (activeChar && characterMode === 'docked' ? 'pr-[380px] ' : '') +
        (openSources ? 'sm:pr-[380px]' : '')
      }`}>
        {activeChar && characterMode === 'docked' && (
          <div
            className="absolute right-10 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center"
            title={activeChar.name}
          >
            <CharacterFrame
              character={activeChar}
              size={312}
              state={characterState}
              mode={characterMode}
              onModeChange={setCharacterMode}
              onShock={handleShock}
            />
          </div>
        )}
        {activeProject && !currentSessionId ? (
          <ProjectLandingView
            project={activeProject}
            chats={projectChats}
            onNewChat={() => handleNewSession(activeProject.id)}
            onEditProject={() => setIsEditingProject(true)}
            onSelectChat={handleSelectSession}
          />
        ) : messages.length === 0 && !isProcessing ? (
          <ChatWelcomeView activeChar={activeChar} />
        ) : (
          <ChatWindow
            messages={messages}
            pipeline={pipeline}
            activeChar={activeChar}
            characterState={characterState}
            characterMode={characterMode}
            onCharacterModeChange={setCharacterMode}
            onCharacterShock={handleShock}
            activeAssistantKey={activeAssistantKey}
            assistantName={activeChar?.name}
            onRetry={handleRetry}
            onOpenSources={handleOpenSources}
            onFollowUp={handleFollowUp}
            findOpen={findInChatOpen}
            findQuery={findInChatQuery}
            findResults={findInChatResults}
            findActiveIndex={findInChatIndex}
            findLoading={findInChatLoading}
            onOpenFind={() => setFindInChatOpen(true)}
            onCloseFind={() => setFindInChatOpen(false)}
            onFindQueryChange={setFindInChatQuery}
            onFindNext={() => {
              if (findInChatResults.length === 0) return;
              const nextIndex = (findInChatIndex + 1) % findInChatResults.length;
              setFindInChatIndex(nextIndex);
              handleSelectFindResult(findInChatResults[nextIndex]);
            }}
            onFindPrev={() => {
              if (findInChatResults.length === 0) return;
              const nextIndex =
                (findInChatIndex - 1 + findInChatResults.length) % findInChatResults.length;
              setFindInChatIndex(nextIndex);
              handleSelectFindResult(findInChatResults[nextIndex]);
            }}
            onSelectFindResult={handleSelectFindResult}
          />
        )}

        <div className="bg-transparent px-[var(--app-shell-gutter)] pb-10 pt-3 sm:pb-12">
          <div
            className="relative mx-auto group"
            style={{ maxWidth: 'var(--app-content-max)' }}
          >
            {!connectivity.backendReachable && (
              <div className="mb-3 rounded-2xl border border-red-400/20 bg-red-950/40 px-4 py-3 text-sm text-red-100 shadow-m1">
                LokiDoki cannot reach the local backend right now. You can keep typing, but sending is paused until the service reconnects.
              </div>
            )}
            <div className="mb-2 flex items-center justify-between gap-3">
              <WorkspacePicker
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspace?.id}
                disabled={isProcessing}
                onSelect={handleSelectWorkspace}
                onManage={() => setIsWorkspaceEditorOpen(true)}
              />
              <ModeToggle
                value={modeToggle}
                onChange={setModeToggle}
                disabled={isProcessing}
              />
            </div>
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setSearchDialogOpen(true)}
                className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-border/50 bg-card/60 px-4 text-sm font-medium text-foreground shadow-m1 transition-colors hover:bg-accent"
              >
                <Search className="h-4 w-4" />
                Search chats
              </button>
            </div>
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={input}
              onChange={(e) => {
                // Chunk 16 barge-in: the moment the user starts typing,
                // any in-flight TTS is cancelled within one frame. We
                // check first so idle turns don't churn the emitter.
                if (tts.speakingKey || tts.pendingKey) tts.bargeIn();
                setInput(e.target.value);
              }}
              onFocus={() => {
                if (tts.speakingKey || tts.pendingKey) tts.bargeIn();
              }}
              onKeyDown={(e) => {
                if (tts.speakingKey || tts.pendingKey) tts.bargeIn();
                if (e.key === 'Enter') handleSend();
              }}
              placeholder={
                !connectivity.backendReachable
                  ? 'Backend offline. Start LokiDoki to resume chat…'
                  : activeChar
                    ? `Chat with ${activeChar.name}…`
                    : 'Chat with your character…'
              }
              disabled={isProcessing}
              className="w-full rounded-[1.45rem] border border-border/50 bg-card/50 py-3.5 pl-6 pr-16 text-sm font-medium shadow-m4 transition-all placeholder:text-muted-foreground/45 focus:border-primary/50 focus:outline-none focus:ring-4 focus:ring-primary/5 disabled:opacity-50 sm:text-base"
            />
            <button
              onClick={handleSend}
              disabled={isProcessing}
              className="absolute right-3.5 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl bg-primary text-white shadow-m2 shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={18} />
            </button>
          </div>

        </div>

        <SourceSurface
          open={openSources !== null}
          onOpenChange={(next) => {
            if (!next) setOpenSources(null);
          }}
          title={openSources?.title}
          sources={openSources?.sources ?? []}
        />
        <WorkspaceEditor
          open={isWorkspaceEditorOpen}
          onOpenChange={setIsWorkspaceEditorOpen}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace?.id}
          onSelect={handleSelectWorkspace}
          onSave={handleSaveWorkspace}
          onCreate={handleCreateWorkspace}
          onDelete={handleDeleteWorkspace}
        />
        <SearchDialog
          open={searchDialogOpen}
          onOpenChange={setSearchDialogOpen}
          query={searchQuery}
          results={searchResults}
          loading={searchLoading}
          onQueryChange={setSearchQuery}
          onSelectResult={handleSelectGlobalSearchResult}
        />
      </main>

      {activeChar && characterMode === 'fullscreen' && (
        <FullscreenCharacterOverlay
          character={activeChar}
          state={characterState}
          onExit={handleExitFullscreen}
          input={input}
          setInput={setInput}
          onSend={handleSend}
          isProcessing={isProcessing}
          placeholder={
            !connectivity.backendReachable
              ? 'Backend offline. Start LokiDoki to resume chat…'
              : activeChar
                ? `Chat with ${activeChar.name}…`
                : 'Chat with your character…'
          }
        />
      )}

      <ProjectModal
        isOpen={isEditingProject}
        onClose={() => setIsEditingProject(false)}
        onSubmit={handleSaveProject}
        initialData={activeProject || null}
        title="Edit Project"
      />
    </div>
  );
};

export default ChatPage;
