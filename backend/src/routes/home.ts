import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, desc, and, asc } from 'drizzle-orm'
import { join, extname } from 'node:path'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { db } from '@/db'
import { homeDevices, homeServiceLog, homeDeviceFiles, homeDeviceLinks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { dataDir } from '@/lib/download'
import { lookupDevice } from '@/lib/home/lookup'
import { getDeviceDigest } from '@/lib/home/digest'
import { getVisionModel, getModel } from '@/lib/models'
import { screenImage, logCsamBlock } from '@/lib/safety/csamGuard'
import { ollamaChat, ollamaChatStream } from '@/llm/ollama'
import { safeFetch } from '@/lib/ssrfGuard'
import type { AppEnv } from '@/types'

const home = new Hono<AppEnv>()

function deviceDir(deviceId: string) {
  return join(dataDir, 'home', 'devices', deviceId)
}

// ── List devices ──────────────────────────────────────────────────────────────

home.get('/devices', requireAuth, async (c) => {
  const q = c.req.query('q')?.trim()
  const category = c.req.query('category')

  let rows = await db.select().from(homeDevices).orderBy(asc(homeDevices.name))

  if (q) {
    const lower = q.toLowerCase()
    rows = rows.filter(d =>
      d.name.toLowerCase().includes(lower) ||
      d.brand?.toLowerCase().includes(lower) ||
      d.model?.toLowerCase().includes(lower) ||
      d.location?.toLowerCase().includes(lower)
    )
  }
  if (category && category !== 'all') {
    rows = rows.filter(d => d.category === category)
  }

  return c.json({ devices: rows })
})

// ── Create device ─────────────────────────────────────────────────────────────

home.post('/devices', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()

  const name = (body.name as string)?.trim()
  if (!name) return c.json({ error: 'name required' }, 400)

  const id = crypto.randomUUID()
  const dir = deviceDir(id)
  await mkdir(dir, { recursive: true })

  let photoPath: string | null = null
  let initialFileId: string | null = null
  const photoFile = body.photo as File | undefined
  if (photoFile && photoFile.size > 0) {
    const ext = extname(photoFile.name) || '.jpg'
    photoPath = join(dir, `photo${ext}`)
    await Bun.write(photoPath, await photoFile.arrayBuffer())
    initialFileId = crypto.randomUUID()
  }

  const now = new Date()
  const device: typeof homeDevices.$inferInsert = {
    id,
    name,
    brand: (body.brand as string)?.trim() || null,
    model: (body.model as string)?.trim() || null,
    serialNumber: (body.serialNumber as string)?.trim() || null,
    category: ((body.category as string) || 'other') as typeof homeDevices.$inferInsert['category'],
    location: (body.location as string)?.trim() || null,
    owner: (body.owner as string)?.trim() || null,
    description: (body.description as string)?.trim() || null,
    manufacturedDate: (body.manufacturedDate as string)?.trim() || null,
    specs: null,
    photoPath,
    mainPhotoId: initialFileId,
    purchaseDate: (body.purchaseDate as string)?.trim() || null,
    purchasePrice: body.purchasePrice ? parseFloat(body.purchasePrice as string) : null,
    purchaseStore: (body.purchaseStore as string)?.trim() || null,
    warrantyExpires: (body.warrantyExpires as string)?.trim() || null,
    warrantyNotes: (body.warrantyNotes as string)?.trim() || null,
    supportUrl: null,
    supportPhone: null,
    manualPath: null,
    manualUrl: null,
    manualFetchedAt: null,
    manualText: null,
    notes: (body.notes as string)?.trim() || null,
    lookupStatus: 'pending',
    lookupQueuedAt: now,
    addedBy: user.id,
    createdAt: now,
    updatedAt: now,
  }

  await db.insert(homeDevices).values(device)

  // Register the uploaded photo in homeDeviceFiles so Photos tab can display it
  if (photoPath && initialFileId) {
    await db.insert(homeDeviceFiles).values({
      id: initialFileId,
      deviceId: id,
      label: 'Device photo',
      filePath: photoPath,
      fileType: 'image',
      source: 'user',
      sizeBytes: photoFile!.size,
      uploadedBy: user.id,
      createdAt: now,
    })
  }

  if (device.brand && device.model) {
    triggerLookup(id, device.brand, device.model, name, user.id, device.category ?? 'other', !!photoPath)
  } else {
    await db.update(homeDevices)
      .set({ lookupStatus: 'skipped', updatedAt: new Date() })
      .where(eq(homeDevices.id, id))
    device.lookupStatus = 'skipped'
  }

  return c.json({ device })
})

// ── Get device ────────────────────────────────────────────────────────────────

home.get('/devices/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const [serviceEntries, files] = await Promise.all([
    db.select().from(homeServiceLog)
      .where(eq(homeServiceLog.deviceId, id))
      .orderBy(desc(homeServiceLog.date)),
    db.select().from(homeDeviceFiles)
      .where(eq(homeDeviceFiles.deviceId, id))
      .orderBy(asc(homeDeviceFiles.createdAt)),
  ])

  return c.json({ device, serviceEntries, files })
})

