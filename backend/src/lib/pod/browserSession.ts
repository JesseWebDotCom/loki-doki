import { randomUUID } from 'node:crypto'
import { logger } from '@/lib/logger'
import { isSameMachine } from '@/lib/clientMachine'

export interface BrowserCommand {
  type: 'navigate' | 'open_url' | 'app_action' | 'stream_deck_page_jump' | 'media_transport' | 'watch_invite'
  path?: string
  url?: string
  action?: string
  payload?: Record<string, unknown>
  pageId?: string
  // media_transport: a play/pause/next/prev/seek from the device's native player.
  transport?: 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'seek' | 'stop'
  position?: number   // seconds, for transport === 'seek'
  ackId?: string      // the app POSTs this back once it HANDLES the command (fire-and-verify)
}

// Server → dock request (file ops etc.), correlated by requestId; the dock's HUD page
// relays it to the Electron main process and POSTs the result back to /dock-result.
export interface DockRequest {
  requestId: string
  type: 'files'
  action?: string
  path?: string
}

export interface SessionEntry {
  send: (cmd: BrowserCommand) => void
  sendVoice: (state: { yield: boolean }) => void
  sendDock: (req: DockRequest) => void
  /** True when this session is the Doki Dock desktop app (either of its windows). */
  isDock: boolean
  surface: 'app' | 'hud'
  /** Arbitration IP (already normalized via clientMachine.getArbitrationIp). */
  ip: string
  lastYield: boolean | null
}

// userId → Set of active SSE sessions. Insertion order = connection recency.
const sessions = new Map<string, Set<SessionEntry>>()

/** Register a browser session. Returns an idempotent unregister function. */
export function registerBrowserSession(userId: string, entry: SessionEntry): () => void {
  if (!sessions.has(userId)) sessions.set(userId, new Set())
  sessions.get(userId)!.add(entry)
  logger.info(`[browser-session] registered userId=${userId} dock=${entry.isDock ? 1 : 0} surface=${entry.surface} ip=${entry.ip} (${sessions.get(userId)!.size} sessions)`)
  recomputeVoiceArbitration(userId)
  return () => {
    const set = sessions.get(userId)
    if (!set || !set.delete(entry)) return // already unregistered
    if (set.size === 0) sessions.delete(userId)
    logger.info(`[browser-session] unregistered userId=${userId} dock=${entry.isDock ? 1 : 0} surface=${entry.surface}`)
    recomputeVoiceArbitration(userId)
  }
}

/** Recompute per-session voice yield for a user and push changes. A non-dock session
 *  yields iff a dock session of the same user is connected from the same machine. Dock
 *  sessions never yield. Pushed only on change (or first computation) — reconnecting
 *  clients always get an initial event because a fresh entry starts with lastYield null. */
function recomputeVoiceArbitration(userId: string): void {
  const set = sessions.get(userId)
  if (!set) return
  const dockIps = Array.from(set).filter((s) => s.isDock).map((s) => s.ip)
  for (const entry of set) {
    const y = entry.isDock ? false : dockIps.some((d) => isSameMachine(d, entry.ip))
    if (entry.lastYield === y) continue
    entry.lastYield = y
    try { entry.sendVoice({ yield: y }) } catch { /* dead stream; ping loop reaps it */ }
  }
}

/** Push a command to the MOST RECENT non-HUD browser session for this user (the latest
 *  tab the user opened) — not every tab, so a controller tap drives one player, not all
 *  of them. The dock's HUD island is skipped: it registers for voice/dock arbitration but
 *  can't navigate or host players, so it must not steal controller commands. */
export function pushToBrowserSession(userId: string, cmd: BrowserCommand): boolean {
  const set = sessions.get(userId)
  const candidates = set ? Array.from(set).filter((s) => s.surface !== 'hud') : []
  if (candidates.length === 0) {
    logger.info(`[browser-session] DROP ${cmd.type} — no active tab for userId=${userId} (is the web app open + connected?)`)
    return false
  }
  logger.info(`[browser-session] → ${cmd.type}${cmd.action ? '/' + cmd.action : ''} to most recent of ${candidates.length} tab(s) userId=${userId}`)
  const recent = candidates[candidates.length - 1]
  if (recent) { try { recent.send(cmd); return true } catch { return false } }
  return false
}

// ── Command ACK: an action isn't "fired" just because it was delivered — the app POSTs an
// ack once it actually HANDLES it. Callers track a pending ack; a timeout means it didn't fire.
const pendingAcks = new Map<string, { onResult: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

export function trackCommandAck(ackId: string, onResult: (ok: boolean) => void, timeoutMs = 2500): void {
  const prev = pendingAcks.get(ackId)
  if (prev) clearTimeout(prev.timer)
  const timer = setTimeout(() => { pendingAcks.delete(ackId); onResult(false) }, timeoutMs)
  pendingAcks.set(ackId, { onResult, timer })
}

/** Called from the app's ack POST — the action was actually handled. */
export function resolveCommandAck(ackId: string): void {
  const p = pendingAcks.get(ackId)
  if (!p) return
  clearTimeout(p.timer)
  pendingAcks.delete(ackId)
  p.onResult(true)
}

// ── Dock request/response: a companion tool asks the user's dock to do something local
// (read-only file ops). Request rides the dock session's SSE; the HUD page relays it over
// the preload bridge and POSTs the result back. The timeout doubles as the offline check.

export interface DockResult {
  ok: boolean
  error?: string
  data?: unknown
}

const pendingDockRequests = new Map<string, { resolve: (r: DockResult) => void; timer: ReturnType<typeof setTimeout> }>()

/** True when the user has a live Doki Dock session connected. */
export function isDockOnline(userId: string): boolean {
  const set = sessions.get(userId)
  if (!set) return false
  return Array.from(set).some((s) => s.isDock)
}

/** Send a request to the user's dock and await its result (or time out). Prefers the HUD
 *  session — it's the always-running window; the main dock window may be closed-to-tray. */
export function sendDockRequest(
  userId: string,
  req: Omit<DockRequest, 'requestId'>,
  timeoutMs = 10_000,
): Promise<DockResult> {
  const set = sessions.get(userId)
  const docks = set ? Array.from(set).filter((s) => s.isDock) : []
  const target = docks.find((s) => s.surface === 'hud') ?? docks[docks.length - 1]
  if (!target) return Promise.resolve({ ok: false, error: 'dock_offline' })
  const requestId = randomUUID()
  return new Promise<DockResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingDockRequests.delete(requestId)
      resolve({ ok: false, error: 'dock_timeout' })
    }, timeoutMs)
    pendingDockRequests.set(requestId, { resolve, timer })
    try {
      target.sendDock({ ...req, requestId })
    } catch {
      clearTimeout(timer)
      pendingDockRequests.delete(requestId)
      resolve({ ok: false, error: 'dock_offline' })
    }
  })
}

/** Called from the dock's result POST. */
export function resolveDockRequest(requestId: string, result: DockResult): void {
  const p = pendingDockRequests.get(requestId)
  if (!p) return
  clearTimeout(p.timer)
  pendingDockRequests.delete(requestId)
  p.resolve(result)
}
