import { ExternalLink } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Source } from '@/lib/transformCitations'

interface Props {
  n: number
  source: Source
}

export function CitationChip({ n, source }: Props) {
  const domain = (() => {
    try { return new URL(source.url).hostname.replace(/^www\./, '') }
    catch { return source.url.slice(0, 30) }
  })()

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-full bg-brand/15 px-1 py-0.5 text-[0.72em] font-semibold text-brand no-underline transition-colors hover:bg-brand/25 hover:text-brand-hover"
          >
            {n}
          </a>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px] p-2.5">
          <p className="mb-1 line-clamp-2 text-xs font-medium leading-snug">{source.title}</p>
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate">{domain}</span>
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
