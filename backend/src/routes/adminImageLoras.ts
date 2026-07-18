import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { writeFile, mkdir, rename, unlink, readdir, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { eq, and, desc, asc } from 'drizzle-orm'
import { db } from '@/db'
import {
  imageLoras,
  imageLoraCategories,
  imageLoraUserCategoryGrants,
  imageLoraUserLoraGrants,
  users,
} from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { dataDir, validateSafetensorsFile } from '@/lib/download'
import { ensureLoraSafetensors } from '@/lib/loraFiles'
import { isGloballyOffline, isDownloadBlocked } from '@/lib/connectivity'
import { ollamaChat } from '@/llm/ollama'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { detectIsAdult, getAdultKeywords } from '@/lib/adultDetection'
import { getProtections } from '@/lib/protections'
import { assertPublicUrl } from '@/lib/ssrfGuard'
import { sanitizeTriggerTokens } from '@/lib/loraTokens'
import type { AppEnv } from '@/types'

const adminImageLoras = new Hono<AppEnv>()

// ── Helpers ────────────────────────────────────────────────────────────────────

function lorasDir() {
  return join(dataDir, 'loras')
}

// ── CivitAI metadata fetch ────────────────────────────────────────────────────

interface CivitAIModelMeta {
  description: string
  trainedWords: string[]
  tags: string[]
  nsfw: boolean
}

async function fetchCivitAIMetadata(civitaiModelId: number): Promise<CivitAIModelMeta | null> {
  try {
    const apiKey = process.env.CIVITAI_API_KEY
    const headers: Record<string, string> = { 'User-Agent': 'loki-doki/1.0' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(`https://civitai.com/api/v1/models/${civitaiModelId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null

    const data = await res.json() as {
      description?: string
      tags?: string[]
      nsfw?: boolean
      modelVersions?: Array<{ trainedWords?: string[] }>
    }

    const rawDesc = data.description ?? ''
    const description = rawDesc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000)
    const trainedWords = data.modelVersions?.[0]?.trainedWords ?? []
    const tags = data.tags ?? []
    const nsfw = data.nsfw ?? false

    return { description, trainedWords, tags, nsfw }
  } catch {
    return null
  }
}

// ── LLM extraction ────────────────────────────────────────────────────────────

interface LoraRoutingMetadata {
  whenToUse: string
  exampleRequests: string[]
  isStylisticLora: boolean
}

async function extractLoraRoutingMetadata(
  lora: { name: string; description: string; triggerTokens: string[] },
  model: string,
): Promise<LoraRoutingMetadata | null> {
  const context = [
    `Name: ${lora.name}`,
    lora.description ? `Description: ${lora.description.slice(0, 800)}` : '',
    lora.triggerTokens.length > 0 ? `Trigger words: ${lora.triggerTokens.join(', ')}` : '',
  ].filter(Boolean).join('\n')

  const extractTool = {
    type: 'function' as const,
    function: {
      name: 'set_routing_metadata',
      description: 'Set routing metadata for a LoRA model',
      parameters: {
        type: 'object',
        required: ['when_to_use', 'example_requests', 'is_stylistic'],
        properties: {
          when_to_use: {
            type: 'string',
            description: 'One concise sentence (≤80 chars) describing when this LoRA should be used',
          },
          example_requests: {
            type: 'array',
            items: { type: 'string' },
            description: '2–5 short example user prompts that would match this LoRA',
          },
          is_stylistic: {
            type: 'boolean',
            description: 'True if this LoRA changes art style (not a portrait/character/object LoRA)',
          },
        },
      },
    },
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await ollamaChat(
        model,
        [
          { role: 'system', content: 'You extract routing metadata for LoRA models used in AI image generation. Be concise.' },
          { role: 'user', content: `Extract routing metadata for this LoRA:\n\n${context}` },
        ],
        [extractTool],
        { temperature: 0.1, num_predict: 256 },
      )

      const call = resp.message?.tool_calls?.[0]?.function
      if (!call || call.name !== 'set_routing_metadata') continue

      const args = call.arguments as {
        when_to_use?: string
        example_requests?: unknown[]
        is_stylistic?: boolean
      }

      const whenToUse = (args.when_to_use ?? '').slice(0, 80)
      const exampleRequests = (args.example_requests ?? [])
        .filter((e): e is string => typeof e === 'string')
        .slice(0, 5)
      const isStylisticLora = args.is_stylistic ?? false

      if (!whenToUse) continue

      return { whenToUse, exampleRequests, isStylisticLora }
    } catch { /* retry */ }
  }
  return null
}

// ── Background extraction trigger ─────────────────────────────────────────────
// Fire-and-forget after DB insert. Fetches CivitAI metadata if civitaiId is
// set, then runs LLM extraction and writes routing fields back to the DB.

function triggerBackgroundExtract(loraId: string): void {
  ;(async () => {
    try {
      const model = (
        (await getAppSetting('router_llm_model') as string | null) ??
        (await getAppSetting('model') as string | null) ??
        ''
      )
      if (!model) return

      const [row] = await db.select().from(imageLoras).where(eq(imageLoras.id, loraId)).limit(1)
      if (!row) return

      let description = row.description ?? ''
      let triggerTokens: string[] = []
      try { triggerTokens = sanitizeTriggerTokens(JSON.parse(row.triggerTokens)) } catch { /* ignore */ }

      // Enrich from CivitAI if we have a model ID. trainedWords routinely
      // contain literal "<lora:...>" syntax and comma-joined tag dumps, so
      // sanitize before merging (this also scrubs legacy junk on re-extract).
      let civitaiNsfw: boolean | undefined
      if (row.civitaiId) {
        const civitaiMeta = await fetchCivitAIMetadata(Number(row.civitaiId))
        if (civitaiMeta) {
          if (civitaiMeta.description) description = civitaiMeta.description
          if (civitaiMeta.trainedWords.length > 0) {
            triggerTokens = sanitizeTriggerTokens([...triggerTokens, ...civitaiMeta.trainedWords])
          }
          civitaiNsfw = civitaiMeta.nsfw
        }
      }

      // Re-run adult detection with enriched data
      const keywords = await getAdultKeywords()
      const isAdult = detectIsAdult(row.name, description, civitaiNsfw, keywords)

      if (!description && triggerTokens.length === 0 && civitaiNsfw === undefined) {
        // Still update isAdult even if we have no other data
        await db.update(imageLoras).set({ isAdult, updatedAt: new Date() }).where(eq(imageLoras.id, loraId))
        return
      }

      const meta = await extractLoraRoutingMetadata(
        { name: row.name, description, triggerTokens },
        model,
      )
      if (!meta) {
        await db.update(imageLoras).set({ isAdult, updatedAt: new Date() }).where(eq(imageLoras.id, loraId))
        return
      }

      await db.update(imageLoras).set({
        whenToUse: meta.whenToUse,
        exampleRequests: JSON.stringify(meta.exampleRequests),
        isStylisticLora: meta.isStylisticLora,
        isAdult,
        // Persist enriched trigger tokens if CivitAI added new ones
        triggerTokens: JSON.stringify(triggerTokens),
        updatedAt: new Date(),
      }).where(eq(imageLoras.id, loraId))
    } catch { /* non-fatal background task */ }
  })()
}

// ── Category routes ────────────────────────────────────────────────────────────

adminImageLoras.get('/categories', requireAdmin, async (c) => {
  const rows = await db.select().from(imageLoraCategories).orderBy(asc(imageLoraCategories.sortOrder))
  return c.json(rows)
})

adminImageLoras.post('/categories', requireAdmin, async (c) => {
  const body = await c.req.json() as { name: string; sortOrder?: number }
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)

  const now = new Date()
  const id = crypto.randomUUID()
  await db.insert(imageLoraCategories).values({
    id,
    name: body.name.trim(),
    sortOrder: body.sortOrder ?? 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  const [row] = await db.select().from(imageLoraCategories).where(eq(imageLoraCategories.id, id)).limit(1)
  return c.json(row, 201)
})

adminImageLoras.patch('/categories/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as { name?: string; sortOrder?: number; enabled?: boolean }

  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name !== undefined) update['name'] = body.name.trim()
  if (body.sortOrder !== undefined) update['sortOrder'] = body.sortOrder
  if (body.enabled !== undefined) update['enabled'] = body.enabled

  await db.update(imageLoraCategories).set(update).where(eq(imageLoraCategories.id, id))
  const [row] = await db.select().from(imageLoraCategories).where(eq(imageLoraCategories.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

adminImageLoras.delete('/categories/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  await db.delete(imageLoraCategories).where(eq(imageLoraCategories.id, id))
  return c.json({ ok: true })
})

// ── LoRA catalog routes ────────────────────────────────────────────────────────

adminImageLoras.get('/', requireAdmin, async (c) => {
  const rows = await db
    .select({
      id: imageLoras.id,
      name: imageLoras.name,
      description: imageLoras.description,
      categoryId: imageLoras.categoryId,
      categoryName: imageLoraCategories.name,
      sourceUrl: imageLoras.sourceUrl,
      author: imageLoras.author,
      baseFamilies: imageLoras.baseFamilies,
      sha256: imageLoras.sha256,
      sizeBytes: imageLoras.sizeBytes,
      filePath: imageLoras.filePath,
      triggerTokens: imageLoras.triggerTokens,
      defaultWeight: imageLoras.defaultWeight,
      minWeight: imageLoras.minWeight,
      maxWeight: imageLoras.maxWeight,
      enabled: imageLoras.enabled,
      thumbnailUrl: imageLoras.thumbnailUrl,
      styleLabel: imageLoras.styleLabel,
      isAdult: imageLoras.isAdult,
      createdAt: imageLoras.createdAt,
    })
    .from(imageLoras)
    .leftJoin(imageLoraCategories, eq(imageLoras.categoryId, imageLoraCategories.id))
    .orderBy(asc(imageLoras.name))

  return c.json(rows.map(r => ({
    ...r,
    triggerTokens: JSON.parse(r.triggerTokens) as string[],
    baseFamilies: JSON.parse(r.baseFamilies) as string[],
    fileExists: existsSync(r.filePath),
  })))
})

adminImageLoras.patch('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as {
    name?: string
    description?: string
    categoryId?: string | null
    triggerTokens?: string[]
    defaultWeight?: number
    minWeight?: number
    maxWeight?: number
    enabled?: boolean
    thumbnailUrl?: string | null
    styleLabel?: string | null
    isAdult?: boolean
  }

  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name !== undefined) update['name'] = body.name.trim()
  if (body.description !== undefined) update['description'] = body.description
  if ('categoryId' in body) update['categoryId'] = body.categoryId
  if (body.triggerTokens !== undefined) update['triggerTokens'] = JSON.stringify(sanitizeTriggerTokens(body.triggerTokens))
  if (body.defaultWeight !== undefined) update['defaultWeight'] = body.defaultWeight
  if (body.minWeight !== undefined) update['minWeight'] = body.minWeight
  if (body.maxWeight !== undefined) update['maxWeight'] = body.maxWeight
  if (body.enabled !== undefined) update['enabled'] = body.enabled
  if ('thumbnailUrl' in body) update['thumbnailUrl'] = body.thumbnailUrl
  if ('styleLabel' in body) update['styleLabel'] = body.styleLabel
  if (body.isAdult !== undefined) update['isAdult'] = body.isAdult

  await db.update(imageLoras).set(update).where(eq(imageLoras.id, id))
  const [row] = await db.select().from(imageLoras).where(eq(imageLoras.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

adminImageLoras.delete('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  await db.delete(imageLoras).where(eq(imageLoras.id, id))
  return c.json({ ok: true })
})

// ── File upload ────────────────────────────────────────────────────────────────

adminImageLoras.post('/import-file', requireAdmin, async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'file is required' }, 400)

  const ext = extname(file.name).toLowerCase()
  if (ext !== '.safetensors' && ext !== '.ckpt' && ext !== '.pt') {
    return c.json({ error: 'Only .safetensors, .ckpt, or .pt files are supported' }, 400)
  }

  const dir = lorasDir()
  await mkdir(dir, { recursive: true })

  // Sanitize filename
  const safeName = basename(file.name).replace(/[^\w\-.]/g, '_')
  const destPath = join(dir, safeName)

  const buffer = await file.arrayBuffer()
  await writeFile(destPath, Buffer.from(buffer))

  const sizeBytes = buffer.byteLength
  const nameWithoutExt = safeName.replace(/\.[^.]+$/, '').replace(/_/g, ' ')

  // A .safetensors upload must actually be one (not a renamed pickle or a
  // truncated copy); a .ckpt/.pt upload is converted right away because the
  // ComfyUI workflow can only load .safetensors LoRAs.
  let finalPath = destPath
  let converted = false
  if (ext === '.safetensors') {
    if (!(await validateSafetensorsFile(destPath))) {
      await unlink(destPath).catch(() => {})
      return c.json({ error: 'That file is not a valid .safetensors model (corrupt or misnamed).' }, 400)
    }
  } else {
    const st = await ensureLoraSafetensors(destPath)
    if (st) {
      finalPath = st
      converted = true
    }
    // Conversion failure is non-fatal here: the file stays registered and the
    // resolver retries once ComfyUI's python is available; until then the
    // style shows as unavailable in the picker instead of failing silently.
  }

  return c.json({ filePath: finalPath, fileName: basename(finalPath), sizeBytes, suggestedName: nameWithoutExt, converted })
})

adminImageLoras.post('/', requireAdmin, async (c) => {
  const body = await c.req.json() as {
    name: string
    description?: string
    categoryId?: string
    filePath: string
    sourceUrl?: string
    author?: string
    triggerTokens?: string[]
    defaultWeight?: number
    thumbnailUrl?: string
    styleLabel?: string
  }

  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
  if (!body.filePath?.trim()) return c.json({ error: 'filePath is required' }, 400)
  if (!existsSync(body.filePath)) return c.json({ error: 'File not found at specified path' }, 400)

  const now = new Date()
  const id = crypto.randomUUID()

  // Compute file size
  const stat = await Bun.file(body.filePath).size

  const civitaiId = body.sourceUrl
    ? (body.sourceUrl.match(/civitai\.com\/models\/(\d+)/)?.[1] ?? null)
    : null

  const keywords = await getAdultKeywords()
  const isAdult = detectIsAdult(body.name.trim(), body.description ?? '', undefined, keywords)

  await db.insert(imageLoras).values({
    id,
    name: body.name.trim(),
    description: body.description ?? null,
    categoryId: body.categoryId ?? null,
    sourceUrl: body.sourceUrl ?? null,
    author: body.author ?? null,
    baseFamilies: '["sdxl"]',
    sha256: null,
    sizeBytes: typeof stat === 'number' ? stat : null,
    filePath: body.filePath,
    triggerTokens: JSON.stringify(sanitizeTriggerTokens(body.triggerTokens ?? [])),
    defaultWeight: body.defaultWeight ?? 1.0,
    minWeight: 0.0,
    maxWeight: 2.0,
    enabled: true,
    isAdult,
    thumbnailUrl: body.thumbnailUrl ?? null,
    styleLabel: body.styleLabel ?? null,
    civitaiId,
    createdAt: now,
    updatedAt: now,
  })

  triggerBackgroundExtract(id)

  const [row] = await db.select().from(imageLoras).where(eq(imageLoras.id, id)).limit(1)
  return c.json(row, 201)
})

// ── Civitai search (Meilisearch + civarchive) ─────────────────────────────────

const SDXL_BASE_MODELS = [
  'SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM', 'SDXL Distilled',
  'SDXL Hyper', 'SDXL Lightning', 'SDXL Turbo', 'Pony', 'Pony V7',
  'Illustrious', 'Illustrious XL v0.1', 'NoobAI XL', 'NoobAI XL Epsilon Pred',
]
const MEILI_BASE = 'https://search.civitai.com'
const IMAGE_BUCKET = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA'
// Public read-only key embedded in civitai's browser bundle
const MEILI_KEY_DEFAULT = '8c46eb2508e21db1e9828a97968d91ab1ca1caa5f70a00e88a2ba1e286603b61'

type CivitaiSource = 'civitai' | 'civitai_red' | 'civarchive'
// Lower = preferred when deduplicating hits across sources
const SOURCE_PREF: Record<CivitaiSource, number> = { civarchive: 0, civitai_red: 1, civitai: 2 }

interface SearchHit {
  modelId: number
  versionId: number
  name: string
  versionName?: string
  author?: string
  baseModel?: string
  downloadUrl: string
  fileName?: string
  sizeKb?: number
  triggerTokens: string[]
  sourceUrl: string
  thumbnailUrl?: string
  downloadCount: number
  thumbsUpCount: number
  createdAt: number
  isNsfw: boolean
  source: CivitaiSource
  allowCommercialUse?: string
  allowDerivatives?: boolean
  allowNoCredit?: boolean
}

function buildMeiliFilter(nsfw: boolean): string[] {
  const clauses = SDXL_BASE_MODELS.map(m => `versions.baseModel="${m}"`)
  const filters: string[] = ['type=LORA', `(${clauses.join(' OR ')})`]
  if (!nsfw) filters.push('nsfwLevel=1')
  return filters
}

function pickMeiliThumbnail(images: unknown): string | null {
  if (!Array.isArray(images)) return null
  for (const e of images) {
    if (typeof e !== 'object' || !e) continue
    const entry = e as Record<string, unknown>
    if (entry.type !== undefined && entry.type !== 'image') continue
    const uuid = entry.url ? String(entry.url) : ''
    if (!uuid) continue
    const name = entry.name ? String(entry.name) : `${uuid}.jpeg`
    return `${IMAGE_BUCKET}/${uuid}/width=450/${name}`
  }
  return null
}

function parseMeiliHit(payload: Record<string, unknown>, source: 'civitai' | 'civitai_red'): SearchHit | null {
  const modelId = Number(payload.id)
  if (!modelId) return null

  // Use `version` (singular) — Meilisearch pre-selects the best matching version for our filter.
  // Fall back to versions[0] only if the singular field is absent.
  const rawVersion = (typeof payload.version === 'object' && payload.version !== null)
    ? payload.version as Record<string, unknown>
    : Array.isArray(payload.versions) ? (payload.versions as Array<Record<string, unknown>>)[0] : null
  if (!rawVersion) return null
  const version = rawVersion

  const versionId = Number(version.id)
  if (!versionId) return null

  const user = typeof payload.user === 'object' && payload.user !== null ? payload.user as Record<string, unknown> : null
  const metrics = typeof payload.metrics === 'object' && payload.metrics !== null ? payload.metrics as Record<string, unknown> : null
  const triggers: string[] = []
  if (Array.isArray(version.trainedWords)) {
    for (const w of version.trainedWords) {
      if (typeof w === 'string' && w.trim()) triggers.push(w.trim().slice(0, 200))
      if (triggers.length >= 10) break
    }
  }

  const perm = typeof payload.permission === 'object' && payload.permission !== null
    ? payload.permission as Record<string, unknown> : payload
  const webBase = source === 'civitai_red' ? 'https://civitai.red' : 'https://civitai.com'
  return {
    modelId, versionId,
    name: String(payload.name ?? `Model ${modelId}`),
    versionName: version.name ? String(version.name) : undefined,
    author: user?.username ? String(user.username) : undefined,
    baseModel: String(version.baseModel ?? ''),
    downloadUrl: `https://civitai.com/api/download/models/${versionId}`,
    fileName: `${String(payload.name ?? modelId)}-${versionId}.safetensors`,
    triggerTokens: triggers,
    sourceUrl: `${webBase}/models/${modelId}?modelVersionId=${versionId}`,
    thumbnailUrl: pickMeiliThumbnail(payload.images) ?? undefined,
    downloadCount: Number(metrics?.downloadCount ?? 0),
    thumbsUpCount: Number(metrics?.thumbsUpCount ?? 0),
    createdAt: payload.publishedAt ? new Date(String(payload.publishedAt)).getTime() : 0,
    isNsfw: Boolean(payload.nsfw),
    source,
    allowCommercialUse: perm.allowCommercialUse !== undefined ? String(perm.allowCommercialUse) : undefined,
    allowDerivatives: perm.allowDerivatives !== undefined ? Boolean(perm.allowDerivatives) : undefined,
    allowNoCredit: perm.allowNoCredit !== undefined ? Boolean(perm.allowNoCredit) : undefined,
  }
}

async function fetchMeiliSource(source: 'civitai' | 'civitai_red', query: string, nsfw: boolean, offset: number, limit: number): Promise<{ hits: SearchHit[]; nextCursor: string; total: number }> {
  const key = process.env.CIVITAI_SEARCH_KEY || MEILI_KEY_DEFAULT
  const res = await fetch(`${MEILI_BASE}/multi-search`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ indexUid: 'models_v9', q: query, filter: buildMeiliFilter(nsfw), offset, limit }] }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`meili_${res.status}`)
  const data = await res.json() as { results?: Array<{ hits: unknown[]; estimatedTotalHits: number }> }
  const bucket = data.results?.[0]
  const rawHits = Array.isArray(bucket?.hits) ? bucket!.hits : []
  const total = bucket?.estimatedTotalHits ?? rawHits.length
  const hits: SearchHit[] = []
  for (const raw of rawHits) {
    const hit = parseMeiliHit(raw as Record<string, unknown>, source)
    if (hit) hits.push(hit)
  }
  return { hits, nextCursor: (offset + limit) < total ? String(offset + limit) : '', total }
}

