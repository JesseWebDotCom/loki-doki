// Remote-Ollama engine pairing. Lets an admin point LLM inference at a remote
// Ollama host (same wire protocol) instead of the local one. The active base URL
// is read through a synchronous in-memory cache so the many `ollamaUrl()` callers
// don't have to become async; the cache is seeded at startup and refreshed on save.
//
// Scope: remote *Ollama* (base URL + model). Token-gated / OpenAI-compatible hosts
// are out of scope for now — the streaming path sends no auth header.

import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const KEY_ENABLED = 'llm.remote.enabled'
const KEY_BASE_URL = 'llm.remote.base_url'
const KEY_MODEL = 'llm.remote.model'

interface RemoteState {
  enabled: boolean
  baseUrl: string | null
  model: string | null
}

// Seeded from the DB at startup; updated whenever the admin saves.
const state: RemoteState = { enabled: false, baseUrl: null, model: null }

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Load persisted remote-engine config into the in-memory cache. Call at boot. */
export async function loadRemoteEngine(): Promise<void> {
  try {
    state.enabled = (await getAppSetting(KEY_ENABLED)) === true
    const base = (await getAppSetting(KEY_BASE_URL)) as string | null
    state.baseUrl = base ? normalizeBase(base) : null
    state.model = ((await getAppSetting(KEY_MODEL)) as string | null) || null
  } catch (e) {
    logger.warn(`[remote-engine] load failed: ${e}`)
  }
}

/** The Ollama base URL in effect right now (remote when enabled, else local/env). */
export function getActiveOllamaUrl(): string {
  if (state.enabled && state.baseUrl) return state.baseUrl
  return process.env.OLLAMA_URL ?? 'http://localhost:11434'
}

/** Remote model override, or null when not pairing. */
export function getRemoteModelOverride(): string | null {
  return state.enabled ? state.model : null
}

export function remoteEngineState(): RemoteState & { localUrl: string } {
  return { ...state, localUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434' }
}

export interface ProbeResult {
  ok: boolean
  models: string[]
  latencyMs: number | null
  error: 'auth' | 'unreachable' | 'invalid_response' | null
}

/** Validate a remote Ollama host by listing its models. Never throws. */
export async function probeRemote(baseUrl: string): Promise<ProbeResult> {
  const base = normalizeBase(baseUrl)
  const t0 = performance.now()
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    const latencyMs = Math.round(performance.now() - t0)
    if (res.status === 401 || res.status === 403) return { ok: false, models: [], latencyMs, error: 'auth' }
    if (!res.ok) return { ok: false, models: [], latencyMs, error: 'invalid_response' }
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    if (!Array.isArray(data.models)) return { ok: false, models: [], latencyMs, error: 'invalid_response' }
    return { ok: true, models: data.models.map((m) => m.name ?? '').filter(Boolean), latencyMs, error: null }
  } catch {
    return { ok: false, models: [], latencyMs: null, error: 'unreachable' }
  }
}

export interface RemoteConfigInput {
  baseUrl?: string | null
  model?: string | null
  enabled?: boolean
}

/** Persist config + update the live cache. Enabling requires a base URL. */
export async function setRemoteConfig(input: RemoteConfigInput): Promise<RemoteState> {
  if (input.baseUrl !== undefined) {
    state.baseUrl = input.baseUrl ? normalizeBase(input.baseUrl) : null
    await setAppSetting(KEY_BASE_URL, state.baseUrl)
  }
  if (input.model !== undefined) {
    state.model = input.model || null
    await setAppSetting(KEY_MODEL, state.model)
  }
  if (input.enabled !== undefined) {
    state.enabled = input.enabled && !!state.baseUrl
    await setAppSetting(KEY_ENABLED, state.enabled)
  }
  return { ...state }
}
