import React from 'react';
import type { SourceInfo } from '../../lib/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { getSourcePresentation } from './sourcePresentation';
import FaviconImage from './FaviconImage';

interface SourceChipProps {
  index: number;
  source: SourceInfo;
}

const SourceChip: React.FC<SourceChipProps> = ({ index, source }) => {
  const presentation = getSourcePresentation(source);

  return (
    <TooltipProvider delayDuration={180}>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mx-0.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/50 bg-muted/50 px-2 py-1 align-middle text-[11px] font-semibold text-muted-foreground/90 transition-all hover:border-primary/40 hover:bg-card hover:text-foreground hover:shadow-sm"
            aria-label={`Source ${index}: ${presentation.label}`}
          >
            <FaviconImage
              hostname={presentation.hostname}
              remoteUrl={presentation.faviconUrl}
              className="h-3.5 w-3.5 rounded-sm bg-card object-cover"
            />
            <span className="leading-none">{presentation.sourceName}</span>
          </a>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="w-72 overflow-hidden rounded-2xl border-border/40 bg-popover/95 p-3 text-popover-foreground shadow-m4 backdrop-blur-md"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FaviconImage
                hostname={presentation.hostname}
                remoteUrl={presentation.faviconUrl}
                className="h-4 w-4 rounded-sm bg-card object-cover"
              />
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                {presentation.sourceName}
              </span>
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold leading-snug text-foreground/90 break-all">
                {presentation.title}
              </p>
              <p className="truncate font-mono text-[9px] text-muted-foreground/70">
                {source.url}
              </p>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default SourceChip;
