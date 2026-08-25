// GraphHopper routing sidecar — ported from the v2 app's maps/routing/.
//
// A single Java GraphHopper server is spawned on demand against the routing
// graph of whichever installed region covers the request. It is reused while
// warm and shut down after an idle timeout. When no local graph covers the
// points (or the toolchain is not installed) routing returns a 503-style
// RouteUnavailableError; if MAIPAI_ROUTER_ONLINE_FALLBACK=1 we fall back to a
// public OSRM instance.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRegion } from '@/lib/maps/catalog'
import { listInstalledRegions } from '@/lib/maps/store'
import { graphhopperJar, javaBin, regionGraphDir, regionPbfPath } from '@/lib/maps/paths'
import { ghServerConfigYaml } from '@/lib/maps/ghConfig'
import { logger } from '@/lib/logger'

export type RouterMode = 'auto' | 'pedestrian' | 'bicycle' | 'hiking' | 'mtb'

export interface LatLon { lat: number; lon: number }

export interface RouteRequest {
  origin: LatLon
  destination: LatLon
  waypoints: LatLon[]
  profile: RouterMode
  alternates: 0 | 1 | 2
  avoid: { highways: boolean; tolls: boolean; ferries: boolean }
}

export interface ManeuverWire {
  text: string
  distance_m: number
  duration_s: number
  sign: number
  interval: [number, number]
  street_name: string | null
}
export interface RouteWire {
  duration_s: number
  distance_m: number
  geometry: string
  profile: RouterMode
  legs: { steps: ManeuverWire[] }[]
}
export interface RouteResponseWire {
  routes: RouteWire[]
  instructions_text: string[]
  alternates: RouteWire[]
  mechanism_used: 'graphhopper' | 'osrm'
}

export class RouteUnavailableError extends Error {
  retryAfterSeconds: number | null
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = 'RouteUnavailableError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const GH_PORT = parseInt(process.env.MAIPAI_GRAPHHOPPER_PORT ?? '8002', 10)
const GH_HEAP_MB = parseInt(process.env.MAIPAI_GRAPHHOPPER_HEAP_MB ?? '1024', 10)
const IDLE_TIMEOUT_MS = parseInt(process.env.MAIPAI_ROUTER_IDLE_TIMEOUT_S ?? '300', 10) * 1000

function ghProfile(mode: RouterMode): 'car' | 'bike' | 'foot' {
  if (mode === 'auto') return 'car'
  if (mode === 'bicycle' || mode === 'mtb') return 'bike'
  return 'foot' // pedestrian, hiking
}

function isToolchainReady(): boolean {
  return existsSync(javaBin()) && existsSync(graphhopperJar())
}

// Pick the installed region whose bbox contains both endpoints and has a graph.
function regionForPoints(a: LatLon, b: LatLon): string | null {
  const contains = (id: string, p: LatLon) => {
    const region = getRegion(id)
    if (!region) return false
    const [minLon, minLat, maxLon, maxLat] = region.bbox
    return p.lon >= minLon && p.lon <= maxLon && p.lat >= minLat && p.lat <= maxLat
  }
  for (const r of listInstalledRegions()) {
    if (!r.valhallaInstalled) continue
    if (!existsSync(regionGraphDir(r.regionId))) continue
    if (contains(r.regionId, a) && contains(r.regionId, b)) return r.regionId
  }
  return null
}

// ── Sidecar lifecycle ─────────────────────────────────────────────────────────

interface Sidecar { proc: ChildProcess; regionId: string; ready: boolean }
let sidecar: Sidecar | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function ghUrl(): string { return `http://127.0.0.1:${GH_PORT}` }

function bumpIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => shutdown(), IDLE_TIMEOUT_MS)
}

