import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { imageLoras } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'

// Self-healing LoRA file resolution.
//
// The generation path used to silently drop any selected LoRA whose DB filePath
// no longer resolved on disk (renamed on re-download, moved data dir, version
// suffix change), while the UI still claimed it was "sent to model". This
// resolver is the single source of truth for "does this LoRA have a usable
// file": if the recorded path is stale it scans data/loras for an unambiguous
// match, repairs the DB row, and returns the healed path. Returns null only
// when the file is genuinely gone (caller should surface that, not hide it).

const LORA_EXTS = new Set(['.safetensors', '.ckpt', '.pt'])

function lorasDir() {
  return join(dataDir, 'loras')
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '')
}

export interface ResolvableLora {
  id: string
  name: string
  filePath: string
}

export async function resolveLoraFile(lora: ResolvableLora): Promise<string | null> {
  if (existsSync(lora.filePath)) return lora.filePath

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

  // Heal only on an unambiguous match. Guessing between two files could bind a
  // style to the wrong weights, which is worse than reporting it missing.
  if (matches.length !== 1) return null

  const healed = join(lorasDir(), matches[0])
  await db.update(imageLoras)
    .set({ filePath: healed, updatedAt: new Date() })
    .where(eq(imageLoras.id, lora.id))
  lora.filePath = healed
  logger.info(`[lora] auto-repaired file path for "${lora.name}" -> ${healed}`)
  return healed
}
