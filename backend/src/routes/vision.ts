import { Hono } from 'hono'
import { join } from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { eq, and, desc } from 'drizzle-orm'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { db } from '@/db'
import { analysisResults } from '@/db/schema'
import { getVisionModel } from '@/lib/models'
import { screenImage, logCsamBlock } from '@/lib/safety/csamGuard'
import { ollamaChat, ollamaList } from '@/llm/ollama'
import { dataDir } from '@/lib/download'

const vision = new Hono<AppEnv>()

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnalysisTask = 'description' | 'scene' | 'objects' | 'text' | 'vehicles' | 'language'

export interface DetectedObject {
  label: string
  confidence: number
  // Rough area hint from VLM — "top-left" | "top-center" | "top-right" |
  // "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right"
  area?: string
}

export interface DetectedText {
  value: string
  language: string
  type: 'license_plate' | 'sign' | 'document' | 'other'
  area?: string
}

export interface DetectedVehicle {
  type: string
  brand: string | null
  model: string | null
  plate: string | null
  plateState: string | null
  color: string | null
  area?: string
}

export interface AnalysisInference {
  timeOfDay: string | null       // e.g. "daytime", "night", "dusk"
  country: string | null         // inferred from flags, plates, signs, language
  sourceType: string | null      // e.g. "security camera", "doorbell camera", "smartphone", "dashcam"
  sourceBrand: string | null     // e.g. "Nest", "Ring", "Arlo", "unknown"
  weather: string | null         // e.g. "sunny", "overcast", "rainy", "snowy"
  summary: string                // one-sentence synthesis of all evidence
}

export interface SafetyFlag {
  hazard: string           // what was detected: "fire", "smoke", "flood", "person on ground", "weapon", etc.
  context: string          // where/how it appears: "in fireplace", "on kitchen stove", "on mattress", etc.
  assessment: 'normal' | 'concerning' | 'critical'
  reason: string           // why — the contextual reasoning
  area?: string
}

export interface AnalysisResult {
  description: string
  scene: string
  inference: AnalysisInference
  safety: SafetyFlag[]
  objects: DetectedObject[]
  text: DetectedText[]
  vehicles: DetectedVehicle[]
}

const AREA_VALUES = ['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right']

// ── Per-pass schemas ──────────────────────────────────────────────────────────

const SCHEMA_CONTEXT = {
  type: 'object', required: ['description', 'scene', 'inference'],
  properties: {
    description: { type: 'string' },
    scene: { type: 'string' },
    inference: {
      type: 'object', required: ['summary'],
      properties: {
        timeOfDay:   { type: ['string', 'null'] },
        country:     { type: ['string', 'null'] },
        sourceType:  { type: ['string', 'null'] },
        sourceBrand: { type: ['string', 'null'] },
        weather:     { type: ['string', 'null'] },
        summary:     { type: 'string' },
      },
    },
  },
}

const SCHEMA_OBJECTS = {
  type: 'object', required: ['objects'],
  properties: {
    objects: {
      type: 'array',
      items: {
        type: 'object', required: ['label', 'confidence'],
        properties: {
          label:      { type: 'string' },
          confidence: { type: 'number' },
          area:       { type: 'string', enum: AREA_VALUES },
        },
      },
    },
  },
}

const SCHEMA_VEHICLES = {
  type: 'object', required: ['vehicles'],
  properties: {
    vehicles: {
      type: 'array',
      items: {
        type: 'object', required: ['type'],
        properties: {
          type:       { type: 'string' },
          brand:      { type: ['string', 'null'] },
          model:      { type: ['string', 'null'] },
          plate:      { type: ['string', 'null'] },
          plateState: { type: ['string', 'null'] },
          color:      { type: ['string', 'null'] },
          area:       { type: 'string', enum: AREA_VALUES },
        },
      },
    },
  },
}

const SCHEMA_TEXT = {
  type: 'object', required: ['text'],
  properties: {
    text: {
      type: 'array',
      items: {
        type: 'object', required: ['value', 'language', 'type'],
        properties: {
          value:    { type: 'string' },
          language: { type: 'string' },
          type:     { type: 'string', enum: ['license_plate', 'sign', 'document', 'other'] },
          area:     { type: 'string', enum: AREA_VALUES },
        },
      },
    },
  },
}

const SCHEMA_SAFETY = {
  type: 'object', required: ['safety'],
  properties: {
    safety: {
      type: 'array',
      items: {
        type: 'object', required: ['hazard', 'context', 'assessment', 'reason'],
        properties: {
          hazard:     { type: 'string' },
          context:    { type: 'string' },
          assessment: { type: 'string', enum: ['normal', 'concerning', 'critical'] },
          reason:     { type: 'string' },
          area:       { type: 'string', enum: AREA_VALUES },
        },
      },
    },
  },
}

