import { useEffect, useRef, useState } from "react"
import { Bolt, Brain, ChevronDown, Clock3, Cpu, ExternalLink, LoaderCircle, RotateCcw, Volume2, VolumeX, ThumbsUp, ThumbsDown } from "lucide-react"

import { ChatCopyButton } from "@/components/chat-copy-button"
import { Button } from "@/components/ui/button"

type AssistantMeta = {
  request_type: string
  route: string
  reason: string
  turn_id?: string
  voice_summary?: string
  response_style?: string
  response_style_debug?: {
    selected_style?: string
    scores?: Record<string, number>
    factors?: Array<{
      source?: string
      style?: string
      weight?: number
      detail?: string
    }>
  }
  skill_route?: {
    outcome: string
    reason: string
    candidate?: {
      skill_id: string
      action: string
    } | null
  }
  execution?: {
    provider: string
    backend: string
    model: string
    acceleration: string
  }
  skill_result?: {
    skill: string
    action: string
    data?: {
      title?: string
      description?: string
      extract?: string
      page_url?: string
      thumbnail?: {
        url?: string
        width?: number
        height?: number
      }
      infobox?: Record<string, unknown>
    }
  }
  rendered_response?: {
    summary: string
    metadata: Record<string, unknown>
  }
  prompt_debug?: {
    prompt_hash?: string
    cache_hit?: boolean
    character_id?: string | null
    care_profile_id?: string
    suppress_chatter?: boolean
  }
  memory_debug?: {
    used?: boolean
    session_applied?: boolean
    long_term_applied?: boolean
    session_preview?: string
    long_term_preview?: string
  }
}

export type AssistantMessage = {
  role: "assistant"
  content: string
  pending?: boolean
  debug?: {
    startedAtMs?: number
    durationMs?: number
  }
  meta?: AssistantMeta
}

type AssistantMessageCardProps = {
  message: AssistantMessage
  messageKey: string
  messageTime: string
  pendingSpeechMessageKey: string
  speakingMessageKey: string
  debugNow: number
  showRuntimeDebug: boolean
  onPlayVoice: (message: AssistantMessage, messageKey: string) => void
  onRetrySmart?: () => void
  retrySmartPending?: boolean
}

function executionTier(execution?: AssistantMeta["execution"]): { icon: typeof Bolt; label: string } {
  if (!execution) {
    return { icon: Cpu, label: "Local" }
  }
  if (execution.provider === "llm_thinking") {
    return { icon: Brain, label: "Smart" }
  }
  if (execution.provider === "llm_fast") {
    return { icon: Bolt, label: "Fast" }
  }
  return { icon: Cpu, label: "Local" }
}

