import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface BreadcrumbSearchConfig {
  query: string
  setQuery: (q: string) => void
  /** Omit for live filtering (no submit button rendered). */
  onSubmit?: () => void
  placeholder?: string
  loading?: boolean
  /** Opens in a new tab — shown as an external link icon. */
  externalHref?: string
  /** Admin-only settings link (AppShell hides it for non-admins). */
  settingsHref?: string
  /** Optional node rendered to the LEFT of the search input (e.g. a mode toggle). */
  leftSlot?: ReactNode
  /** Optional node rendered to the RIGHT of the search input (e.g. a mode toggle). */
  rightSlot?: ReactNode
}

type SetFn = (c: BreadcrumbSearchConfig | null) => void

// Two separate contexts on purpose: the SETTER never changes identity, so pages that
// publish a config (useBreadcrumbSearch) subscribe ONLY to it and do NOT re-render when
// the config value changes. Without this split, publishing would re-render the page,
// which would produce a fresh `leftSlot` element, re-run the effect, and loop forever.
const ConfigCtx = createContext<BreadcrumbSearchConfig | null>(null)
const SetCtx = createContext<SetFn | null>(null)

export function BreadcrumbSearchProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<BreadcrumbSearchConfig | null>(null)
  const _set = useCallback(setConfig as SetFn, [])
  return (
    <SetCtx.Provider value={_set}>
      <ConfigCtx.Provider value={config}>{children}</ConfigCtx.Provider>
    </SetCtx.Provider>
  )
}

export function useBreadcrumbSearchConfig(): BreadcrumbSearchConfig | null {
  return useContext(ConfigCtx)
}

/**
 * Call in a page component to register breadcrumb actions (search, external link, settings).
 * Automatically cleared when the page unmounts.
 */
export function useBreadcrumbSearch(config: BreadcrumbSearchConfig) {
  const _set = useContext(SetCtx)!

  // Hold the latest config in a ref so callers don't have to memoize setQuery/onSubmit.
  // The effect below only depends on primitive values + stable wrappers, so it won't
  // re-run (and thrash _set) on every render when callbacks have fresh identities.
  const configRef = useRef(config)
  configRef.current = config

  const setQuery = useCallback((q: string) => configRef.current.setQuery(q), [])
  const onSubmit = useCallback(() => configRef.current.onSubmit?.(), [])

  const { query, loading, placeholder, externalHref, settingsHref, leftSlot, rightSlot } = config
  const hasSubmit = !!config.onSubmit

  useLayoutEffect(() => {
    _set({
      query,
      loading,
      placeholder,
      externalHref,
      settingsHref,
      leftSlot,
      rightSlot,
      setQuery,
      onSubmit: hasSubmit ? onSubmit : undefined,
    })
    return () => _set(null)
  }, [query, loading, placeholder, externalHref, settingsHref, leftSlot, rightSlot, hasSubmit, setQuery, onSubmit, _set])
}
