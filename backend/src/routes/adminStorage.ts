import { Hono } from 'hono'
import { writeFile, rename, unlink, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { statfs } from 'node:fs/promises'
import { db } from '@/db'
import { users } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { getDataRoot, userSlug } from '@/lib/storage/paths'
import { dataDir, ollamaModelsDir } from '@/lib/download'

const app = new Hono()
app.use('*', requireAdmin)

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively sum the size of a directory tree in bytes. Returns 0 if missing. */
async function dirSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true })
    for (const e of entries) {
      if (e.isFile()) {
        try {
          const s = await stat(join(e.parentPath ?? (e as any).path ?? dir, e.name))
          total += s.size
        } catch { /* skip */ }
      }
    }
  } catch { /* unreadable */ }
  return total
}

/** Get free bytes at a given path. */
async function freeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path)
    return s.bfree * s.bsize
  } catch {
    // statvfs may not exist on all platforms — try df as fallback
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

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}

// ── GET / — current root + per-user usage ─────────────────────────────────────

app.get('/', async (c) => {
  const root = await getDataRoot()
  const allUsers = await db.select({ id: users.id, firstName: users.firstName }).from(users)

  // Measure all these in parallel
  const [userUsageRaw, appDataBytes, ollamaBytes, free] = await Promise.all([
    Promise.all(allUsers.map(async (u) => {
      const slug = userSlug(u.id, u.firstName)
      const dir = join(root, slug)
      const bytes = await dirSize(dir)
      return { userId: u.id, firstName: u.firstName, slug, bytes, formatted: formatBytes(bytes) }
    })),
    dirSize(dataDir),
    dirSize(ollamaModelsDir()),
    freeBytes(root),
  ])

  const userUsage = userUsageRaw
  const totalBytes = userUsage.reduce((s, u) => s + u.bytes, 0)
  // Ollama models now live under dataDir/ollama-models (see lib/download.ts ollamaModelsDir),
  // so appDataBytes already includes them — don't double-count in the total.
  const appTotalBytes = appDataBytes

  return c.json({
    root,
    isDefault: root === join(dataDir, 'users'),
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    appTotalBytes,
    appTotalFormatted: formatBytes(appTotalBytes),
    ollamaBytes,
    ollamaFormatted: formatBytes(ollamaBytes),
    freeBytes: free,
    freeFormatted: free != null ? formatBytes(free) : null,
    users: userUsage,
  })
})

// ── POST /validate — test a candidate path before committing ──────────────────

app.post('/validate', async (c) => {
  const { path: candidatePath } = await c.req.json<{ path: string }>()
  if (!candidatePath || !isAbsolute(candidatePath)) {
    return c.json({ ok: false, error: 'Path must be an absolute filesystem path.' }, 400)
  }

  const checks: Record<string, boolean> = { read: false, write: false, rename: false, delete: false }
  let errorMsg: string | null = null
  const tmpFile = join(candidatePath, `.loki-access-check-${Date.now()}`)
  const tmpRenamed = join(candidatePath, `.loki-access-renamed-${Date.now()}`)

  try {
    // Ensure directory exists (attempt creation)
    await import('node:fs/promises').then(m => m.mkdir(candidatePath, { recursive: true }))

    // 1. Write
    await writeFile(tmpFile, 'ok')
    checks.write = true

    // 2. Read
    await import('node:fs/promises').then(m => m.readFile(tmpFile))
    checks.read = true

    // 3. Rename
    await rename(tmpFile, tmpRenamed)
    checks.rename = true

    // 4. Delete
    await unlink(tmpRenamed)
    checks.delete = true
  } catch (err: any) {
    errorMsg = err?.message ?? 'Access check failed'
    // Clean up any temp files left behind
    try { await unlink(tmpFile) } catch { /* ignore */ }
    try { await unlink(tmpRenamed) } catch { /* ignore */ }
  }

  const allPassed = Object.values(checks).every(Boolean)

  // Space stats
  const currentRoot = await getDataRoot()
  const currentBytes = await dirSize(currentRoot)
  const candidateFree = await freeBytes(candidatePath)
  const fitsInDestination = candidateFree == null || candidateFree >= currentBytes

  return c.json({
    ok: allPassed && fitsInDestination,
    checks,
    error: errorMsg,
    currentBytes,
    currentFormatted: formatBytes(currentBytes),
    freeBytes: candidateFree,
    freeFormatted: candidateFree != null ? formatBytes(candidateFree) : null,
    fitsInDestination,
    spaceWarning: !fitsInDestination
      ? `Destination has ${candidateFree != null ? formatBytes(candidateFree) : 'unknown'} free but your user data is ${formatBytes(currentBytes)}.`
      : null,
  })
})

// ── POST /migrate — enqueue a durable storage migration job ──────────────────

app.post('/migrate', async (c) => {
  const { path: newRoot } = await c.req.json<{ path: string }>()
  if (!newRoot || !isAbsolute(newRoot)) {
    return c.json({ ok: false, error: 'Path must be absolute.' }, 400)
  }

  const currentRoot = await getDataRoot()
  if (newRoot === currentRoot) {
    return c.json({ ok: false, error: 'New path is the same as current path.' }, 400)
  }

  // Pre-flight space check
  const currentBytes = await dirSize(currentRoot)
  const free = await freeBytes(newRoot)
  if (free != null && free < currentBytes) {
    return c.json({
      ok: false,
      error: `Not enough space at destination. Need ${formatBytes(currentBytes)}, have ${formatBytes(free)}.`,
    }, 400)
  }

  // Enqueue the migration job
  const { enqueueStorageMove } = await import('@/lib/storage/migrate')
  const jobId = await enqueueStorageMove(currentRoot, newRoot)

  return c.json({ ok: true, jobId })
})

export default app
