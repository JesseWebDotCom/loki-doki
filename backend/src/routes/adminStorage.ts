import { Hono } from 'hono'
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { db } from '@/db'
import { users } from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { getDataRoot, userSlug } from '@/lib/storage/paths'
import { dataDir, ollamaModelsDir } from '@/lib/download'
import { checkDirectoryAccess, freeBytesAt, formatBytes as sharedFormatBytes, crossPlatformPathHint } from '@/lib/storage/accessCheck'

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

const freeBytes = freeBytesAt
const formatBytes = sharedFormatBytes

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
    // Full shape, not a bare {ok,error} — the frontend renders checks.read/write/etc.
    // unconditionally and a differently-shaped reply here would crash instead of showing this.
    // Gate is node:path's own host-native isAbsolute(), not a cross-platform shape check —
    // see accessCheck.ts's crossPlatformPathHint() doc comment for why that's load-bearing.
    return c.json({
      ok: false, checks: { read: false, write: false, rename: false, delete: false },
      error: crossPlatformPathHint(candidatePath ?? '') ?? 'Path must be an absolute filesystem path for the OS this backend runs on.',
      currentBytes: 0, currentFormatted: '0 B', freeBytes: null, freeFormatted: null, fitsInDestination: true, spaceWarning: null,
    }, 400)
  }

  const access = await checkDirectoryAccess(candidatePath)

  // Space stats — specific to this route's "moving the whole data root" framing;
  // checkDirectoryAccess() itself only reports raw free space, not fit-vs-current-usage.
  const currentRoot = await getDataRoot()
  const currentBytes = await dirSize(currentRoot)
  const fitsInDestination = access.freeBytes == null || access.freeBytes >= currentBytes

  return c.json({
    ok: access.ok && fitsInDestination,
    checks: access.checks,
    error: access.error,
    currentBytes,
    currentFormatted: formatBytes(currentBytes),
    freeBytes: access.freeBytes,
    freeFormatted: access.freeFormatted,
    fitsInDestination,
    spaceWarning: !fitsInDestination
      ? `Destination has ${access.freeFormatted ?? 'unknown'} free but your user data is ${formatBytes(currentBytes)}.`
      : null,
  })
})

// ── POST /migrate — enqueue a durable storage migration job ──────────────────

app.post('/migrate', async (c) => {
  const { path: newRoot } = await c.req.json<{ path: string }>()
  if (!newRoot || !isAbsolute(newRoot)) {
    return c.json({ ok: false, error: crossPlatformPathHint(newRoot ?? '') ?? 'Path must be an absolute filesystem path for the OS this backend runs on.' }, 400)
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
