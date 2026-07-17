// Backups: scheduled or manual snapshots of the household's irreplaceable state.
//
// Every run always snapshots the SQLite database (VACUUM INTO — an online, consistent,
// WAL-safe copy) into <root>/db/app-<stamp>.db, pruned by a keep-N retention policy.
// Optionally it also mirrors user files (the per-user content tree, voice memos, home
// inventory files, and trained wake words) into <root>/files/ — an incremental
// size+mtime sync kept as ONE current mirror, not one copy per snapshot, so repeat
// runs only move what changed. Re-downloadable assets (model weights, maps, ZIM
// archives, managed binaries) are deliberately excluded.
//
// The destination is either a Storage Location (Admin → Storage → Locations, incl.
// NAS paths) or the default data/backups next to the live database. Restore is staged:
// the chosen snapshot is integrity-checked and copied to `<db>.restore-pending`, and
// db/index.ts swaps it in on the next boot, before the database is opened.

import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { desc, eq, inArray } from 'drizzle-orm'
import { db, dbPath, sqlite } from '@/db'
import { backups, storageLocations } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { getDataRoot } from '@/lib/storage/paths'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { checkDirectoryAccess } from '@/lib/storage/accessCheck'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

// ── Config ────────────────────────────────────────────────────────────────────

export interface BackupConfig {
  enabled: boolean
  time: string // 'HH:MM', server-local
  retainCount: number // db snapshots kept at the destination
  storageLocationId: string | null // null = data/backups
  includeFiles: boolean
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  time: '03:00',
  retainCount: 14,
  storageLocationId: null,
  includeFiles: true,
}

const CONFIG_KEY = 'backup.config'
const LAST_SCHEDULED_KEY = 'backup.last_scheduled_date'

export async function getBackupConfig(): Promise<BackupConfig> {
  const stored = (await getAppSetting(CONFIG_KEY)) as Partial<BackupConfig> | null
  return { ...DEFAULT_BACKUP_CONFIG, ...(stored ?? {}) }
}

export async function setBackupConfig(cfg: BackupConfig): Promise<void> {
  await setAppSetting(CONFIG_KEY, cfg)
}

/** Absolute backup root for the current config. Location paths get a loki-backups
 *  subfolder so pointing one at a share's root never mingles with other content. */
export async function resolveBackupRoot(cfg?: BackupConfig): Promise<string> {
  const config = cfg ?? (await getBackupConfig())
  if (config.storageLocationId) {
    const [loc] = await db.select().from(storageLocations)
      .where(eq(storageLocations.id, config.storageLocationId)).limit(1)
    if (loc) return join(loc.path, 'loki-backups')
    // The location was deleted since config was saved; fall through to the default
    // rather than silently writing to a wrong path.
  }
  return join(dataDir, 'backups')
}

// ── File mirror ───────────────────────────────────────────────────────────────

/** The user-data sources worth mirroring: name → absolute path resolver. Missing
 *  sources are skipped (not every install has voice memos or home inventory files). */
async function mirrorSources(): Promise<Array<{ name: string; path: string }>> {
  return [
    { name: 'users', path: await getDataRoot() },
    { name: 'voice-memos', path: join(dataDir, 'voice-memos') },
    { name: 'home', path: join(dataDir, 'home') },
    { name: 'wakewords', path: join(dataDir, 'voice', 'wakewords') },
  ]
}

interface SyncStats { copied: number; bytes: number }

/** Incremental one-way sync src → dest: copy files that are missing or differ by
 *  size/mtime. Never deletes at dest (a mirror that only grows is the safe default
 *  for a backup). Symlinks are skipped. */
async function syncDir(src: string, dest: string, stats: SyncStats): Promise<void> {
  let entries
  try {
    entries = await readdir(src, { withFileTypes: true })
  } catch {
    return // source absent on this install
  }
  await mkdir(dest, { recursive: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await syncDir(from, to, stats)
      continue
    }
    if (!entry.isFile()) continue
    const srcStat = await stat(from).catch(() => null)
    if (!srcStat) continue
    const destStat = await stat(to).catch(() => null)
    if (destStat && destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) continue
    await copyFile(from, to)
    stats.copied += 1
    stats.bytes += srcStat.size
  }
}

/** Reverse sync: copy mirror files back into place, but ONLY where the live file is
 *  missing. Never overwrites current data; meant for recovering onto a fresh machine
 *  or after accidental deletion. */
