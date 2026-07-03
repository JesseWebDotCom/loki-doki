// Server-backed favorites + recently-viewed for the Shop landing, per-user so they sync
// across a person's devices. Both hooks read one shared react-query cache (single fetch)
// and mutate through /api/shopping/saved; the API owns pruning recents to the newest N.
// The exported hook shapes match the old localStorage version, so callers didn't change.

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

export interface ShopItem {
  retailer: string
  externalId: string
  title: string
  imageUrl: string | null
  url: string
  priceCents: number | null
  wasPriceCents?: number | null
  ts?: number
}

interface SavedRow extends ShopItem {
  id: string
  kind: 'favorite' | 'recent'
  createdAt: number
}

export function itemKey(i: { retailer: string; externalId: string }): string {
  return `${i.retailer}:${i.externalId}`
}

const QKEY = ['shopping-saved']

async function fetchSaved(): Promise<SavedRow[]> {
  const res = await fetch('/api/shopping/saved', { credentials: 'include' })
  if (!res.ok) return []
  const data = await res.json() as { items: SavedRow[] }
  return data.items ?? []
}

function post(path: string, body: unknown): Promise<unknown> {
  return fetch(`/api/shopping/saved${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify(body),
  }).catch(() => undefined)
}

function useSaved(kind: 'favorite' | 'recent') {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: QKEY, queryFn: fetchSaved, staleTime: 30_000 })
  const items = (data ?? []).filter(r => r.kind === kind) as ShopItem[]
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: QKEY }), [qc])
  return { qc, items, invalidate }
}

export function useRecentlyViewed() {
  const { items, invalidate } = useSaved('recent')
  const record = useCallback((item: Omit<ShopItem, 'ts'>) => {
    void post('', { kind: 'recent', ...item }).then(invalidate)
  }, [invalidate])
  const remove = useCallback((key: string) => {
    const [retailer, ...rest] = key.split(':')
    void post('/remove', { kind: 'recent', retailer, externalId: rest.join(':') }).then(invalidate)
  }, [invalidate])
  const clear = useCallback(() => { void post('/clear', { kind: 'recent' }).then(invalidate) }, [invalidate])
  return { items, record, remove, clear }
}

export function useFavorites() {
  const { items, invalidate } = useSaved('favorite')
  const isFavorite = useCallback((key: string) => items.some(i => itemKey(i) === key), [items])
  const toggle = useCallback((item: Omit<ShopItem, 'ts'>) => {
    const key = itemKey(item)
    const on = items.some(i => itemKey(i) === key)
    const req = on
      ? post('/remove', { kind: 'favorite', retailer: item.retailer, externalId: item.externalId })
      : post('', { kind: 'favorite', ...item })
    void req.then(invalidate)
  }, [items, invalidate])
  const remove = useCallback((key: string) => {
    const [retailer, ...rest] = key.split(':')
    void post('/remove', { kind: 'favorite', retailer, externalId: rest.join(':') }).then(invalidate)
  }, [invalidate])
  const clear = useCallback(() => { void post('/clear', { kind: 'favorite' }).then(invalidate) }, [invalidate])
  return { items, isFavorite, toggle, remove, clear }
}