function parseCivarchiveRow(row: Record<string, unknown>): SearchHit | null {
  if (row.kind !== 'version') return null
  if (row.type !== undefined && row.type !== 'LORA') return null
  const versionId = parseInt(String(row.id ?? '').replace(/\D/g, ''))
  if (!versionId) return null
  const urlField = String(row.url ?? '')
  const modelMatch = urlField.match(/\/models\/(\d+)/)
  if (!modelMatch) return null
  const modelId = parseInt(modelMatch[1])
  const name = String(row.name ?? `Version ${versionId}`)
  return {
    modelId, versionId, name,
    author: row.username ? String(row.username) : undefined,
    baseModel: String(row.base_model ?? ''),
    downloadUrl: `https://civitai.com/api/download/models/${versionId}`,
    fileName: `${name}-${versionId}.safetensors`,
    triggerTokens: [],
    sourceUrl: `https://civarchive.com/models/${modelId}?modelVersionId=${versionId}`,
    thumbnailUrl: row.image_url ? String(row.image_url) : undefined,
    downloadCount: Number(row.download_count ?? 0),
    thumbsUpCount: 0,
    createdAt: row.created_at ? new Date(String(row.created_at)).getTime() : 0,
    isNsfw: Boolean(row.is_nsfw),
    source: 'civarchive',
  }
}