export function AssistantMessageCard({
  message,
  messageKey,
  messageTime,
  pendingSpeechMessageKey,
  speakingMessageKey,
  debugNow,
  showRuntimeDebug,
  onPlayVoice,
  onRetrySmart,
  retrySmartPending = false,
}: AssistantMessageCardProps) {
  const [isToolbarVisible, setIsToolbarVisible] = useState(false)
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const detailPanelRef = useRef<HTMLDivElement | null>(null)
  const tier = executionTier(message.meta?.execution)
  const TierIcon = tier.icon
  const [isThoughtExpanded, setIsThoughtExpanded] = useState(false)

  const detailLines = [
    message.meta?.execution ? `${tier.label} ${message.meta.execution.model}` : null,
    message.meta?.execution
      ? `${message.meta.execution.backend} / ${message.meta.execution.acceleration} / ${message.meta.execution.model}`
      : null,
    message.meta?.request_type === "skill_call" && message.meta?.skill_result?.skill
      ? `skill used / ${message.meta.skill_result.skill}.${message.meta.skill_result.action}`
      : "skill used / none",
    message.meta?.skill_route
      ? message.meta.skill_route.outcome === "skill_call" && message.meta.skill_route.candidate
        ? `skill route / ${message.meta.skill_route.candidate.skill_id}.${message.meta.skill_route.candidate.action}`
        : `skill route / ${message.meta.skill_route.outcome}`
      : null,
    message.meta?.prompt_debug?.prompt_hash
      ? `prompt / ${message.meta.prompt_debug.prompt_hash.slice(0, 12)}`
      : null,
    message.debug
      ? message.pending
        ? `${((debugNow - (message.debug.startedAtMs || debugNow)) / 1000).toFixed(1)}s live`
        : `${((message.debug.durationMs || 0) / 1000).toFixed(2)}s total`
      : null,
    message.meta?.prompt_debug?.suppress_chatter !== undefined
      ? `chatter suppression / ${message.meta.prompt_debug.suppress_chatter ? "on" : "off"}`
      : null,
    message.meta?.response_style
      ? `response style / ${message.meta.response_style}`
      : null,
    message.meta?.memory_debug
      ? `memory / ${message.meta.memory_debug.used ? "used" : "not used"}`
      : null,
  ].filter((line): line is string => Boolean(line))

  const technicalDetailText = detailLines.join("\n")

  useEffect(() => {
    if (!showTechnicalDetails || !detailPanelRef.current) return
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    })
  }, [showTechnicalDetails])

  function renderWithLinks(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    const urlRegex = /((https?:\/\/)?([\w-]+\.)+[a-zA-Z]{2,}(\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?)/g;
    const result: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const [raw] = match;
      const index = match.index;
      if (index > lastIndex) {
        result.push(text.slice(lastIndex, index));
      }
      const url = raw.startsWith('http') ? raw : `https://${raw}`;
      result.push(
        <a
          key={`link-${index}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-[#ececec] hover:text-white"
        >
          {raw}
        </a>
      );
      lastIndex = index + raw.length;
    }
    if (lastIndex < text.length) result.push(text.slice(lastIndex));
    return result;
  }

  function renderContent(text: string): React.ReactNode[] {
    if (!text) return [];
    const normalized = text.trim().replace(/([.!?])\s+(#+\s)/g, '$1\n$2');
    const lines = normalized.split('\n');
    return lines.map((line, lineIndex) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) return <h1 key={`h1-${lineIndex}`} className="mb-4 text-2xl font-extrabold text-[#ececec]">{renderInline(line.replace(/^# /, ''))}</h1>;
      if (trimmed.startsWith('## ')) return <h2 key={`h2-${lineIndex}`} className="mb-3 text-xl font-bold text-[#ececec]">{renderInline(line.replace(/^## /, ''))}</h2>;
      if (trimmed.startsWith('### ')) return <h3 key={`h3-${lineIndex}`} className="mb-2 text-lg font-semibold text-[#ececec]">{renderInline(line.replace(/^### /, ''))}</h3>;
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        return (
          <div key={`li-${lineIndex}`} className="ml-4 flex gap-2 leading-[1.7] mb-2">
            <span className="shrink-0 mt-3 h-1 w-1 rounded-full bg-[#8e8e8e]" />
            <div className="flex-1 text-[#ececec]">{renderInline(line.replace(/^[-*] /, ''))}</div>
          </div>
        );
      }
      if (!trimmed) return <div key={`br-${lineIndex}`} className="h-6" />;
      return <p key={`p-${lineIndex}`} className="leading-[1.7] mb-6 text-[#ececec]">{renderInline(line)}</p>;
    });
  }

  function renderInline(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    const boldRegex = /(\*\*(.*?)\*\*|__(.*?)__)/g;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;
    while ((match = boldRegex.exec(text)) !== null) {
      const [full, , starContent, underscoreContent] = match;
      const content = starContent || underscoreContent;
      const index = match.index;
      if (index > lastIndex) parts.push(...renderItalics(text.slice(lastIndex, index)));
      parts.push(<strong key={`bold-${index}`} className="font-bold text-white">{renderItalics(content)}</strong>);
      lastIndex = index + full.length;
    }
    if (lastIndex < text.length) parts.push(...renderItalics(text.slice(lastIndex)));
    return parts;
  }

  function renderItalics(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    const italicRegex = /(\*(.*?)\*|_(.*?)_)/g;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;
    while ((match = italicRegex.exec(text)) !== null) {
      const [full, , starContent, underscoreContent] = match;
      const content = starContent || underscoreContent;
      const index = match.index;
      if (index > lastIndex) parts.push(...renderLinksAndImages(text.slice(lastIndex, index)));
      parts.push(<em key={`italic-${index}`} className="italic">{renderLinksAndImages(content)}</em>);
      lastIndex = index + full.length;
    }
    if (lastIndex < text.length) parts.push(...renderLinksAndImages(text.slice(lastIndex)));
    return parts;
  }

  function renderLinksAndImages(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    const markdownRegex = /(!?\[([^\]]*)\]\((.*?)\))/g;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;
    while ((match = markdownRegex.exec(text)) !== null) {
      const [full, , altText, urlOrSrcRaw] = match;
      const index = match.index;
      const isImage = full.startsWith('!');
      const urlOrSrc = urlOrSrcRaw.replace(/\s+/g, '');
      if (index > lastIndex) parts.push(...renderWithLinks(text.slice(lastIndex, index)));
      if (isImage) {
        parts.push(
          <div key={`img-${index}`} className="my-6">
            <img src={urlOrSrc} alt={altText || "Generated Image"} className="max-w-md w-full rounded-xl shadow-2xl ring-1 ring-white/10" />
          </div>
        );
      } else {
        parts.push(
          <a
            key={`link-${index}`}
            href={urlOrSrc.startsWith('http') ? urlOrSrc : `https://${urlOrSrc}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#ececec] underline decoration-[#8e8e8e]/40 underline-offset-4 hover:decoration-[#ececec]"
          >
            {altText || urlOrSrc}
          </a>
        );
      }
      lastIndex = index + full.length;
    }
    if (lastIndex < text.length) parts.push(...renderWithLinks(text.slice(lastIndex)));
    return parts;
  }

  const durationMs = message.debug?.durationMs || 0;
  const thoughtTime = (durationMs / 1000).toFixed(1);

  return (
    <div
      className="group relative mb-12 flex w-full items-start gap-4"
      onMouseEnter={() => setIsToolbarVisible(true)}
      onMouseLeave={() => setIsToolbarVisible(false)}
      ref={cardRef}
    >
      <div className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-md border border-[#1a1a1a] bg-[#0d0d0d]">
        <img src="/lokidoki-logo.svg" alt="LokiDoki" className="h-[18px] w-[18px] opacity-80" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 mb-4">
          {!message.pending && durationMs > 0 && (
            <button 
              onClick={() => setIsThoughtExpanded(!isThoughtExpanded)}
              className="flex items-center gap-2 text-[13px] font-medium text-[#8e8e8e] hover:text-[#ececec] transition-colors"
            >
              <span>Thought for {thoughtTime}s</span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isThoughtExpanded ? 'rotate-180' : ''}`} />
            </button>
          )}
          {message.pending && (
            <span className="text-[13px] font-medium text-[#8e8e8e] animate-pulse">Thinking...</span>
          )}
        </div>

        {isThoughtExpanded && detailLines.length > 0 && (
            <div className="mb-6 rounded-xl border border-[#1a1a1a] bg-[#161616] p-4 text-[13px] text-[#8e8e8e] leading-relaxed shadow-inner">
              <div className="font-bold uppercase tracking-wider text-[#8e8e8e]/40 text-[10px] mb-3">Reasoning Path</div>
              <div className="space-y-1.5 font-mono">
                {detailLines.map((line, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="opacity-30">›</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            </div>
        )}

        <div className="w-full">
          <div className="text-[18px] font-medium leading-[1.7] text-[#ececec] break-words">
            {renderContent(message.content)}
          </div>
        </div>

        {!message.pending && (
          <div className={`mt-4 flex items-center gap-0.5 transition-opacity duration-200 ${isToolbarVisible ? 'opacity-100' : 'opacity-0'}`}>
            <ChatCopyButton className="h-7 w-7 text-[#8e8e8e]/60 hover:text-[#ececec] p-1.5" content={message.content} />
            <Button className="h-7 w-7 text-[#8e8e8e]/60 hover:text-[#ececec]" size="icon" variant="ghost">
              <ThumbsUp className="h-[14px] w-[14px]" />
            </Button>
            <Button className="h-7 w-7 text-[#8e8e8e]/60 hover:text-[#ececec]" size="icon" variant="ghost">
              <ThumbsDown className="h-[14px] w-[14px]" />
            </Button>
            {onRetrySmart && (
              <Button
                className={`h-7 w-7 text-[#8e8e8e]/60 hover:text-[#ececec] ${retrySmartPending ? "animate-pulse" : ""}`}
                disabled={retrySmartPending}
                onClick={onRetrySmart}
                size="icon"
                variant="ghost"
              >
                <RotateCcw className="h-[15px] w-[15px]" />
              </Button>
            )}
            <Button
              className={`h-8 w-8 text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec] ${pendingSpeechMessageKey === messageKey || speakingMessageKey === messageKey ? "animate-pulse" : ""}`}
              onClick={() => onPlayVoice(message, messageKey)}
              size="icon"
              variant="ghost"
            >
              {pendingSpeechMessageKey === messageKey ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : speakingMessageKey === messageKey ? (
                <VolumeX className="h-[15px] w-[15px]" />
              ) : (
                <Volume2 className="h-[15px] w-[15px]" />
              )}
            </Button>
            
            {detailLines.length > 0 && (
              <Button
                className="h-8 w-8 text-[#8e8e8e] hover:bg-white/[0.05] hover:text-[#ececec] ml-2"
                onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
                size="icon"
                variant="ghost"
              >
                <TierIcon className="h-[14px] w-[14px]" />
              </Button>
            )}
          </div>
        )}

        {showTechnicalDetails && (
          <div className="mt-4 rounded-xl bg-[#161616] border border-[#1a1a1a] p-3 overflow-hidden shadow-2xl">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#8e8e8e]/40">System context</div>
            <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap text-[#ececec]/70">
              {technicalDetailText}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
