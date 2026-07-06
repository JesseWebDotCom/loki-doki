// Chromium install check + repair for the install registry. Deliberately imports
// ONLY playwright + node builtins — NOT logger/download — so installRegistry can pull
// it in during early boot without triggering the logger↔download circular-init TDZ
// that render.ts (with its logger/dataDir imports) would.
//
// Chromium powers the Reader offline archive AND Canvas → PDF export. It was only ever
// lazy-installed before; registering it makes the setup wizard provision it and boot
// self-heal reconcile it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

// Keep Playwright's managed browsers under data/ (matches lib/bookmarks/render.ts). This MUST
// be set before chromium.executablePath() is first evaluated. This module runs the install
// CHECK and is loaded at boot by installRegistry - potentially BEFORE render.ts, which is the
// only other place that used to set this. If the env is still unset when the check runs,
// executablePath() resolves Playwright's default (~/.cache) location instead of ours, so
// isChromiumInstalled() falsely returns false even though Chromium is installed under data/ -
// which made the setup wizard's chromium-render job flakily report "Chromium install failed".
// Derived from process.cwd() (not the imported dataDir) to preserve this module's deliberate
// "only playwright + node builtins" rule that avoids the boot-time circular-init TDZ.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(process.cwd(), '..', 'data', 'bin', 'playwright')

/** Cheap sync check for the registry: is OUR managed Chromium on disk? A dev machine
 *  with only system Chrome reports false and would install managed Chromium on repair —
 *  fine for the appliance target, which has no system browser. */
export function isChromiumInstalled(): boolean {
  try { return existsSync(chromium.executablePath()) } catch { return false }
}

async function systemBrowserWorks(): Promise<boolean> {
  for (const channel of ['chrome', 'msedge'] as const) {
    // Short timeout: this probe runs inside the setup wizard's retry loop, and the
    // default 30s (per channel, per attempt) held the "Checking for a usable browser"
    // step for minutes when neither browser cooperated.
    try { const b = await chromium.launch({ channel, headless: true, timeout: 10_000 }); await b.close(); return true } catch { /* not this one */ }
  }
  return false
}

/** Ensure a usable browser exists, reporting status to the wizard/Admin progress UI.
 *  Prefers an already-present managed or system browser; else installs Playwright's
 *  managed Chromium (~150MB). Throws if none can be had. */
export async function installChromium(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  onStatus('Checking for a usable browser…')
  if (isChromiumInstalled()) { onStatus('Chromium ready'); return }
  if (await systemBrowserWorks()) { onStatus('Using system browser'); return }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  onStatus('Installing Chromium (~150MB)…')
  const errTail = await new Promise<string | null>((resolve) => {
    // `playwright install chromium` honors PLAYWRIGHT_BROWSERS_PATH from the env.
    const proc = spawn('bun', ['x', 'playwright', 'install', 'chromium'], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    proc.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 16_000) err = err.slice(-8_000) })
    signal?.addEventListener('abort', () => { try { proc.kill() } catch { /* already gone */ } })
    proc.on('exit', (code) => resolve(code === 0 ? null : (err.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`)))
    proc.on('error', (e) => resolve(e.message))
  })
  if (errTail !== null || !isChromiumInstalled()) throw new Error(`Chromium install failed${errTail ? `: ${errTail}` : ' (installer ok but browser missing at expected path)'}`)
  onStatus('Chromium ready')
}
