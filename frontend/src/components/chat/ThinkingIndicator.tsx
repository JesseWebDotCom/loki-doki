import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { PipelineState } from '../../pages/ChatPage';
import PipelineInfoPopover from './PipelineInfoPopover';
import { stabilizeStreamingMarkdown } from '../../utils/markdownStabilizer';

interface ThinkingIndicatorProps {
  pipeline: PipelineState;
  avatar?: React.ReactNode;
  /** True when a live assistant bubble is already rendering streamed
   *  block_patch deltas. In that case the indicator must NOT also
   *  render ``pipeline.streamingResponse`` or the user sees two copies
   *  of the same prose side-by-side. */
  suppressStreaming?: boolean;
}

// Strip the spoken_text island the LLM appends for voice parity so the
// tag never flashes on screen during streaming.
function sanitizeStreamingText(content: string): string {
  let processed = content.replace(/\s*<spoken_text>[\s\S]*?<\/spoken_text>/gi, '');
  processed = processed.replace(/\s*<spoken_text>[\s\S]*$/i, '');
  return processed;
}

const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ pipeline, avatar, suppressStreaming = false }) => {
  if (pipeline.phase === 'idle') return null;

  // Show streamed LLM tokens as soon as they start arriving, so the user
  // sees the answer forming instead of staring at the phase chips while
  // the full envelope is assembled. When the backend pre-emits
  // ``response_init`` before synthesis, an in-progress bubble renders
  // the same content via ``block_patch`` deltas — in that case the
  // caller passes ``suppressStreaming`` so we don't double-render.
  const streaming = sanitizeStreamingText(pipeline.streamingResponse ?? '');
  const showStreaming =
    !suppressStreaming && streaming.trim().length > 0 && pipeline.phase !== 'completed';
  const stabilized = showStreaming ? stabilizeStreamingMarkdown(streaming) : '';

  return (
    <div className={`${pipeline.phase === 'completed' ? 'mb-2' : 'mb-8'} w-full`}>
      <div className="flex items-start gap-4">
        {avatar}
        <div className="min-w-0 flex-1 pt-1 flex flex-col gap-3">
          {showStreaming && (
            <div className="prose-onyx font-medium tracking-tight text-base leading-7 text-foreground/90 sm:text-[1.05rem] sm:leading-8">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="ml-6 mb-4 list-disc space-y-1.5">{children}</ul>,
                  ol: ({ children }) => <ol className="ml-6 mb-4 list-decimal space-y-1.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-7 sm:leading-8">{children}</li>,
                  h1: ({ children }) => (
                    <h1 className="mb-4 mt-1 text-[1.65rem] font-bold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.95rem]">
                      {children}
                    </h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="mb-3 mt-1 text-[1.3rem] font-bold leading-tight tracking-[-0.01em] text-foreground sm:text-[1.5rem]">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="mb-2 mt-1 text-[1.1rem] font-semibold leading-tight text-foreground sm:text-[1.2rem]">
                      {children}
                    </h3>
                  ),
                  strong: ({ children }) => <strong className="font-bold text-primary/90">{children}</strong>,
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
                }}
              >
                {stabilized}
              </ReactMarkdown>
              <span aria-hidden="true" className="opacity-50 animate-pulse">▍</span>
            </div>
          )}
          <PipelineInfoPopover pipeline={pipeline} currentPhase={pipeline.phase} />
        </div>
      </div>
    </div>
  );
};

export default ThinkingIndicator;