// ── Update device ─────────────────────────────────────────────────────────────

home.patch('/devices/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.parseBody()
  const now = new Date()

  const user = c.get('user')
  let photoPath = existing.photoPath
  let newPhotoFileId: string | null = null
  const photoFile = body.photo as File | undefined
  if (photoFile && photoFile.size > 0) {
    const dir = deviceDir(id)
    await mkdir(dir, { recursive: true })
    const ext = extname(photoFile.name) || '.jpg'
    photoPath = join(dir, `photo${ext}`)
    await Bun.write(photoPath, await photoFile.arrayBuffer())
    newPhotoFileId = crypto.randomUUID()
  }

  const patch: Partial<typeof existing> = { updatedAt: now }
  if (body.name !== undefined)             patch.name            = (body.name as string).trim()
  if (body.brand !== undefined)            patch.brand           = (body.brand as string).trim() || null
  if (body.model !== undefined)            patch.model           = (body.model as string).trim() || null
  if (body.serialNumber !== undefined)     patch.serialNumber    = (body.serialNumber as string).trim() || null
  if (body.category !== undefined)         patch.category        = body.category as typeof existing.category
  if (body.location !== undefined)         patch.location        = (body.location as string).trim() || null
  if (body.owner !== undefined)            patch.owner           = (body.owner as string).trim() || null
  if (body.description !== undefined)      patch.description     = (body.description as string).trim() || null
  if (body.manufacturedDate !== undefined) patch.manufacturedDate = (body.manufacturedDate as string).trim() || null
  if (body.specs !== undefined)            patch.specs           = (body.specs as string).trim() || null
  if (body.purchaseDate !== undefined)     patch.purchaseDate    = (body.purchaseDate as string).trim() || null
  if (body.purchasePrice !== undefined)    patch.purchasePrice   = body.purchasePrice ? parseFloat(body.purchasePrice as string) : null
  if (body.purchaseStore !== undefined)    patch.purchaseStore   = (body.purchaseStore as string).trim() || null
  if (body.warrantyExpires !== undefined)  patch.warrantyExpires = (body.warrantyExpires as string).trim() || null
  if (body.warrantyNotes !== undefined)    patch.warrantyNotes   = (body.warrantyNotes as string).trim() || null
  if (body.supportUrl !== undefined)       patch.supportUrl      = (body.supportUrl as string).trim() || null
  if (body.supportPhone !== undefined)     patch.supportPhone    = (body.supportPhone as string).trim() || null
  if (body.manualUrl !== undefined)        patch.manualUrl       = (body.manualUrl as string).trim() || null
  if (body.notes !== undefined)            patch.notes           = (body.notes as string).trim() || null
  if (body.rawLabelText !== undefined)     patch.rawLabelText    = (body.rawLabelText as string).trim() || null
  if (newPhotoFileId) {
    patch.photoPath   = photoPath
    patch.mainPhotoId = newPhotoFileId
  }

  await db.update(homeDevices).set(patch).where(eq(homeDevices.id, id))

  // Register the new photo in homeDeviceFiles
  if (photoPath && newPhotoFileId) {
    await db.insert(homeDeviceFiles).values({
      id: newPhotoFileId,
      deviceId: id,
      label: 'Device photo',
      filePath: photoPath,
      fileType: 'image',
      source: 'user',
      sizeBytes: photoFile!.size,
      uploadedBy: user.id,
      createdAt: now,
    })
  }

  const updated = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  return c.json({ device: updated })
})

// ── Delete device ─────────────────────────────────────────────────────────────

home.delete('/devices/:id', requireAuth, async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(homeDevices).where(eq(homeDevices.id, id))

  const dir = deviceDir(id)
  try { await import('node:fs/promises').then(m => m.rm(dir, { recursive: true, force: true })) } catch {}

  return c.json({ ok: true })
})

// ── Serve photo ───────────────────────────────────────────────────────────────

home.get('/devices/:id/photo', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device?.photoPath || !existsSync(device.photoPath)) {
    return c.json({ error: 'No photo' }, 404)
  }
  const file = Bun.file(device.photoPath)
  return new Response(file, { headers: { 'Cache-Control': 'private, max-age=3600' } })
})

// ── Set main photo ────────────────────────────────────────────────────────────

home.post('/devices/:id/set-main-photo', requireAuth, async (c) => {
  const id = c.req.param('id')
  const { fileId } = await c.req.json<{ fileId: string }>()

  const fileRow = await db.select().from(homeDeviceFiles)
    .where(and(eq(homeDeviceFiles.id, fileId), eq(homeDeviceFiles.deviceId, id)))
    .then(r => r[0])
  if (!fileRow || fileRow.fileType !== 'image') return c.json({ error: 'Image file not found' }, 404)
  if (!existsSync(fileRow.filePath)) return c.json({ error: 'File missing on disk' }, 404)

  // Copy selected photo to the device's main photo path so legacy display works
  const dir = deviceDir(id)
  await mkdir(dir, { recursive: true })
  const ext = extname(fileRow.filePath) || '.jpg'
  const photoPath = join(dir, `photo${ext}`)
  await Bun.write(photoPath, Bun.file(fileRow.filePath))

  await db.update(homeDevices)
    .set({ photoPath, mainPhotoId: fileId, updatedAt: new Date() })
    .where(eq(homeDevices.id, id))

  const updated = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  return c.json({ device: updated })
})

