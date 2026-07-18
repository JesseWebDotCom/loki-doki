import { existsSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, basename, extname } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { imageLoras } from '@/db/schema'
import { dataDir, validateSafetensorsFile } from '@/lib/download'
import { venvPython } from '@/lib/comfyui'
import { logger } from '@/lib/logger'

// Self-healing LoRA file resolution.
//
// The generation path used to silently drop any selected LoRA whose DB filePath
// no longer resolved on disk (renamed on re-download, moved data dir, version
// suffix change), while the UI still claimed it was "sent to model". This
// resolver is the single source of truth for "does this LoRA have a usable
// file":
// - if the recorded path is stale it scans data/loras for an unambiguous
//   match and repairs the DB row
// - if the file is a .ckpt/.pt pickle (which the ComfyUI workflow cannot load,
//   LoraLoader names are hardcoded to .safetensors) it converts the file to
//   .safetensors using ComfyUI's own venv python
// Returns null only when the file is genuinely gone or unconvertible (callers
// should surface that, not hide it).

const LORA_EXTS = new Set(['.safetensors', '.ckpt', '.pt'])

function lorasDir() {
  return join(dataDir, 'loras')
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '')
}

// ── Pickle -> safetensors conversion ─────────────────────────────────────────
// ComfyUI's venv is guaranteed to ship torch and safetensors, so it does the
// conversion. weights_only=True keeps torch.load on the safe unpickler: a
// downloaded file can never execute code during conversion.

const CONVERT_PY = `
import sys, torch
from safetensors.torch import save_file
src, dst = sys.argv[1], sys.argv[2]
sd = torch.load(src, map_location="cpu", weights_only=True)
if isinstance(sd, dict) and isinstance(sd.get("state_dict"), dict):
    sd = sd["state_dict"]
tensors = {k: v.contiguous() for k, v in sd.items() if torch.is_tensor(v)}
if not tensors:
    raise SystemExit("no tensors found in checkpoint")
save_file(tensors, dst)
`

// Paths that failed conversion in this process, so a broken file doesn't
// respawn python on every /loras poll. A backend restart retries.
const convertFailed = new Set<string>()

export async function ensureLoraSafetensors(filePath: string): Promise<string | null> {
  if (filePath.toLowerCase().endsWith('.safetensors')) return filePath

  // A previous conversion (or a sibling upload) may already have produced it.
  const target = filePath.replace(/\.[^.]+$/, '.safetensors')
  if (existsSync(target) && await validateSafetensorsFile(target)) return target

  if (convertFailed.has(filePath)) return null
  const python = venvPython()
  if (!existsSync(python)) {
    // ComfyUI not installed yet; retry on a later call once it is.
    return null
  }

  const ok = await new Promise<boolean>(resolve => {
    const child = spawn(python, ['-c', CONVERT_PY, filePath, target], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', d => { stderr += String(d) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(false) }, 300_000)
    child.on('error', () => { clearTimeout(timer); resolve(false) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) logger.warn(`[lora] safetensors conversion failed for ${basename(filePath)}: ${stderr.slice(0, 400)}`)
      resolve(code === 0)
    })
  })

  if (!ok || !(await validateSafetensorsFile(target))) {
    try { await unlink(target) } catch { /* never written */ }
    convertFailed.add(filePath)
    return null
  }

  // The pickle original is redundant now; drop it to save disk.
  try { await unlink(filePath) } catch { /* non-fatal */ }
  logger.info(`[lora] converted ${basename(filePath)} to ${basename(target)}`)
  return target
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvableLora {
  id: string
  name: string
  filePath: string
}

export async function resolveLoraFile(lora: ResolvableLora): Promise<string | null> {
  let path: string | null = existsSync(lora.filePath) ? lora.filePath : null

  if (!path) {
    let entries: string[]
    try {
      entries = await readdir(lorasDir())
    } catch {
      return null
    }

    // Never steal a file that another catalog row already points at.
    const rows = await db.select({ id: imageLoras.id, filePath: imageLoras.filePath }).from(imageLoras)
    const claimed = new Set(rows.filter(r => r.id !== lora.id).map(r => r.filePath))

    const wantFile = normalizeName(basename(lora.filePath))
    const wantName = normalizeName(lora.name)
    const matches = entries.filter(f => {
      if (!LORA_EXTS.has(extname(f).toLowerCase())) return false
      if (claimed.has(join(lorasDir(), f))) return false
      const n = normalizeName(f)
      if (n === wantFile || (wantName.length >= 4 && n === wantName)) return true
      // Version-suffix drift (e.g. "mordecai_v123" vs "mordecai_v456" is NOT a
      // match, but "mordecai" vs "mordecai_v123" is): containment, gated on a
      // reasonably long normalized name so short names can't fuzzy-match.
      return wantFile.length >= 8 && (n.includes(wantFile) || wantFile.includes(n))
    })

    // Heal only on an unambiguous match. Guessing between two files could bind
    // a style to the wrong weights, which is worse than reporting it missing.
    if (matches.length !== 1) return null
    path = join(lorasDir(), matches[0])
    logger.info(`[lora] auto-repaired file path for "${lora.name}" -> ${path}`)
  }

  const usable = await ensureLoraSafetensors(path)
  if (!usable) return null

  if (usable !== lora.filePath) {
    await db.update(imageLoras)
      .set({ filePath: usable, updatedAt: new Date() })
      .where(eq(imageLoras.id, lora.id))
    lora.filePath = usable
  }
  return usable
}
