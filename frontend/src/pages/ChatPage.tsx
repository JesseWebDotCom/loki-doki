import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { useTTSState } from '../utils/tts';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useConnectivityStatus } from '../lib/connectivity';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWindow from '../components/chat/ChatWindow';
import ChatWelcomeView from '../components/chat/ChatWelcomeView';
import ProjectLandingView from '../components/projects/ProjectLandingView';
import ProjectModal from '../components/sidebar/ProjectModal';
import {
  sendChatMessage,
  getSessionMessages,
  getProjects,
  getSessions,
  updateProject,
  listCharacters,
  type CharacterRow,
} from '../lib/api';
import CharacterFrame from '../components/character/CharacterFrame';
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
  RoutingData,
  ProjectRecord,
  ProjectInput,
  SilentConfirmation,
} from '../lib/api';

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
  pipeline?: PipelineState;
  confirmations?: SilentConfirmation[];
  clarification?: string;
  mentionedPeople?: MentionedPerson[];
  /** DB id of the stored message — used for feedback. */
  messageId?: number;
}

export interface PipelineState {
  phase: 'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis' | 'completed';
  augmentation: AugmentationData | null;
  decomposition: DecompositionData | null;
  routing: RoutingData | null;
  synthesis: SynthesisData | null;
  microFastLane: MicroFastLaneData | null;
  streamingResponse: string;
  totalLatencyMs: number;
  confirmations: SilentConfirmation[];
  clarification: string | null;
}

const INITIAL_PIPELINE: PipelineState = {
  phase: 'idle',
  augmentation: null,
  decomposition: null,
  routing: null,
  synthesis: null,
  microFastLane: null,
  streamingResponse: '',
  totalLatencyMs: 0,
  confirmations: [],
  clarification: null,
};

