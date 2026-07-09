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
// (analyze.py / library_analyze.py), never imported into app code — the same posture as
// the SearXNG sidecar. The music-intelligence classifier models (MTG discogs-effnet
// backbone + heads) are CC BY-NC-SA 4.0 — recorded in NOTICE at the repo root.

import { join, dirname } from 'node:path'
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
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
// The content is VERSIONED: bumping MARKER_VERSION makes existing installs read as
// not-installed, so boot reconcile upgrades them in place (v1 → v2 swapped plain
// essentia for essentia-tensorflow, which adds the ML classifier runtime).
const MARKER = join(STEM_VENV, '.stem-audio-ready')
const MARKER_VERSION = 'v2:essentia-tensorflow'
// Markers this build considers a healthy stem-audio install. The lyric-alignment MODEL is
// intentionally NOT gated on this marker — it downloads lazily inside the first align job (its
// own background progress), so adding it never invalidates the 2.5 GB Demucs+Essentia install
// or triggers the "restore missing components" prompt. 'v3:mms-fa-align' is an older build that
// bundled the model into this marker; accept it too so those installs don't re-prompt.
const ACCEPTED_MARKERS = ['v2:essentia-tensorflow', 'v3:mms-fa-align']

// torch.hub cache for the MMS forced-alignment model (torchaudio.pipelines.MMS_FA). Kept under
// data/ (not ~/.cache) so it's contained. The align job pre-checks + lazily downloads it.
export const TORCH_HOME = join(dataDir, 'torch')
export const ALIGN_MODEL_PATH = join(TORCH_HOME, 'hub', 'checkpoints', 'model.pt')

