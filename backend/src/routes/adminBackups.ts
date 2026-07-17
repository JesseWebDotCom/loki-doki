// Admin → Storage → Backups: config, run-now, snapshot list, restore, delete.
// Restore is staged (see lib/backup stageRestore); the client follows up with the
// existing POST /api/admin/server/restart to complete it.

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import {
  deleteBackup,
  getBackupConfig,
  isBackupRunning,
  listBackups,
  resolveBackupRoot,
  restoreMissingFiles,
  runBackup,
  setBackupConfig,
  stageRestore,
  type BackupConfig,
} from '@/lib/backup'

const app = new Hono()
app.use('*', requireAdmin)

app.get('/', async (c) => {
  const config = await getBackupConfig()
  return c.json({
    config,
    root: await resolveBackupRoot(config),
    running: isBackupRunning(),
    backups: await listBackups(),
  })
})

app.put('/config', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<BackupConfig> | null
  if (!body) return c.json({ ok: false, error: 'Invalid request body.' }, 400)
  const current = await getBackupConfig()
  const next: BackupConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    time: typeof body.time === 'string' ? body.time : current.time,
    retainCount: typeof body.retainCount === 'number' ? Math.round(body.retainCount) : current.retainCount,
    storageLocationId: body.storageLocationId === undefined ? current.storageLocationId : body.storageLocationId,
    includeFiles: typeof body.includeFiles === 'boolean' ? body.includeFiles : current.includeFiles,
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time)) {
    return c.json({ ok: false, error: 'Time must be HH:MM (24-hour).' }, 400)
  }
  if (next.retainCount < 1 || next.retainCount > 365) {
    return c.json({ ok: false, error: 'Keep between 1 and 365 snapshots.' }, 400)
  }
  await setBackupConfig(next)
  return c.json({ ok: true, config: next, root: await resolveBackupRoot(next) })
})

app.post('/run', async (c) => {
  if (isBackupRunning()) return c.json({ ok: false, error: 'A backup is already running.' }, 409)
  // Fire and return; the row in the list reflects progress and outcome.
  void runBackup('manual')
  return c.json({ ok: true })
})

app.post('/restore', async (c) => {
  const body = await c.req.json().catch(() => null) as { backupId?: string } | null
  if (!body?.backupId) return c.json({ ok: false, error: 'backupId is required.' }, 400)
  const result = await stageRestore(body.backupId)
  return c.json(result, result.ok ? 200 : 400)
})

app.post('/restore-files', async (c) => {
  const result = await restoreMissingFiles()
  return c.json(result, result.ok ? 200 : 400)
})

app.delete('/:id', async (c) => {
  const result = await deleteBackup(c.req.param('id'))
  return c.json(result, result.ok ? 200 : 400)
})

export default app
