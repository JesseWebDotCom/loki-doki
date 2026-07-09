import { useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useSuggestions } from '@/hooks/useSuggestions'
import { cn } from '@/lib/cn'
import type { SuggestSource, Suggestion } from '@/lib/smartSearch/types'

export interface SmartSearchInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit: (query: string) => void
  /** Optional entity-aware pick handler. Return true when the pick was handled (e.g.
   *  navigated to an artist page) to skip the default text-search onSubmit. */
  onPick?: (s: Suggestion) => boolean
  suggest: SuggestSource
  placeholder?: string
  minLength?: number
  debounceMs?: number
  inputRef?: React.Ref<HTMLInputElement>
  className?: string
}

/** A search input with a Google/YouTube-style autosuggest dropdown, built on a plain
 *  pluggable `suggest` function so any surface can back it with an external API or local
 *  data. Drop-in for a plain <Input>: same props shape (value/onChange/placeholder/className)
 *  plus `suggest` and `onSubmit` (called on Enter, or on picking a suggestion). */
export function SmartSearchInput({
  value, onChange, onSubmit, onPick, suggest, placeholder, minLength, debounceMs, inputRef, className,
}: SmartSearchInputProps) {
  const [open, setOpen] = useState(false)
  // -1 = nothing highlighted: Enter searches the typed text. Only Arrow keys move into the
  // list, and only then does Enter pick a suggestion.
  const [selected, setSelected] = useState(-1)
  const { suggestions } = useSuggestions(value, suggest, { minLength, debounceMs })
  const localRef = useRef<HTMLInputElement | null>(null)

  function pick(s: Suggestion) {
    onChange(s.label)
    setOpen(false)
    if (onPick?.(s)) return
    onSubmit(s.label)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (e.key === 'Enter') { e.preventDefault(); onSubmit(value); setOpen(false) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, -1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      // Enter searches exactly what was typed unless the user arrowed onto a suggestion.
      if (selected >= 0) pick(suggestions[selected]!)
      else { onSubmit(value); setOpen(false) }
    }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  const showDropdown = open && suggestions.length > 0

  return (
    <Popover open={showDropdown}>
      <PopoverAnchor asChild>
        <Input
          ref={node => { localRef.current = node; if (typeof inputRef === 'function') inputRef(node); else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = node }}
          value={value}
          onChange={e => { onChange(e.target.value); setSelected(-1); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={className}
        />
      </PopoverAnchor>
      <PopoverContent
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
        style={{ width: localRef.current?.offsetWidth }}
        className="max-h-72 overflow-y-auto p-1"
      >
        {suggestions.map((s, i) => (
          <button
            key={s.id}
            type="button"
            // onMouseDown (not onClick) fires before the input's onBlur closes the popover.
            onMouseDown={e => { e.preventDefault(); pick(s) }}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-1.5 text-left text-sm',
              i === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
            )}
          >
            <span className="truncate">{s.label}</span>
            {s.sublabel && <span className="shrink-0 text-xs text-muted-foreground">{s.sublabel}</span>}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
