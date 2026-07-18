import {
  createContext,
  useCallback,
  useContext,
  useId,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'

export interface UIContextEntry {
  description: string             // LLM-friendly summary of what the user is looking at
  label?: string                  // brief label for the UI indicator chip (e.g. "Popeyes")
  data?: Record<string, unknown>  // structured data (available to tools)
  /** Evaluated at SEND time instead of `description`, for context that moves between
   *  publishes (e.g. media playback position + the lyric/transcript lines just heard)
   *  without re-publishing (and re-rendering every consumer) on each tick. Return '' to
   *  contribute nothing this turn. */
  getDescription?: () => string
}

interface UIContextValue {
  publish: (id: string, entry: UIContextEntry) => void
  unpublish: (id: string) => void
  getContextBlock: () => string | null  // formatted for LLM system prompt
  activeLabels: string[]                // for UI indicator chips
}

const UIContext = createContext<UIContextValue | null>(null)

export function UIContextProvider({ children }: { children: ReactNode }) {
  // Use a ref for the source of truth (no re-render on every update)
  // and a state tick to trigger re-render only when entries actually change
  const mapRef = useRef<Map<string, UIContextEntry>>(new Map())
  const [, setTick] = useState(0)

  const publish = useCallback((id: string, entry: UIContextEntry) => {
    mapRef.current.set(id, entry)
    setTick((t) => t + 1)
  }, [])

  const unpublish = useCallback((id: string) => {
    mapRef.current.delete(id)
    setTick((t) => t + 1)
  }, [])

  const getContextBlock = useCallback((): string | null => {
    const entries = [...mapRef.current.values()]
    if (entries.length === 0) return null
    const lines = entries.map((e) => (e.getDescription?.() ?? e.description).trim()).filter(Boolean)
    if (lines.length === 0) return null
    return `[App Context, what the user is currently viewing]\n${lines.join('\n')}\nUse this to interpret pronouns and implicit references in the user's message (e.g. "this", "it", "here", "the article"). Answer as if you can see what they're looking at.`
  }, [])

  const activeLabels = [...mapRef.current.values()]
    .map((e) => e.label)
    .filter((l): l is string => !!l)

  return (
    <UIContext.Provider value={{ publish, unpublish, getContextBlock, activeLabels }}>
      {children}
    </UIContext.Provider>
  )
}

export function useUIContext() {
  const ctx = useContext(UIContext)
  if (!ctx) throw new Error('useUIContext must be used within UIContextProvider')
  return ctx
}

/**
 * Call this in any component that wants to push context to the LLM.
 * Context is active while the component is mounted and auto-clears on unmount.
 *
 * @example
 * usePublishUIContext({
 *   label: 'Popeyes',
 *   description: `Viewing Popeyes at 123 Main St. Open until 11 PM.`,
 *   data: poi,
 * })
 */
export function usePublishUIContext(entry: UIContextEntry) {
  const { publish, unpublish } = useUIContext()
  const id = useId()

  // Latest entry, so a getDescription closure never goes stale between publishes
  // (the published wrapper below always delegates to the freshest one).
  const entryRef = useRef(entry)
  entryRef.current = entry

  useEffect(() => {
    const e = entryRef.current
    publish(id, {
      ...e,
      ...(e.getDescription ? { getDescription: () => entryRef.current.getDescription?.() ?? entryRef.current.description } : {}),
    })
    return () => unpublish(id)
    // Re-publish when description changes (e.g. user selects a different POI)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, entry.description])
}
