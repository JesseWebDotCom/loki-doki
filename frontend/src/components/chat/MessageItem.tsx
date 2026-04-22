import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Brain, Play, Square, LoaderCircle, Volume2, VolumeX, Copy, Check, ThumbsUp, ThumbsDown, RefreshCw, Bot } from 'lucide-react';
import { useTTSState } from '../../utils/tts';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '../ui/tooltip';
import { formatMessageDateTime, formatMessageTime } from '../../lib/chatTimestamp';
import type { SourceInfo, MediaCard, SilentConfirmation } from '../../lib/api';
import type { Block, ResponseEnvelope } from '../../lib/response-types';
import type { PipelineState } from '../../pages/ChatPage';
import { FeedbackDialog } from './FeedbackDialog';
import SourceChip from './SourceChip';
import { getSourcePresentation } from './sourcePresentation';
import FaviconImage from './FaviconImage';
import PipelineInfoPopover from './PipelineInfoPopover';
import OfflineTrustChip from './OfflineTrustChip';
import DocumentChip from './DocumentChip';
import { BlockContextProvider, renderBlock } from './blocks';

interface MentionedPerson {
  id: number;
  name: string;
  photo_url?: string;
  relation?: string;
}

interface MessageProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sources?: SourceInfo[];
  media?: MediaCard[];
  confirmations?: SilentConfirmation[];
  clarification?: string;
  messageKey?: string;
  avatar?: React.ReactNode;
  assistantName?: string;
  pipeline?: PipelineState;
  mentionedPeople?: MentionedPerson[];
  /** DB id of the stored message — enables feedback. */
  messageId?: number;
  /** Retry callback — removes this message and re-sends the prior user turn. */
  onRetry?: () => void;
  onOpenSources?: () => void;
  /**
   * Chunk 16 (folds chunk 15 deferral #1). Invoked when the user taps
   * a follow-up chip or a clarification quick-reply rendered inside
   * this message's block stack. The text arrives as the next user
   * turn via ``ChatPage`` / ``handleSend``.
   */
  onFollowUp?: (text: string) => void;
  /** Chunk 10: canonical server-reconciled envelope. Live turns
   *  populate this from the SSE reducer; history replay populates
   *  it from the persisted ``response_envelope`` column. When
   *  absent, the component falls back to client-derived blocks
   *  (legacy rows + fast-lane turns where no ``response_init``
   *  fired). */
  envelope?: ResponseEnvelope;
}

/**
 * Pre-processes content to turn [src:N] markers into markdown citation
 * links, and strips legacy [youtube:N] / [youtube_channel:N] markers —
 * media is rendered structurally via <MediaBar /> now, so any stray
 * marker the model still emits is scrubbed from the visible text.
 */
function preprocessContent(content: string): string {
  let processed = content.replace(/\s*\[src:(\d+)\]/g, '\u00A0[🔗$1](#cite-$1)');
  processed = processed.replace(/\s*\[youtube(?:_channel)?:\d+\]/g, '');
  return processed;
}