// ── Per-pass prompts ──────────────────────────────────────────────────────────

const PREAMBLE = 'You are a precise visual analysis system. Output ONLY valid JSON matching the schema. No prose, no markdown fences. Describe only what is ACTUALLY VISIBLE — do not infer what a space is typically used for. Describe foreground subjects first, then background.'

const PROMPT_CONTEXT = [
  PREAMBLE,
  '',
  'Study the image and fill:',
  '- description: literal description starting with the most prominent foreground subjects and what they are doing, then background. If a person is holding a weapon or doing something notable, say so. Do not aestheticize hazards. Do not describe what a space is "typically used for" — only what you see.',
  '- scene: location or setting (e.g. "residential driveway", "school cafeteria", "suburban street")',
  '- inference: synthesize all visual evidence:',
  '  - timeOfDay: "daytime", "night", "dusk", "dawn", or null',
  '  - country: infer from flags, plate styles, signs, language, vehicle livery — or null',
  '  - sourceType: reason from lens distortion, mounting angle, resolution, timestamps, watermarks: "security camera", "doorbell camera", "dashcam", "smartphone", "professional camera", or null',
  '  - sourceBrand: "Nest", "Ring", "Arlo", "Wyze", "Blink", "GoPro", or null — look for watermarks and UI chrome',
  '  - weather: "sunny", "cloudy", "overcast", "rainy", "foggy", "snowy", or null',
  '  - summary: one sentence synthesizing all evidence',
].join('\n')

const PROMPT_OBJECTS = [
  PREAMBLE,
  '',
  'Your ONLY task: list every physically distinct person, animal, and object visible in the image.',
  'Scan these easy-to-miss areas carefully:',
  '- Furniture surfaces (sofas, chairs, beds): people, babies, children, or pets resting on them — even if blending in or partially hidden',
  '- Floor and ground: people or animals lying down, packages, boxes, parcels',
  '- Doorstep, porch, entryway: packages or deliveries',
  '- Each person\'s hands, arms, waistband, holster: weapons (label specifically: "handgun", "rifle", "shotgun", "knife", "bat")',
  'ONE entry per distinct physical object. Do NOT list vehicles. Do NOT label uncontained fire as "fireplace".',
  'Fields: label (specific noun), confidence (0.0–1.0), area (screen region: top-left/top-center/top-right/center-left/center/center-right/bottom-left/bottom-center/bottom-right)',
].join('\n')

const PROMPT_VEHICLES = [
  PREAMBLE,
  '',
  'Your ONLY task: identify every vehicle in the image. ONE entry per physically distinct vehicle.',
  'For each vehicle identify:',
  '- type: car|van|truck|delivery_truck|bus|motorcycle|bicycle|other',
  '- brand: manufacturer or delivery operator inferred from shape, badge, grille, livery, logos, color scheme (e.g. "Tesla", "Ford", "FedEx", "USPS", "Amazon", "UPS") or null',
  '- model: specific model inferred from body shape, badge, or distinctive features (e.g. "Model 3", "Model Y", "Cybertruck", "F-150", "Silverado", "Prius", "RAV4", "Wrangler") or null',
  '- plate: license plate text exactly as written, or null',
  '- plateState: US state abbreviation or country code from plate design, or null',
  '- color: primary body color',
  '- area: screen region',
].join('\n')

const PROMPT_TEXT = [
  PREAMBLE,
  '',
  'Your ONLY task: read every piece of visible text and identify every logo in the image.',
  'Look carefully at every surface, corner, and edge — small or partial text counts.',
  'Include: license plates, brand logos, product names, street signs, building names, door numbers, package labels, timestamps, watermarks, stickers, any printed or displayed text.',
  'Fields: value (exact characters or brand name), language (ISO 639-1, use "en" for brand names), type (license_plate | sign | document | other), area (screen region)',
].join('\n')

