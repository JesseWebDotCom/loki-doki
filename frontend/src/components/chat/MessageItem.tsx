import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Brain, Play, Square, LoaderCircle, Volume2, VolumeX, Copy, Check, ThumbsUp, ThumbsDown, RefreshCw } from 'lucide-react';
import { useTTSState } from '../../utils/tts';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '../ui/tooltip';
import { formatMessageDateTime, formatMessageTime } from '../../lib/chatTimestamp';
import type { SourceInfo, SilentConfirmation } from '../../lib/api';
import type { PipelineState } from '../../pages/ChatPage';
import PipelineInfoPopover from './PipelineInfoPopover';
import { FeedbackDialog } from './FeedbackDialog';
import SourceChip from './SourceChip';
import { getSourcePresentation } from './sourcePresentation';
import FaviconImage from './FaviconImage';

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
}

/**
 * Pre-processes content to transform [src:N] into markdown links that our 
 * custom link component can recognize as citations.
 */
function preprocessContent(content: string): string {
  return content.replace(/\s*\[src:(\d+)\]/g, '\u00A0[🔗$1](#cite-$1)');
}

const MessageItem: React.FC<MessageProps> = ({
  role,
  content,
  timestamp,
  sources = [],
  confirmations = [],
  clarification,
  messageKey,
  avatar,
  assistantName,
  pipeline,
  mentionedPeople = [],
  messageId,
  onRetry,
  onOpenSources,
}) => {
  const isUser = role === 'user';
  const tts = useTTSState();
  const myKey = messageKey ?? '';
  const isSpeaking = !isUser && tts.speakingKey === myKey;
  const isPending = !isUser && tts.pendingKey === myKey;

  // Action bar state
  const [copied, setCopied] = useState(false);
  const [feedbackState, setFeedbackState] = useState<1 | -1 | null>(null);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [pendingRating, setPendingRating] = useState<1 | -1 | null>(null);

  // Transform citations into markdown-recognizable links
  const processedContent = isUser ? content : preprocessContent(content);
  const primarySource = sources[0] ? getSourcePresentation(sources[0]) : null;

  const isActive = isSpeaking || isPending;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = (rating: 1 | -1) => {
    // If clicking same rating that is already active, we just toggle it off (reset)
    // but the user wants a dialog "when we click it", so we'll show the dialog 
    // even for re-submitting or changing.
    setPendingRating(rating);
    setFeedbackDialogOpen(true);
  };

  const handleFeedbackSuccess = (rating: 1 | -1) => {
    setFeedbackState(rating);
  };

  const displayTime = formatMessageTime(timestamp);
  const hoverDateTime = formatMessageDateTime(timestamp);

  return (
    <div className={`group/msg mb-12 flex w-full items-start gap-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && avatar}
      <div className={`flex max-w-[92%] flex-col sm:max-w-[84%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          data-testid="message-bubble"
          className={`rounded-3xl border px-7 py-5 transition-all duration-300 shadow-m3 ${
          isUser
            ? 'bg-primary/10 border-primary/20 text-foreground'
            : 'bg-card border-border/40 text-foreground'
        }`}>
          {!isUser && (
            <div className="mb-3 space-y-2">
              <div className="flex items-center gap-2.5 opacity-70">
                <span className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">
                  {assistantName || 'assistant'}
                </span>
                <span className="font-mono text-xs italic text-muted-foreground/40" title={hoverDateTime}>
                  {displayTime}
                </span>
              </div>
              {pipeline && <PipelineInfoPopover pipeline={pipeline} />}
            </div>
          )}
          
          <div className={`prose-onyx text-base leading-8 font-medium tracking-tight sm:text-[1.02rem] ${isUser ? 'text-foreground' : 'text-foreground/90'}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={{
                p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="mb-4 ml-6 list-disc space-y-1.5">{children}</ul>,
                ol: ({ children }) => <ol className="mb-4 ml-6 list-decimal space-y-1.5">{children}</ol>,
                li: ({ children }) => <li className="leading-8">{children}</li>,
                strong: ({ children }) => <strong className="font-bold text-primary/90">{children}</strong>,
                a: ({ href, children }) => {
                  if (href?.startsWith('#cite-')) {
                    const index = parseInt(href.replace('#cite-', ''), 10);
                    const source = sources[index - 1];
                    if (!source) return null;
                    return <SourceChip index={index} source={source} />;
                  }
                  // Person mention chip: /people?focus=ID
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

          {!isUser && confirmations.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border/20 space-y-1.5">
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

          {!isUser && clarification && (
            <div className="mt-3 text-[11px] italic text-primary/70 border-l-2 border-primary/40 pl-3">
              {clarification}
            </div>
          )}
        </div>

        <div className="relative z-10 min-h-10 w-full pt-2.5">
          {isUser && (
            <div className="flex items-center justify-end gap-2 px-2 opacity-0 transition-opacity group-hover/msg:opacity-100">
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
          )}

          {!isUser && (
            <div className="flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 transition-opacity px-2">
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
                  <div className="w-px h-4 bg-border/40 mx-1" />
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

              {sources.length > 0 && onOpenSources && (
                <>
                  <div className="w-px h-4 bg-border/40 mx-1" />
                  <button
                    type="button"
                    onClick={onOpenSources}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-sm font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
                  >
                    {primarySource ? (
                      <FaviconImage
                        hostname={primarySource.hostname}
                        remoteUrl={primarySource.faviconUrl}
                        className="h-4 w-4 rounded-[4px] bg-card object-cover"
                      />
                    ) : null}
                    <span>Sources</span>
                  </button>
                </>
              )}
            </TooltipProvider>
          </div>
        )}
      </div>

      {!isUser && messageId && pendingRating !== null && (
        <FeedbackDialog
          open={feedbackDialogOpen}
          onOpenChange={setFeedbackDialogOpen}
          messageId={messageId}
          initialRating={pendingRating}
          onSuccess={handleFeedbackSuccess}
        />
      )}
    </div>
  </div>
);
};

export default MessageItem;
