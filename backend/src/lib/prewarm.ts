// Background pre-warm of lazily-installed binary dependencies.
//
// Each of these otherwise downloads on FIRST USE — a multi-minute stall in the
// middle of a user action (the first media export waits on ffmpeg; the first
// bookmark archive waits on a ~150 MB Chromium; the first voice request waits on
// the Node runtime). Warming them shortly after boot moves that cost into idle
// background time, and doubles as self-healing: a dep deleted from disk is
// re-acquired on the next boot instead of failing at first use.
//
// Everything here is best-effort, no-ops when already present, and deliberately
// delayed so boot-critical work and the download queue get the bandwidth first.

import { logger } from '@/lib/logger'

const WARM_DELAY_MS = 60_000

export function scheduleBinaryPrewarm(): void {
  setTimeout(() => { void warm() }, WARM_DELAY_MS)
}

async function warm(): Promise<void> {
  // ffmpeg — podcasts, the converter, music, and YouTube exports all need it.
  try {
    const { ensureFfmpeg } = await import('@/lib/ffmpeg')
    await ensureFfmpeg()
  } catch (e) { logger.warn(`[prewarm] ffmpeg: ${e}`) }

  // Headless Chromium — bookmark server-side archiving. Only once bookmarks are in use.
  try {
    const { db } = await import('@/db')
    const { bookmarks } = await import('@/db/schema')
    const rows = await db.select({ id: bookmarks.id }).from(bookmarks).limit(1)
    if (rows.length) {
      const { ensureChromium } = await import('@/lib/bookmarks/render')
      await ensureChromium()
    }
  } catch (e) { logger.warn(`[prewarm] chromium: ${e}`) }

  // Node runtime — the voice sidecar runs under Node, not Bun (onnxruntime-node
  // segfaults under Bun). Only when the voice feature is installed.
  try {
    const { getInstalledLedger } = await import('@/lib/installRegistry')
    if ((await getInstalledLedger()).includes('voice-core')) {
      const { ensureNode } = await import('@/lib/node')
      await ensureNode()
    }
  } catch (e) { logger.warn(`[prewarm] node: ${e}`) }
}