async function fillMissingFrom(src: string, dest: string, stats: SyncStats): Promise<void> {
  let entries
  try {
    entries = await readdir(src, { withFileTypes: true })
  } catch {
    return
  }
  await mkdir(dest, { recursive: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await fillMissingFrom(from, to, stats)
      continue
    }
    if (!entry.isFile()) continue
    const exists = await stat(to).catch(() => null)
    if (exists) continue
    const srcStat = await stat(from).catch(() => null)
    if (!srcStat) continue
    await copyFile(from, to)
    stats.copied += 1
    stats.bytes += srcStat.size
  }
}

// ── Backup run ────────────────────────────────────────────────────────────────

export type BackupKind = 'manual' | 'scheduled' | 'pre-update'

export interface BackupResult {
  ok: boolean
  backupId?: string
  dbFileName?: string
  dbSizeBytes?: number
  error?: string
}

let runInFlight = false

export function isBackupRunning(): boolean {
  return runInFlight
}

function stampName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `app-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`
}

/** Run a backup now. Serialized: a second call while one runs returns an error
 *  instead of racing the same destination. */
export async function runBackup(kind: BackupKind, opts?: { includeFiles?: boolean }): Promise<BackupResult> {
  if (runInFlight) return { ok: false, error: 'A backup is already running.' }
  runInFlight = true
  const startedAt = new Date()
  const id = crypto.randomUUID()
  try {
    const cfg = await getBackupConfig()
    const includeFiles = opts?.includeFiles ?? cfg.includeFiles
    const root = await resolveBackupRoot(cfg)

    const access = await checkDirectoryAccess(root)
    if (!access.ok) {
      throw new Error(`Backup destination is not writable (${root}): ${access.error ?? 'access check failed'}`)
    }

    await db.insert(backups).values({
      id, kind, status: 'running', destinationPath: root, startedAt,
    })

    // 1. Database snapshot. VACUUM INTO writes a compacted, consistent copy of the
    // committed state without blocking readers or writers. It refuses to overwrite,
    // so write to a temp name and rename into place for atomicity.
    const dbDir = join(root, 'db')
    await mkdir(dbDir, { recursive: true })
    // Stamp names have second resolution; two runs in the same second (e.g. a manual
    // run during a pre-update snapshot window) must not overwrite each other.
    let fileName = stampName(startedAt)
    for (let n = 2; await stat(join(dbDir, fileName)).catch(() => null); n++) {
      fileName = stampName(startedAt).replace(/\.db$/, `-${n}.db`)
    }
    const tmpTarget = join(dbDir, `.${fileName}.tmp`)
    await rm(tmpTarget, { force: true })
    sqlite.exec(`VACUUM INTO '${tmpTarget.replace(/'/g, "''")}'`)
    await rename(tmpTarget, join(dbDir, fileName))
    const dbSizeBytes = (await stat(join(dbDir, fileName))).size

    // 2. User-file mirror (optional).
    let filesSynced: number | null = null
    let filesBytes: number | null = null
    if (includeFiles) {
      const stats: SyncStats = { copied: 0, bytes: 0 }
      for (const source of await mirrorSources()) {
        await syncDir(source.path, join(root, 'files', source.name), stats)
      }
      filesSynced = stats.copied
      filesBytes = stats.bytes
    }

    // 3. Retention: keep the newest N db snapshots at this destination. Stamped names
    // sort chronologically, so a name sort is a time sort.
    const cutList = (await readdir(dbDir).catch(() => [] as string[]))
      .filter((f) => /^app-\d{8}-\d{6}(-\d+)?\.db$/.test(f))
      .sort()
      .reverse()
      .slice(Math.max(1, cfg.retainCount))
    for (const old of cutList) {
      await rm(join(dbDir, old), { force: true })
      await db.update(backups).set({ status: 'pruned' })
        .where(eq(backups.dbFileName, old))
    }

    await db.update(backups).set({
      status: 'complete', dbFileName: fileName, dbSizeBytes,
      filesSynced, filesBytes, finishedAt: new Date(),
    }).where(eq(backups.id, id))

    logger.info(`[backup] ${kind} backup complete: ${fileName} (${dbSizeBytes} bytes db${filesSynced != null ? `, ${filesSynced} files synced` : ''}) → ${root}`)
    return { ok: true, backupId: id, dbFileName: fileName, dbSizeBytes }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[backup] ${kind} backup failed: ${message}`)
    await db.update(backups).set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(backups.id, id)).catch(() => {})
    await emitNotification({
      type: 'system',
      userId: null,
      title: 'Backup failed',
      body: `The ${kind === 'pre-update' ? 'pre-update' : kind} backup did not complete: ${message}`,
      url: '/admin/storage/backups',
      dedupeKey: `backup_failed:${new Date().toDateString()}`,
    }).catch(() => {})
    return { ok: false, error: message }
  } finally {
    runInFlight = false
  }
}

// ── Restore ───────────────────────────────────────────────────────────────────

/** Verify a snapshot and stage it for the boot-time swap. The caller restarts the
 *  server afterwards (the same restart flow as Admin → Server). */
export async function stageRestore(backupId: string): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1)
  if (!row || row.status !== 'complete' || !row.dbFileName) {
    return { ok: false, error: 'That backup is not restorable.' }
  }
  const snapshot = join(row.destinationPath, 'db', row.dbFileName)
  const exists = await stat(snapshot).catch(() => null)
  if (!exists) return { ok: false, error: 'The snapshot file is missing from the backup destination.' }

  // Integrity-check the snapshot before staging: a corrupt restore discovered at
  // boot would leave the server down.
  try {
    const check = new Database(snapshot, { readonly: true })
    try {
      const result = check.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
      if (result?.integrity_check !== 'ok') {
        return { ok: false, error: `Snapshot failed the integrity check: ${result?.integrity_check ?? 'unknown result'}` }
      }
    } finally {
      check.close()
    }
  } catch (err) {
    return { ok: false, error: `Could not open the snapshot: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Copy (not move — the snapshot stays in the backup set) then rename into the
  // staging name so a partial copy is never picked up at boot.
  const staging = `${dbPath}.restore-staging`
  const pending = `${dbPath}.restore-pending`
  await rm(staging, { force: true })
  await copyFile(snapshot, staging)
  await rm(pending, { force: true })
  await rename(staging, pending)
  return { ok: true }
}

/** Copy mirrored user files back into place where missing. Returns counts. */
export async function restoreMissingFiles(): Promise<{ ok: boolean; copied: number; bytes: number; error?: string }> {
  try {
    const root = await resolveBackupRoot()
    const stats: SyncStats = { copied: 0, bytes: 0 }
    for (const source of await mirrorSources()) {
      await fillMissingFrom(join(root, 'files', source.name), source.path, stats)
    }
    return { ok: true, ...stats }
  } catch (err) {
    return { ok: false, copied: 0, bytes: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Listing / deletion ────────────────────────────────────────────────────────

export async function listBackups(limit = 50) {
  return db.select().from(backups)
    .where(inArray(backups.status, ['running', 'complete', 'failed']))
    .orderBy(desc(backups.startedAt))
    .limit(limit)
}

export async function deleteBackup(backupId: string): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1)
  if (!row) return { ok: false, error: 'Backup not found.' }
  if (row.status === 'running') return { ok: false, error: 'That backup is still running.' }
  if (row.dbFileName) {
    await rm(join(row.destinationPath, 'db', row.dbFileName), { force: true }).catch(() => {})
  }
  await db.delete(backups).where(eq(backups.id, backupId))
  return { ok: true }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** Minute tick: fire the daily backup once when the server-local clock passes the
 *  configured HH:MM. The last-fired date is persisted so a restart later the same
 *  day doesn't re-run it, and a missed window (server off at 03:00) runs on the
 *  next tick after boot rather than silently skipping the day. */
export function startBackupScheduler(): void {
  const tick = async () => {
    try {
      const cfg = await getBackupConfig()
      if (!cfg.enabled) return
      if (runInFlight) return
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
      if (nowHm < cfg.time) return
      const last = (await getAppSetting(LAST_SCHEDULED_KEY)) as string | null
      if (last === today) return
      await setAppSetting(LAST_SCHEDULED_KEY, today) // set first so a crash can't double-fire
      await runBackup('scheduled')
    } catch (err) {
      logger.warn(`[backup] scheduler tick failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  setTimeout(() => { void tick() }, 90_000) // settle after boot before the first check
  setInterval(() => { void tick() }, 60_000)
}