async function fetchCivarchive(query: string, nsfw: boolean, cursor: string, limit: number): Promise<{ hits: SearchHit[]; nextCursor: string; total: number }> {
  const page = /^\d+$/.test(cursor) ? parseInt(cursor) : 1
  const params = new URLSearchParams({
    type: 'LORA', limit: String(Math.min(limit, 50)), page: String(page),
    rating: nsfw ? 'all' : 'safe',
    base_model: SDXL_BASE_MODELS.join(','),
  })
  if (query) params.set('q', query)
  const res = await fetch(`https://civarchive.com/api/search?${params}`, {
    headers: { 'User-Agent': 'loki-doki/1.0' },
    signal: AbortSignal.timeout(4_000),
  })
  if (!res.ok) throw new Error(`civarchive_${res.status}`)
  const data = await res.json() as { results?: unknown[]; total?: number }
  const rows = Array.isArray(data.results) ? data.results : []
  const hits: SearchHit[] = []
  for (const row of rows) {
    const hit = parseCivarchiveRow(row as Record<string, unknown>)
    if (hit) hits.push(hit)
  }
  return { hits, nextCursor: hits.length > 0 ? String(page + 1) : '', total: Number(data.total ?? 0) }
}

type SearchCacheEntry = { hits: SearchHit[]; nextCursors: Record<string, string>; hasNextPage: boolean; ts: number }
const searchCache = new Map<string, SearchCacheEntry>()
const SEARCH_CACHE_TTL = 5 * 60 * 1000