// ── Update photo comment ──────────────────────────────────────────────────────

home.patch('/devices/:id/files/:fileId/comment', requireAuth, async (c) => {
  const { id, fileId } = c.req.param()
  const { comment } = await c.req.json<{ comment: string }>()
  await db.update(homeDeviceFiles)
    .set({ comment: comment || null })
    .where(and(eq(homeDeviceFiles.id, fileId), eq(homeDeviceFiles.deviceId, id)))
  const updated = await db.select().from(homeDeviceFiles)
    .where(eq(homeDeviceFiles.id, fileId)).then(r => r[0])
  return c.json({ file: updated })
})

// ── VLM identify from photo ───────────────────────────────────────────────────

home.post('/devices/:id/identify', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const photoPath = device.photoPath
  if (!photoPath || !existsSync(photoPath)) {
    return c.json({ error: 'No photo to identify' }, 400)
  }

  const visionModel = await getVisionModel()
  if (!visionModel) return c.json({ error: 'Vision model not configured' }, 503)

  const imageBytes = await Bun.file(photoPath).arrayBuffer()
  const base64 = Buffer.from(imageBytes).toString('base64')

  // Device photos are user uploads — screen before the VLM reads them.
  const photoVerdict = await screenImage(base64)
  if (photoVerdict.flagged) {
    logCsamBlock('home device photo', c.get('user').id, photoVerdict.reason ?? 'photo')
    return c.json({ error: 'content_blocked', message: 'This image was blocked by a safety policy.' }, 403)
  }

  // ── Pass 1: OCR — Apple Vision (macOS) first, VLM fallback ───────────────────
  // Apple Vision is the same engine as iPhone/Photos text recognition.
  // It reads multi-language labels (Chinese, Spanish, etc.) with high accuracy.
  let rawLabelText = ''

  if (process.platform === 'darwin') {
    try {
      const { exec: _exec2 } = await import('node:child_process')
      const { promisify: _promisify2 } = await import('node:util')
      const runExec = _promisify2(_exec2)

      // Write the Vision OCR script once; Swift caches compilation after first run
      const scriptPath = join(dataDir, 'home', 'vision_ocr.swift')
      await mkdir(join(dataDir, 'home'), { recursive: true })
      if (!existsSync(scriptPath)) {
        await writeFile(scriptPath, `import Vision
import Foundation

let args = CommandLine.arguments
guard args.count > 1 else { exit(1) }
let url = URL(fileURLWithPath: args[1])
var lines: [(Double, String)] = []
let done = DispatchSemaphore(value: 0)

let req = VNRecognizeTextRequest { r, _ in
    defer { done.signal() }
    let obs = r.results as? [VNRecognizedTextObservation] ?? []
    for o in obs {
        if let c = o.topCandidates(1).first, c.confidence > 0.2 {
            lines.append((1.0 - o.boundingBox.minY, c.string))
        }
    }
}
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false  // preserve model numbers and codes exactly
req.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant", "es", "ja"]
if #available(macOS 13, *) { req.automaticallyDetectsLanguage = true }

try? VNImageRequestHandler(url: url).perform([req])
done.wait()
lines.sort { $0.0 < $1.0 }
print(lines.map(\\.1).joined(separator: "\\n"))
`, 'utf8')
      }

      const { stdout } = await runExec(`swift "${scriptPath}" "${photoPath}"`, { timeout: 25_000 })
      const visionText = stdout.trim()
      if (visionText.replace(/\s/g, '').length > 10) {
        rawLabelText = visionText
        console.log('[identify] Apple Vision OCR succeeded:', rawLabelText.slice(0, 120))
      }
    } catch (e) {
      console.log('[identify] Apple Vision not available, falling back to VLM OCR:', String(e).slice(0, 80))
    }
  }

  // VLM OCR fallback — used on non-macOS or if Vision fails
  const visionOcrPromise = !rawLabelText ? ollamaChat(visionModel, [
    {
      role: 'system',
      content: 'You are reading text from a product photo. Transcribe all text you can see — do not use your product knowledge to fill in anything you cannot actually read.',
    },
    {
      role: 'user',
      content: `Read ALL text visible in this image — every word, number, code, and symbol on any label, sticker, nameplate, or printed surface. Include everything:

- Brand name and any copyright text
- Product family, product line, model number or code
- Machine type (MT:), WTM codes, or other product identifiers
- Serial number (SN:), work order (WO:) or similar tracking codes
- Input voltage, wattage, amperage, frequency
- Manufacturing date, country of manufacture
- Regulatory marks and certification numbers
- Text in any language

Output each line as you read it. If text is unclear, skip it rather than guessing.`,
      images: [base64],
    },
  ], undefined, { temperature: 0.0 }) : Promise.resolve(null)

  // ── Pass 2: VLM visual description (runs in parallel with OCR fallback) ────────
  const visualPromise = ollamaChat(visionModel, [
    {
      role: 'system',
      content: 'Describe only what you can see physically. Do not read labels or text.',
    },
    {
      role: 'user',
      content: 'What type of product is in this image? Describe its form factor, size, and shape. Do NOT read any text or use product names — only describe what you physically see.',
      images: [base64],
    },
  ], undefined, { temperature: 0.0 })

  const [ocrResult, visualResult] = await Promise.allSettled([visionOcrPromise, visualPromise])

  // If Apple Vision already populated rawLabelText, ocrResult is null — keep it
  if (!rawLabelText && ocrResult.status === 'fulfilled' && ocrResult.value) {
    rawLabelText = ocrResult.value.message.content.trim()
  }
  const visualDescription = visualResult.status === 'fulfilled' ? visualResult.value.message.content.trim() : ''

  // ── Pass 3: Text LLM — no image, pure reasoning from the two evidence sources ──
  const extractionModel = await getModel()

  const reconcilePrompt = [
    rawLabelText    && `LABEL TEXT READ FROM IMAGE:\n${rawLabelText}`,
    visualDescription && `VISUAL DESCRIPTION:\n${visualDescription}`,
  ].filter(Boolean).join('\n\n') || 'No label text or visual data available.'

  const jsonInstruction = `\n\nExtract structured fields from the label text. Rules:
- ONLY use text that appears verbatim in the label — NEVER substitute with product knowledge
- "model" = the alphanumeric product code that appears WITHIN the product name line (e.g. "34IMZ5" from "Lenovo Legion T7 34IMZ5")
- Machine Type (MT:) codes, Part Numbers, CTO codes — these are NOT the model; put them in labelSpecs
- "name" = brand + product line + model code exactly as printed (e.g. "Lenovo Legion T7 34IMZ5")
- Serial number (SN:) lines → serialNumber field
- Use the visual description ONLY to determine category

Respond with JSON only:
{
  "name": "brand + line + model code exactly as on the label, or null",
  "brand": "manufacturer name from label, or null",
  "model": "the product model code within the product name (e.g. '34IMZ5', 'WRT54GL', 'MQ013LL/A') — NOT a Machine Type number, or null",
  "serialNumber": "serial number from label (SN: field), or null",
  "category": "one of: appliance, electronics, vehicle, tool, furniture, other",
  "manufacturedDate": "manufacture date from label as YYYY-MM-DD or YYYY-MM or YYYY, or null",
  "labelSpecs": { "Machine Type": "9008", "Part Number": "...", "Voltage": "...", "Country": "..." },
  "confidence": "high | medium | low"
}
Return null for fields not found. Return null for labelSpecs if no additional specs were on the label.`

  try {
    const response = await ollamaChat(extractionModel,
      [
        {
          role: 'system',
          content: 'You are a label data extractor. Your ONLY job is to copy field values verbatim from label text provided by the user. You must NEVER use your product knowledge to substitute, correct, or augment what the label says. Even if a model number looks unusual or unfamiliar, output it exactly as read.',
        },
        { role: 'user', content: reconcilePrompt + jsonInstruction },
      ],
      undefined, { temperature: 0.0 })

    const text = response.message.content.trim()

    // Find the first complete JSON object by tracking brace depth — more robust
    // than a greedy regex when the model adds trailing text or extra braces.
    function extractFirstJson(s: string): string | null {
      const start = s.indexOf('{')
      if (start === -1) return null
      let depth = 0, inStr = false, esc = false
      for (let i = start; i < s.length; i++) {
        const ch = s[i]
        if (esc) { esc = false; continue }
        if (ch === '\\' && inStr) { esc = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) return s.slice(start, i + 1)
      }
      return null
    }

    const jsonStr = extractFirstJson(text)

    // LLMs often output trailing commas — strip them before parsing
    const sanitized = jsonStr ? jsonStr.replace(/,(\s*[}\]])/g, '$1') : '{}'

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(sanitized) as Record<string, unknown>
    } catch (parseErr) {
      console.error('[identify] bad JSON from model:\n', sanitized)
      // Return null-filled result rather than an error — better UX than hard failure
      raw = {}
    }
    const nullify = (v: unknown) => (v === 'null' || v === '' || v == null) ? null : String(v)

    // Clean up labelSpecs — remove the example placeholder key the LLM might include
    let labelSpecs: Record<string, string> | null = null
    if (raw.labelSpecs && typeof raw.labelSpecs === 'object') {
      const cleaned: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw.labelSpecs as Record<string, unknown>)) {
        if (k.toLowerCase().includes('include') || k.toLowerCase().includes('for example') || k.toLowerCase().includes('other fields')) continue
        const val = nullify(v)
        if (val) cleaned[k] = val
      }
      if (Object.keys(cleaned).length > 0) labelSpecs = cleaned
    }

    const identified = {
      name:             nullify(raw.name),
      brand:            nullify(raw.brand),
      model:            nullify(raw.model),
      serialNumber:     nullify(raw.serialNumber),
      category:         nullify(raw.category) ?? 'other',
      manufacturedDate: nullify(raw.manufacturedDate),
      labelSpecs,
      rawLabelText:      rawLabelText || null,
      visualDescription: visualDescription || null,
      confidence:        nullify(raw.confidence),
    }

    // Persist the raw OCR text so it's always available in the device sheet
    if (rawLabelText) {
      await db.update(homeDevices).set({ rawLabelText, updatedAt: new Date() }).where(eq(homeDevices.id, id))
    }

    return c.json({ identified })
  } catch (err) {
    console.error('[identify] unexpected error:', err)
    return c.json({ error: 'Identification failed' }, 500)
  }
})

