// Music Studio Python runtime — the ML backend for stem separation (Demucs) and
// audio analysis (Essentia: tempo/beats/key/chords).
//
// One dedicated venv under data/stem-audio-venv, seeded by lib/python.ensurePython
// (the same relocatable interpreter ComfyUI/SearXNG use). Unlike SearXNG this is NOT a
// long-lived server — the two jobs spawn a one-shot `python analyze.py` / `python -m
// demucs` per track (see analyzeJob.ts / separateJob.ts). Install/repair is wired
// through lib/installRegistry as the `stem-audio` component so boot reconcile heals it.
//
// LICENSING: Essentia is AGPL-3.0. It is only ever invoked as an arm's-length subprocess
// (analyze.py), never imported into app code — the same posture as the SearXNG sidecar.

import { join, dirname } from 'node:path'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { ensurePython } from '@/lib/python'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

export const STEM_VENV = join(dataDir, 'stem-audio-venv')
// Written once the pip install + model warm both succeed, so isInstalled() can't be
// fooled by a half-built venv (a crash mid-pip leaves the interpreter but no packages).
const MARKER = join(STEM_VENV, '.stem-audio-ready')

// RoFormer guitar model (becruily) — a better guitar stem than Demucs. Kept in its OWN venv
// so its deps can't conflict with Demucs/Essentia, and treated as OPTIONAL: the Studio falls
// back to Demucs' guitar when it's absent.
export const ROFORMER_VENV = join(dataDir, 'stem-roformer-venv')
const ROFORMER_DIR = join(dataDir, 'stem-roformer')
export const ROFORMER_CKPT = join(ROFORMER_DIR, 'becruily_guitar.ckpt')
export const ROFORMER_CONFIG = join(ROFORMER_DIR, 'config_guitar_becruily.yaml')
const ROFORMER_CKPT_URL = 'https://huggingface.co/becruily/mel-band-roformer-guitar/resolve/main/becruily_guitar.ckpt'
const ROFORMER_CONFIG_URL = 'https://huggingface.co/becruily/mel-band-roformer-guitar/resolve/main/config_guitar_becruily.yaml'

function roformerVenvBin(name: string): string {
  return IS_WIN ? join(ROFORMER_VENV, 'Scripts', `${name}.exe`) : join(ROFORMER_VENV, 'bin', name)
}
/** Console script that runs Mel-Band RoFormer inference. */
export function roformerInferBin(): string { return roformerVenvBin('melband-roformer-infer') }
/** Venv python — exposed for the install registry's functional probe. */
export function roformerVenvPython(): string { return roformerVenvBin('python') }
export function isRoformerGuitarInstalled(): boolean {
  return existsSync(ROFORMER_CKPT) && existsSync(ROFORMER_CONFIG) && existsSync(roformerVenvBin('python'))
}

// The Python entry scripts live beside this module (committed to the repo). fileURLToPath
// resolves them whether the backend runs from src/ (bun --hot) or a bundled dir.
const HERE = dirname(fileURLToPath(import.meta.url))
export const ANALYZE_SCRIPT = join(HERE, 'analyze.py')

function venvBin(name: string): string {
  return IS_WIN ? join(STEM_VENV, 'Scripts', `${name}.exe`) : join(STEM_VENV, 'bin', name)
}

/** Path to the venv's python — exposed for the install registry's functional probe. */
export function stemVenvPython(): string {
  return venvBin('python')
}

export function isStemAudioInstalled(): boolean {
  return existsSync(venvBin('python')) && existsSync(MARKER)
}

// ── install / repair (dispatched from installRegistry) ──────────────────────────

type StatusFn = (msg: string) => void

/** Spawn a child, streaming its last stdout/stderr line as coarse status; rejects on
 *  non-zero exit or abort. Mirrors the run() helper in lib/searxng.ts. */
