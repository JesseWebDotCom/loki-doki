import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWindow from '../components/chat/ChatWindow';
import ProjectLandingView from '../components/projects/ProjectLandingView';
import ProjectModal from '../components/sidebar/ProjectModal';
import {
  sendChatMessage,
  getSessionMessages,
  getProjects,
  getSessions,
  updateProject,
} from '../lib/api';
import type {
  PipelineEvent,
  DecompositionData,
  SynthesisData,
  SourceInfo,
  RoutingData,
  ProjectRecord,
  ProjectInput,
  SilentConfirmation,
} from '../lib/api';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sources?: SourceInfo[];
  pipeline?: PipelineState;
  confirmations?: SilentConfirmation[];
  clarification?: string;
}

export interface PipelineState {
  phase: 'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis' | 'completed';
  decomposition: DecompositionData | null;
  routing: RoutingData | null;
  synthesis: SynthesisData | null;
  streamingResponse: string;
  totalLatencyMs: number;
  confirmations: SilentConfirmation[];
  clarification: string | null;
}

const INITIAL_PIPELINE: PipelineState = {
  phase: 'idle',
  decomposition: null,
  routing: null,
  synthesis: null,
  streamingResponse: '',
  totalLatencyMs: 0,
  confirmations: [],
  clarification: null,
};

const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'LokiDoki Core initialized. System ready for agentic orchestration.', timestamp: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectChats, setProjectChats] = useState<any[]>([]);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);

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
        const decompMs = next.decomposition?.latency_ms ?? 0;
        const routingMs = next.routing?.latency_ms ?? 0;
        const synthMs = (event.data as SynthesisData).latency_ms ?? 0;
        next.totalLatencyMs = decompMs + routingMs + synthMs;
      }

      return next;
    });
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

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
        setMessages(msgs => [...msgs, {
          role: 'assistant',
          content: finalText,
          timestamp: new Date().toLocaleTimeString(),
          sources: prev.synthesis?.sources ?? [],
          pipeline: completedPipeline,
          confirmations: prev.confirmations,
          clarification: prev.clarification ?? undefined,
        }]);
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
    }
  };

  const handleNewSession = (projectId?: number) => {
    setMessages([
      { role: 'assistant', content: projectId ? `New project-scoped chat started. System ready.` : 'New chat started. System ready.', timestamp: new Date().toLocaleTimeString() }
    ]);
    setPipeline(INITIAL_PIPELINE);
    setCurrentSessionId(undefined);
    setActiveProjectId(projectId || null);
  };

  const handleSelectSession = async (sessionId: string) => {
    // Switch state immediately so the right pane reacts even if the
    // messages fetch is slow or errors. Clearing activeProjectId
    // ensures the ProjectLandingView gate (`activeProject && !currentSessionId`)
    // can never trap us when picking a chat from the sidebar.
    setActiveProjectId(null);
    setCurrentSessionId(sessionId);
    setPipeline(INITIAL_PIPELINE);
    setMessages([
      { role: 'assistant', content: 'Loading session…', timestamp: new Date().toLocaleTimeString() }
    ]);
    try {
      const res = await getSessionMessages(sessionId);
      const loaded: Message[] = (res.messages || []).map((m: any) => ({
        role: m.role,
        content: m.content,
        timestamp: m.created_at?.split('T')[1]?.slice(0, 8) || '',
      }));
      setMessages(loaded.length > 0 ? loaded : [
        { role: 'assistant', content: 'Empty session loaded.', timestamp: new Date().toLocaleTimeString() }
      ]);
    } catch (err) {
      console.error('[ChatPage] failed to load session messages', sessionId, err);
      setMessages([
        { role: 'assistant', content: `Failed to load session: ${err instanceof Error ? err.message : 'unknown error'}`, timestamp: new Date().toLocaleTimeString() }
      ]);
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

      <main className="flex-1 flex flex-col relative bg-background shadow-inner">
        {activeProject && !currentSessionId ? (
          <ProjectLandingView
            project={activeProject}
            chats={projectChats}
            onNewChat={() => handleNewSession(activeProject.id)}
            onEditProject={() => setIsEditingProject(true)}
            onSelectChat={handleSelectSession}
          />
        ) : (
          <ChatWindow messages={messages} pipeline={pipeline} />
        )}

        <div className="p-10 bg-background/50 backdrop-blur-xl border-t border-border/20">
          <div className="max-w-4xl mx-auto relative group">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Interact with the LokiDoki agentic pipeline..."
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

          <div className="text-center mt-6 flex items-center justify-center gap-4">
            <span className="h-[1px] w-12 bg-border/50" />
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.4em] font-bold font-sans">
              Onyx Material Orchestration
            </div>
            <span className="h-[1px] w-12 bg-border/50" />
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
