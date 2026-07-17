// Tailscale detection and control for Admin -> Server -> Remote Access.
//
// The app deliberately does NOT install or run the daemon itself: tailscaled is a
// system service that needs root to set up its tunnel device, and silently owning a
// VPN install is the wrong posture for a family hub. Instead this module finds an
// existing Tailscale CLI, reads its state, and drives login/up/down, and the admin
// UI walks the operator through the (one-time) install when nothing is found.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

export interface TailscalePeer {
  hostName: string
  dnsName: string | null
  os: string | null
  online: boolean
  ips: string[]
}

export interface TailscaleStatus {
  installed: boolean
  state: 'not-installed' | 'stopped' | 'needs-login' | 'starting' | 'running' | 'error'
  version: string | null
  authUrl: string | null
  hostName: string | null
  dnsName: string | null // MagicDNS name of this machine, trailing dot stripped
  ips: string[]
  tailnet: string | null
  peers: TailscalePeer[]
  error: string | null
}

const NOT_INSTALLED: TailscaleStatus = {
  installed: false, state: 'not-installed', version: null, authUrl: null,
  hostName: null, dnsName: null, ips: [], tailnet: null, peers: [], error: null,
}

function cliCandidates(): string[] {
  const fromPath = 'tailscale'
  if (process.platform === 'darwin') {
    return [fromPath, '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
  }
  if (process.platform === 'win32') {
    return [fromPath, 'C:\\Program Files\\Tailscale\\tailscale.exe']
  }
  return [fromPath, '/usr/bin/tailscale', '/usr/sbin/tailscale']
}

let cachedCli: string | null | undefined
let cachedVersion: string | null = null

/** Locate a working Tailscale CLI once per process; a miss is re-checked on every
 *  call so an install done while the server runs is picked up without a restart. */
async function findCli(): Promise<string | null> {
  if (cachedCli) return cachedCli
  for (const candidate of cliCandidates()) {
    try {
      const { stdout } = await execFileAsync(candidate, ['version'], { timeout: 5_000 })
      cachedCli = candidate
      cachedVersion = stdout.split('\n')[0]?.trim() || null
      return candidate
    } catch { /* try the next candidate */ }
  }
  return null
}

function stripDot(name: string | null | undefined): string | null {
  if (!name) return null
  return name.replace(/\.$/, '')
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const cli = await findCli()
  if (!cli) return NOT_INSTALLED
  try {
    const { stdout } = await execFileAsync(cli, ['status', '--json'], { timeout: 10_000 })
    const raw = JSON.parse(stdout) as {
      BackendState?: string
      AuthURL?: string
      MagicDNSSuffix?: string
      CurrentTailnet?: { Name?: string } | null
      Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean } | null
      Peer?: Record<string, { HostName?: string; DNSName?: string; OS?: string; Online?: boolean; TailscaleIPs?: string[] }> | null
    }
    const backend = raw.BackendState ?? 'NoState'
    const state: TailscaleStatus['state'] =
      backend === 'Running' ? 'running'
      : backend === 'NeedsLogin' || backend === 'NeedsMachineAuth' ? 'needs-login'
      : backend === 'Starting' ? 'starting'
      : 'stopped'
    return {
      installed: true,
      state,
      version: cachedVersion,
      authUrl: raw.AuthURL || null,
      hostName: raw.Self?.HostName ?? null,
      dnsName: stripDot(raw.Self?.DNSName),
      ips: raw.Self?.TailscaleIPs ?? [],
      tailnet: raw.CurrentTailnet?.Name ?? null,
      peers: Object.values(raw.Peer ?? {}).map((p) => ({
        hostName: p.HostName ?? 'unknown',
        dnsName: stripDot(p.DNSName),
        os: p.OS ?? null,
        online: p.Online === true,
        ips: p.TailscaleIPs ?? [],
      })).sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName)),
      error: null,
    }
  } catch (err) {
    // The CLI exists but the daemon is unreachable (not running / no permission).
    return {
      ...NOT_INSTALLED,
      installed: true,
      state: 'error',
      version: cachedVersion,
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    }
  }
}

/** Bring the tunnel up. When the node was never logged in, `tailscale up` blocks
 *  printing an auth URL, so it is spawned detached and the status is polled for
 *  either the URL (returned for the QR code) or the running state. */
export async function tailscaleUp(): Promise<TailscaleStatus> {
  const cli = await findCli()
  if (!cli) return NOT_INSTALLED
  try {
    const child = spawn(cli, ['up'], { stdio: 'ignore', detached: true })
    child.unref()
    child.on('error', (err) => logger.warn(`[tailscale] up failed to spawn: ${err.message}`))
  } catch (err) {
    logger.warn(`[tailscale] up failed: ${err instanceof Error ? err.message : err}`)
  }
  // Poll briefly: a logged-in node flips to Running almost immediately; a fresh
  // one publishes AuthURL within a couple of seconds.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 700))
    const status = await getTailscaleStatus()
    if (status.state === 'running' || status.authUrl) return status
  }
  return getTailscaleStatus()
}

export async function tailscaleDown(): Promise<TailscaleStatus> {
  const cli = await findCli()
  if (!cli) return NOT_INSTALLED
  try {
    await execFileAsync(cli, ['down'], { timeout: 15_000 })
  } catch (err) {
    logger.warn(`[tailscale] down failed: ${err instanceof Error ? err.message : err}`)
  }
  return getTailscaleStatus()
}
