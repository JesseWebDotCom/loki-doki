// SABnzbd client for the media integrations. SAB's API is query-param shaped
// (?apikey=...&mode=...&output=json), unlike the arr X-Api-Key header style, so it
// gets its own helper. Everything degrades to null/no-op when unconfigured.

import { getIntegrationsConfig } from '@/lib/media/integrations'

async function sabCall<T>(mode: string, params: Record<string, string> = {}): Promise<T | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sabnzbd_url || !cfg.sabnzbd_key) return null
  const qs = new URLSearchParams({ output: 'json', apikey: cfg.sabnzbd_key, mode, ...params })
  try {
    const res = await fetch(`${cfg.sabnzbd_url.trim().replace(/\/+$/, '')}/api?${qs}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export interface SabQueueSlot {
  nzoId: string
  filename: string
  /** 0..100 */
  percentage: number
  mb: number
  mbLeft: number
  timeLeft: string
  status: string
}

export interface SabQueue {
  paused: boolean
  /** Current download speed, human string from SAB (e.g. "3.2 M"). */
  speed: string
  sizeLeft: string
  slots: SabQueueSlot[]
}

interface SabQueueRaw {
  queue?: {
    paused?: boolean
    speed?: string
    sizeleft?: string
    slots?: Array<{ nzo_id?: string; filename?: string; percentage?: string; mb?: string; mbleft?: string; timeleft?: string; status?: string }>
  }
}

export async function sabQueue(): Promise<SabQueue | null> {
  const raw = await sabCall<SabQueueRaw>('queue')
  if (!raw?.queue) return null
  return {
    paused: raw.queue.paused === true,
    speed: raw.queue.speed ?? '0',
    sizeLeft: raw.queue.sizeleft ?? '0',
    slots: (raw.queue.slots ?? []).map((s) => ({
      nzoId: s.nzo_id ?? '',
      filename: s.filename ?? 'Unknown',
      percentage: Number(s.percentage) || 0,
      mb: Number(s.mb) || 0,
      mbLeft: Number(s.mbleft) || 0,
      timeLeft: s.timeleft ?? '',
      status: s.status ?? 'Unknown',
    })),
  }
}

export interface SabHistoryItem {
  nzoId: string
  name: string
  status: string
  failMessage: string | null
  size: string
  completedAt: number | null
}

interface SabHistoryRaw {
  history?: {
    slots?: Array<{ nzo_id?: string; name?: string; status?: string; fail_message?: string; size?: string; completed?: number }>
  }
}

export async function sabHistory(limit = 30): Promise<SabHistoryItem[] | null> {
  const raw = await sabCall<SabHistoryRaw>('history', { start: '0', limit: String(limit) })
  if (!raw?.history) return null
  return (raw.history.slots ?? []).map((s) => ({
    nzoId: s.nzo_id ?? '',
    name: s.name ?? 'Unknown',
    status: s.status ?? 'Unknown',
    failMessage: s.fail_message || null,
    size: s.size ?? '',
    completedAt: s.completed ? s.completed * 1000 : null,
  }))
}

export async function sabPauseQueue(): Promise<boolean> {
  return !!(await sabCall<{ status?: boolean }>('pause'))?.status
}
export async function sabResumeQueue(): Promise<boolean> {
  return !!(await sabCall<{ status?: boolean }>('resume'))?.status
}
export async function sabPauseItem(nzoId: string): Promise<boolean> {
  return !!(await sabCall<{ status?: boolean }>('queue', { name: 'pause', value: nzoId }))?.status
}
export async function sabResumeItem(nzoId: string): Promise<boolean> {
  return !!(await sabCall<{ status?: boolean }>('queue', { name: 'resume', value: nzoId }))?.status
}
export async function sabDeleteItem(nzoId: string): Promise<boolean> {
  return !!(await sabCall<{ status?: boolean }>('queue', { name: 'delete', value: nzoId }))?.status
}

/** Cheap connectivity probe for the admin Test button. */
export async function sabTest(): Promise<{ ok: boolean; version?: string }> {
  const raw = await sabCall<{ version?: string }>('version')
  return raw?.version ? { ok: true, version: raw.version } : { ok: false }
}
