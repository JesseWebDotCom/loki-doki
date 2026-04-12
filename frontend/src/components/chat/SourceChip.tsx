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
            className="mx-0.5 inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 align-middle text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-card hover:text-foreground"
            aria-label={`Source ${index}: ${presentation.label}`}
          >
            <FaviconImage
              hostname={presentation.hostname}
              remoteUrl={presentation.faviconUrl}
              className="h-3.5 w-3.5 rounded-[3px] bg-card object-cover"
            />
            <span className="max-w-[220px] truncate">{presentation.label}</span>
          </a>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-sm rounded-3xl border-border/50 bg-popover/98 p-4 text-popover-foreground shadow-m4"
        >
          <div className="flex items-start gap-3">
            <FaviconImage
              hostname={presentation.hostname}
              remoteUrl={presentation.faviconUrl}
              className="mt-0.5 h-5 w-5 rounded-md bg-card object-cover"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold leading-snug">{presentation.label}</p>
              <p className="text-xs text-muted-foreground">{source.title}</p>
              <p className="truncate text-[11px] text-muted-foreground/80">{source.url}</p>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default SourceChip;