type TaskResult = { source: CivitaiSource; hits: SearchHit[]; nextCursor: string; total: number; error: string | undefined }

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>(res => setTimeout(() => res(fallback), ms))])
}

adminImageLoras.post('/civitai-search', requireAdmin, async (c) => {
  if (await isGloballyOffline()) return c.json({ error: 'Offline mode is active — internet search is unavailable.' }, 503)
  const body = await c.req.json() as {
    query?: string
    limit?: number
    cursors?: Record<string, string>
    sort?: 'downloads' | 'relevance' | 'newest' | 'highest_rated'
    nsfw?: boolean
    sources?: CivitaiSource[]
  }

  const query = body.query?.trim() ?? ''
  const limit = Math.min(Math.max(Number(body.limit ?? 20), 1), 50)
  const nsfw = body.nsfw ?? false
  const cursors = body.cursors ?? {}
  const selectedSources: CivitaiSource[] = body.sources?.length ? body.sources : ['civitai', 'civarchive']

  const cacheKey = JSON.stringify({ query, sort: body.sort ?? 'downloads', nsfw, cursors, sources: selectedSources })
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
    return c.json({ hits: cached.hits, nextCursors: cached.nextCursors, hasNextPage: cached.hasNextPage })
  }

  const empty = (source: CivitaiSource): TaskResult => ({ source, hits: [], nextCursor: '', total: 0, error: undefined })

  // Each source gets its own timeout — secondary sources (civarchive) use a shorter
  // one so they can't block fast primary (civitai) results.
  const tasks = selectedSources.map(source => {
    const isPrimary = source === 'civitai' || source === 'civitai_red'
    const task = async (): Promise<TaskResult> => {
      try {
        if (isPrimary) {
          const cursor = cursors[source] ?? ''
          const offset = /^\d+$/.test(cursor) ? parseInt(cursor) : 0
          const result = await fetchMeiliSource(source, query, nsfw, offset, limit)
          return { source, ...result, error: undefined }
        } else {
          const result = await fetchCivarchive(query, nsfw, cursors['civarchive'] ?? '', limit)
          return { source, ...result, error: undefined }
        }
      } catch (err) {
        return { source, hits: [], nextCursor: '', total: 0, error: String(err) }
      }
    }
    return withTimeout(task(), isPrimary ? 8_000 : 2_000, empty(source))
  })

  const results = await Promise.all(tasks)

  const byVersion = new Map<number, SearchHit>()
  const nextCursors: Record<string, string> = {}
  const perSourceErrors: Record<string, string> = {}

  for (const result of results) {
    if (result.error) perSourceErrors[result.source] = result.error
    if (result.nextCursor) nextCursors[result.source] = result.nextCursor
    for (const hit of result.hits) {
      const existing = byVersion.get(hit.versionId)
      if (!existing || SOURCE_PREF[hit.source] < SOURCE_PREF[existing.source]) {
        byVersion.set(hit.versionId, hit)
      }
    }
  }

  let hits: SearchHit[]
  if (body.sort === 'relevance') {
    const buckets = new Map<CivitaiSource, SearchHit[]>()
    for (const hit of byVersion.values()) {
      const b = buckets.get(hit.source) ?? []
      b.push(hit); buckets.set(hit.source, b)
    }
    for (const b of buckets.values()) b.sort((a, b) => b.downloadCount - a.downloadCount)
    hits = []
    let remaining = true
    const iters = selectedSources.map(s => (buckets.get(s) ?? [])[Symbol.iterator]())
    while (remaining) {
      remaining = false
      for (const it of iters) {
        const { value, done } = it.next()
        if (!done) { hits.push(value!); remaining = true }
      }
    }
  } else if (body.sort === 'newest') {
    hits = Array.from(byVersion.values()).sort((a, b) => b.createdAt - a.createdAt)
  } else if (body.sort === 'highest_rated') {
    hits = Array.from(byVersion.values()).sort((a, b) => b.thumbsUpCount - a.thumbsUpCount)
  } else {
    hits = Array.from(byVersion.values()).sort((a, b) => b.downloadCount - a.downloadCount)
  }

  const response = { hits, nextCursors, hasNextPage: Object.keys(nextCursors).length > 0 }
  searchCache.set(cacheKey, { ...response, ts: Date.now() })
  return c.json({ ...response, perSourceErrors })
})

