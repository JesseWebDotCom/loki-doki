import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, MessageSquare, ScanEye, Search, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { APP_GROUPS } from '@/lib/appCategories'
import { useInstalledTools, isAppVisible } from '@/hooks/useInstalledTools'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'

// Command palette for the dock (#3): a hotkey-reachable, fuzzy-searchable action list in the
// full panel. Type to ask the companion, or jump to any installed app. Fully keyboard-driven
// (arrows + Enter). Sourced from the app registry so it stays in sync with what's installed.

interface Action {
  id: string
  label: string
  hint?: string
  Icon: LucideIcon
  run: () => void
}

export function IslandPageActions() {
  const engine = useCompanionEngine()
  const { enabledToolIds } = useInstalledTools()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const apps = useMemo(
    () => APP_GROUPS.flatMap((g) => g.apps).filter((a) => isAppVisible(a.toolId, enabledToolIds)),
    [enabledToolIds],
  )

  const q = query.trim().toLowerCase()

  const actions = useMemo<Action[]>(() => {
    const list: Action[] = []
    const text = query.trim()
    if (text) {
      list.push({ id: 'ask', label: `Ask: ${text}`, hint: 'Companion', Icon: MessageSquare, run: () => engine.handleSend(text) })
    }
    if (!q || 'look at my screen whats on screen'.includes(q)) {
      list.push({ id: 'screen', label: 'Look at my screen', hint: 'Companion', Icon: ScanEye, run: () => engine.handleSend('What is on my screen right now?') })
    }
    for (const a of apps) {
      if (!q || a.label.toLowerCase().includes(q)) {
        list.push({ id: `app:${a.id}`, label: a.label, hint: 'Open', Icon: a.icon, run: () => window.lokiDesktop?.openMainWindow(a.to) })
      }
    }
    return list
  }, [q, query, apps, engine])

  // Keep the selection in range as the filtered list changes.
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, actions.length - 1))) }, [actions.length])

  const run = (i: number) => { actions[i]?.run() }

  return (
    <div className="flex flex-col gap-2">
      {/* design-ok(glass-on-plain-bg): sits inside the black island surface */}
      <div className="flex items-center gap-2 rounded-control bg-white/10 px-2.5 py-2">
        <Search className="size-4 shrink-0 text-white/50" />
        {/* design-ok(raw-input-element): search field on the fixed-black island, ui Input's theme tokens would clash */}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(actions.length - 1, s + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); run(sel) }
          }}
          placeholder="Search actions, or type to ask…"
          className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/40 outline-none"
        />
      </div>

      <div className="flex flex-col gap-0.5">
        {actions.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onMouseEnter={() => setSel(i)}
            onClick={() => run(i)}
            // design-ok(glass-on-plain-bg): sits inside the black island surface
            className={cn(
              'flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-sm transition-colors',
              i === sel ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10',
            )}
          >
            <a.Icon className="size-4 shrink-0 text-white/60" />
            <span className="min-w-0 flex-1 truncate">{a.label}</span>
            {a.hint && <span className="shrink-0 text-[11px] text-white/40">{a.hint}</span>}
            {i === sel && <CornerDownLeft className="size-3.5 shrink-0 text-white/40" />}
          </button>
        ))}
        {actions.length === 0 && <p className="px-2.5 py-2 text-sm text-white/40">No matching actions.</p>}
      </div>
    </div>
  )
}
