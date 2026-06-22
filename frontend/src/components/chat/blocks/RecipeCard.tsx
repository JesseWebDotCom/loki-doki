import { useState } from 'react'
import { ChevronDown, ChevronUp, ExternalLink, Play } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import type { RecipeBlockData } from './types'

export function RecipeCard({ data }: { data: RecipeBlockData }) {
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const visibleIngredients = showAll ? data.ingredients : data.ingredients.slice(0, 8)
  const preview = data.instructions.slice(0, 240).trimEnd()
  const hasMore = data.instructions.length > 240

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden text-sm">
      {/* Thumbnail + header */}
      <div className="flex gap-0">
        {data.thumbnail && (
          <div className="shrink-0 w-28 h-28 overflow-hidden">
            <img
              src={data.thumbnail}
              alt={data.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
        )}
        <div className="flex-1 min-w-0 px-4 py-3">
          <p className="font-semibold text-[13px] leading-snug mb-1">{data.name}</p>
          <div className="flex flex-wrap gap-1 mb-2">
            {data.area && <Badge variant="secondary" className="text-[10px]">{data.area}</Badge>}
            {data.category && <Badge variant="outline" className="text-[10px]">{data.category}</Badge>}
          </div>
          <div className="flex gap-2">
            {data.youtube && (
              <a
                href={data.youtube}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] text-red-500 hover:text-red-400 transition-colors"
              >
                <Play className="size-3 fill-current" /> Watch
              </a>
            )}
            {data.source && (
              <a
                href={data.source}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="size-3" /> Recipe
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Ingredients */}
      {data.ingredients.length > 0 && (
        <div className="border-t border-border/30 px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Ingredients
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {visibleIngredients.map((ing, i) => (
              <li key={i} className="text-[12px] text-card-foreground/90">· {ing}</li>
            ))}
          </ul>
          {data.ingredients.length > 8 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="mt-2 flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showAll ? <><ChevronUp className="size-3" /> Show less</> : <><ChevronDown className="size-3" /> +{data.ingredients.length - 8} more</>}
            </button>
          )}
        </div>
      )}

      {/* Instructions preview */}
      {data.instructions && (
        <div className="border-t border-border/30 px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Instructions
          </p>
          <p className={cn('text-[12px] leading-relaxed text-card-foreground/90', !expanded && 'line-clamp-4')}>
            {data.instructions}
          </p>
          {hasMore && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="mt-1.5 flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <><ChevronUp className="size-3" /> Show less</> : <><ChevronDown className="size-3" /> Show full recipe</>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