// ── Recover orphaned files from disk ──────────────────────────────────────────

adminImageLoras.post('/recover-disk', requireAdmin, async (c) => {
  const dir = lorasDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return c.json({ recovered: 0 })
  }

  const existing = await db.select({ filePath: imageLoras.filePath }).from(imageLoras)
  const knownPaths = new Set(existing.map(r => r.filePath))

  const EXTS = new Set(['.safetensors', '.ckpt', '.pt'])
  let recovered = 0

  for (const file of files) {
    if (file.endsWith('.part')) continue
    if (!EXTS.has('.' + file.split('.').pop()!)) continue
    const fullPath = join(dir, file)
    if (knownPaths.has(fullPath)) continue

    const fileStat = await stat(fullPath)
    const name = file.replace(/\.[^.]+$/, '').replace(/_v\d+$/, '').replace(/_/g, ' ')
    const now = new Date()
    await db.insert(imageLoras).values({
      id: crypto.randomUUID(),
      name,
      description: null,
      categoryId: null,
      sourceUrl: null,
      author: null,
      baseFamilies: '["sdxl"]',
      sha256: null,
      sizeBytes: fileStat.size,
      filePath: fullPath,
      triggerTokens: '[]',
      defaultWeight: 1.0,
      minWeight: 0.0,
      maxWeight: 2.0,
      enabled: true,
      thumbnailUrl: null,
      styleLabel: null,
      civitaiId: null,
      createdAt: now,
      updatedAt: now,
    })
    recovered++
  }

  return c.json({ recovered })
})

