import { useEffect, useRef, useState } from "react"
import { Bolt, Brain, ChevronDown, Clock3, Cpu, ExternalLink, LoaderCircle, RotateCcw, Volume2, VolumeX } from "lucide-react"

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
    message.meta?.response_style_debug?.scores
      ? `style scores / ${Object.entries(message.meta.response_style_debug.scores).map(([style, score]) => `${style}:${score}`).join(" / ")}`
      : null,
    message.meta?.response_style_debug?.factors?.length
      ? `style factors / ${message.meta.response_style_debug.factors.map((factor) => `${factor.source}:${factor.style}:${factor.weight}`).join(" / ")}`
      : null,
    message.meta?.memory_debug
      ? `memory / ${message.meta.memory_debug.used ? "used" : "not used"}`
      : null,
    message.meta?.memory_debug?.session_applied !== undefined
      ? `session memory / ${message.meta.memory_debug.session_applied ? "applied" : "not applied"}`
      : null,
    message.meta?.memory_debug?.long_term_applied !== undefined
      ? `long-term memory / ${message.meta.memory_debug.long_term_applied ? "applied" : "not applied"}`
      : null,
    message.meta?.memory_debug?.session_preview
      ? `session preview / ${message.meta.memory_debug.session_preview}`
      : null,
    message.meta?.memory_debug?.long_term_preview
      ? `long-term preview / ${message.meta.memory_debug.long_term_preview}`
      : null,
  ].filter((line): line is string => Boolean(line))
  const technicalDetailText = detailLines.join("\n")

  useEffect(() => {
    if (!showTechnicalDetails || !detailPanelRef.current) {
      return
    }
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    })
  }, [showTechnicalDetails])

  useEffect(() => {
    if (!showTechnicalDetails) {
      return
    }
    function handlePointerDown(event: MouseEvent) {
      if (!cardRef.current?.contains(event.target as Node)) {
        setIsToolbarVisible(false)
        setShowTechnicalDetails(false)
      }
    }
    window.addEventListener("mousedown", handlePointerDown)
    return () => window.removeEventListener("mousedown", handlePointerDown)
  }, [showTechnicalDetails])

  // --- Pure TypeScript autolink helper ---
  function renderWithLinks(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    // Regex matches URLs and bare domains (e.g. vrd.io, example.com, http(s)://...)
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
      // Prepend https:// if not present
      const url = raw.startsWith('http') ? raw : `https://${raw}`;
      result.push(
        <a
          key={`link-${index}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline text-blue-600 hover:text-blue-800"
        >
          {raw}
        </a>
      );
      lastIndex = index + raw.length;
    }
    if (lastIndex < text.length) {
      result.push(text.slice(lastIndex));
    }
    return result;
  }

  function renderContent(text: string): React.ReactNode[] {
    if (!text) return [];
    
    // Normalize: If the model accidentally puts a header at the end of a line, force a split
    // e.g. "paragraph. #### Header" -> "paragraph.\n#### Header"
    const normalized = text.replace(/([.!?])\s+(#+\s)/g, '$1\n$2');
    
    // Split into intentional blocks (paragraphs/lines)
    const lines = normalized.split('\n');
    return lines.map((line, lineIndex) => {
      const trimmed = line.trim();
      
      // H1 Support
      if (trimmed.startsWith('# ')) {
        const hasTopMargin = lineIndex > 0;
        return (
          <h1 key={`h1-${lineIndex}`} className={`mb-4 text-2xl font-extrabold text-[var(--foreground)] ${hasTopMargin ? 'mt-8' : 'mt-0'}`}>
            {renderInline(line.replace(/^# /, ''))}
          </h1>
        );
      }

      // H2 Support
      if (trimmed.startsWith('## ')) {
        const hasTopMargin = lineIndex > 0;
        return (
          <h2 key={`h2-${lineIndex}`} className={`mb-3 text-xl font-bold text-[var(--foreground)] ${hasTopMargin ? 'mt-6' : 'mt-0'}`}>
            {renderInline(line.replace(/^## /, ''))}
          </h2>
        );
      }

      // H3 Support
      if (trimmed.startsWith('### ')) {
        const hasTopMargin = lineIndex > 0;
        return (
          <h3 key={`h3-${lineIndex}`} className={`mb-2 text-lg font-semibold text-[var(--foreground)] ${hasTopMargin ? 'mt-4' : 'mt-0'}`}>
            {renderInline(line.replace(/^### /, ''))}
          </h3>
        );
      }

      // H4 Support
      if (trimmed.startsWith('#### ')) {
        const hasTopMargin = lineIndex > 0;
        return (
          <h4 key={`h4-${lineIndex}`} className={`mb-1 text-base font-bold text-[var(--foreground)] ${hasTopMargin ? 'mt-3' : 'mt-0'}`}>
            {renderInline(line.replace(/^#### /, ''))}
          </h4>
        );
      }

      // Bullet points
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        return (
          <div key={`li-${lineIndex}`} className="ml-4 flex gap-2 leading-7">
            <span className="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full bg-[var(--muted-foreground)]" />
            <div className="flex-1">
              {renderInline(line.replace(/^[-*] /, ''))}
            </div>
          </div>
        );
      }

      // Paragraph / Empty line
      if (!trimmed) {
        return <div key={`br-${lineIndex}`} className="h-2" />;
      }

      return (
        <p key={`p-${lineIndex}`} className="leading-7">
          {renderInline(line)}
        </p>
      );
    });
  }

  function renderInline(text: string): (string | React.ReactNode)[] {
    if (!text) return [];

    // Order: Bold, Italic, Link/Image
    const boldRegex = /(\*\*(.*?)\*\*|__(.*?)__)/g;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;

    while ((match = boldRegex.exec(text)) !== null) {
      const [full, , starContent, underscoreContent] = match;
      const content = starContent || underscoreContent;
      const index = match.index;

      if (index > lastIndex) {
        parts.push(...renderItalics(text.slice(lastIndex, index)));
      }

      parts.push(<strong key={`bold-${index}`} className="font-bold">{renderItalics(content)}</strong>);
      lastIndex = index + full.length;
    }

    if (lastIndex < text.length) {
      parts.push(...renderItalics(text.slice(lastIndex)));
    }

    return parts;
  }

  function renderItalics(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    
    // Support italics (*text* or _text_)
    const italicRegex = /(\*(.*?)\*|_(.*?)_)/g;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;

    while ((match = italicRegex.exec(text)) !== null) {
      const [full, , starContent, underscoreContent] = match;
      const content = starContent || underscoreContent;
      const index = match.index;

      if (index > lastIndex) {
        parts.push(...renderLinksAndImages(text.slice(lastIndex, index)));
      }

      parts.push(<em key={`italic-${index}`} className="italic">{renderLinksAndImages(content)}</em>);
      lastIndex = index + full.length;
    }

    if (lastIndex < text.length) {
      parts.push(...renderLinksAndImages(text.slice(lastIndex)));
    }

    return parts;
  }

  function renderLinksAndImages(text: string): (string | React.ReactNode)[] {
    if (!text) return [];
    
    // Support standard Markdown links [text](url) and images ![alt](src)
    const markdownRegex = /(!?\[([^\]]*)\]\((.*?)\))/g;
    const parts: (string | React.ReactNode)[] = [];
    let lastIndex = 0;
    let match;
    
    while ((match = markdownRegex.exec(text)) !== null) {
      const [full, , altText, urlOrSrcRaw] = match;
      const index = match.index;
      const isImage = full.startsWith('!');
      
      // Clean up URL: remove any spaces the model accidentally inserted in the URL block
      const urlOrSrc = urlOrSrcRaw.replace(/\s+/g, '');
      
      if (index > lastIndex) {
        parts.push(...renderWithLinks(text.slice(lastIndex, index)));
      }
      
      if (isImage) {
        parts.push(
          <a 
            key={`img-${index}`} 
            href={urlOrSrc} 
            download={`lokidoki-${Date.now()}.jpg`} 
            title="Click to download full resolution"
            className="block my-3 max-w-sm cursor-zoom-in"
          >
             <img 
               src={urlOrSrc} 
               alt={altText || "Generated Image"} 
               className="w-full rounded-lg shadow-sm ring-1 ring-black/5 object-cover transition-all hover:ring-black/20 hover:shadow-md" 
             />
          </a>
        );
      } else {
        parts.push(
          <a
            key={`link-${index}`}
            href={urlOrSrc.startsWith('http') ? urlOrSrc : `https://${urlOrSrc}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-medium text-blue-600 hover:text-blue-800 transition-colors underline decoration-blue-300/30 underline-offset-4 hover:decoration-blue-500/50"
          >
            {altText || urlOrSrc}
            <ExternalLink className="ml-0.5 h-3.5 w-3.5 opacity-70" />
          </a>
        );
      }
      
      lastIndex = index + full.length;
    }
    
    if (lastIndex < text.length) {
      parts.push(...renderWithLinks(text.slice(lastIndex)));
    }
    
    return parts;
  }

  return (
    <div
      className="group"
      onBlur={(event) => {
        if (!cardRef.current?.contains(event.relatedTarget as Node | null)) {
          setIsToolbarVisible(false)
          setShowTechnicalDetails(false)
        }
      }}
      onFocus={() => setIsToolbarVisible(true)}
      onMouseEnter={() => setIsToolbarVisible(true)}
      onMouseLeave={() => {
        setIsToolbarVisible(false)
        setShowTechnicalDetails(false)
      }}
      ref={cardRef}
    >
      <div className="py-2 text-[var(--foreground)]">
        {/* Wikipedia thumbnail image card */}
        {(() => {
          const thumb = message.meta?.skill_result?.data?.thumbnail
          const pageUrl = message.meta?.skill_result?.data?.page_url
          const title = message.meta?.skill_result?.data?.title
          if (!thumb?.url) return null
          return (
            <a
              href={pageUrl || thumb.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-4 block w-40 overflow-hidden rounded-xl ring-1 ring-black/10 shadow-md transition-all hover:shadow-lg hover:ring-black/20 float-right ml-4"
              title={title ? `View ${title} on Wikipedia` : "View on Wikipedia"}
            >
              <img
                src={thumb.url}
                alt={title || "Wikipedia"}
                className="w-full object-cover"
              />
              <div className="px-2 py-1 bg-[var(--panel-strong)] text-[10px] text-[var(--muted-foreground)] truncate">
                {title || "Wikipedia"}
              </div>
            </a>
          )
        })()}
        <div className="max-w-3xl whitespace-pre-wrap break-words text-[15px] leading-7">
          {renderContent(message.content)}
        </div>
        <div className="clear-both" />
        {showTechnicalDetails && message.meta?.skill_result && (
          <div className="mt-4 rounded-lg bg-[var(--panel-strong)] p-3 border border-[var(--line)] overflow-hidden">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground)]">Technical Insight: Skill Grounding</div>
            <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap text-[var(--foreground)]">
              {JSON.stringify(message.meta.skill_result, null, 2)}
            </pre>
          </div>
        )}
      </div>
      {!message.pending ? (
        <div className="chat-message-actions mt-1 flex min-h-[40px] items-center gap-2 px-1 text-xs text-[var(--muted-foreground)]">
          <div className={`flex w-full items-center gap-2 transition-opacity duration-150 ${isToolbarVisible || showTechnicalDetails ? "opacity-100" : "opacity-0"}`}>
            <span className="text-[11px] text-[var(--muted-foreground)]">{messageTime}</span>
            <ChatCopyButton className="h-9 w-9 rounded-xl border border-[var(--line)] bg-transparent text-[var(--foreground)] transition-colors duration-150 hover:bg-white/[0.04]" content={message.content} />
            <Button
              aria-label={pendingSpeechMessageKey === messageKey ? "Cancel voice playback" : speakingMessageKey === messageKey ? "Stop voice playback" : "Play voice reply"}
              className={`h-9 w-9 rounded-xl border border-[var(--line)] bg-transparent p-0 text-[var(--foreground)] transition-colors duration-150 hover:bg-white/[0.04] ${pendingSpeechMessageKey === messageKey || speakingMessageKey === messageKey ? "animate-pulse" : ""}`}
              onClick={() => onPlayVoice(message, messageKey)}
              type="button"
              variant="outline"
            >
              {pendingSpeechMessageKey === messageKey ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : speakingMessageKey === messageKey ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            {onRetrySmart ? (
              <Button
                aria-label="Retry with smart model"
                className={`h-9 w-9 rounded-xl border border-[var(--line)] bg-transparent p-0 text-[var(--foreground)] transition-colors duration-150 hover:bg-white/[0.04] ${retrySmartPending ? "animate-pulse" : ""}`}
                disabled={retrySmartPending}
                onClick={() => onRetrySmart()}
                type="button"
                variant="outline"
              >
                {retrySmartPending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
              </Button>
            ) : null}
            {detailLines.length > 0 ? (
              <Button
                aria-label={showTechnicalDetails ? "Hide technical details" : "Show technical details"}
                className="ml-auto h-9 w-9 rounded-xl border border-[var(--line)] bg-transparent p-0 text-[var(--muted-foreground)] transition-colors duration-150 hover:bg-white/[0.04]"
                onClick={() => setShowTechnicalDetails((current) => !current)}
                type="button"
                variant="outline"
              >
                <span className="relative flex items-center justify-center">
                  <TierIcon className="h-4 w-4" />
                  <ChevronDown className={`absolute -right-2 -bottom-2 h-3 w-3 rounded-full bg-[var(--background)] transition-transform ${showTechnicalDetails ? "rotate-180" : ""}`} />
                </span>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {showTechnicalDetails && detailLines.length > 0 ? (
        <div
          className="mt-3 scroll-mb-40 space-y-2 rounded-2xl border border-[var(--line)] bg-white/[0.03] p-3 text-[11px] uppercase tracking-[0.14em] text-cyan-300/80"
          ref={detailPanelRef}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-cyan-300/80">Technical details</div>
            <ChatCopyButton
              className="h-8 w-8 rounded-lg border border-[var(--line)] bg-transparent text-[var(--foreground)] hover:bg-white/[0.04]"
              content={technicalDetailText}
            />
          </div>
          {detailLines.map((line) => (
            <div key={line} className="break-words text-[var(--muted-foreground)]">
              {line}
            </div>
          ))}
          {showRuntimeDebug && message.debug ? (
            <div className="flex items-center gap-2 text-cyan-300/80">
              <Clock3 className="h-3.5 w-3.5" />
              Runtime trace enabled
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
