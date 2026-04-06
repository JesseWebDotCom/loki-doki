import React from 'react';
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
 * Parse message content and replace [src:N] markers with chain-anchor icons.
 * Returns an array of React nodes (strings + citation elements).
 */
function renderWithCitations(content: string, sources: SourceInfo[]): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /\[src:(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let hasMarkers = false;

  while ((match = regex.exec(content)) !== null) {
    hasMarkers = true;
    // Text before this marker
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }

    const srcIndex = parseInt(match[1], 10) - 1; // [src:1] -> index 0
    const source = sources[srcIndex];

    if (source) {
      parts.push(
        <TooltipProvider key={`src-${match.index}`} delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-colors mx-0.5 align-middle"
                aria-label={`Source: ${source.title}`}
              >
                <LinkIcon size={10} />
              </a>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="font-semibold text-xs">{source.title}</p>
              <p className="text-[10px] text-muted-foreground truncate">{source.url}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    } else {
      // Source not available — render as a muted indicator (strip raw marker)
      parts.push(
        <span
          key={`src-na-${match.index}`}
          className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-muted/50 border border-border/30 text-muted-foreground mx-0.5 align-middle"
          title={`Source ${match[1]} unavailable`}
        >
          <LinkIcon size={10} />
        </span>
      );
    }

    lastIndex = regex.lastIndex;
  }

  if (!hasMarkers) return [content];

  // Remaining text after last marker
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts;
}

const MessageItem: React.FC<MessageProps> = ({ role, content, timestamp, sources = [] }) => {
  const isUser = role === 'user';
  const rendered = isUser ? [content] : renderWithCitations(content, sources);

  return (
    <div className={`flex w-full mb-8 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-6 py-4 border transition-all duration-300 shadow-m3 ${
        isUser
          ? 'bg-primary/10 border-primary/20 text-foreground'
          : 'bg-card border-border/40 text-foreground'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-widest ${isUser ? 'text-primary' : 'text-muted-foreground'}`}>
            {role}
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-mono italic">{timestamp}</span>
        </div>
        <div className="text-[15px] leading-relaxed whitespace-pre-wrap font-medium tracking-tight">
          {rendered}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
