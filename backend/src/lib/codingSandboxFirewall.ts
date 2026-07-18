// Opt-in network egress fence for the coding sandbox user (lokidoki-coding).
//
// The FS boundary (codingSandboxUser.ts) walls the sandbox off from this app's repo,
// DB, and secrets, but says nothing about the network: by default the sandbox user
// reaches the LAN and the internet like any other account. CODING-SANDBOX-DESIGN §7
// lists an egress fence as future work; this is it, kept deliberately SEPARATE from the
// mandatory sandbox setup so enabling it never disturbs an existing install and turning
// it off fully reverts.
//
// Two policies, both police ONLY the sandbox user (never the app's own traffic):
//   - 'lan-block' (default when enabled): allow loopback + the public internet, but deny
//     the private LAN (RFC1918 + link-local). Stops sandboxed code from poking at other
//     devices on the home network while still allowing package installs.
//   - 'deny-all' (strict): allow only loopback (the local coding engine on :11435) plus an
//     explicit allowlist; drop everything else. Best for local-only / offline coding.
//
// Platform support is honest, not pretended:
//   - Linux:   both policies, via an nftables table with owner (skuid) matching.
//   - Windows: 'lan-block' only, via per-user (SID) Windows Firewall block rules. A
//              per-user default-deny (needed for 'deny-all') is not expressible there.
//   - macOS:   unsupported (pf has no per-user matching; the sandbox there leans on the
//              FS boundary alone).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as dns } from 'node:dns'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { SANDBOX_USER } from '@/lib/codingSandboxUser'
import { IS_LINUX, IS_WIN, IS_MAC } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

export type EgressFenceMode = 'lan-block' | 'deny-all'

export interface EgressFenceConfig {
  enabled: boolean
  mode: EgressFenceMode
  /** Extra CIDRs/IPs/hostnames the sandbox may reach in 'deny-all'. Loopback is always allowed. */
  allowlist: string[]
}

const CONFIG_KEY = 'coding.egress_fence'
const NFT_TABLE = 'lokidoki_coding'
const WIN_RULE_GROUP = 'lokidoki-coding'

// RFC1918 + link-local, the "home LAN" the sandbox should not be able to reach.
const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']
const PRIVATE_V6 = ['fc00::/7', 'fe80::/10']

export const DEFAULT_EGRESS_FENCE_CONFIG: EgressFenceConfig = {
  enabled: false,
  mode: 'lan-block',
  allowlist: [],
}

export async function getEgressFenceConfig(): Promise<EgressFenceConfig> {
  const stored = (await getAppSetting(CONFIG_KEY)) as Partial<EgressFenceConfig> | null
  return { ...DEFAULT_EGRESS_FENCE_CONFIG, ...(stored ?? {}) }
}

export async function setEgressFenceConfig(cfg: EgressFenceConfig): Promise<void> {
  await setAppSetting(CONFIG_KEY, cfg)
}

export interface PlatformSupport {
  supported: boolean
  modes: EgressFenceMode[]
  reason?: string
}

export function fencePlatformSupport(): PlatformSupport {
  if (IS_LINUX) return { supported: true, modes: ['lan-block', 'deny-all'] }
  if (IS_WIN) return { supported: true, modes: ['lan-block'], reason: "'deny-all' needs a per-user default-deny, which Windows Firewall cannot express." }
  if (IS_MAC) return { supported: false, modes: [], reason: 'macOS pf has no per-user matching; the sandbox relies on its filesystem boundary here.' }
  return { supported: false, modes: [], reason: 'Unsupported platform.' }
}

// ── Identity lookup ─────────────────────────────────────────────────────────────

async function sandboxUid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('id', ['-u', SANDBOX_USER])
    const uid = stdout.trim()
    return /^\d+$/.test(uid) ? uid : null
  } catch {
    return null
  }
}

