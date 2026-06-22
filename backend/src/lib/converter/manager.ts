// Converter service — THE internal API. The HTTP route, the companion chat tool, and any
// backend subsystem call convert() directly (no HTTP hop), the same way routes/image.ts
// is consumed via @/lib/comfyui. Conversions run on the shared genQueue 'convert' lane so
// they're bounded, cancellable, and stream progress over SSE like image/chat jobs.

import { extname, basename } from 'node:path'
import { stat, unlink } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { conversions } from '@/db/schema'
import * as genQueue from '@/lib/genQueue'
import { userPath, toRelativePath } from '@/lib/storage/paths'
import { logger } from '@/lib/logger'
import { pickEngine } from './registry'
import { familyOf, LOSSY } from './formats'
import type { ConvertInput } from './types'

export { capabilities } from './registry'

/** Lowercase extension without the dot. */
function extOf(name: string): string {
  return extname(name).replace(/^\./, '').toLowerCase()
}

export class ConversionError extends Error {}

export interface ConvertResult {
  conversionId: string
  jobId: string
}

/**
 * Validate the requested conversion, persist a row, and enqueue the work. Returns
 * immediately; progress streams via genQueue (subscribe with the returned jobId).
 * Throws ConversionError synchronously for an unsupported (input → output) pair so
 * callers can surface a clean 400 before any job exists.
 */
export async function convert(input: ConvertInput): Promise<ConvertResult> {
  const srcExt = extOf(input.srcName)
  const outExt = input.targetFormat.toLowerCase().replace(/^\./, '')

  if (!srcExt) throw new ConversionError('Could not determine the input file type')
  if (srcExt === outExt) throw new ConversionError('Input and output formats are the same')

  const family = familyOf(srcExt)
  if (!family) throw new ConversionError(`Unsupported input format: .${srcExt}`)

  const engine = await pickEngine(srcExt, outExt)
  if (!engine) throw new ConversionError(`Can't convert .${srcExt} → .${outExt}`)

  const conversionId = crypto.randomUUID()
  const now = new Date()
  const baseName = basename(input.srcName, extname(input.srcName)) || 'converted'
  const outputName = `${baseName}.${outExt}`
  const quality = input.quality ?? (LOSSY.has(outExt) ? 90 : undefined)

  let inputBytes: number | null = null
  try { inputBytes = (await stat(input.srcPath)).size } catch { /* best-effort */ }

  await db.insert(conversions).values({
    id: conversionId,
    userId: input.userId,
    inputName: input.srcName,
    outputName,
    inputFormat: srcExt,
    outputFormat: outExt,
    family,
    engine: engine.name,
    relPath: null,
    state: 'pending',
    failureReason: null,
    inputBytes,
    outputBytes: null,
    createdAt: now,
    updatedAt: now,
  })

  const job = genQueue.enqueue({
    type: 'convert',
    userId: input.userId,
    meta: { conversionId, outputName },
    run: async (ctx) => {
      await db.update(conversions)
        .set({ state: 'converting', updatedAt: new Date() })
        .where(eq(conversions.id, conversionId))
      ctx.emit('start', JSON.stringify({ conversionId, outputName, from: srcExt, to: outExt, engine: engine.name }))

      try {
        const outPath = await userPath(input.userId, input.firstName, 'converted', `${conversionId}.${outExt}`)
        await engine.run({ inPath: input.srcPath, outPath, outExt, family, quality, signal: ctx.signal })

        const outBytes = (await stat(outPath).catch(() => null))?.size ?? null
        const relPath = await toRelativePath(outPath)
        await db.update(conversions)
          .set({ state: 'ready', relPath, outputBytes: outBytes, updatedAt: new Date() })
          .where(eq(conversions.id, conversionId))
        ctx.emit('done', JSON.stringify({ conversionId, outputName, bytes: outBytes }))
      } catch (err) {
        const reason = ctx.signal.aborted ? 'cancelled' : (err instanceof Error ? err.message : String(err))
        await db.update(conversions)
          .set({ state: ctx.signal.aborted ? 'cancelled' : 'failed', failureReason: reason, updatedAt: new Date() })
          .where(eq(conversions.id, conversionId))
        logger.warn(`[converter] ${conversionId} failed: ${reason}`)
        ctx.emit('error', JSON.stringify({ conversionId, error: reason }))
        throw err
      } finally {
        if (input.cleanupSrc) await unlink(input.srcPath).catch(() => {})
      }
    },
  })

  return { conversionId, jobId: job.id }
}
