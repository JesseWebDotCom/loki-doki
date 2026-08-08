import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

// The card-style preference the iPhone and Apple TV apps share, stored on the
// hub under /api/client-prefs/cardStyle so every signed-in device agrees:
//  - modern: the Netflix look (billboard hero leading the video home)
//  - classic: YouTube's look (the home just starts with cards)
//  - classicMinimal: the classic cards with just the title, no meta line
export type CardStyle = 'modern' | 'classic' | 'classicMinimal'

const KEY = 'cardStyle'
const MIRROR = 'ld-cardStyle'

function parse(value: unknown): CardStyle | null {
  return value === 'modern' || value === 'classic' || value === 'classicMinimal' ? value : null
}

export function useCardStyle() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['client-prefs', KEY],
    queryFn: async (): Promise<CardStyle> => {
      const res = await fetch(`/api/client-prefs/${KEY}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`client-prefs ${res.status}`)
      const body = (await res.json()) as { value?: unknown }
      const style = parse(body.value) ?? 'modern'
      try { localStorage.setItem(MIRROR, style) } catch { /* storage unavailable */ }
      return style
    },
    staleTime: 60_000,
    // First paint from the device mirror so the page never flashes the
    // default style before the hub answers (same trick as useUserPreferences).
    placeholderData: () => {
      try { return parse(localStorage.getItem(MIRROR)) ?? 'modern' } catch { return 'modern' }
    },
  })

  const setStyle = useCallback((next: CardStyle) => {
    queryClient.setQueryData(['client-prefs', KEY], next)
    try { localStorage.setItem(MIRROR, next) } catch { /* storage unavailable */ }
    fetch(`/api/client-prefs/${KEY}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: next }),
    })
  }, [queryClient])

  return [query.data ?? 'modern', setStyle] as const
}