async function sandboxSid(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-LocalUser -Name '${SANDBOX_USER}').SID.Value`,
    ])
    const sid = stdout.trim()
    return /^S-1-/.test(sid) ? sid : null
  } catch {
    return null
  }
}

// ── Rule generation ─────────────────────────────────────────────────────────────

/** Resolve allowlist entries to v4/v6 CIDR literals nftables accepts. CIDRs/IPs pass
 *  through; bare hostnames are resolved best-effort (a local hub's allowlist is small
 *  and stable, and loopback - the one that must work - never needs DNS). */
async function resolveAllowlist(entries: string[]): Promise<{ v4: string[]; v6: string[] }> {
  const v4: string[] = []
  const v6: string[] = []
  for (const raw of entries) {
    const e = raw.trim()
    if (!e) continue
    if (/^[0-9.]+(\/\d{1,2})?$/.test(e)) { v4.push(e.includes('/') ? e : `${e}/32`); continue }
    if (/:/.test(e) && /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(e)) { v6.push(e.includes('/') ? e : `${e}/128`); continue }
    try {
      const addrs = await dns.lookup(e, { all: true })
      for (const a of addrs) (a.family === 6 ? v6 : v4).push(a.family === 6 ? `${a.address}/128` : `${a.address}/32`)
    } catch {
      logger.warn(`[coding-fence] could not resolve allowlist entry "${e}"; skipping`)
    }
  }
  return { v4, v6 }
}

async function buildNftRuleset(cfg: EgressFenceConfig, uid: string): Promise<string> {
  const lines: string[] = []
  lines.push(`table inet ${NFT_TABLE} {`)
  lines.push('  chain output {')
  lines.push('    type filter hook output priority 0; policy accept;')
  // Only police the sandbox user; everyone else (the app included) is untouched.
  lines.push(`    meta skuid != ${uid} accept`)
  // Loopback is always allowed - the local coding engine lives on 127.0.0.1:11435.
  lines.push('    oif "lo" accept')
  lines.push('    ip daddr 127.0.0.0/8 accept')
  lines.push('    ip6 daddr ::1 accept')
  if (cfg.mode === 'lan-block') {
    lines.push(`    ip daddr { ${PRIVATE_V4.join(', ')} } drop`)
    lines.push(`    ip6 daddr { ${PRIVATE_V6.join(', ')} } drop`)
  } else {
    const { v4, v6 } = await resolveAllowlist(cfg.allowlist)
    if (v4.length) lines.push(`    ip daddr { ${v4.join(', ')} } accept`)
    if (v6.length) lines.push(`    ip6 daddr { ${v6.join(', ')} } accept`)
    // DNS is needed even in deny-all so allowlisted names keep resolving.
    lines.push('    udp dport 53 accept')
    lines.push('    tcp dport 53 accept')
    lines.push('    drop')
  }
  lines.push('  }')
  lines.push('}')
  return lines.join('\n') + '\n'
}

// ── Privileged execution ────────────────────────────────────────────────────────

/** Run a privileged command: try directly (root), then non-interactive sudo. Returns
 *  ok=false with needsPrivilege when neither works, so the caller can surface the exact
 *  command for an admin to run by hand rather than silently doing nothing. */
async function runPrivileged(cmd: string, args: string[], stdin?: string): Promise<{ ok: boolean; error?: string; needsPrivilege?: boolean }> {
  const attempt = (c: string, a: string[]) => new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = execFile(c, a, { timeout: 15_000 }, (err, _out, stderr) => {
      resolve(err ? { ok: false, error: (stderr || err.message || '').trim() } : { ok: true })
    })
    if (stdin && child.stdin) { child.stdin.write(stdin); child.stdin.end() }
  })

  const direct = await attempt(cmd, args)
  if (direct.ok) return { ok: true }
  const viaSudo = await attempt('sudo', ['-n', cmd, ...args])
  if (viaSudo.ok) return { ok: true }
  return { ok: false, error: direct.error, needsPrivilege: true }
}

// ── Public actions ──────────────────────────────────────────────────────────────

export interface FencePlan {
  supported: boolean
  reason?: string
  /** Human-inspectable commands that apply the fence (shown before anyone elevates). */
  commands: string[]
}

/** Dry run: the exact privileged commands that applying this config would execute. */
export async function planEgressFence(cfg: EgressFenceConfig): Promise<FencePlan> {
  const support = fencePlatformSupport()
  if (!support.supported) return { supported: false, reason: support.reason, commands: [] }
  if (!support.modes.includes(cfg.mode)) return { supported: false, reason: support.reason, commands: [] }

  if (IS_LINUX) {
    const uid = await sandboxUid()
    if (!uid) return { supported: false, reason: `Sandbox user ${SANDBOX_USER} is not installed.`, commands: [] }
    const ruleset = await buildNftRuleset(cfg, uid)
    return {
      supported: true,
      commands: [`nft delete table inet ${NFT_TABLE}   # (ignored if absent)`, `nft -f - <<'EOF'\n${ruleset}EOF`],
    }
  }
  // Windows lan-block
  const sid = await sandboxSid()
  if (!sid) return { supported: false, reason: `Sandbox user ${SANDBOX_USER} is not installed.`, commands: [] }
  const ranges = [...PRIVATE_V4, ...PRIVATE_V6].join("','")
  return {
    supported: true,
    commands: [
      `Remove-NetFirewallRule -Group '${WIN_RULE_GROUP}' -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName 'lokidoki-coding LAN block' -Group '${WIN_RULE_GROUP}' ` +
        `-Direction Outbound -Action Block -LocalUser 'D:(A;;CC;;;${sid})' -RemoteAddress @('${ranges}')`,
    ],
  }
}

