import { useCallback, useEffect, useState } from 'react'

export interface HomeWidget {
  toolId: string
  colSpan: 1 | 2
}

export interface HomeRow {
  id: string
  cols: HomeWidget[]
}

export interface HomeLayoutHeader {
  weather: boolean
  jokes: boolean
  sports: boolean
  locked: boolean
}

export interface HomeLayout {
  header: HomeLayoutHeader
  canvas: HomeRow[]
}

const DEFAULT_LAYOUT: HomeLayout = {
  header: { weather: true, jokes: true, sports: true, locked: false },
  canvas: [],
}

export interface UseHomeLayoutResult {
  layout: HomeLayout
  locked: boolean
  isLoading: boolean
  save: (layout: HomeLayout) => Promise<void>
  reload: () => void
}

export function useHomeLayout(): UseHomeLayoutResult {
  const [layout, setLayout] = useState<HomeLayout>(DEFAULT_LAYOUT)
  const [locked, setLocked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [rev, setRev] = useState(0)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    fetch('/api/home-layout', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { layout?: HomeLayout; locked?: boolean } | null) => {
        if (cancelled) return
        if (d?.layout) setLayout(d.layout)
        setLocked(d?.locked ?? false)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [rev])

  const save = useCallback(async (next: HomeLayout) => {
    await fetch('/api/home-layout', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    setLayout(next)
  }, [])

  const reload = useCallback(() => setRev(v => v + 1), [])

  return { layout, locked, isLoading, save, reload }
}
