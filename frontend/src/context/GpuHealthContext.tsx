import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/context/AuthContext'

// Polls the admin GPU-health endpoint (admin only), exposes the latest snapshot to the System tab,
// and raises a dismissible toast whenever a NEW GPU issue appears (missing/ejected card, driver
// down, overheat, VRAM near-full) — so an admin is alerted even when not on an admin page.

export interface GpuStat {
  index: number
  name: string
  uuid: string
  utilizationPct: number | null
  memUsedMb: number | null
  memTotalMb: number | null
  temperatureC: number | null
}
export interface GpuIssue {
  kind: 'missing' | 'driver' | 'overheat' | 'vram' | 'offload'
  key: string
  severity: 'warn' | 'error'
  message: string
  gpu?: string
}
// Live LLM engine census (mirrors backend lib/llmStatus.ts).
export interface LoadedLlmModel {
  engine: 'main' | 'coding'
  name: string
  sizeBytes: number
  vramBytes: number
  offloadPct: number
  contextLength: number | null
  expiresAt: string | null
}
export interface LlmStatus {
  models: LoadedLlmModel[]
  engines: { main: boolean; coding: boolean }
  orphanSweep: { at: number; pids: number[] }
  sustainedOffload: LoadedLlmModel[]
}
export interface GpuHealth {
  supported: boolean
  driverOk: boolean
  gpus: GpuStat[]
  expected: { uuid: string; name: string }[]
  issues: GpuIssue[]
  llm: LlmStatus
}
export interface GpuAlertConfig {
  missing:  { enabled: boolean }
  driver:   { enabled: boolean }
  overheat: { enabled: boolean; thresholdC: number }
  vram:     { enabled: boolean; thresholdPct: number }
  offload:  { enabled: boolean }
}
export type GpuAlertConfigPatch = {
  missing?:  { enabled?: boolean }
  driver?:   { enabled?: boolean }
  overheat?: { enabled?: boolean; thresholdC?: number }
  vram?:     { enabled?: boolean; thresholdPct?: number }
  offload?:  { enabled?: boolean }
}

interface GpuCtx {
  health: GpuHealth | null
  config: GpuAlertConfig | null
  saveConfig: (patch: GpuAlertConfigPatch) => Promise<void>
  resetBaseline: () => Promise<void>
  refresh: () => void
}

const Ctx = createContext<GpuCtx>({ health: null, config: null, saveConfig: async () => {}, resetBaseline: async () => {}, refresh: () => {} })
export const useGpuHealth = () => useContext(Ctx)

const POLL_MS = 20_000

export function GpuHealthProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [health, setHealth] = useState<GpuHealth | null>(null)
  const [config, setConfig] = useState<GpuAlertConfig | null>(null)
  const [bump, setBump] = useState(0)
  const toasted = useRef<Set<string>>(new Set())

  const refresh = useCallback(() => setBump((b) => b + 1), [])

  const saveConfig = useCallback(async (patch: GpuAlertConfigPatch) => {
    try {
      const r = await fetch('/api/admin/gpu/config', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (r.ok) setConfig(await r.json() as GpuAlertConfig)
    } catch { /* ignore */ }
    refresh()
  }, [refresh])

  const resetBaseline = useCallback(async () => {
    try { await fetch('/api/admin/gpu/reset-baseline', { method: 'POST', credentials: 'include' }) } catch { /* ignore */ }
    refresh()
  }, [refresh])

  // Load config once when the admin arrives.
  useEffect(() => {
    if (!isAdmin) { setConfig(null); return }
    fetch('/api/admin/gpu/config', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((c) => { if (c) setConfig(c as GpuAlertConfig) })
      .catch(() => {})
  }, [isAdmin])

  // Poll status; toast newly-appeared issues, dismiss resolved ones.
  useEffect(() => {
    if (!isAdmin) { setHealth(null); return }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const r = await fetch('/api/admin/gpu/status', { credentials: 'include' })
        if (alive && r.ok) {
          const h = await r.json() as GpuHealth
          setHealth(h)
          const live = new Set(h.issues.map((i) => i.key))
          for (const issue of h.issues) {
            if (!toasted.current.has(issue.key)) {
              toasted.current.add(issue.key)
              const fn = issue.severity === 'error' ? toast.error : toast.warning
              fn(issue.message, { id: issue.key, duration: Infinity })   // sticky + dismissible
            }
          }
          for (const key of [...toasted.current]) {
            if (!live.has(key)) { toasted.current.delete(key); toast.dismiss(key) }
          }
        }
      } catch { /* offline / not logged in — keep last value */ }
      if (alive) timer = setTimeout(poll, POLL_MS)
    }

    poll()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [isAdmin, bump])

  return <Ctx.Provider value={{ health, config, saveConfig, resetBaseline, refresh }}>{children}</Ctx.Provider>
}