export interface FenceResult {
  ok: boolean
  error?: string
  needsPrivilege?: boolean
  /** The commands to run manually when auto-apply lacked privilege. */
  manualCommands?: string[]
}

/** Apply the fence for `cfg`. Idempotent: any prior fence is torn down first. */
export async function applyEgressFence(cfg: EgressFenceConfig): Promise<FenceResult> {
  const plan = await planEgressFence(cfg)
  if (!plan.supported) return { ok: false, error: plan.reason ?? 'Unsupported.' }

  if (IS_LINUX) {
    const uid = await sandboxUid()
    if (!uid) return { ok: false, error: `Sandbox user ${SANDBOX_USER} is not installed.` }
    // Tear down any prior table (ignore "does not exist"), then load fresh from stdin.
    await runPrivileged('nft', ['delete', 'table', 'inet', NFT_TABLE]).catch(() => {})
    const ruleset = await buildNftRuleset(cfg, uid)
    const res = await runPrivileged('nft', ['-f', '-'], ruleset)
    if (!res.ok) return { ok: false, error: res.error, needsPrivilege: res.needsPrivilege, manualCommands: plan.commands }
    logger.info(`[coding-fence] applied ${cfg.mode} egress fence for ${SANDBOX_USER}`)
    return { ok: true }
  }

  // Windows
  const sid = await sandboxSid()
  if (!sid) return { ok: false, error: `Sandbox user ${SANDBOX_USER} is not installed.` }
  const ranges = [...PRIVATE_V4, ...PRIVATE_V6].map((r) => `'${r}'`).join(',')
  const ps =
    `Remove-NetFirewallRule -Group '${WIN_RULE_GROUP}' -ErrorAction SilentlyContinue; ` +
    `New-NetFirewallRule -DisplayName 'lokidoki-coding LAN block' -Group '${WIN_RULE_GROUP}' ` +
    `-Direction Outbound -Action Block -LocalUser 'D:(A;;CC;;;${sid})' -RemoteAddress @(${ranges}) | Out-Null`
  const res = await runPrivileged('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
  if (!res.ok) return { ok: false, error: res.error, needsPrivilege: res.needsPrivilege, manualCommands: plan.commands }
  logger.info(`[coding-fence] applied lan-block egress fence for ${SANDBOX_USER}`)
  return { ok: true }
}

/** Remove the fence entirely (revert to unrestricted egress). */
export async function removeEgressFence(): Promise<FenceResult> {
  if (IS_LINUX) {
    const res = await runPrivileged('nft', ['delete', 'table', 'inet', NFT_TABLE])
    // "No such file or directory" just means it was already absent - treat as success.
    if (!res.ok && !/does not exist|No such/i.test(res.error ?? '')) {
      return { ok: false, error: res.error, needsPrivilege: res.needsPrivilege }
    }
    return { ok: true }
  }
  if (IS_WIN) {
    const res = await runPrivileged('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Remove-NetFirewallRule -Group '${WIN_RULE_GROUP}' -ErrorAction SilentlyContinue`,
    ])
    return res.ok ? { ok: true } : { ok: false, error: res.error, needsPrivilege: res.needsPrivilege }
  }
  return { ok: true } // nothing was ever applied on macOS
}

/** Whether a fence is currently installed at the OS level (independent of stored config). */
export async function egressFenceActive(): Promise<boolean> {
  try {
    if (IS_LINUX) {
      const { stdout } = await execFileAsync('nft', ['list', 'tables'])
      return stdout.includes(NFT_TABLE)
    }
    if (IS_WIN) {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-NetFirewallRule -Group '${WIN_RULE_GROUP}' -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ])
      return Number(stdout.trim()) > 0
    }
  } catch {
    return false
  }
  return false
}

/** Reconcile the OS fence to the stored config at boot (apply if enabled, remove if not). */
export async function reconcileEgressFence(): Promise<void> {
  const cfg = await getEgressFenceConfig()
  const support = fencePlatformSupport()
  if (!support.supported) return
  const active = await egressFenceActive()
  if (cfg.enabled && support.modes.includes(cfg.mode)) {
    // Re-apply on every boot so a rule flushed by a reboot (nftables is not persistent
    // by default) comes back.
    const res = await applyEgressFence(cfg)
    if (!res.ok) logger.warn(`[coding-fence] could not (re)apply fence on boot: ${res.error ?? 'unknown'}${res.needsPrivilege ? ' (needs privilege)' : ''}`)
  } else if (active) {
    await removeEgressFence()
  }
}