const ChatPage: React.FC = () => {
  const [chatTitle, setChatTitle] = useState('Chat');
  useDocumentTitle(chatTitle);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectChats, setProjectChats] = useState<any[]>([]);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const tts = useTTSState();
  const { currentUser } = useAuth();
  const connectivity = useConnectivityStatus();
  const [activeChar, setActiveChar] = useState<CharacterRow | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  // Keeps the chat input focused across send-cycles and session
  // changes — without this the user has to click back into the box
  // every turn (and after starting a new chat).
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (!isProcessing) {
      inputRef.current?.focus();
    }
  }, [isProcessing, currentSessionId]);
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

  // Character display mode lives in a shared store so the avatar's
  // hover toolbar AND the Settings → Character section both write to
  // the same source of truth. Fullscreen is reserved for a future
  // iteration — for now it falls back to the docked layout.
  const [characterMode, setCharacterMode] = useCharacterMode();

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

  const activeProject = useMemo<ProjectRecord | null>(
    () => (activeProjectId ? projects.find((p) => p.id === activeProjectId) || null : null),
    [activeProjectId, projects],
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
        setProjectChats((s.details || []).filter((c: any) => c.project_id === activeProjectId));
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
        const match = (s.details || []).find((c: any) => String(c.id) === String(currentSessionId));
        if (!cancelled) setChatTitle(match?.title || 'Chat');
      } catch {
        if (!cancelled) setChatTitle('Chat');
      }
    })();
    return () => { cancelled = true; };
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

    const userMsg: Message = { role: 'user', content: input, timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsProcessing(true);
    setPipeline({ ...INITIAL_PIPELINE, phase: 'augmentation', streamingResponse: '' });

    try {
      await sendChatMessage(input, handleEvent, currentSessionId ? Number(currentSessionId) : undefined, activeProjectId || undefined);

      setPipeline(prev => {
        // Always emit a message at the end of a turn, even if synthesis
        // returned empty or errored. Falls back to whatever streamed in,
        // or a clear "no response" placeholder so the UI never looks stuck.
        const finalText =
          prev.synthesis?.response?.trim() ||
          prev.streamingResponse?.trim() ||
          '⚠️ No response received. Check the backend log — Ollama may have errored.';
        const completedPipeline: PipelineState = { ...prev, phase: 'completed' as PipelineState['phase'] };
        setMessages(msgs => {
          const next = [...msgs, {
            role: 'assistant' as const,
            content: finalText,
            timestamp: new Date().toLocaleTimeString(),
            sources: prev.synthesis?.sources ?? [],
            pipeline: completedPipeline,
            confirmations: prev.confirmations,
            clarification: prev.clarification ?? undefined,
            mentionedPeople: (prev.synthesis as any)?.mentioned_people ?? [],
            messageId: (prev.synthesis as any)?.assistant_message_id as number | undefined,
          }];
          // Auto-play the new assistant message (no-op when muted).
          // Skills can supply a short `spoken_text` override when the
          // on-screen response is rich (e.g. a wall of showtimes) — TTS
          // reads that instead of the full visual content.
          const spoken = prev.synthesis?.spoken_text?.trim() || finalText;
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
        content: `Pipeline error: ${err instanceof Error ? err.message : 'Unknown error'}. Is Ollama running?`,
        timestamp: new Date().toLocaleTimeString(),
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
      setPipeline({ ...INITIAL_PIPELINE, phase: 'augmentation', streamingResponse: '' });
      sendChatMessage(userInput, handleEvent, currentSessionId ? Number(currentSessionId) : undefined, activeProjectId || undefined)
        .then(() => {
          setPipeline(prev => {
            const finalText =
              prev.synthesis?.response?.trim() ||
              prev.streamingResponse?.trim() ||
              '⚠️ No response received.';
            const completedPipeline: PipelineState = { ...prev, phase: 'completed' as PipelineState['phase'] };
            setMessages(msgs => {
              const next = [...msgs, {
                role: 'assistant' as const,
                content: finalText,
                timestamp: new Date().toLocaleTimeString(),
                sources: prev.synthesis?.sources ?? [],
                pipeline: completedPipeline,
                confirmations: prev.confirmations,
                clarification: prev.clarification ?? undefined,
                mentionedPeople: (prev.synthesis as any)?.mentioned_people ?? [],
                messageId: (prev.synthesis as any)?.assistant_message_id as number | undefined,
              }];
              const spoken = prev.synthesis?.spoken_text?.trim() || finalText;
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
            timestamp: new Date().toLocaleTimeString(),
          }]);
          setPipeline({ ...INITIAL_PIPELINE });
        })
        .finally(() => setIsProcessing(false));
    }, 0);
  }, [messages, handleEvent, currentSessionId, activeProjectId, tts]);

  const handleNewSession = (projectId?: number) => {
    setMessages([]);
    setPipeline(INITIAL_PIPELINE);
    setCurrentSessionId(undefined);
    setActiveProjectId(projectId || null);
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
    try {
      const res = await getSessionMessages(sessionId);
      const loaded: Message[] = (res.messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
        timestamp: m.created_at?.split('T')[1]?.slice(0, 8) || '',
        messageId: m.id as number | undefined,
      }));
      setMessages(loaded);
    } catch (err) {
      console.error('[ChatPage] failed to load session messages', sessionId, err);
      setMessages([]);
    }
  };

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

      <main className={`flex-1 flex flex-col relative bg-background shadow-inner transition-[padding] duration-300 ${activeChar && characterMode === 'docked' ? 'pr-[380px]' : ''}`}>
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
            userName={currentUser?.username}
            onRetry={handleRetry}
          />
        )}

        <div className="pb-10 px-10 bg-transparent">
          <div className="max-w-4xl mx-auto relative group">
            {!connectivity.backendReachable && (
              <div className="mb-3 rounded-2xl border border-red-400/20 bg-red-950/40 px-4 py-3 text-sm text-red-100 shadow-m1">
                LokiDoki cannot reach the local backend right now. You can keep typing, but sending is paused until the service reconnects.
              </div>
            )}
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={
                !connectivity.backendReachable
                  ? 'Backend offline. Start LokiDoki to resume chat…'
                  : activeChar
                    ? `Chat with ${activeChar.name}…`
                    : 'Chat with your character…'
              }
              disabled={isProcessing}
              className="w-full bg-card/50 border border-border/50 rounded-2xl py-5 pl-8 pr-16 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all placeholder-gray-700 shadow-m4 text-lg font-medium disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={isProcessing}
              className="absolute right-4 top-4 p-3 bg-primary hover:bg-primary/90 text-white rounded-xl transition-all shadow-m2 shadow-primary/20 active:scale-95 disabled:opacity-50"
            >
              <Send size={20} />
            </button>
          </div>

        </div>
      </main>

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
