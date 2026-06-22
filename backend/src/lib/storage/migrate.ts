// Durable storage migration — moves per-user data from one root to another.
// Enqueued as a 'storage-move' job in the download_jobs queue so it survives
// restarts, shows progress in BackgroundSetupWidget, and respects the job
// scheduler (won't overlap with large downloads).

import { mkdir, cp, rm, symlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { downloadJobs } from '@/db/schema'
import { setAppSetting } from '@/lib/settings'
import type { DownloadProgress } from '@/lib/download'

export type StorageMovePayload = {
  fromRoot: string
  toRoot: string
}

/** Enqueue a storage-move job. Returns the job id. */
export async function enqueueStorageMove(fromRoot: string, toRoot: string): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(downloadJobs).values({
    id,
    type: 'storage-move',
    refId: `${fromRoot}|${toRoot}`,
    domain: 'storage',
    sizeClass: 'large',
    label: 'Moving user data to new location',
    status: 'pending',
    priority: 5,   // low — not blocking any essential installs
    attempts: 0,
    maxAttempts: 3,
    progress: null,
    variantKey: null,
    lastError: null,
    nextEligibleAt: null,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

/** Runs the actual migration. Called by downloadJobs.ts runJob() dispatch. */
export async function runStorageMove(
  fromRoot: string,
  toRoot: string,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  _signal: AbortSignal,
): Promise<void> {
  const note = (msg: string) =>
    onProgress({ completed: 0, total: 100, speedBps: 0, etaSeconds: 0, note: msg })

  const abortIfCancelled = () => {
    if (_signal.aborted) throw new Error('Storage move cancelled')
  }

  abortIfCancelled()
  note('Preparing destination…')
  await mkdir(dirname(toRoot), { recursive: true })

  if (!existsSync(fromRoot)) {
    // Nothing to move — just update the setting
    note('No existing user data to move')
    await mkdir(toRoot, { recursive: true })
    await setAppSetting('storage.user_data_root', toRoot)
    return
  }

  // Crash-safe copy: stage into a sibling ".incoming" dir, then atomically rename
  // it into place. A failed/interrupted attempt leaves only the staging dir, which
  // we wipe before retrying, so a retry never merges into a half-populated toRoot.
  const staging = `${toRoot}.incoming`
  note('Copying user data…')
  if (existsSync(staging)) await rm(staging, { recursive: true, force: true })
  await cp(fromRoot, staging, { recursive: true, preserveTimestamps: true })
  abortIfCancelled()

  note('Activating new location…')
  // Atomic swap into the final path (same filesystem → rename is atomic).
  if (existsSync(toRoot)) await rm(toRoot, { recursive: true, force: true })
  await rename(staging, toRoot)

  note('Updating storage root setting…')
  // Flip the live setting only after the data is fully in place.
  await setAppSetting('storage.user_data_root', toRoot)

  // Leave a symlink from old location → new so any in-flight absolute-path
  // references (e.g. a long-running image job) still resolve during this window.
  const symlinkPath = `${fromRoot}.old`
  note('Creating compatibility symlink…')
  try {
    if (existsSync(fromRoot)) {
      await rename(fromRoot, symlinkPath)
      await symlink(toRoot, fromRoot)
    }
  } catch {
    // Non-fatal: the symlink is a courtesy; old paths will resolve via DB lookup anyway
  }

  note('Cleaning up old location…')
  try {
    if (existsSync(symlinkPath)) await rm(symlinkPath, { recursive: true, force: true })
  } catch { /* ignore */ }

  onProgress({ completed: 100, total: 100, speedBps: 0, etaSeconds: 0, note: 'Done' })
}
