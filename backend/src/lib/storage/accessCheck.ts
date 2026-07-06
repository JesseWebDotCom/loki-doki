import { writeFile, readFile, rename, unlink, mkdir, statfs } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

const WINDOWS_ABSOLUTE_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/

/**
 * REJECTED (2026-07): this used to accept a Windows-style path even when the host process
 * is POSIX, reasoning that the real fs check below would fail cleanly if it didn't actually
 * work on this host. That assumption was wrong, and it was confirmed live in production, not
 * hypothetically: POSIX `fs` calls don't error on a backslash-UNC string, they silently
 * treat the WHOLE thing as one bizarre RELATIVE filename (no leading '/') and happily create
 * it wherever the process's cwd happens to be. "Test access" reported success — because it
 * genuinely could write/read/delete a file — while never touching the real network share at
 * all, leaving junk folders inside the app's own working directory instead. So the real gate
 * must be `node:path`'s own host-native `isAbsolute()` — see `crossPlatformPathHint()` below
 * for turning a same-shape-wrong-host rejection into a specific, actionable message instead
 * of a generic "must be absolute" one.
 */
function pathFlavor(p: string): 'windows' | 'posix' | null {
  if (WINDOWS_ABSOLUTE_RE.test(p)) return 'windows'
  if (p.startsWith('/')) return 'posix'
  return null
}

/** When `p` fails the real `isAbsolute()` gate, this explains WHY if it's recognizably an
 *  absolute path for the OTHER kind of OS — e.g. a Windows UNC path typed against a
 *  macOS/Linux backend. Returns null when there's nothing more specific to say (caller falls
 *  back to a generic "must be an absolute path" message). */
export function crossPlatformPathHint(p: string): string | null {
  const flavor = pathFlavor(p)
  if (!flavor || isAbsolute(p)) return null
  if (flavor === 'windows') {
    return 'This looks like a Windows path, but this backend runs on macOS/Linux, which can\'t use backslash paths directly. Mount the network share at the OS level first (e.g. Finder → Connect to Server on macOS, or an /etc/fstab entry on Linux), then enter the resulting LOCAL path here — e.g. /Volumes/ShareName/... — not the raw \\\\server\\share address.'
  }
  return 'This looks like a POSIX path, but this backend runs on Windows. Use a drive letter (C:\\...) or a UNC path (\\\\server\\share) instead.'
}

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
