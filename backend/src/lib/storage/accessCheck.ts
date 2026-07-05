import { writeFile, readFile, rename, unlink, mkdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'

export interface AccessCheckResult {
  ok: boolean
  checks: { read: boolean; write: boolean; rename: boolean; delete: boolean }
  error: string | null
  freeBytes: number | null
  freeFormatted: string | null
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}

/** Free bytes at a path, falling back to `df` on platforms without statfs. */
export async function freeBytesAt(path: string): Promise<number | null> {
  try {
    const s = await statfs(path)
    return s.bfree * s.bsize
  } catch {
    try {
      const { execFileSync } = await import('node:child_process')
      // argv form — never interpolate the path into a shell string.
      const out = execFileSync('df', ['-Pk', path], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      const lastLine = out.split('\n').pop() ?? ''
      const avail = parseInt(lastLine.split(/\s+/)[3] ?? '0', 10)
      return isNaN(avail) ? null : avail * 1024
    } catch {
      return null
    }
  }
}

/**
 * Write+read+rename+delete probe against a directory (created if missing). Shared by
 * adminStorage.ts (single data root migration) and adminStorageLocations.ts (arbitrary
 * per-content-type storage locations, incl. network/UNC paths) — same underlying check,
 * different framing on top (the data-root route additionally compares against current
 * usage to warn on insufficient space).
 */
export async function checkDirectoryAccess(candidatePath: string): Promise<AccessCheckResult> {
  const checks = { read: false, write: false, rename: false, delete: false }
  let errorMsg: string | null = null
  const tmpFile = join(candidatePath, `.loki-access-check-${Date.now()}`)
  const tmpRenamed = join(candidatePath, `.loki-access-renamed-${Date.now()}`)

  try {
    await mkdir(candidatePath, { recursive: true })
    await writeFile(tmpFile, 'ok')
    checks.write = true
    await readFile(tmpFile)
    checks.read = true
    await rename(tmpFile, tmpRenamed)
    checks.rename = true
    await unlink(tmpRenamed)
    checks.delete = true
  } catch (err: any) {
    errorMsg = err?.message ?? 'Access check failed'
    try { await unlink(tmpFile) } catch { /* ignore */ }
    try { await unlink(tmpRenamed) } catch { /* ignore */ }
  }

  const freeBytes = await freeBytesAt(candidatePath)
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    error: errorMsg,
    freeBytes,
    freeFormatted: freeBytes != null ? formatBytes(freeBytes) : null,
  }
}