// ── AI digest (common issues, recalls, care tips) ────────────────────────────

home.get('/devices/:id/digest', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const digest = await getDeviceDigest({
    name: device.name,
    brand: device.brand,
    model: device.model,
    category: device.category,
    manualText: device.manualText,
  })
  return c.json({ digest })
})

// ── Trigger web lookup ────────────────────────────────────────────────────────

home.post('/devices/:id/lookup', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)
  if (!device.brand || !device.model) return c.json({ error: 'Brand and model required for lookup' }, 400)

  await db.update(homeDevices)
    .set({ lookupStatus: 'pending', lookupQueuedAt: new Date(), updatedAt: new Date() })
    .where(eq(homeDevices.id, id))

  triggerLookup(id, device.brand, device.model, device.name, device.addedBy, device.category, !!device.photoPath)
  return c.json({ ok: true, status: 'pending' })
})

// ── Generate specs (on-demand) ────────────────────────────────────────────────

home.post('/devices/:id/generate-specs', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)
  if (!device.brand || !device.model) return c.json({ error: 'Brand and model required' }, 400)

  const model = await getModel()
  if (!model) return c.json({ error: 'Model not configured' }, 503)

  const response = await ollamaChat(model, [
    { role: 'system', content: 'You are a product researcher. Respond ONLY with valid JSON. No markdown, no code blocks.' },
    { role: 'user', content: `Provide information for: ${device.name} — brand: ${device.brand}, model: ${device.model}, category: ${device.category}

Respond with JSON only:
{
  "description": "one or two sentence product description",
  "manufacturedDate": "year first released e.g. '2021', or null if unknown",
  "specs": {
    "key": "value"
  }
}

For electronics/computers: include CPU, RAM, storage, GPU, display, OS, ports.
For appliances: include capacity, power consumption, dimensions, notable features.
For vehicles: include engine, fuel type, transmission, seating.
Include 8-15 specs relevant to this product type. Use concise values like "32 GB" not "32 gigabytes".` },
  ], undefined, { temperature: 0.2 })

  const text = response.message.content.trim()
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return c.json({ error: 'Could not parse specs' }, 422)

  // Guard the parse of untrusted LLM output: malformed JSON must not 500 the route.
  let parsed: { description?: string; manufacturedDate?: string; specs?: Record<string, string> }
  try {
    parsed = JSON.parse(match[0]) as typeof parsed
  } catch {
    return c.json({ error: 'Could not parse specs' }, 422)
  }

  const now = new Date()
  const patch: Partial<typeof device> = { updatedAt: now }
  if (parsed.description && !device.description) patch.description = parsed.description
  if (parsed.manufacturedDate && !device.manufacturedDate) patch.manufacturedDate = parsed.manufacturedDate
  if (parsed.specs) {
    // Guard the parse of the stored specs column: a corrupt value must not throw.
    let existing: Record<string, string> = {}
    if (device.specs) {
      try { existing = JSON.parse(device.specs) as Record<string, string> } catch { existing = {} }
    }
    patch.specs = JSON.stringify({ ...existing, ...parsed.specs })
  }

  await db.update(homeDevices).set(patch).where(eq(homeDevices.id, id))

  const updated = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  return c.json({ device: updated })
})

