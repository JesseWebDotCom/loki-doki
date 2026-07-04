import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SuggestSource } from '@/lib/smartSearch/types'

export interface AppHeaderConfig {
  query: string
  setQuery: (q: string) => void
  /** Omit for live filtering (no submit button rendered). */
  onSubmit?: () => void
  /** Set false to hide the search input entirely (for header rows that only use slots). */
  searchable?: boolean
  /** Opt into the autosuggest dropdown (SmartSearchInput) instead of a plain input. */
  suggest?: SuggestSource
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
  /**
   * Extra crumbs appended after the page's own crumb (e.g. a panel app's current
   * section/subsection: Admin > System > Connectivity). Omit `onClick` on the
   * last one so it renders as the non-interactive current page, matching the
   * chat conversation-title crumb convention. This is the sanctioned way for a
   * panel page to surface its internal navigation state in the ONE global
   * breadcrumb instead of building a second local header bar.
   */
  extraCrumbs?: { label: string; onClick?: () => void }[]
}

type SetFn = (c: AppHeaderConfig | null) => void

// Two separate contexts on purpose: the SETTER never changes identity, so pages that
// publish a config (useAppHeader) subscribe ONLY to it and do NOT re-render when
// the config value changes. Without this split, publishing would re-render the page,
// which would produce a fresh `leftSlot` element, re-run the effect, and loop forever.
const ConfigCtx = createContext<AppHeaderConfig | null>(null)
const SetCtx = createContext<SetFn | null>(null)

export function BreadcrumbSearchProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppHeaderConfig | null>(null)
  const _set = useCallback(setConfig as SetFn, [])
  return (
    <SetCtx.Provider value={_set}>
      <ConfigCtx.Provider value={config}>{children}</ConfigCtx.Provider>
    </SetCtx.Provider>
  )
}

export function useAppHeaderConfig(): AppHeaderConfig | null {
  return useContext(ConfigCtx)
}

/**
 * Call in a page component to register the app header actions (search, external link,
 * settings, toggle slots). Automatically cleared when the page unmounts. This is the
 * single sanctioned way for an app to populate the breadcrumb's action row — see the
 * "App Header Contract" section in agents.md.
 */
export function useAppHeader(config: AppHeaderConfig) {
  const _set = useContext(SetCtx)!

  // Hold the latest config in a ref so callers don't have to memoize setQuery/onSubmit.
  // The effect below only depends on primitive values + stable wrappers, so it won't
  // re-run (and thrash _set) on every render when callbacks have fresh identities.
  const configRef = useRef(config)
  configRef.current = config

  const setQuery = useCallback((q: string) => configRef.current.setQuery(q), [])
  const onSubmit = useCallback(() => configRef.current.onSubmit?.(), [])

  const { query, loading, placeholder, externalHref, settingsHref, leftSlot, rightSlot, searchable, extraCrumbs, suggest } = config
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
      searchable,
      extraCrumbs,
      suggest,
      setQuery,
      onSubmit: hasSubmit ? onSubmit : undefined,
    })
    return () => _set(null)
  }, [query, loading, placeholder, externalHref, settingsHref, leftSlot, rightSlot, searchable, extraCrumbs, suggest, hasSubmit, setQuery, onSubmit, _set])
}

// ── Back-compat aliases ────────────────────────────────────────────────────────
// The header system was originally named "breadcrumb search". These keep older call
// sites working; prefer useAppHeader / AppHeaderConfig / useAppHeaderConfig in new code.
/** @deprecated Use {@link AppHeaderConfig}. */
export type BreadcrumbSearchConfig = AppHeaderConfig
/** @deprecated Use {@link useAppHeader}. */
export const useBreadcrumbSearch = useAppHeader
/** @deprecated Use {@link useAppHeaderConfig}. */
export const useBreadcrumbSearchConfig = useAppHeaderConfig