function run(cmd: string, args: string[], opts: { signal?: AbortSignal; onStatus?: StatusFn; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* dead */ } }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL') } catch { /* dead */ } }, opts.timeoutMs) : null
    let lastErr = ''
    const onData = (b: Buffer) => { const s = b.toString().trim(); if (s) { lastErr = s.split('\n').pop() ?? lastErr; opts.onStatus?.(lastErr) } }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); reject(err) })
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('aborted'))
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] ?? ''} exited ${code}: ${lastErr}`))
    })
  })
}

/**
 * Install (or repair) the stem-audio runtime: resolve a Python ≥3.10, build a venv,
 * pip-install Demucs + Essentia, and pre-download the default htdemucs weights so the
 * first separation doesn't stall on a model fetch. Idempotent; streams coarse status.
 */
export async function installStemAudio(onStatus: StatusFn = () => {}, signal?: AbortSignal): Promise<void> {
  onStatus('Resolving Python ≥3.10…')
  const python = await ensurePython()
  if (!python) throw new Error('no suitable Python (≥3.10) could be resolved')

  // A venv that survived on disk but whose base interpreter was moved/wiped executes
  // nothing — rebuild rather than trust existsSync (mirrors installSearXNG).
  if (existsSync(venvBin('python'))) {
    const ok = await execFileAsync(venvBin('python'), ['--version'], { timeout: 10_000, windowsHide: true })
      .then(() => true).catch(() => false)
    if (!ok) {
      onStatus('Existing virtualenv is broken — rebuilding…')
      const { rmSync } = await import('node:fs')
      rmSync(STEM_VENV, { recursive: true, force: true })
    }
  }
  if (!existsSync(venvBin('python'))) {
    onStatus('Creating Python virtualenv…')
    await run(python, ['-m', 'venv', STEM_VENV], { signal, onStatus })
  }

  onStatus('Upgrading pip…')
  await run(venvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], { signal, onStatus })

  // Demucs pulls torch + torchaudio; lameenc gives it MP3 output; essentia does the
  // tempo/key/chord analysis. One install so pip resolves numpy across all of them.
  // (~10 min the first time — torch wheels dominate.)
  onStatus('Installing Demucs + Essentia (this can take several minutes)…')
  await run(venvBin('python'), ['-m', 'pip', 'install', 'demucs', 'lameenc', 'soundfile', 'essentia'], { signal, onStatus, timeoutMs: 30 * 60_000 })

  // Pre-fetch the default 4-stem model so the first "Generate AI Stems" isn't a silent
  // ~80 MB download. htdemucs_6s downloads lazily on first 6-stem use.
  onStatus('Downloading htdemucs model…')
  await run(venvBin('python'), ['-c', "from demucs.pretrained import get_model; get_model('htdemucs')"], { signal, onStatus, timeoutMs: 15 * 60_000 })

  try { mkdirSync(dirname(MARKER), { recursive: true }); writeFileSync(MARKER, new Date().toISOString()) } catch { /* non-fatal */ }
  onStatus('Stem audio runtime installed.')
  logger.info('[stem-audio] runtime installed')
}

/**
 * Install (or repair) the OPTIONAL RoFormer guitar model — a cleaner guitar stem than Demucs.
 * Its own isolated venv so its deps can't touch the Demucs/Essentia one. Registered as a
 * separate install component (`stem-roformer-guitar`) so it can be added to an existing
 * Studio install; the Studio falls back to Demucs' guitar whenever this isn't present.
 */
export async function installRoformerGuitar(onStatus: StatusFn = () => {}, signal?: AbortSignal): Promise<void> {
  onStatus('Resolving Python ≥3.10…')
  const python = await ensurePython()
  if (!python) throw new Error('no suitable Python (≥3.10) could be resolved')

  if (existsSync(roformerVenvBin('python'))) {
    const ok = await execFileAsync(roformerVenvBin('python'), ['--version'], { timeout: 10_000, windowsHide: true }).then(() => true).catch(() => false)
    if (!ok) { onStatus('Existing RoFormer venv is broken — rebuilding…'); const { rmSync } = await import('node:fs'); rmSync(ROFORMER_VENV, { recursive: true, force: true }) }
  }
  if (!existsSync(roformerVenvBin('python'))) {
    onStatus('Creating RoFormer virtualenv…')
    await run(python, ['-m', 'venv', ROFORMER_VENV], { signal, onStatus })
  }
  onStatus('Upgrading pip…')
  await run(roformerVenvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], { signal, onStatus })
  onStatus('Installing RoFormer inference (this can take several minutes)…')
  await run(roformerVenvBin('python'), ['-m', 'pip', 'install', 'melband-roformer-infer'], { signal, onStatus, timeoutMs: 30 * 60_000 })
  mkdirSync(ROFORMER_DIR, { recursive: true })
  if (!existsSync(ROFORMER_CKPT)) { onStatus('Downloading RoFormer guitar weights…'); await downloadUrl(ROFORMER_CKPT_URL, ROFORMER_CKPT, () => {}, signal, { minBytes: 1_000_000 }) }
  if (!existsSync(ROFORMER_CONFIG)) { onStatus('Downloading RoFormer guitar config…'); await downloadUrl(ROFORMER_CONFIG_URL, ROFORMER_CONFIG, () => {}, signal) }
  onStatus('RoFormer guitar model installed.')
  logger.info('[stem-audio] RoFormer guitar model installed')
}