function triggerLookup(
  deviceId: string,
  brand: string,
  model: string,
  name: string,
  addedBy: string,
  category: string,
  hasPhoto: boolean,
) {
  lookupDevice(brand, model, name, deviceId, category)
    .then(async result => {
      const now = new Date()

      // Download up to 3 AI product photos. Skip if already have AI photos (re-lookup guard).
      const existingAiPhotos = await db.select({ id: homeDeviceFiles.id })
        .from(homeDeviceFiles)
        .where(and(eq(homeDeviceFiles.deviceId, deviceId), eq(homeDeviceFiles.source, 'ai'), eq(homeDeviceFiles.fileType, 'image')))

      let mainPhotoId: string | null = null
      let mainPhotoPath: string | null = null

      if (result.aiPhotoUrls.length > 0 && existingAiPhotos.length === 0) {
        const UA = 'Mozilla/5.0 (compatible; HomeLookup/1.0)'
        const dir = join(deviceDir(deviceId), 'files')
        await mkdir(dir, { recursive: true })

        for (let i = 0; i < result.aiPhotoUrls.length; i++) {
          try {
            const photoRes = await safeFetch(result.aiPhotoUrls[i]!, {
              headers: { 'User-Agent': UA },
            }, { timeoutMs: 10_000 })
            if (!photoRes.ok) continue
            const ct = photoRes.headers.get('content-type') ?? ''
            if (!ct.startsWith('image/')) continue

            const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg'
            const buf = await photoRes.arrayBuffer()
            const fileId = crypto.randomUUID()
            const filePath = join(dir, `${fileId}${ext}`)
            await Bun.write(filePath, buf)

            const label = i === 0 ? 'Product photo' : `Product photo ${i + 1}`
            await db.insert(homeDeviceFiles).values({
              id: fileId, deviceId, label, filePath,
              fileType: 'image', source: 'ai',
              sizeBytes: buf.byteLength, uploadedBy: addedBy, createdAt: now,
            })

            // First photo becomes the cover
            if (i === 0) {
              const photoDir = deviceDir(deviceId)
              await mkdir(photoDir, { recursive: true })
              mainPhotoPath = join(photoDir, `photo${ext}`)
              await Bun.write(mainPhotoPath, Bun.file(filePath))
              mainPhotoId = fileId
            }
          } catch { /* best-effort per photo */ }
        }
      }

      // Merge AI specs with any existing label-extracted specs
      const currentDevice = await db.select({ specs: homeDevices.specs, description: homeDevices.description, manufacturedDate: homeDevices.manufacturedDate })
        .from(homeDevices).where(eq(homeDevices.id, deviceId)).then(r => r[0])
      let mergedSpecs: string | null = null
      if (result.specs) {
        const existing = currentDevice?.specs ? (JSON.parse(currentDevice.specs) as Record<string, string>) : {}
        mergedSpecs = JSON.stringify({ ...existing, ...result.specs })
      } else if (currentDevice?.specs) {
        mergedSpecs = currentDevice.specs
      }

      await db.update(homeDevices).set({
        lookupStatus: 'complete',
        manualUrl: result.manualUrl,
        manualPath: result.manualPath,
        manualText: result.manualText,
        manualFetchedAt: result.manualPath ? now : null,
        supportUrl: result.supportUrl,
        supportPhone: result.supportPhone,
        description: result.description ?? currentDevice?.description,
        specs: mergedSpecs,
        manufacturedDate: result.manufacturedDate ?? currentDevice?.manufacturedDate,
        ...(mainPhotoId ? { mainPhotoId, photoPath: mainPhotoPath } : {}),
        updatedAt: now,
      }).where(eq(homeDevices.id, deviceId))

      // Save AI-found video links (skip any already saved)
      if (result.videoLinks.length > 0) {
        const existingLinks = await db.select({ url: homeDeviceLinks.url })
          .from(homeDeviceLinks).where(eq(homeDeviceLinks.deviceId, deviceId))
        const existingUrls = new Set(existingLinks.map(l => l.url))
        const newVideos = result.videoLinks.filter(v => !existingUrls.has(v.url))
        if (newVideos.length > 0) {
          await db.insert(homeDeviceLinks).values(newVideos.map(v => ({
            id: crypto.randomUUID(),
            deviceId,
            category: 'video' as const,
            label: v.label,
            url: v.url,
            createdAt: now,
          })))
        }
      }
    })
    .catch(async () => {
      await db.update(homeDevices)
        .set({ lookupStatus: 'failed', updatedAt: new Date() })
        .where(eq(homeDevices.id, deviceId))
    })
}