const PROMPT_SAFETY = [
  PREAMBLE,
  '',
  'Your ONLY task: identify safety hazards that ARE ACTUALLY PRESENT in the image. Do not flag things that are absent.',
  '',
  'Step 1 — FIRE: Do you see actual visible flames or fire in the image right now? If NO → skip fire entirely, do not mention it. If YES → check whether a physical fireplace structure (brick surround, mantle, fire box, grate, stone ring) clearly encloses the flames. No structure visible → assessment "critical".',
  '',
  'Step 2 — WEAPONS: Look at each person\'s hands and body. Is anyone visibly holding, carrying, or pointing a weapon (gun, knife, bat)? If YES → create an entry. Drawn or pointed → "critical". Holstered or slung → "concerning".',
  '',
  'Step 3 — OTHER: Smoke without a source, person/baby motionless on floor, standing water indoors, exposed wiring, broken glass. Only flag what you can actually see.',
  '',
  'For each hazard found:',
  '- hazard: short label ("fire", "handgun", "rifle", "knife", "smoke", "person on ground", etc.)',
  '- context: one phrase describing where and how it appears',
  '- assessment: "normal" | "concerning" | "critical"',
  '- reason: one sentence explaining why',
  '- area: screen region',
  '',
  'If you see NO hazards → return {"safety":[]}. Do not invent hazards.',
].join('\n')

// ── Multi-pass inference ──────────────────────────────────────────────────────

async function runPass<T>(model: string, b64: string, prompt: string, schema: object): Promise<T> {
  const chunk = await ollamaChat(
    model,
    [{ role: 'user', content: prompt, images: [b64] }],
    undefined,
    { temperature: 0.1 },
    schema,
  )
  const text = chunk.message.content
  try {
    return JSON.parse(text) as T
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`Pass returned non-JSON: ${text.slice(0, 120)}`)
    return JSON.parse(match[0]) as T
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/vision/status
vision.get('/status', requireAuth, async (c) => {
  const model = await getVisionModel()
  try {
    const models = await ollamaList()
    const modelBase = model.split(':')[0] ?? model
    const available = models.some(m => m.name === model || m.name.startsWith(modelBase))
    return c.json({ available, model })
  } catch {
    return c.json({ available: false, model })
  }
})

// POST /api/vision/analyze (multipart: image file + tasks JSON)
vision.post('/analyze', requireAuth, async (c) => {
  const user = c.get('user')
  const formData = await c.req.formData()
  const imageFile = formData.get('image') as File | null
  const tasksRaw = formData.get('tasks') as string | null

  if (!imageFile) return c.json({ error: 'image required' }, 400)

  // Guard the parse of untrusted multipart form data, then filter to known tasks.
  const KNOWN_TASKS: AnalysisTask[] = ['description', 'scene', 'objects', 'text', 'vehicles', 'language']
  let tasks: AnalysisTask[] = []
  if (tasksRaw) {
    try {
      const raw = JSON.parse(tasksRaw)
      if (Array.isArray(raw)) {
        tasks = raw.filter((t): t is AnalysisTask => KNOWN_TASKS.includes(t as AnalysisTask))
      }
    } catch {
      tasks = []
    }
  }
  const model = await getVisionModel()
  const id = crypto.randomUUID()
  const now = new Date()

  // Save source image
  const analysisDir = join(dataDir, 'analysis')
  await mkdir(analysisDir, { recursive: true })
  const ext = imageFile.type.includes('png') ? 'png' : 'jpg'
  const imagePath = join(analysisDir, `${id}.${ext}`)
  const imageBuffer = Buffer.from(await imageFile.arrayBuffer())

  // Screen the upload before it touches disk or the VLM — refuse CSAM at the door.
  const screenVerdict = await screenImage(imageBuffer.toString('base64'))
  if (screenVerdict.flagged) {
    logCsamBlock('vision analyze upload', user.id, screenVerdict.reason ?? 'upload')
    return c.json({ error: 'content_blocked', message: 'This image was blocked by a safety policy and cannot be analyzed.' }, 403)
  }

  await Bun.write(imagePath, imageBuffer)

  // Insert building row
  await db.insert(analysisResults).values({
    id,
    userId: user.id,
    path: imagePath,
    model,
    tasks: JSON.stringify(tasks),
    state: 'building',
    createdAt: now,
  })

  // Multi-pass inference — each pass focuses on one category
  const b64 = imageBuffer.toString('base64')
  const runAll = tasks.length === 0

  type ContextResult  = Pick<AnalysisResult, 'description' | 'scene' | 'inference'>
  type ObjectsResult  = { objects: AnalysisResult['objects'] }
  type VehiclesResult = { vehicles: AnalysisResult['vehicles'] }
  type TextResult     = { text: AnalysisResult['text'] }
  type SafetyResult   = { safety: AnalysisResult['safety'] }

  try {
    const [context, objects, vehicles, text, safety] = await Promise.all([
      runPass<ContextResult>(model, b64, PROMPT_CONTEXT, SCHEMA_CONTEXT),
      (runAll || tasks.includes('objects'))
        ? runPass<ObjectsResult>(model, b64, PROMPT_OBJECTS, SCHEMA_OBJECTS)
        : Promise.resolve({ objects: [] }),
      (runAll || tasks.includes('vehicles'))
        ? runPass<VehiclesResult>(model, b64, PROMPT_VEHICLES, SCHEMA_VEHICLES)
        : Promise.resolve({ vehicles: [] }),
      (runAll || tasks.includes('text'))
        ? runPass<TextResult>(model, b64, PROMPT_TEXT, SCHEMA_TEXT)
        : Promise.resolve({ text: [] }),
      runPass<SafetyResult>(model, b64, PROMPT_SAFETY, SCHEMA_SAFETY),
    ])

    const mergedSafety = safety.safety ?? []

    // Cross-reference: promote weapon/fire objects the safety pass missed
    const WEAPON_TERMS = ['handgun', 'gun', 'pistol', 'rifle', 'shotgun', 'firearm', 'weapon', 'knife', 'blade', 'sword', 'machete', 'bat', 'club']
    const FIRE_TERMS   = ['fire', 'flames', 'flame', 'burning']
    for (const obj of (objects.objects ?? [])) {
      const lbl = obj.label.toLowerCase()
      const isWeapon = WEAPON_TERMS.some(w => lbl.includes(w))
      const isFire   = FIRE_TERMS.some(f => lbl.includes(f))
      if (!isWeapon && !isFire) continue
      const alreadyCovered = mergedSafety.some(s =>
        s.hazard.toLowerCase().includes(lbl) || lbl.includes(s.hazard.toLowerCase())
      )
      if (alreadyCovered) continue
      mergedSafety.push({
        hazard: obj.label,
        context: `detected in scene at ${Math.round(obj.confidence * 100)}% confidence`,
        assessment: isWeapon ? 'critical' : 'concerning',
        reason: isWeapon
          ? `A ${obj.label} was detected in the image by the object detection pass.`
          : `Uncontained fire or flames were detected — no containment structure confirmed.`,
        area: obj.area,
      })
    }

    const parsed: AnalysisResult = {
      description: context.description ?? '',
      scene: context.scene ?? '',
      inference: context.inference ?? { timeOfDay: null, country: null, sourceType: null, sourceBrand: null, weather: null, summary: '' },
      objects: objects.objects ?? [],
      vehicles: vehicles.vehicles ?? [],
      text: text.text ?? [],
      safety: mergedSafety,
    }

    await db.update(analysisResults)
      .set({ result: JSON.stringify(parsed), state: 'ready' })
      .where(eq(analysisResults.id, id))

    return c.json({ id, result: parsed, model, state: 'ready' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.update(analysisResults)
      .set({ state: 'failed', error: msg })
      .where(eq(analysisResults.id, id))
    return c.json({ error: msg }, 500)
  }
})

// GET /api/vision/history
vision.get('/history', requireAuth, async (c) => {
  const user = c.get('user')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '24'), 50)

  const rows = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.userId, user.id), eq(analysisResults.state, 'ready')))
    .orderBy(desc(analysisResults.createdAt))
    .limit(limit)

  return c.json(rows.map(r => ({
    id: r.id,
    model: r.model,
    tasks: JSON.parse(r.tasks),
    result: r.result ? (JSON.parse(r.result) as AnalysisResult) : null,
    createdAt: r.createdAt,
  })))
})

