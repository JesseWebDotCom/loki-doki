import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Link as LinkIcon, Brain, Play, Square, LoaderCircle, Volume2, VolumeX, Copy, Check, ThumbsUp, ThumbsDown, RefreshCw } from 'lucide-react';
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
}

/**
 * Citation component to render the chain-anchor icon with tooltip.
 */
const Citation: React.FC<{ index: number; sources: SourceInfo[] }> = ({ index, sources }) => {
  const source = sources[index - 1]; // [src:1] -> index 0

  if (source) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-colors mx-0.5 align-middle shadow-sm"
              aria-label={`Source: ${source.title}`}
            >
              <LinkIcon size={10} />
            </a>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs p-3 rounded-xl border-border/50 bg-popover text-popover-foreground shadow-m3">
            <p className="font-bold text-xs mb-1">{source.title}</p>
            <p className="text-[10px] text-muted-foreground truncate opacity-70">{source.url}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-muted/50 border border-border/30 text-muted-foreground mx-0.5 align-middle"
      title={`Source ${index} unavailable`}
    >
      <LinkIcon size={10} />
    </span>
  );
};

/**
 * Pre-processes content to transform [src:N] into markdown links that our 
 * custom link component can recognize as citations.
 */
function preprocessContent(content: string): string {
  return content.replace(/\[src:(\d+)\]/g, ' [🔗$1](#cite-$1)');
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
    <div className={`flex w-full mb-10 items-start gap-3 group/msg ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && avatar}
      <div className={`flex flex-col max-w-[85%] sm:max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`rounded-2xl px-6 py-4 border transition-all duration-300 shadow-m3 ${
          isUser
            ? 'bg-primary/10 border-primary/20 text-foreground'
            : 'bg-card border-border/40 text-foreground'
        }`}>
          {!isUser && (
            <div className="flex items-center gap-2 mb-3 opacity-70">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {assistantName || 'assistant'}
              </span>
              <span className="text-[10px] text-muted-foreground/40 font-mono italic" title={hoverDateTime}>
                {displayTime}
              </span>
              {pipeline && <PipelineInfoPopover pipeline={pipeline} />}
            </div>
          )}
          
          <div className={`prose-onyx text-[15px] leading-relaxed font-medium tracking-tight ${isUser ? 'text-foreground' : 'text-foreground/90'}`}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={{
                p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc ml-6 mb-4 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal ml-6 mb-4 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                strong: ({ children }) => <strong className="font-bold text-primary/90">{children}</strong>,
                a: ({ href, children }) => {
                  if (href?.startsWith('#cite-')) {
                    const index = parseInt(href.replace('#cite-', ''), 10);
                    return <Citation index={index} sources={sources} />;
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
                      className="text-primary hover:underline underline-offset-4 decoration-primary/30 transition-all font-semibold inline-flex items-center gap-1 cursor-pointer"
                    >
                      {children}
                    </a>
                  );
                },
                code: ({ children }) => (
                  <code className="bg-muted px-1.5 py-0.5 rounded-md font-mono text-sm border border-border/20">
                    {children}
                  </code>
                ),
                pre: ({ children }) => (
                  <pre className="bg-muted p-4 rounded-xl font-mono text-sm overflow-x-auto my-4 border border-border/30 shadow-inner">
                    {children}
                  </pre>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-4 border-primary/30 pl-4 py-1 italic text-muted-foreground my-4 bg-muted/20 rounded-r-lg">
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

        <div className="relative min-h-10 w-full pt-2 z-10">
          {isUser && (
            <div className="flex items-center gap-2 opacity-0 group-hover/msg:opacity-100 transition-opacity px-2 justify-end">
              <span 
                className="text-[10px] text-muted-foreground/60 font-mono italic cursor-default hover:text-muted-foreground transition-colors"
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