// ── Serve manual PDF ──────────────────────────────────────────────────────────

home.get('/devices/:id/manual', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device?.manualPath || !existsSync(device.manualPath)) {
    return c.json({ error: 'No manual cached' }, 404)
  }
  const file = Bun.file(device.manualPath)
  return new Response(file, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, max-age=86400',
    },
  })
})

// ── Files ─────────────────────────────────────────────────────────────────────

home.get('/devices/:id/files', requireAuth, async (c) => {
  const id = c.req.param('id')
  const files = await db.select().from(homeDeviceFiles)
    .where(eq(homeDeviceFiles.deviceId, id))
    .orderBy(asc(homeDeviceFiles.createdAt))
  return c.json({ files })
})

home.post('/devices/:id/files', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.parseBody()
  const file = body.file as File | undefined
  if (!file || file.size === 0) return c.json({ error: 'file required' }, 400)

  const label = (body.label as string)?.trim() || file.name
  const ext = extname(file.name).toLowerCase()
  const fileType: 'pdf' | 'image' | 'other' =
    ext === '.pdf' ? 'pdf' :
    ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? 'image' : 'other'

  const fileId = crypto.randomUUID()
  const dir = join(deviceDir(id), 'files')
  await mkdir(dir, { recursive: true })
  const filename = `${fileId}${ext}`
  const filePath = join(dir, filename)
  await Bun.write(filePath, await file.arrayBuffer())

  const now = new Date()
  const entry = {
    id: fileId,
    deviceId: id,
    label,
    filePath,
    fileType,
    source: 'user' as const,
    sizeBytes: file.size,
    uploadedBy: user.id,
    createdAt: now,
  }
  await db.insert(homeDeviceFiles).values(entry)

  if (fileType === 'pdf' && !device.manualText) {
    extractPdfTextAsync(id, filePath)
  }

  return c.json({ file: entry })
})