function shutdown(): void {
  stopSupervision()  // intentional stop (idle timeout / server exit) must never respawn
  if (sidecar) {
    try { sidecar.proc.kill('SIGTERM') } catch { /* gone */ }
    sidecar = null   // nulled before the exit event fires → exit handler won't respawn
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
}

// ── Post-ready supervision ──────────────────────────────────────────────────────
// ensureSidecar only health-checks at request time; a JVM that dies between requests
// (OOM is common with big graphs) would otherwise stay dead until the next route()
// call. A low-frequency liveness re-probe + the child 'exit' handler respawn it —
// capped so a persistently-crashing graph can't respawn-loop forever. The idle
// timeout still governs shutdown: a respawned-but-unused sidecar ages out normally.

const SUPERVISE_INTERVAL_MS = 60_000
const SUPERVISE_RETRY_MS    = 5_000       // quick re-probe before declaring death
const RESTART_WINDOW_MS     = 10 * 60_000
const RESTART_MAX           = 3

let superviseTimer: ReturnType<typeof setTimeout> | null = null
let superviseFailures = 0
let restartTimes: number[] = []

function stopSupervision(): void {
  if (superviseTimer) { clearTimeout(superviseTimer); superviseTimer = null }
  superviseFailures = 0
}

function startSupervision(): void {
  if (superviseTimer) return  // already supervising this instance
  superviseFailures = 0
  const tick = async (): Promise<void> => {
    const current = sidecar
    if (!current) { superviseTimer = null; return }  // shut down while waiting
    let ok = false
    try {
      const r = await fetch(`${ghUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      ok = r.ok
    } catch { /* down or wedged */ }
    if (sidecar !== current) { superviseTimer = null; return }  // replaced/stopped while probing
    if (ok) {
      superviseFailures = 0
      superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
      return
    }
    superviseFailures++
    if (superviseFailures < 2) {
      superviseTimer = setTimeout(() => void tick(), SUPERVISE_RETRY_MS)
      return
    }
    superviseTimer = null
    handleCrash(current.regionId)
  }
  superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
}

// Shared respawn path for the liveness probe and the child 'exit' handler. Old
// restart timestamps age out of the window, so a sustained healthy period naturally
// resets the cap.
function handleCrash(regionId: string): void {
  stopSupervision()
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimes.length >= RESTART_MAX) {
    shutdown()  // leave no zombie; the next route() request may still retry explicitly
    logger.error(`[graphhopper] GraphHopper (${regionId}) crashed ${RESTART_MAX}+ times within 10 minutes — not auto-respawning`)
    return
  }
  restartTimes.push(now)
  logger.warn(`[graphhopper] GraphHopper (${regionId}) died — respawning`)
  void ensureSidecar(regionId).catch((err) => {
    logger.warn(`[graphhopper] respawn failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

/** Stop the GraphHopper JVM sidecar on server shutdown so it doesn't outlive us. */
export function stopGraphHopper(): void {
  shutdown()
}

async function ensureSidecar(regionId: string): Promise<void> {
  if (sidecar && sidecar.regionId === regionId) {
    bumpIdle()
    // Confirm still healthy.
    try {
      const r = await fetch(`${ghUrl()}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return
    } catch { /* fall through to respawn */ }
  }
  shutdown()

  const graphDir = regionGraphDir(regionId)
  const configPath = join(graphDir, 'gh-config.yml')
  await writeFile(configPath, ghServerConfigYaml(regionPbfPath(regionId), graphDir, GH_PORT))

  const proc = spawn(
    javaBin(),
    [`-Xmx${GH_HEAP_MB}m`, '-jar', graphhopperJar(), 'server', configPath],
    { stdio: 'ignore', detached: false, windowsHide: true },
  )
  sidecar = { proc, regionId, ready: false }
  // Crash accelerator, post-ready only (a JVM dying during graph load is handled by
  // the readiness poll below, as before). shutdown() nulls `sidecar` before the exit
  // event fires, so intentional kills (idle timeout, region swap, server exit) never
  // respawn.
  proc.on('exit', () => {
    if (sidecar?.proc !== proc) return
    const wasReady = sidecar.ready
    sidecar = null
    if (wasReady) handleCrash(regionId)
  })
  bumpIdle()

  // Poll for readiness (up to 60s — graph load into RAM can take a while).
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ghUrl()}/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) {
        if (sidecar?.proc === proc) sidecar.ready = true
        startSupervision()
        return
      }
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1500))
  }
  throw new RouteUnavailableError('Routing engine did not start in time.', 10)
}

// ── GraphHopper response mapping ────────────────────────────────────────────────

interface GhInstruction {
  text: string
  distance: number
  time: number
  sign: number
  interval: [number, number]
  street_name?: string
}
interface GhPath {
  distance: number
  time: number
  points: string
  instructions: GhInstruction[]
}

function mapPath(p: GhPath, profile: RouterMode): RouteWire {
  const steps: ManeuverWire[] = (p.instructions ?? []).map((ins) => ({
    text: ins.text,
    distance_m: ins.distance,
    duration_s: ins.time / 1000,
    sign: ins.sign,
    interval: ins.interval,
    street_name: ins.street_name ?? null,
  }))
  return {
    duration_s: p.time / 1000,
    distance_m: p.distance,
    geometry: p.points,
    profile,
    legs: [{ steps }],
  }
}

function buildGhUrl(req: RouteRequest): string {
  const pts = [req.origin, ...req.waypoints, req.destination]
  const params = new URLSearchParams()
  for (const pt of pts) params.append('point', `${pt.lat},${pt.lon}`)
  params.set('profile', ghProfile(req.profile))
  params.set('points_encoded', 'true')
  params.set('instructions', 'true')
  params.set('locale', 'en')
  if (req.alternates > 0) {
    params.set('algorithm', 'alternative_route')
    params.set('alternative_route.max_paths', String(req.alternates + 1))
  }
  return `${ghUrl()}/route?${params.toString()}`
}

export async function route(req: RouteRequest): Promise<RouteResponseWire> {
  const regionId = regionForPoints(req.origin, req.destination)
  if (!regionId || !isToolchainReady()) {
    if (process.env.MAIPAI_ROUTER_ONLINE_FALLBACK === '1') return routeOnline(req)
    throw new RouteUnavailableError(
      'Routing unavailable. Install a region that covers both points or enable the online fallback.',
    )
  }
  await ensureSidecar(regionId)
  const res = await fetch(buildGhUrl(req), { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) {
    throw new RouteUnavailableError(`Routing engine error (${res.status}).`)
  }
  const body = (await res.json()) as { paths?: GhPath[] }
  const paths = body.paths ?? []
  if (paths.length === 0) throw new RouteUnavailableError('No route found between these points.')
  const routes = paths.map((p) => mapPath(p, req.profile))
  const primary = routes[0]!
  return {
    routes: [primary],
    instructions_text: (primary.legs[0]?.steps ?? []).map((s) => s.text),
    alternates: routes.slice(1),
    mechanism_used: 'graphhopper',
  }
}

export async function eta(origin: LatLon, destination: LatLon, profile: RouterMode): Promise<{ duration_s: number; distance_m: number; mechanism_used: string }> {
  const resp = await route({ origin, destination, waypoints: [], profile, alternates: 0, avoid: { highways: false, tolls: false, ferries: false } })
  const primary = resp.routes[0]!
  return { duration_s: primary.duration_s, distance_m: primary.distance_m, mechanism_used: resp.mechanism_used }
}

// ── Online OSRM fallback (opt-in) ───────────────────────────────────────────────

const OSRM_PROFILE: Record<RouterMode, string> = {
  auto: 'driving', pedestrian: 'foot', hiking: 'foot', bicycle: 'bike', mtb: 'bike',
}

async function routeOnline(req: RouteRequest): Promise<RouteResponseWire> {
  const pts = [req.origin, ...req.waypoints, req.destination]
    .map((p) => `${p.lon},${p.lat}`)
    .join(';')
  const url = `https://router.project-osrm.org/route/v1/${OSRM_PROFILE[req.profile]}/${pts}?overview=full&geometries=polyline&steps=true&alternatives=${req.alternates > 0}`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new RouteUnavailableError('Online routing fallback is unreachable.')
  }
  if (!res.ok) throw new RouteUnavailableError(`Online routing error (${res.status}).`)
  const body = (await res.json()) as {
    routes?: { distance: number; duration: number; geometry: string; legs: { steps: { name: string; distance: number; duration: number; geometry: string; maneuver: { type: string } }[] }[] }[]
  }
  const osrmRoutes = body.routes ?? []
  if (osrmRoutes.length === 0) throw new RouteUnavailableError('No route found between these points.')
  const toWire = (r: typeof osrmRoutes[number]): RouteWire => ({
    duration_s: r.duration,
    distance_m: r.distance,
    geometry: r.geometry,
    profile: req.profile,
    legs: r.legs.map((leg) => ({
      steps: leg.steps.map((s) => ({
        text: s.name || s.maneuver.type,
        distance_m: s.distance,
        duration_s: s.duration,
        sign: 0,
        interval: [0, 0] as [number, number],
        street_name: s.name || null,
      })),
    })),
  })
  const wires = osrmRoutes.map(toWire)
  const primary = wires[0]!
  return {
    routes: [primary],
    instructions_text: primary.legs.flatMap((l) => l.steps.map((s) => s.text)),
    alternates: wires.slice(1),
    mechanism_used: 'osrm',
  }
}

export function isRoutingAvailable(): boolean {
  return isToolchainReady() || process.env.MAIPAI_ROUTER_ONLINE_FALLBACK === '1'
}
