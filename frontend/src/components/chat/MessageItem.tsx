import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Link as LinkIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '../ui/tooltip';
import type { SourceInfo } from '../../lib/api';

interface MessageProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sources?: SourceInfo[];
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

const MessageItem: React.FC<MessageProps> = ({ role, content, timestamp, sources = [] }) => {
  const isUser = role === 'user';
  
  // Transform citations into markdown-recognizable links
  const processedContent = isUser ? content : preprocessContent(content);

  return (
    <div className={`flex w-full mb-8 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] sm:max-w-[80%] rounded-2xl px-6 py-4 border transition-all duration-300 shadow-m3 ${
        isUser
          ? 'bg-primary/10 border-primary/20 text-foreground'
          : 'bg-card border-border/40 text-foreground'
      }`}>
        <div className="flex items-center gap-2 mb-3 opacity-70">
          <span className={`text-[10px] font-bold uppercase tracking-widest ${isUser ? 'text-primary' : 'text-muted-foreground'}`}>
            {role}
          </span>
          <span className="text-[10px] text-muted-foreground/40 font-mono italic">{timestamp}</span>
        </div>
        
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
                return (
                  <a 
                    href={href} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="text-primary hover:underline underline-offset-4 decoration-primary/30 transition-all font-semibold inline-flex items-center gap-1"
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
      </div>
    </div>
  );
};

export default MessageItem;