const MessageItem: React.FC<MessageProps> = ({
  role,
  content,
  timestamp,
  sources = [],
  media = [],
  confirmations = [],
  clarification,
  messageKey,
  avatar,
  pipeline,
  mentionedPeople = [],
  messageId,
  onRetry,
  onOpenSources,
  onFollowUp,
  envelope,
}) => {
  const isUser = role === 'user';
  const tts = useTTSState();
  const myKey = messageKey ?? '';
  const isSpeaking = !isUser && tts.speakingKey === myKey;
  const isPending = !isUser && tts.pendingKey === myKey;
  const isActive = isSpeaking || isPending;

  // Action bar state
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedbackState, setFeedbackState] = useState<1 | -1 | null>(null);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [pendingRating, setPendingRating] = useState<1 | -1 | null>(null);

  const processedContent = useMemo(() => isUser ? content : preprocessContent(content), [content, isUser]);
  // ``primarySource`` is read AFTER ``effectiveSources`` is declared
  // below (the useMemo ordering is lexical here); we recompute it
  // inline at the render site so the envelope / fallback branches
  // agree. Keeping the ``sources``-based reference around would make
  // the favicon lag the envelope on fast-lane -> full-lane transitions.

  // Chunk 10 dual-source rendering:
  //   * ``envelope`` present → render the canonical server envelope
  //     directly (live stream or history replay from the persisted
  //     snapshot).
  //   * ``envelope`` absent → fall back to client-derived blocks built
  //     from the legacy ``synthesis`` payload. This preserves behavior
  //     for pre-envelope history rows and for fast-lane turns (where
  //     the backend skips synthesis and no ``response_init`` fires).
  // Block order matches the legacy inline render order (media before
  // prose) so pixel-level behavior is unchanged.
  const assistantBlocks: Block[] = useMemo(() => {
    if (isUser) return [];
    if (envelope) {
      return envelope.blocks;
    }
    return [
      {
        id: 'media',
        type: 'media',
        state: media.length > 0 ? 'ready' : 'omitted',
        seq: 0,
        items: media,
      },
      {
        id: 'summary',
        type: 'summary',
        state: 'ready',
        seq: 0,
        content,
      },
      {
        id: 'sources',
        type: 'sources',
        state: sources.length > 0 ? 'ready' : 'omitted',
        seq: 0,
        items: sources,
      },
    ];
  }, [isUser, content, media, sources, envelope]);

  // When the envelope IS present, source chips inside the summary
  // markdown resolve through ``source_surface`` rather than the legacy
  // ``sources`` prop. Cast through ``unknown`` because the surface
  // items are typed as opaque ``unknown[]`` until chunk 11.
  const effectiveSources: SourceInfo[] = useMemo(() => {
    if (envelope) {
      return envelope.source_surface as unknown as SourceInfo[];
    }
    return sources;
  }, [envelope, sources]);

  const primarySource = effectiveSources[0]
    ? getSourcePresentation(effectiveSources[0])
    : null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = (rating: 1 | -1) => {
    setPendingRating(rating);
    setFeedbackDialogOpen(true);
  };

  const handleFeedbackSuccess = (rating: 1 | -1) => {
    setFeedbackState(rating);
  };

  const displayTime = formatMessageTime(timestamp);
  const hoverDateTime = formatMessageDateTime(timestamp);

  const contentMarkup = (
    <div className={`prose-onyx font-medium tracking-tight ${isUser ? 'text-base leading-8 text-foreground sm:text-[1.02rem]' : 'text-[1.14rem] leading-9 text-foreground/95 sm:text-[1.36rem] sm:leading-[2.45rem]'}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => (
            <p className={`last:mb-0 ${isUser ? 'mb-4' : 'mb-5'}`}>{children}</p>
          ),
          ul: ({ children }) => <ul className={`ml-6 list-disc ${isUser ? 'mb-4 space-y-1.5' : 'mb-5 space-y-2'}`}>{children}</ul>,
          ol: ({ children }) => <ol className={`ml-6 list-decimal ${isUser ? 'mb-4 space-y-1.5' : 'mb-5 space-y-2'}`}>{children}</ol>,
          li: ({ children }) => <li className={isUser ? 'leading-8' : 'leading-9 sm:leading-[2.45rem]'}>{children}</li>,
          h1: ({ children }) => <h1 className="mb-5 mt-1 text-[2.35rem] font-bold leading-tight tracking-[-0.04em] text-foreground sm:text-[3.7rem]">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-4 mt-1 text-[1.8rem] font-bold leading-tight tracking-[-0.03em] text-foreground sm:text-[2.6rem]">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-3 mt-1 text-[1.35rem] font-semibold leading-tight text-foreground sm:text-[1.7rem]">{children}</h3>,
          strong: ({ children }) => <strong className="font-bold text-primary/90">{children}</strong>,
          a: ({ href, children }) => {
            if (href?.startsWith('#cite-')) {
              const index = parseInt(href.replace('#cite-', ''), 10);
              const source = effectiveSources[index - 1];
              if (!source) return null;
              return <SourceChip index={index} source={source} />;
            }
            if (href?.startsWith('/people?focus=')) {
              const personId = parseInt(new URLSearchParams(href.split('?')[1]).get('focus') || '0', 10);
              const person = mentionedPeople.find((p) => p.id === personId);
              return (
                <a
                  href={href}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors no-underline align-middle mx-0.5 cursor-pointer"
                  title={person ? `View ${person.name}'s profile${person.relation ? ` (${person.relation})` : ''}` : 'View profile'}
                >
                  {person?.photo_url ? (
                    <img src={person.photo_url} alt="" className="w-4 h-4 rounded-full object-cover" />
                  ) : (
                    <span className="w-4 h-4 rounded-full bg-primary/20 text-[8px] font-bold flex items-center justify-center">
                      {(String(children) || '?').charAt(0).toUpperCase()}
                    </span>
                  )}
                  {children}
                </a>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex cursor-pointer items-center gap-1 font-semibold text-primary underline-offset-4 decoration-primary/30 transition-all hover:underline"
              >
                {children}
              </a>
            );
          },
          code: ({ children }) => (
            <code className="rounded-md border border-border/20 bg-muted px-1.5 py-0.5 font-mono text-sm">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-4 overflow-x-auto rounded-2xl border border-border/30 bg-muted p-4 font-mono text-sm shadow-inner">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-4 rounded-r-lg border-l-4 border-primary/30 bg-muted/20 py-1 pl-4 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );

  return (
    <div className={`group/msg mb-12 w-full ${isUser ? 'flex justify-end' : ''}`} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
      {isUser ? (
        <div className="flex max-w-[92%] flex-col items-end sm:max-w-[84%]">
          <div
            data-testid="message-bubble"
            className="rounded-3xl border border-primary/20 bg-primary/10 px-7 py-5 text-foreground shadow-m3 transition-all duration-300"
          >
            {contentMarkup}
          </div>
          <div className="relative z-10 min-h-10 w-full pt-3">
            <div className={`flex items-center justify-end gap-2 px-2 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
              <span
                className="cursor-default font-mono text-xs italic text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                title={hoverDateTime}
              >
                {displayTime}
              </span>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-card transition cursor-pointer"
                    >
                      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">{copied ? 'Copied!' : 'Copy'}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full">
          <div className="flex items-start gap-4">
            {avatar ? (
              avatar
            ) : (
              <div className="h-8 w-8 shrink-0 flex items-center justify-center rounded-full border border-border/40 bg-muted shadow-sm sm:h-10 sm:w-10">
                <Bot className="h-4 w-4 text-muted-foreground/50" />
              </div>
            )}
            <div className="min-w-0 flex-1 pt-1 flex flex-col gap-1">
               <div className="flex items-center gap-2 px-1">
                <span className="text-[10px] sm:text-[11px] font-bold tracking-widest text-muted-foreground/40 uppercase font-mono">
                  {pipeline?.synthesis?.model?.split(':')[0]?.toUpperCase() || 'LokiDoki'}
                </span>
                <span className="text-[10px] sm:text-[11px] font-mono text-muted-foreground/30">
                  {displayTime}
                </span>
              </div>
              {pipeline && (
                <div className="px-1">
                  <PipelineInfoPopover pipeline={pipeline} />
                </div>
              )}
              <div data-testid="message-bubble" className="w-full text-foreground relative">
                {envelope?.offline_degraded ? <OfflineTrustChip /> : null}
                {envelope?.document_mode ? (
                  <DocumentChip mode={envelope.document_mode} />
                ) : null}
                <BlockContextProvider
                  sources={effectiveSources}
                  mentionedPeople={mentionedPeople}
                  onOpenSources={onOpenSources}
                  onFollowUp={onFollowUp}
                >
                  {assistantBlocks.map((block) => renderBlock(block))}
                </BlockContextProvider>

                {confirmations.length > 0 && (
                  <div className="mt-5 border-t border-border/10 pt-4 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-widest text-primary/70">
                      <Brain size={11} />
                      Memory updated
                    </div>
                    {confirmations.map((c) => (
                      <div
                        key={c.fact_id}
                        className="flex items-center gap-2 text-[11px] text-muted-foreground pl-1"
                      >
                        <Brain size={11} className={c.status === 'ambiguous' ? 'text-amber-400' : 'text-primary/70'} />
                        <span className="truncate">
                          <span className="font-medium text-foreground/80">{c.subject}</span>{' '}
                          <span className="font-mono text-[10px]">{c.predicate}</span>{' '}
                          <span className="font-medium text-foreground/80">{c.value}</span>
                          {c.contradiction_action === 'revise' && c.previous_value && (
                            <span className="text-amber-400/80"> (was: {c.previous_value})</span>
                          )}
                          {c.contradiction_action === 'supersede' && c.previous_value && (
                            <span className="text-amber-400/80"> (replaces: {c.previous_value})</span>
                          )}
                          {c.status === 'ambiguous' && (
                            <span className="text-amber-400/80"> — needs disambiguation</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {clarification && (
                  <div className="mt-5 border-l-2 border-primary/40 pl-3 text-[11px] italic text-primary/70">
                    {clarification}
                  </div>
                )}
              </div>

              <div className="relative z-10 min-h-10 w-full pt-3">
                <div className={`flex items-center gap-1 transition-opacity px-2 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
                  <TooltipProvider delayDuration={300}>
                    {myKey && (
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => tts.speak(myKey, content)}
                              disabled={tts.muted || isActive}
                              className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-card transition disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                            >
                              {isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">
                            {tts.muted ? 'Voice muted' : 'Play'}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => tts.stop()}
                              disabled={!isActive}
                              className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-card transition disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                            >
                              <Square size={14} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">Stop</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={tts.toggleMute}
                              className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-card transition cursor-pointer"
                            >
                              {tts.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">
                            {tts.muted ? 'Unmute' : 'Mute'}
                          </TooltipContent>
                        </Tooltip>
                        <div className="mx-1 h-4 w-px bg-border/40" />
                      </>
                    )}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handleCopy}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-card transition cursor-pointer"
                        >
                          {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">{copied ? 'Copied!' : 'Copy'}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleFeedback(1)}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition cursor-pointer ${
                            feedbackState === 1
                              ? 'text-green-400 bg-green-400/10'
                              : 'text-muted-foreground/60 hover:text-foreground hover:bg-card'
                          }`}
                        >
                          <ThumbsUp size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">Good response</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleFeedback(-1)}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition cursor-pointer ${
                            feedbackState === -1
                              ? 'text-red-400 bg-red-400/10'
                              : 'text-muted-foreground/60 hover:text-foreground hover:bg-card'
                          }`}
                        >
                          <ThumbsDown size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">Bad response</TooltipContent>
                    </Tooltip>

                    {onRetry && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={onRetry}
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground/60 hover:text-foreground hover:bg-card transition cursor-pointer"
                          >
                            <RefreshCw size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs">Retry</TooltipContent>
                      </Tooltip>
                    )}

                    {effectiveSources.length > 0 && onOpenSources && (
                      <>
                        <div className="mx-1 h-4 w-px bg-border/40" />
                        <button
                          type="button"
                          onClick={onOpenSources}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground/60 transition-colors hover:text-foreground hover:bg-card"
                        >
                          {primarySource ? (
                            <FaviconImage
                              hostname={primarySource.hostname}
                              remoteUrl={primarySource.faviconUrl}
                              className="h-3.5 w-3.5 rounded-[3px] bg-card object-cover"
                            />
                          ) : null}
                          <span>Sources</span>
                        </button>
                      </>
                    )}
                  </TooltipProvider>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isUser && messageId && pendingRating !== null && (
        <FeedbackDialog
          open={feedbackDialogOpen}
          onOpenChange={setFeedbackDialogOpen}
          messageId={messageId}
          initialRating={pendingRating}
          traceJson={pipeline?.synthesis?.trace_snapshot ? JSON.stringify(pipeline.synthesis.trace_snapshot) : undefined}
          onSuccess={handleFeedbackSuccess}
        />
      )}
    </div>
  );
};

export default MessageItem;
