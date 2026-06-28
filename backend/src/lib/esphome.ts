// Managed ESPHome toolchain — the firmware builder/flasher behind the in-app
// "Add a device" flow for ESP32 voice satellites (Pods).
//
// Why a managed install: building/flashing firmware shouldn't ask the user to
// touch a terminal. ESPHome is a Python package, so — exactly like SearXNG and
// ComfyUI (lib/searxng.ts, lib/comfyui.ts) — we install it into a private venv
// (reusing lib/python.ensurePython) and drive its CLI on demand. Unlike those,
// ESPHome is NOT a long-running daemon: there's no port/health/PID, just a
// command we shell out to for `compile` (build) and `run --device` (USB flash).
//
// The heavy part is the first compile: ESPHome's PlatformIO backend downloads the
// ESP32 toolchain (~1 GB) once and caches it under ~/.platformio. We surface that
// as install progress so the first real flash isn't a multi-minute surprise.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { ensurePython } from '@/lib/python'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

export const ESPHOME_VENV = join(dataDir, 'esphome-venv')

export function esphomeVenvBin(name: string): string {
  return IS_WIN ? join(ESPHOME_VENV, 'Scripts', `${name}.exe`) : join(ESPHOME_VENV, 'bin', name)
}

/** ESPHome is installed when its venv python exists (we invoke `python -m esphome`). */
export function isESPHomeInstalled(): boolean {
  return existsSync(esphomeVenvBin('python')) && existsSync(esphomeVenvBin('esphome'))
}

// ── install state ────────────────────────────────────────────────────────────

export type ESPHomeState = 'idle' | 'installing' | 'ready' | 'failed'
const state = { current: 'idle' as ESPHomeState, error: '' }
export function getESPHomeState(): ESPHomeState { return state.current }
export function getESPHomeError(): string { return state.error }

// ── subprocess helper (line-streamed; mirrors searxng.run) ─────────────────────

export interface RunOpts {
  cwd?: string
  signal?: AbortSignal
  /** Called with every trimmed stdout/stderr line — feeds SSE log streams. */
  onLine?: (line: string) => void
  env?: Record<string, string>
  timeoutMs?: number
}

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // SIGTERM, then SIGKILL if it doesn't die. ESPHome/PlatformIO can ignore SIGTERM
    // (and keep child compilers alive), so without escalation an aborted/timed-out
    // build never fires 'exit' → this promise never settles → the caller's flash
    // stays "busy" forever (the wizard then 409s on every retry). SIGKILL guarantees
    // the process exits so the promise rejects and the busy flag clears.
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const terminate = () => {
      try { child.kill('SIGTERM') } catch { /* dead */ }
      if (!killTimer) killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* dead */ } }, 4000)
    }
    const onAbort = () => terminate()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    let timer: ReturnType<typeof setTimeout> | null = null
    if (opts.timeoutMs) timer = setTimeout(terminate, opts.timeoutMs)

    let lastErr = ''
    const onData = (b: Buffer) => {
      const text = b.toString()
      for (const line of text.split('\n')) {
        const s = line.trimEnd()
        if (!s) continue
        lastErr = s
        opts.onLine?.(s)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('exit', (code) => {
      cleanup()
      if (opts.signal?.aborted) return reject(new Error('aborted'))
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${lastErr}`))
    })
  })
}

/** Invoke the ESPHome CLI in the managed venv. */
export function runEsphome(args: string[], opts: RunOpts = {}): Promise<void> {
  return run(esphomeVenvBin('python'), ['-m', 'esphome', ...args], opts)
}

// ── install / repair (dispatched from installRegistry) ─────────────────────────

type StatusFn = (msg: string) => void

/**
 * Install (or repair) the ESPHome toolchain: resolve Python ≥3.10, build a venv,
 * and pip-install esphome. Idempotent — skips the venv if present. Streams coarse
 * status; throws on failure. Does NOT download the PlatformIO toolchain (that
 * happens on the first compile — see warmUpToolchain in lib/pod/firmware.ts).
 */
export async function installESPHome(onStatus: StatusFn = () => {}, signal?: AbortSignal): Promise<void> {
  state.current = 'installing'
  state.error = ''
  try {
    onStatus('Resolving Python ≥3.10…')
    const python = await ensurePython()
    if (!python) throw new Error('no suitable Python (≥3.10) could be resolved')

    if (!existsSync(esphomeVenvBin('python'))) {
      onStatus('Creating Python virtualenv…')
      await run(python, ['-m', 'venv', ESPHOME_VENV], { signal, onLine: onStatus })
    }

    onStatus('Upgrading pip…')
    await run(esphomeVenvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip'], { signal, onLine: onStatus })

    onStatus('Installing ESPHome (this can take a minute)…')
    await run(esphomeVenvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'esphome'], { signal, onLine: onStatus })

    onStatus('ESPHome installed.')
    state.current = 'ready'
  } catch (err) {
    const msg = `install failed: ${err instanceof Error ? err.message : String(err)}`
    state.current = 'failed'
    state.error = msg
    logger.warn(`[esphome] ${msg}`)
    throw err
  }
}

/** ESPHome version string (e.g. "2026.5.0"), or null if not installed/queryable. */
export async function esphomeVersion(): Promise<string | null> {
  if (!isESPHomeInstalled()) return null
  let out = ''
  try {
    await runEsphome(['version'], { onLine: (l) => { out += l + '\n' }, timeoutMs: 20_000 })
  } catch { return null }
  const m = out.match(/Version:\s*([\d.]+\S*)/i) ?? out.match(/([0-9]{4}\.[0-9]+\.[0-9]+\S*)/)
  return m ? m[1]! : null
}