// ── Civitai import (SSE progress) ─────────────────────────────────────────────

adminImageLoras.post('/civitai-import', requireAdmin, async (c) => {
  if (await isDownloadBlocked()) return c.json({ error: 'Offline mode is active — downloads are unavailable.' }, 503)
  const body = await c.req.json() as {
    downloadUrl: string
    fileName: string
    name: string
    description?: string
    author?: string
    sourceUrl?: string
    thumbnailUrl?: string
    triggerTokens?: string[]
    sha256?: string
    categoryId?: string
    civitaiModelId?: number
    versionId?: number
    styleLabel?: string
    isNsfw?: boolean
  }

  if (!body.downloadUrl) return c.json({ error: 'downloadUrl is required' }, 400)
  if (!body.fileName) return c.json({ error: 'fileName is required' }, 400)

  const dir = lorasDir()
  await mkdir(dir, { recursive: true })

  const bodyExt = (body.fileName.split('.').pop() ?? 'safetensors').toLowerCase()
  const slug = body.name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  const suffix = body.versionId ? `_v${body.versionId}` : ''
  const pathsFor = (ext: string) => {
    const safeName = `${slug}${suffix}.${ext}`
    const destPath = join(dir, safeName)
    return { safeName, destPath, partPath: destPath + '.part' }
  }

  let dlHost = ''
  try { dlHost = new URL(body.downloadUrl).hostname.toLowerCase() } catch { /* validated below */ }
  const isCivitai = dlHost === 'civitai.com' || dlHost.endsWith('.civitai.com')

  // Ask Civitai's download API for the SafeTensor build explicitly; the bare
  // URL returns the version's primary file, which can be a PickleTensor. Models
  // that only ship a pickle fall back to the original URL and get converted
  // locally after download.
  const candidates: Array<{ url: string; ext: string }> = []
  if (isCivitai && /\/api\/download\/models\/\d+/.test(body.downloadUrl)) {
    try {
      const u = new URL(body.downloadUrl)
      if (!u.searchParams.has('format')) {
        u.searchParams.set('type', 'Model')
        u.searchParams.set('format', 'SafeTensor')
        candidates.push({ url: u.toString(), ext: 'safetensors' })
      }
    } catch { /* fall through to the original URL */ }
  }
  if (!candidates.some(cand => cand.url === body.downloadUrl)) {
    candidates.push({ url: body.downloadUrl, ext: bodyExt })
  }

  // Check if already downloaded (under any candidate extension)
  const existingPaths = [...new Set(candidates.map(cand => pathsFor(cand.ext).destPath))]
  const destPath = existingPaths.find(p => existsSync(p)) ?? pathsFor(candidates[0].ext).destPath
  if (existsSync(destPath)) {
    const [existing] = await db.select({ id: imageLoras.id })
      .from(imageLoras)
      .where(eq(imageLoras.filePath, destPath))
      .limit(1)
    if (existing) {
      return c.json({ error: 'A LoRA with this filename already exists', filePath: destPath }, 409)
    }
    // File on disk but no DB record — re-register it
    const now = new Date()
    const id = crypto.randomUUID()
    const civitaiIdStr = body.civitaiModelId
      ? String(body.civitaiModelId)
      : (body.sourceUrl?.match(/civitai\.com\/models\/(\d+)/)?.[1] ?? null)
    const fileStat = Bun.file(destPath)
    const reregKws = await getAdultKeywords()
    const reregIsAdult = detectIsAdult(body.name, body.description ?? '', body.isNsfw, reregKws)
    await db.insert(imageLoras).values({
      id,
      name: body.name,
      description: body.description ?? null,
      categoryId: body.categoryId ?? null,
      sourceUrl: body.sourceUrl ?? null,
      author: body.author ?? null,
      baseFamilies: '["sdxl"]',
      sha256: body.sha256 ?? null,
      sizeBytes: await fileStat.size,
      filePath: destPath,
      triggerTokens: JSON.stringify(sanitizeTriggerTokens(body.triggerTokens ?? [])),
      defaultWeight: 1.0,
      minWeight: 0.0,
      maxWeight: 2.0,
      enabled: true,
      thumbnailUrl: body.thumbnailUrl ?? null,
      styleLabel: body.styleLabel ?? null,
      civitaiId: civitaiIdStr,
      isAdult: reregIsAdult,
      createdAt: now,
      updatedAt: now,
    })
    triggerBackgroundExtract(id)
    return c.json({ loraId: id, filePath: destPath, reregistered: true })
  }

  const apiKey = process.env.CIVITAI_API_KEY || (await getAppSetting('civitai_api_key') as string | null) || ''
  const baseHeaders: Record<string, string> = { 'User-Agent': 'loki-doki/1.0' }
  // Only attach the Civitai API key when downloading from Civitai, so a mistyped
  // or hostile downloadUrl can't exfiltrate the key to a third-party host.
  if (apiKey && isCivitai) baseHeaders['Authorization'] = `Bearer ${apiKey}`

  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    let activePartPath: string | null = null
    try {
      await stream.writeSSE({ event: 'start', data: JSON.stringify({ fileName: pathsFor(candidates[0].ext).safeName }) })

      // Follow redirects manually, re-validating each hop against the SSRF guard (a validated
      // public host can still 302 to an internal address). Drop the Civitai auth header the
      // moment the origin changes so a redirect can't exfiltrate the key to a third-party host.
      const openDownload = async (url: string, headers: Record<string, string>): Promise<Response | 'blocked'> => {
        try { await assertPublicUrl(url) } catch { return 'blocked' }
        let current = url
        const startOrigin = new URL(current).origin
        let res: Response
        for (let hop = 0; ; hop++) {
          const hopHeaders = new URL(current).origin === startOrigin
            ? headers
            : Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'))
          res = await fetch(current, { headers: hopHeaders, redirect: 'manual', signal: AbortSignal.timeout(300_000) })
          if (res.status >= 300 && res.status < 400 && res.headers.has('location') && hop < 6) {
            res.body?.cancel().catch(() => {})
            current = new URL(res.headers.get('location')!, current).toString()
            try { await assertPublicUrl(current) } catch { return 'blocked' }
            continue
          }
          break
        }
        return res
      }

      // Try candidates in order (SafeTensor build first, original URL last).
      let dlRes: Response | null = null
      let chosen: { url: string; ext: string } | null = null
      let resumeFrom = 0
      let lastStatus = 0
      let sawBlocked = false
      for (const cand of candidates) {
        const headers = { ...baseHeaders }
        resumeFrom = 0
        // Resume this candidate's partial download if one is on disk
        try {
          const size = await Bun.file(pathsFor(cand.ext).partPath).size
          if (size > 0) { resumeFrom = size; headers['Range'] = `bytes=${resumeFrom}-` }
        } catch { /* no partial */ }
        const res = await openDownload(cand.url, headers)
        if (res === 'blocked') { sawBlocked = true; continue }
        if (res.ok || res.status === 206) { dlRes = res; chosen = cand; break }
        lastStatus = res.status
        res.body?.cancel().catch(() => {})
      }

      if (!dlRes || !chosen) {
        const hint = lastStatus === 401
          ? 'This model requires a Civitai API key — add one via the 🔑 key icon.'
          : lastStatus === 404
          ? 'Model version not found on Civitai — it may have been deleted. Try downloading manually from the source URL.'
          : lastStatus > 0
          ? `Download failed (${lastStatus})`
          : sawBlocked
          ? 'Invalid or blocked download URL'
          : 'Download failed'
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: hint }) })
        return
      }
      if (!dlRes.body) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'No response body' }) })
        return
      }

      const { destPath: dlDest, partPath } = pathsFor(chosen.ext)
      activePartPath = partPath

      const isPartial = dlRes.status === 206
      const contentLength = parseInt(dlRes.headers.get('content-length') ?? '0', 10)
      const total = isPartial ? resumeFrom + contentLength : contentLength

      const fileStream = createWriteStream(partPath, { flags: isPartial ? 'a' : 'w' })
      const reader = dlRes.body.getReader()

      let completed = isPartial ? resumeFrom : 0
      let lastEmit = 0
      let lastBytes = completed
      let lastTime = Date.now()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        fileStream.write(value)
        completed += value.length

        const now = Date.now()
        if (now - lastEmit >= 500 || completed >= total) {
          const elapsed = (now - lastTime) / 1000
          const speedBps = elapsed > 0 ? (completed - lastBytes) / elapsed : 0
          const etaSeconds = speedBps > 0 && total > 0 ? (total - completed) / speedBps : 0
          await stream.writeSSE({
            event: 'progress',
            data: JSON.stringify({ completed, total, speedBps: Math.round(speedBps), etaSeconds: Math.round(etaSeconds) }),
          })
          lastEmit = now
          lastTime = now
          lastBytes = completed
        }
      }

      await new Promise<void>((res, rej) => fileStream.end((err?: Error | null) => (err ? rej(err) : res())))
      await rename(partPath, dlDest)
      activePartPath = null

      // Integrity gate: a Civitai error page saved under a .safetensors name
      // must never register as a working style, and a pickle build converts to
      // safetensors right away (the ComfyUI workflow can only load safetensors).
      let finalPath = dlDest
      let warning: string | undefined
      if (dlDest.toLowerCase().endsWith('.safetensors')) {
        if (!(await validateSafetensorsFile(dlDest))) {
          await unlink(dlDest).catch(() => {})
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'The downloaded file is not a valid safetensors model. Civitai may have returned an error page instead of the file; if this is a gated model, add a Civitai API key.' }) })
          return
        }
      } else {
        const st = await ensureLoraSafetensors(dlDest)
        if (st) {
          finalPath = st
        } else {
          // Keep the pickle registered: the resolver retries conversion later
          // (e.g. once ComfyUI is installed) and the picker shows it as
          // unavailable until then, instead of pretending it works.
          warning = 'Only a pickle build was available and converting it to safetensors failed. The style will stay unavailable until conversion succeeds.'
        }
      }

      // Create DB entry
      const now = new Date()
      const id = crypto.randomUUID()
      const civitaiIdStr = body.civitaiModelId
        ? String(body.civitaiModelId)
        : (body.sourceUrl?.match(/civitai\.com\/models\/(\d+)/)?.[1] ?? null)

      const dlKws = await getAdultKeywords()
      const dlIsAdult = detectIsAdult(body.name, body.description ?? '', body.isNsfw, dlKws)

      await db.insert(imageLoras).values({
        id,
        name: body.name,
        description: body.description ?? null,
        categoryId: body.categoryId ?? null,
        sourceUrl: body.sourceUrl ?? null,
        author: body.author ?? null,
        baseFamilies: '["sdxl"]',
        sha256: body.sha256 ?? null,
        sizeBytes: (await Bun.file(finalPath).size) || completed,
        filePath: finalPath,
        triggerTokens: JSON.stringify(sanitizeTriggerTokens(body.triggerTokens ?? [])),
        defaultWeight: 1.0,
        minWeight: 0.0,
        maxWeight: 2.0,
        enabled: true,
        thumbnailUrl: body.thumbnailUrl ?? null,
        styleLabel: body.styleLabel ?? null,
        civitaiId: civitaiIdStr,
        isAdult: dlIsAdult,
        createdAt: now,
        updatedAt: now,
      })

      triggerBackgroundExtract(id)
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ loraId: id, filePath: finalPath, warning }) })
    } catch (err) {
      // Clean up the active candidate's partial file on error
      if (activePartPath) { try { await unlink(activePartPath) } catch { /* ignore */ } }
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: String(err) }) })
    }
  })
})