home.get('/devices/:id/files/:fid', requireAuth, async (c) => {
  const { id, fid } = c.req.param()
  const fileRow = await db.select().from(homeDeviceFiles)
    .where(and(eq(homeDeviceFiles.id, fid), eq(homeDeviceFiles.deviceId, id)))
    .then(r => r[0])
  if (!fileRow || !existsSync(fileRow.filePath)) return c.json({ error: 'Not found' }, 404)

  const bunFile = Bun.file(fileRow.filePath)
  const ct = fileRow.fileType === 'pdf' ? 'application/pdf' :
    fileRow.fileType === 'image' ? 'image/*' : 'application/octet-stream'
  return new Response(bunFile, {
    headers: { 'Content-Type': ct, 'Cache-Control': 'private, max-age=3600' },
  })
})

home.delete('/devices/:id/files/:fid', requireAuth, async (c) => {
  const { id, fid } = c.req.param()
  const fileRow = await db.select().from(homeDeviceFiles)
    .where(and(eq(homeDeviceFiles.id, fid), eq(homeDeviceFiles.deviceId, id)))
    .then(r => r[0])
  if (!fileRow) return c.json({ error: 'Not found' }, 404)

  await db.delete(homeDeviceFiles).where(eq(homeDeviceFiles.id, fid))
  try { await unlink(fileRow.filePath) } catch {}
  return c.json({ ok: true })
})

async function extractPdfTextAsync(deviceId: string, pdfPath: string) {
  try {
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)
    const { stdout } = await execAsync(`pdftotext "${pdfPath}" -`, { timeout: 15_000, windowsHide: true })
    const text = stdout.slice(0, 40_000).trim()
    if (text) {
      await db.update(homeDevices)
        .set({ manualText: text, updatedAt: new Date() })
        .where(eq(homeDevices.id, deviceId))
    }
  } catch { /* pdftotext not available */ }
}

// ── Links ─────────────────────────────────────────────────────────────────────

home.get('/devices/:id/links', requireAuth, async (c) => {
  const id = c.req.param('id')
  const links = await db.select().from(homeDeviceLinks)
    .where(eq(homeDeviceLinks.deviceId, id))
    .orderBy(asc(homeDeviceLinks.createdAt))
  return c.json({ links })
})

home.post('/devices/:id/links', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{ category?: string; label: string; url: string }>()
  if (!body.label?.trim() || !body.url?.trim()) return c.json({ error: 'label and url required' }, 400)

  const link = {
    id: crypto.randomUUID(),
    deviceId: id,
    category: (body.category as 'manual' | 'support' | 'download' | 'other') ?? 'other',
    label: body.label.trim(),
    url: body.url.trim(),
    createdAt: new Date(),
  }
  await db.insert(homeDeviceLinks).values(link)
  return c.json({ link })
})

home.delete('/devices/:id/links/:lid', requireAuth, async (c) => {
  const { id, lid } = c.req.param()
  await db.delete(homeDeviceLinks)
    .where(and(eq(homeDeviceLinks.id, lid), eq(homeDeviceLinks.deviceId, id)))
  return c.json({ ok: true })
})

// ── Service log ───────────────────────────────────────────────────────────────

home.get('/devices/:id/service', requireAuth, async (c) => {
  const id = c.req.param('id')
  const entries = await db.select().from(homeServiceLog)
    .where(eq(homeServiceLog.deviceId, id))
    .orderBy(desc(homeServiceLog.date))
  return c.json({ entries })
})

home.post('/devices/:id/service', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{
    date: string; type?: string; description: string; technician?: string; cost?: number
  }>()
  if (!body.date || !body.description?.trim()) return c.json({ error: 'date and description required' }, 400)

  const now = new Date()
  const entry = {
    id: crypto.randomUUID(),
    deviceId: id,
    date: body.date,
    type: (body.type as typeof homeServiceLog.$inferInsert['type']) ?? 'other',
    description: body.description.trim(),
    technician: body.technician?.trim() ?? null,
    cost: body.cost ?? null,
    createdBy: user.id,
    createdAt: now,
  }
  await db.insert(homeServiceLog).values(entry)
  return c.json({ entry })
})