// ── Music-intelligence models (discogs-effnet backbone + classifier heads) ─────────
// ~27 MB total from essentia.upf.edu. The backbone yields a 1280-d embedding per patch;
// the heads score genre/mood/danceability/etc. off that embedding. CC BY-NC-SA 4.0.
export const MUSIC_INTEL_DIR = join(dataDir, 'music-intel-models')
/** Stamped into music_track_features rows; bump to force re-analysis on model swaps. */
export const INTEL_MODEL_VERSION = 'discogs-effnet-1'
const INTEL_BASE = 'https://essentia.upf.edu/models'
export const MUSIC_INTEL_MODELS: readonly { file: string; url: string }[] = [
  { file: 'discogs-effnet-bs64-1.pb', url: `${INTEL_BASE}/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb` },
  { file: 'genre_discogs400-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb` },
  { file: 'genre_discogs400-discogs-effnet-1.json', url: `${INTEL_BASE}/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json` },
  { file: 'mtg_jamendo_moodtheme-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.pb` },
  { file: 'mtg_jamendo_moodtheme-discogs-effnet-1.json', url: `${INTEL_BASE}/classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.json` },
  { file: 'danceability-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/danceability/danceability-discogs-effnet-1.pb` },
  { file: 'mood_aggressive-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/mood_aggressive/mood_aggressive-discogs-effnet-1.pb` },
  { file: 'mood_happy-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/mood_happy/mood_happy-discogs-effnet-1.pb` },
  { file: 'mood_sad-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/mood_sad/mood_sad-discogs-effnet-1.pb` },
  { file: 'mood_relaxed-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/mood_relaxed/mood_relaxed-discogs-effnet-1.pb` },
  { file: 'mood_acoustic-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/mood_acoustic/mood_acoustic-discogs-effnet-1.pb` },
  { file: 'approachability_regression-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/approachability/approachability_regression-discogs-effnet-1.pb` },
  { file: 'engagement_regression-discogs-effnet-1.pb', url: `${INTEL_BASE}/classification-heads/engagement/engagement_regression-discogs-effnet-1.pb` },
]
export function intelModelPath(file: string): string { return join(MUSIC_INTEL_DIR, file) }
/** Music-intelligence gate: v2 runtime + every classifier model on disk. Feature tiers
 *  (similar-sounding stations, Discovery rail, mood seeds) contribute 0 when false. */
export function isMusicIntelReady(): boolean {
  return isStemAudioInstalled() && MUSIC_INTEL_MODELS.every(m => existsSync(intelModelPath(m.file)))
}

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
export const LIBRARY_ANALYZE_SCRIPT = join(HERE, 'library_analyze.py')
export const ALIGN_SCRIPT = join(HERE, 'align.py')

function venvBin(name: string): string {
  return IS_WIN ? join(STEM_VENV, 'Scripts', `${name}.exe`) : join(STEM_VENV, 'bin', name)
}

/** Path to the venv's python — exposed for the install registry's functional probe. */
export function stemVenvPython(): string {
  return venvBin('python')
}

export function isStemAudioInstalled(): boolean {
  if (!existsSync(venvBin('python')) || !existsSync(MARKER)) return false
  // Pre-v2 markers hold a bare timestamp — treat as not-installed so boot reconcile
  // upgrades the venv (essentia → essentia-tensorflow) without user action. Any accepted
  // marker (v2, or the older v3 that also bundled the align model) counts as installed.
  try { const m = readFileSync(MARKER, 'utf8'); return ACCEPTED_MARKERS.some((v) => m.startsWith(v)) } catch { return false }
}

/** Whether the MMS forced-alignment model weights are on disk. Independent of the stem-audio
 *  marker so it never affects the Studio-runtime install/restore prompts. */
export function isLyricAlignModelReady(): boolean {
  return existsSync(ALIGN_MODEL_PATH)
}

/** Lazily fetch the MMS_FA lyric-alignment model (~1.2 GB) into TORCH_HOME via the stem venv.
 *  Called by the align job on first use — no boot-repair prompt, no admin gate. Idempotent
 *  (torch.hub skips a cached model). Requires the stem-audio venv (torch/torchaudio) to exist. */
export async function ensureLyricAlignModel(onStatus: StatusFn = () => {}, signal?: AbortSignal): Promise<void> {
  if (isLyricAlignModelReady()) return
  if (!existsSync(venvBin('python'))) throw new Error('stem-audio runtime not installed')
  onStatus('Downloading lyric-alignment model…')
  mkdirSync(TORCH_HOME, { recursive: true })
  await run(venvBin('python'), ['-c', 'import torchaudio; torchaudio.pipelines.MMS_FA.get_model(); torchaudio.pipelines.MMS_FA.get_aligner()'],
    { signal, onStatus, timeoutMs: 30 * 60_000, env: { ...process.env, TORCH_HOME } })
}

// ── install / repair (dispatched from installRegistry) ──────────────────────────

type StatusFn = (msg: string) => void

/** Spawn a child, streaming its last stdout/stderr line as coarse status; rejects on
 *  non-zero exit or abort. Mirrors the run() helper in lib/searxng.ts. */
function run(cmd: string, args: string[], opts: { signal?: AbortSignal; onStatus?: StatusFn; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

  // Plain `essentia` (v1 installs) and `essentia-tensorflow` ship the SAME import name —
  // installing one over the other leaves a mixed site-packages. Remove the plain build
  // first (no-op on fresh venvs), then install the tensorflow variant.
  onStatus('Removing plain Essentia (superseded by essentia-tensorflow)…')
  await run(venvBin('python'), ['-m', 'pip', 'uninstall', '-y', 'essentia'], { signal, onStatus }).catch(() => { /* not installed */ })

  // Demucs pulls torch + torchaudio; lameenc gives it MP3 output; essentia-tensorflow does
  // the tempo/key/chord analysis PLUS the ML classifiers (genre/mood embeddings) behind
  // the music-intelligence features. One install so pip resolves numpy across all of them.
  // (~10 min the first time — torch wheels dominate.)
  onStatus('Installing Demucs + Essentia-TensorFlow (this can take several minutes)…')
  await run(venvBin('python'), ['-m', 'pip', 'install', 'demucs', 'lameenc', 'soundfile', 'essentia-tensorflow'], { signal, onStatus, timeoutMs: 30 * 60_000 })

  // The classifier import is the functional probe for the swap: it fails if pip resolved
  // a broken numpy/TF combination, and failing HERE keeps the old marker (retry next boot).
  onStatus('Verifying the analysis runtime…')
  await run(venvBin('python'), ['-c', 'from essentia.standard import TensorflowPredictEffnetDiscogs, RhythmExtractor2013'], { signal, onStatus, timeoutMs: 5 * 60_000 })

  // Pre-fetch the default 4-stem model so the first "Generate AI Stems" isn't a silent
  // ~80 MB download. htdemucs_6s downloads lazily on first 6-stem use.
  onStatus('Downloading htdemucs model…')
  await run(venvBin('python'), ['-c', "from demucs.pretrained import get_model; get_model('htdemucs')"], { signal, onStatus, timeoutMs: 15 * 60_000 })

  // Music-intelligence classifier models (~27 MB). Skips files already on disk.
  mkdirSync(MUSIC_INTEL_DIR, { recursive: true })
  for (const m of MUSIC_INTEL_MODELS) {
    if (existsSync(intelModelPath(m.file))) continue
    onStatus(`Downloading ${m.file}…`)
    await downloadUrl(m.url, intelModelPath(m.file), () => {}, signal, { minBytes: 1_000 })
  }

  // NOTE: the lyric-alignment model is NOT downloaded here — it's fetched lazily by the first
  // align job (ensureLyricAlignModel), so it never bloats this install or trips the restore prompt.

  try { mkdirSync(dirname(MARKER), { recursive: true }); writeFileSync(MARKER, `${MARKER_VERSION} ${new Date().toISOString()}`) } catch { /* non-fatal */ }
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