// ── User grants management ─────────────────────────────────────────────────────

// List all users with their grant state for a given LoRA
adminImageLoras.get('/:loraId/grants', requireAdmin, async (c) => {
  const loraId = c.req.param('loraId')

  const [lora] = await db.select({ id: imageLoras.id }).from(imageLoras).where(eq(imageLoras.id, loraId)).limit(1)
  if (!lora) return c.json({ error: 'Not found' }, 404)

  const allUsers = await db.select({ id: users.id, nickname: users.nickname, role: users.role }).from(users)
  const grants = await db.select().from(imageLoraUserLoraGrants).where(eq(imageLoraUserLoraGrants.loraId, loraId))
  const grantMap = new Map(grants.map(g => [g.userId, g.state]))

  return c.json(allUsers.map(u => ({
    userId: u.id,
    nickname: u.nickname,
    role: u.role,
    state: grantMap.get(u.id) ?? 'none',
  })))
})

// Set grant for a user + LoRA
adminImageLoras.put('/:loraId/grants/:userId', requireAdmin, async (c) => {
  const loraId = c.req.param('loraId')
  const userId = c.req.param('userId')
  const body = await c.req.json() as { state: 'on' | 'off' | 'none' }

  if (body.state === 'none') {
    await db.delete(imageLoraUserLoraGrants)
      .where(and(eq(imageLoraUserLoraGrants.loraId, loraId), eq(imageLoraUserLoraGrants.userId, userId)))
    return c.json({ ok: true })
  }

  // Block granting access to adult LoRAs for protected users
  if (body.state === 'on') {
    const [lora, protections] = await Promise.all([
      db.select({ isAdult: imageLoras.isAdult }).from(imageLoras).where(eq(imageLoras.id, loraId)).limit(1),
      getProtections(userId),
    ])
    if (lora[0]?.isAdult && protections.blockAdultLoras) {
      return c.json({ error: 'This user has adult LoRAs blocked. Remove that protection first.' }, 409)
    }
  }

  const now = new Date()
  await db.insert(imageLoraUserLoraGrants)
    .values({ id: crypto.randomUUID(), userId, loraId, state: body.state, updatedAt: now })
    .onConflictDoUpdate({ target: [imageLoraUserLoraGrants.userId, imageLoraUserLoraGrants.loraId], set: { state: body.state, updatedAt: now } })

  return c.json({ ok: true })
})

