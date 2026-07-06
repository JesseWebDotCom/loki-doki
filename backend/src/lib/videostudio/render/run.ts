// Studio render runner (job type 'studio-render'). Loads the export's studio_media row
// (EDL snapshot + preset in source_meta), resolves every referenced asset to its blob
// path, compiles the filter_complex, and runs ffmpeg with -progress parsing so the job
// widget shows real out_time progress. Output lands in the blob store as the export
// row's asset (sourceType='studio').

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, studioMedia } from '@/db/schema'
import { blobAbsPath, contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { edlDurationSec, parseEdl, type Edl } from '@/lib/videostudio/edl'
import { probeMedia } from '@/lib/videostudio/probe'
import { compileFilterGraph, type RenderPlan } from '@/lib/videostudio/render/filtergraph'
import { resolveStudioEncoder, STUDIO_CPU_ENCODER } from '@/lib/videostudio/render/encoder'
import type { DownloadProgress } from '@/lib/download'

export interface StudioRenderJobPayload {
  exportId: string   // studio_media row (origin='export')
}

export interface ExportPreset {
  width: number
  height: number
  fps: number
}

export const EXPORT_PRESETS: Record<string, ExportPreset> = {
  '1080p': { width: 1920, height: 1080, fps: 30 },
  '720p': { width: 1280, height: 720, fps: 30 },
  vertical: { width: 1080, height: 1920, fps: 30 },
  draft: { width: 640, height: 360, fps: 30 },
}

/** Resolve the EDL's asset ids → blob paths + probes, producing the pure RenderPlan. */
async function buildPlan(edl: Edl, preset: ExportPreset): Promise<RenderPlan> {
  const assetIds = [...new Set(edl.video.map((c) => c.assetId))]
  const assets = assetIds.length
    ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, assetIds))
    : []
  const byId = new Map(assets.map((a) => [a.id, a]))

  const inputs: RenderPlan['inputs'] = []
  const inputIndexByAsset = new Map<string, number>()
  for (const assetId of assetIds) {
    const asset = byId.get(assetId)
    if (!asset?.blobHash || asset.status !== 'ready') throw new Error(`source media missing or not ready (${assetId})`)
    const path = await blobAbsPath(asset.blobHash)
    const probe = await probeMedia(path)
    inputIndexByAsset.set(assetId, inputs.length)
    inputs.push({ path, hasAudio: probe.hasAudio })
  }

  return {
    canvas: { width: preset.width, height: preset.height, fps: preset.fps },
    inputs,
    clips: edl.video.map((c) => ({
      inputIndex: inputIndexByAsset.get(c.assetId)!,
      in: c.in, out: c.out, speed: c.speed, muted: c.muted,
    })),
  }
}

function runFfmpeg(bin: string, args: string[], plannedSec: number, onProgress: (p: DownloadProgress & { note?: string }) => void, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let errTail = ''
    proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-8192) })
    // -progress pipe:1 emits key=value blocks; out_time_ms tracks the rendered position.
    proc.stdout?.on('data', (d: Buffer) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString())
      if (m) {
        const sec = parseInt(m[1]!, 10) / 1_000_000
        onProgress({ completed: Math.min(sec, plannedSec), total: plannedSec, speedBps: 0, etaSeconds: 0, note: 'Rendering…' })
      }
    })
    const onAbort = () => proc.kill('SIGKILL')
    signal.addEventListener('abort', onAbort, { once: true })
    proc.on('error', (e) => { signal.removeEventListener('abort', onAbort); reject(e) })
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new Error('cancelled'))
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg render exited ${code}: ${errTail.trim().split('\n').slice(-4).join(' | ').slice(-600)}`))
    })
  })
}

export async function runStudioRenderJob(
  payload: StudioRenderJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db.select().from(studioMedia).where(eq(studioMedia.id, payload.exportId)).limit(1)
  if (!row || row.origin !== 'export') throw new Error('export row not found')
  const meta = JSON.parse(row.sourceMeta ?? '{}') as { edlSnapshot?: string; preset?: string }
  if (!meta.edlSnapshot) throw new Error('export row missing EDL snapshot')
  const preset = EXPORT_PRESETS[meta.preset ?? '1080p'] ?? EXPORT_PRESETS['1080p']!
  const edl = parseEdl(meta.edlSnapshot)

  await db.update(studioMedia).set({ status: 'processing', updatedAt: new Date() }).where(eq(studioMedia.id, row.id))
  try {
    const bin = await ensureFfmpeg()
    const plan = await buildPlan(edl, preset)
    const graph = compileFilterGraph(plan)
    const encoder = await resolveStudioEncoder()
    const plannedSec = Math.max(1, edlDurationSec(edl))

    const tmpDir = await contentTmpDir()
    const outPath = join(tmpDir, `studio-export-${row.id}.mp4`)
    const argsFor = (enc: typeof encoder) => [
      '-y', '-loglevel', 'error', '-progress', 'pipe:1',
      ...graph.inputArgs,
      '-filter_complex', graph.filterComplex,
      ...graph.mapArgs,
      '-c:v', enc.codec, ...enc.args,
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outPath,
    ]
    try {
      await runFfmpeg(bin, argsFor(encoder), plannedSec, onProgress, signal)
    } catch (err) {
      // Hardware encoders occasionally refuse odd dimensions/pixel formats — retry on CPU
      // once (mirrors enhance.ts's runtime fallback) instead of failing the export.
      if (!encoder.hw || signal.aborted) throw err
      await runFfmpeg(bin, argsFor(STUDIO_CPU_ENCODER), plannedSec, onProgress, signal)
    }

    const { hash, sizeBytes } = await putBlobFromFile(outPath, { mime: 'video/mp4' })
    await withLock(`studio-media:${row.id}`, async () => {
      const now = new Date()
      await markBlobLive(hash)
      const assetId = row.assetId ?? randomUUID()
      const [existing] = row.assetId
        ? await db.select().from(mediaAssets).where(eq(mediaAssets.id, row.assetId)).limit(1)
        : []
      if (existing) {
        await db.update(mediaAssets).set({ blobHash: hash, sizeBytes, status: 'ready', error: null, updatedAt: now }).where(eq(mediaAssets.id, assetId))
      } else {
        await db.insert(mediaAssets).values({
          id: assetId, sourceType: 'studio', sourceId: row.id, kind: 'video', format: 'mp4',
          height: preset.height, blobHash: hash, status: 'ready', sizeBytes, error: null,
          createdAt: now, updatedAt: now,
        })
      }
      await db.update(studioMedia).set({
        status: 'ready', assetId, durationSec: edlDurationSec(edl),
        width: preset.width, height: preset.height, error: null, updatedAt: now,
      }).where(eq(studioMedia.id, row.id))
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.update(studioMedia).set({ status: 'failed', error: message.slice(0, 500), updatedAt: new Date() }).where(eq(studioMedia.id, row.id))
    throw err
  }
}

/** Terminal-failure hook (downloadJobs): flip the export row if the runner's own catch
 *  didn't already (e.g. the process died between attempts). */
export async function failStudioRenderByJobRefId(refId: string, error: string): Promise<void> {
  const payload = JSON.parse(refId) as StudioRenderJobPayload
  const [row] = await db.select({ status: studioMedia.status }).from(studioMedia).where(eq(studioMedia.id, payload.exportId)).limit(1)
  if (row && row.status !== 'ready') {
    await db.update(studioMedia).set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() }).where(eq(studioMedia.id, payload.exportId))
  }
}
