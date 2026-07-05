// Bring a video file from the blob store into the Plex-visible tree. Hardlink when the
// blob and the destination share a volume (free, zero extra disk); fall back to a real
// copy on EXDEV (cross-device — e.g. blob store local, Plex tree on a network share),
// mirroring the exact fallback content/store.ts already uses for the same reason.

import { link, cp, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function placeFile(sourceAbsPath: string, destAbsPath: string): Promise<void> {
  await mkdir(dirname(destAbsPath), { recursive: true })
  try { await unlink(destAbsPath) } catch { /* fine if nothing was there yet */ }
  try {
    await link(sourceAbsPath, destAbsPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      await cp(sourceAbsPath, destAbsPath)
    } else {
      throw err
    }
  }
}