// GET /api/vision/results/:id
vision.get('/results/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.id, id), eq(analysisResults.userId, user.id)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({
    id: row.id,
    model: row.model,
    tasks: JSON.parse(row.tasks),
    result: row.result ? (JSON.parse(row.result) as AnalysisResult) : null,
    state: row.state,
    error: row.error,
    createdAt: row.createdAt,
  })
})

// GET /api/vision/artifacts/:id — serve source image
vision.get('/artifacts/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select({ path: analysisResults.path, userId: analysisResults.userId })
    .from(analysisResults)
    .where(and(eq(analysisResults.id, id), eq(analysisResults.userId, user.id)))
    .limit(1)

  if (!row?.path || !existsSync(row.path)) return c.json({ error: 'Not found' }, 404)

  const file = Bun.file(row.path)
  return new Response(file, {
    headers: {
      'Content-Type': file.type || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

// DELETE /api/vision/artifacts/:id
vision.delete('/artifacts/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [row] = await db
    .select()
    .from(analysisResults)
    .where(and(eq(analysisResults.id, id), eq(analysisResults.userId, user.id)))
    .limit(1)

  if (!row) return c.json({ error: 'Not found' }, 404)

  if (row.path && existsSync(row.path)) {
    await unlink(row.path).catch(() => {})
  }
  await db.delete(analysisResults).where(eq(analysisResults.id, id))
  return c.json({ ok: true })
})

export { vision }
