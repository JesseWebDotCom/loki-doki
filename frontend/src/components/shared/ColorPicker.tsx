import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'

export interface ColorChoice {
  slug: string
  label: string
  className: string
}

export const COLOR_CHOICES: ColorChoice[] = [
  { slug: 'accent',  label: 'Accent',  className: 'bg-primary' },
  { slug: 'muted',   label: 'Muted',   className: 'bg-muted-foreground' },
  { slug: 'blue',    label: 'Blue',    className: 'bg-blue-500' },
  { slug: 'green',   label: 'Green',   className: 'bg-emerald-500' },
  { slug: 'amber',   label: 'Amber',   className: 'bg-amber-500' },
  { slug: 'rose',    label: 'Rose',    className: 'bg-rose-500' },
  { slug: 'violet',  label: 'Violet',  className: 'bg-violet-500' },
  { slug: 'slate',   label: 'Slate',   className: 'bg-slate-500' },
]

const COLOR_VALUE: Record<string, string> = {
  accent: 'var(--primary)',
  muted:  'var(--muted-foreground)',
  blue:   'oklch(0.623 0.214 259.815)',
  green:  'oklch(0.696 0.17 162.48)',
  amber:  'oklch(0.769 0.188 70.08)',
  rose:   'oklch(0.645 0.246 16.439)',
  violet: 'oklch(0.606 0.25 292.717)',
  slate:  'oklch(0.554 0.046 257.417)',
}

export function resolveProjectColor(slug: string | null | undefined): string {
  if (!slug) return COLOR_VALUE.accent
  return COLOR_VALUE[slug] ?? COLOR_VALUE.accent
}

interface ColorPickerProps {
  value: string | null
  onChange: (slug: string | null) => void
}

export function ColorPicker({ value, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false)
  const selected = COLOR_CHOICES.find((c) => c.slug === value) ?? null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'outline' }), 'w-full justify-between')}
          aria-label="Project color"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <>
                <span className={cn('size-4 shrink-0 rounded-full ring-1 ring-border', selected.className)} />
                <span className="truncate">{selected.label}</span>
              </>
            ) : (
              <span className="truncate text-muted-foreground">Pick color</span>
            )}
          </span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 p-2" align="start">
        <TooltipProvider>
          <div role="radiogroup" aria-label="Project color" className="grid grid-cols-4 gap-2">
            {COLOR_CHOICES.map((choice) => {
              const isSelected = choice.slug === value
              return (
                <Tooltip key={choice.slug}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      aria-label={`Select ${choice.label} color`}
                      onClick={() => { onChange(isSelected ? null : choice.slug); setOpen(false) }}
                      className={cn(
                        'flex items-center justify-center rounded-md border border-transparent p-2 transition hover:bg-accent',
                        isSelected ? 'border-border bg-accent' : 'bg-transparent',
                      )}
                    >
                      <span className={cn('size-5 shrink-0 rounded-full ring-1 ring-border', choice.className)} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{choice.label}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </TooltipProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
