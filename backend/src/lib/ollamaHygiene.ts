// Orphaned llama-server runner cleanup. Ollama's architecture: `ollama serve` spawns one
// `llama-server` child per loaded model and talks to it over localhost; the scheduler holds
// the runner handles in memory only. If the parent dies (crash, flat kill by command line -
// see killByCommandLine), the children are orphaned: nothing can ever reach them again, but
// they keep squatting their VRAM until killed. Observed live: ~12 orphans across both GPUs
// forcing every new model load onto the CPU (a 90-second "hi" in the Coding app).
//
// Sweep policy (deliberately conservative):
//   - Only processes NAMED llama-server whose ExecutablePath sits under an Ollama directory
//     (protects a user's own llama.cpp servers).
//   - Killed when the parent is dead, OR the parent PID was recycled by a non-ollama process
//     (PID-reuse hole: a dead parent's PID can be reassigned, making the orphan look parented).
//   - A live `ollama serve`'s runners are never touched - their parent is alive and ollama-named.
//
// Runs UNCONDITIONALLY (not gated on the remote-engine setting): orphans squat LOCAL VRAM
// regardless of which engine currently serves requests.

import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/** PIDs swept in the most recent sweep - surfaced by the admin LLM status census. */
let lastSweep: { at: number; pids: number[] } = { at: 0, pids: [] }
export function lastOrphanSweep(): { at: number; pids: number[] } {
  return lastSweep
}

// One CIM pass: index every process, pick llama-server runners under an ollama dir, kill the
// ones whose parent is dead or PID-recycled by a non-ollama process. Emits swept PIDs, one
// per line, so the TS side can count and log them.
const WIN_SWEEP_CMD = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$procs = Get-CimInstance Win32_Process',
  '$byPid = @{}',
  'foreach ($p in $procs) { $byPid[[uint32]$p.ProcessId] = $p }',
  `$runners = $procs | Where-Object { $_.Name -eq 'llama-server.exe' -and $_.ExecutablePath -like '*\\ollama\\*' }`,
  'foreach ($r in $runners) {',
  '  $parent = $byPid[[uint32]$r.ParentProcessId]',
  '  if ((-not $parent) -or ($parent.Name -notlike "ollama*")) {',
  '    Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue',
  '    Write-Output $r.ProcessId',
  '  }',
  '}',
].join('; ')

async function sweepWindows(): Promise<number[]> {
  const { stdout } = await execFileAsync(
    'powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_SWEEP_CMD],
    { timeout: 15_000, windowsHide: true },
  )
  return stdout.split('\n').map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n))
}

async function sweepPosix(): Promise<number[]> {
  // ps snapshot: pid, ppid, comm, full args. Runners are `llama-server` with an ollama path in
  // their args/executable; orphan test mirrors Windows (dead parent or non-ollama parent comm).
  const { stdout } = await execAsync('ps -eo pid=,ppid=,comm=,args=', { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
  interface Row { pid: number; ppid: number; comm: string; args: string }
  const rows: Row[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]!, args: m[4]! })
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const swept: number[] = []
  for (const r of rows) {
    if (!r.comm.includes('llama-server')) continue
    if (!r.args.includes('/ollama/')) continue
    const parent = byPid.get(r.ppid)
    const orphan = !parent || r.ppid <= 1 || !parent.comm.includes('ollama')
    if (!orphan) continue
    try { process.kill(r.pid, 'SIGKILL'); swept.push(r.pid) } catch { /* already gone */ }
  }
  return swept
}

/**
 * Kill orphaned llama-server runners (dead or PID-recycled parent). Safe to call anytime -
 * a live Ollama's runners are never matched. Returns the swept PIDs. Never throws.
 */
export async function sweepOrphanLlamaRunners(reason: string): Promise<number[]> {
  try {
    const pids = IS_WIN ? await sweepWindows() : await sweepPosix()
    if (pids.length > 0) {
      lastSweep = { at: Date.now(), pids }
      logger.warn(`[ollama-hygiene] swept ${pids.length} orphaned llama-server runner(s) (${reason}): PIDs ${pids.join(', ')}`)
    }
    return pids
  } catch (err) {
    logger.warn(`[ollama-hygiene] orphan sweep failed (${reason}): ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