// List all users with their grant state for a given category
adminImageLoras.get('/categories/:categoryId/grants', requireAdmin, async (c) => {
  const categoryId = c.req.param('categoryId')

  const [cat] = await db.select({ id: imageLoraCategories.id }).from(imageLoraCategories).where(eq(imageLoraCategories.id, categoryId)).limit(1)
  if (!cat) return c.json({ error: 'Not found' }, 404)

  const allUsers = await db.select({ id: users.id, nickname: users.nickname, role: users.role }).from(users)
  const grants = await db.select().from(imageLoraUserCategoryGrants).where(eq(imageLoraUserCategoryGrants.categoryId, categoryId))
  const grantMap = new Map(grants.map(g => [g.userId, g.state]))

  return c.json(allUsers.map(u => ({
    userId: u.id,
    nickname: u.nickname,
    role: u.role,
    state: grantMap.get(u.id) ?? 'none',
  })))
})

// Set grant for a user + category
adminImageLoras.put('/categories/:categoryId/grants/:userId', requireAdmin, async (c) => {
  const categoryId = c.req.param('categoryId')
  const userId = c.req.param('userId')
  const body = await c.req.json() as { state: 'on' | 'off' | 'none' }

  if (body.state === 'none') {
    await db.delete(imageLoraUserCategoryGrants)
      .where(and(eq(imageLoraUserCategoryGrants.categoryId, categoryId), eq(imageLoraUserCategoryGrants.userId, userId)))
    return c.json({ ok: true })
  }

  const now = new Date()
  await db.insert(imageLoraUserCategoryGrants)
    .values({ id: crypto.randomUUID(), userId, categoryId, state: body.state, updatedAt: now })
    .onConflictDoUpdate({ target: [imageLoraUserCategoryGrants.userId, imageLoraUserCategoryGrants.categoryId], set: { state: body.state, updatedAt: now } })

  return c.json({ ok: true })
})

// ── Civitai API key management ────────────────────────────────────────────────

adminImageLoras.get('/civitai-key', requireAdmin, async (c) => {
  const envKey = process.env.CIVITAI_API_KEY
  const dbKey = await getAppSetting('civitai_api_key') as string | null
  return c.json({ hasKey: !!(envKey || dbKey), source: envKey ? 'env' : dbKey ? 'db' : 'none' })
})

adminImageLoras.put('/civitai-key', requireAdmin, async (c) => {
  const body = await c.req.json() as { key: string }
  const key = body.key?.trim()
  if (!key) return c.json({ error: 'key is required' }, 400)
  await setAppSetting('civitai_api_key', key)
  return c.json({ ok: true })
})

adminImageLoras.delete('/civitai-key', requireAdmin, async (c) => {
  await setAppSetting('civitai_api_key', null)
  return c.json({ ok: true })
})

export { adminImageLoras }