home.patch('/devices/:id/service/:eid', requireAuth, async (c) => {
  const { id, eid } = c.req.param()
  const entry = await db.select().from(homeServiceLog)
    .where(and(eq(homeServiceLog.id, eid), eq(homeServiceLog.deviceId, id)))
    .then(r => r[0])
  if (!entry) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<Partial<{ date: string; type: string; description: string; technician: string; cost: number }>>()
  await db.update(homeServiceLog).set({
    date:        body.date        ?? entry.date,
    type:        (body.type as typeof entry.type) ?? entry.type,
    description: body.description ?? entry.description,
    technician:  body.technician !== undefined ? body.technician : entry.technician,
    cost:        body.cost        !== undefined ? body.cost       : entry.cost,
  }).where(eq(homeServiceLog.id, eid))

  return c.json({ ok: true })
})

home.delete('/devices/:id/service/:eid', requireAuth, async (c) => {
  const { id, eid } = c.req.param()
  await db.delete(homeServiceLog)
    .where(and(eq(homeServiceLog.id, eid), eq(homeServiceLog.deviceId, id)))
  return c.json({ ok: true })
})

// ── Ask AI about device ───────────────────────────────────────────────────────

home.post('/devices/:id/ask', requireAuth, async (c) => {
  const id = c.req.param('id')
  const device = await db.select().from(homeDevices).where(eq(homeDevices.id, id)).then(r => r[0])
  if (!device) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{ question: string }>()
  if (!body.question?.trim()) return c.json({ error: 'question required' }, 400)

  const model = await getModel()

  // Guard the parse of the stored specs column: a corrupt value must not throw.
  let parsedSpecs: Record<string, string> = {}
  if (device.specs) {
    try { parsedSpecs = JSON.parse(device.specs) as Record<string, string> } catch { parsedSpecs = {} }
  }
  const specsText = Object.keys(parsedSpecs).length > 0
    ? '\n\nSpecs:\n' + Object.entries(parsedSpecs)
        .map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''

  const deviceContext = [
    `Device: ${device.name}`,
    device.brand && `Brand: ${device.brand}`,
    device.model && `Model: ${device.model}`,
    device.serialNumber && `Serial: ${device.serialNumber}`,
    device.category && `Category: ${device.category}`,
    device.description && `Description: ${device.description}`,
    device.notes && `Notes: ${device.notes}`,
  ].filter(Boolean).join('\n')

  const manualSnippet = device.manualText
    ? `\n\nManual content (excerpt):\n${device.manualText.slice(0, 8_000)}`
    : ''

  const systemPrompt = `You are a helpful home support assistant. Answer questions about household devices based on the provided device information.
Only answer from the provided context. If the answer isn't in the manual or device info, say so honestly.

${deviceContext}${specsText}${manualSnippet}`

  return streamSSE(c, async stream => {
    const chunks = ollamaChatStream(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: body.question.trim() },
    ], { temperature: 0.3 })

    for await (const chunk of chunks) {
      if (chunk.message?.content) {
        await stream.writeSSE({ data: JSON.stringify({ token: chunk.message.content }) })
      }
    }
    await stream.writeSSE({ data: JSON.stringify({ done: true }) })
  })
})

// ── Warranties expiring soon ──────────────────────────────────────────────────

home.get('/warranties', requireAuth, async (c) => {
  const days = parseInt(c.req.query('days') ?? '90')
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() + days)
  const cutoffStr = cutoff.toISOString().split('T')[0]!
  const todayStr = new Date().toISOString().split('T')[0]!

  const devices = await db.select().from(homeDevices)
  const expiring = devices.filter(d =>
    d.warrantyExpires && d.warrantyExpires >= todayStr && d.warrantyExpires <= cutoffStr
  ).sort((a, b) => (a.warrantyExpires! < b.warrantyExpires! ? -1 : 1))
  const expired = devices.filter(d =>
    d.warrantyExpires && d.warrantyExpires < todayStr
  )

  return c.json({ expiring, expired })
})

// ── Export ────────────────────────────────────────────────────────────────────

home.get('/export', requireAuth, async (c) => {
  const devices = await db.select().from(homeDevices).orderBy(asc(homeDevices.name))
  const serviceEntries = await db.select().from(homeServiceLog).orderBy(desc(homeServiceLog.date))
  const files = await db.select().from(homeDeviceFiles)
  const links = await db.select().from(homeDeviceLinks)

  const exportData = devices.map(d => ({
    ...d,
    photoPath: undefined,
    manualPath: undefined,
    manualText: undefined,
    serviceLog: serviceEntries.filter(s => s.deviceId === d.id),
    files: files.filter(f => f.deviceId === d.id).map(f => ({
      id: f.id, label: f.label, fileType: f.fileType, source: f.source, sizeBytes: f.sizeBytes,
    })),
    links: links.filter(l => l.deviceId === d.id),
  }))

  return c.json({ exportedAt: new Date().toISOString(), devices: exportData })
})

export { home }
