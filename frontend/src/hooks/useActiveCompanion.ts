import { useCallback, useEffect, useState } from 'react'

export interface CompanionRecord {
  id: string
  name: string
  slug: string
  personalityPrompt: string
  backstory: string | null
  personaExamples?: string[]
  phoneticName: string | null
  replyStyle: 'brief' | 'balanced' | 'detailed' | 'auto'
  voiceId: string | null
  ttsVoice: string | null
  wakeWordModelId: string | null
  wakeWordPhrase: string | null
  speechRate: number | null
  /** 0–1 prosody swing (admin studio slider); null = default. */
  expressiveness: number | null
  renderer: string
  style: string | null
  seed: string | null
  avatarConfig: Record<string, unknown>
  category: string | null
  isActive: boolean
  published: boolean
  // Per-user content eligibility gate (from /api/companions). A character is locked when
  // its content config exceeds the user's effective ceiling.
  gate?: { usable: boolean; blockedBy: { dial: string; required: string }[] }
  content?: { profanity: string; sexual: string; violence: string; substances: string; candor: string }
}

// ── Module-level shared store ──────────────────────────────────────────────────
// All consumers (companion bar, catalog, context-menu switcher) share one source
// of truth so a switch anywhere updates everywhere without prop-drilling.
let cache: { companions: CompanionRecord[]; activeId: string | null; favorites: string[]; loaded: boolean } = {
  companions: [],
  activeId: null,
  favorites: [],
  loaded: false,
}
const subscribers = new Set<() => void>()
let inflight: Promise<void> | null = null

function notify() { subscribers.forEach((fn) => fn()) }

async function loadCompanions(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const [listRes, activeRes, favRes] = await Promise.all([
        fetch('/api/companions', { credentials: 'include' }),
        fetch('/api/companions/active', { credentials: 'include' }),
        fetch('/api/companions/favorites', { credentials: 'include' }),
      ])
      const companions = listRes.ok ? (await listRes.json() as CompanionRecord[]) : []
      const activeId = activeRes.ok ? ((await activeRes.json() as { activeCharacterId: string | null }).activeCharacterId) : null
      const favorites = favRes.ok ? ((await favRes.json() as { favorites: string[] }).favorites ?? []) : []
      cache = { companions, activeId, favorites, loaded: true }
    } catch {
      cache = { ...cache, loaded: true }
    } finally {
      inflight = null
      notify()
    }
  })()
  return inflight
}

async function persistFavorites(favorites: string[]): Promise<void> {
  cache = { ...cache, favorites }
  notify()
  try {
    await fetch('/api/companions/favorites', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites }),
    })
  } catch { /* offline — local state already updated */ }
}

async function persistActive(id: string | null): Promise<void> {
  cache = { ...cache, activeId: id }
  notify()
  try {
    await fetch('/api/companions/active', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeCharacterId: id }),
    })
  } catch { /* offline — local state already updated */ }
}

export function refreshCompanions(): Promise<void> {
  inflight = null
  return loadCompanions()
}

/** Current active companion id from the shared cache (for non-hook callers like ChatContext). */
export function getActiveCompanionId(): string | null {
  return cache.activeId
}

export function useActiveCompanion() {
  const [, forceRender] = useState(0)

  useEffect(() => {
    const sub = () => forceRender((n) => n + 1)
    subscribers.add(sub)
    if (!cache.loaded && !inflight) loadCompanions()
    return () => { subscribers.delete(sub) }
  }, [])

  const setCompanion = useCallback((id: string) => { persistActive(id) }, [])
  const clearCompanion = useCallback(() => { persistActive(null) }, [])
  const toggleFavorite = useCallback((id: string) => {
    const next = cache.favorites.includes(id)
      ? cache.favorites.filter((f) => f !== id)
      : [...cache.favorites, id]
    persistFavorites(next)
  }, [])

  const companion = cache.activeId
    ? cache.companions.find((c) => c.id === cache.activeId) ?? null
    : null

  return {
    companion,
    companions: cache.companions,
    activeCompanionId: cache.activeId,
    favorites: cache.favorites,
    setCompanion,
    clearCompanion,
    toggleFavorite,
    isFavorite: (id: string) => cache.favorites.includes(id),
    isLoading: !cache.loaded,
  }
}
