// Chromium install check + repair for the install registry. Deliberately imports
// ONLY playwright + node builtins — NOT logger/download — so installRegistry can pull
// it in during early boot without triggering the logger↔download circular-init TDZ
// that render.ts (with its logger/dataDir imports) would.
//
// Chromium powers the Reader offline archive AND Canvas → PDF export. It was only ever
// lazy-installed before; registering it makes the setup wizard provision it and boot
// self-heal reconcile it.

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

/** Cheap sync check for the registry: is OUR managed Chromium on disk? A dev machine
 *  with only system Chrome reports false and would install managed Chromium on repair —
 *  fine for the appliance target, which has no system browser. */
export function isChromiumInstalled(): boolean {
  try { return existsSync(chromium.executablePath()) } catch { return false }
}

async function systemBrowserWorks(): Promise<boolean> {
  for (const channel of ['chrome', 'msedge'] as const) {
    try { const b = await chromium.launch({ channel, headless: true }); await b.close(); return true } catch { /* not this one */ }
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
  const ok = await new Promise<boolean>((resolve) => {
    // `playwright install chromium` honors PLAYWRIGHT_BROWSERS_PATH from the env.
    const proc = spawn('bun', ['x', 'playwright', 'install', 'chromium'], { env: process.env, stdio: 'ignore' })
    signal?.addEventListener('abort', () => { try { proc.kill() } catch { /* already gone */ } })
    proc.on('exit', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
  if (!ok || !isChromiumInstalled()) throw new Error('Chromium install failed')
  onStatus('Chromium ready')
}
