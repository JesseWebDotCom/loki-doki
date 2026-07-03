// Photo product lookup: turn a phone photo of a barcode, product, box, or label into
// candidate products to track. Reuses the home-inventory identify machinery — the CSAM
// safety gate, Apple Vision on macOS, and the vision LLM fallback. The user always
// confirms a candidate before anything is tracked.
//
// Ladder:
//   1. Safety screen (never send a flagged image to any model).
//   2. Barcode (Apple Vision VNDetectBarcodesRequest, macOS) → UPC/EAN → upcitemdb → search.
//   3. No barcode → OCR + a vision "what product is this?" pass → cross-retailer search.

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { getVisionModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { screenImage, logCsamBlock } from '@/lib/safety/csamGuard'
import { cachedLookup } from '@/lib/lookupCache'
import { fetchHtml } from '@/lib/scrape'
import { searchableAdapters } from '@/lib/shopping/adapters'
import { normalizeGtin } from '@/lib/shopping/fetch'
import type { ProductSummary } from '@/lib/shopping/types'
import { logger } from '@/lib/logger'

export interface IdentifyResult {
  barcode: string | null
  guess: string | null            // editable search phrase for the user
  brand: string | null
  candidates: ProductSummary[]
  note?: string
}

// ── barcode via Apple Vision (macOS only) ──────────────────────────────────────────

const BARCODE_SWIFT = `import Vision
import Foundation

let args = CommandLine.arguments
guard args.count > 1 else { exit(1) }
let url = URL(fileURLWithPath: args[1])
var found: [String] = []
let done = DispatchSemaphore(value: 0)

let req = VNDetectBarcodesRequest { r, _ in
    defer { done.signal() }
    for o in (r.results as? [VNBarcodeObservation] ?? []) {
        if let s = o.payloadStringValue { found.append(s) }
    }
}
req.symbologies = [.ean13, .ean8, .upce, .code128, .code39]
try? VNImageRequestHandler(url: url).perform([req])
done.wait()
print(found.first ?? "")
`

async function detectBarcode(photoPath: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const runExec = promisify(exec)
    const scriptPath = join(dataDir, 'shopping', 'barcode.swift')
    await mkdir(join(dataDir, 'shopping'), { recursive: true })
    if (!existsSync(scriptPath)) await writeFile(scriptPath, BARCODE_SWIFT, 'utf8')
    const { stdout } = await runExec(`swift "${scriptPath}" "${photoPath}"`, { timeout: 25_000 })
    const code = stdout.trim()
    return code.length >= 8 ? code : null
  } catch (e) {
    logger.info(`[shopping/identify] barcode detect unavailable: ${String(e).slice(0, 80)}`)
    return null
  }
}

// ── UPC → product name (upcitemdb free trial, ~100/day, keyless) ────────────────────

async function upcLookup(gtin: string): Promise<{ title: string; brand: string | null } | null> {
  return cachedLookup('shopping:upc', gtin, 30 * 24 * 60 * 60 * 1000, async () => {
    const json = await fetchHtml(`https://api.upcitemdb.com/prod/trial/lookup?upc=${gtin}`, { timeoutMs: 10_000 })
    if (!json) return null
    try {
      const data = JSON.parse(json) as { items?: { title?: string; brand?: string }[] }
      const item = data.items?.[0]
      if (!item?.title) return null
      return { title: item.title, brand: item.brand ?? null }
    } catch {
      return null
    }
  })
}

// ── VLM identify (no barcode) ───────────────────────────────────────────────────────

async function visionIdentify(base64: string): Promise<{ query: string; brand: string | null } | null> {
  const model = await getVisionModel()
  if (!model) return null
  try {
    const res = await ollamaChat(
      model,
      [
        { role: 'system', content: 'You identify consumer products from a photo so they can be searched in online stores. Read any visible brand and model text. Answer only from what you see.' },
        { role: 'user', content: 'Identify this product. Give the brand, a concise searchable name (brand + product line + model if visible), and the model number if visible.', images: [base64] },
      ],
      undefined,
      { temperature: 0 },
      {
        type: 'object',
        properties: {
          brand: { type: ['string', 'null'] },
          name: { type: ['string', 'null'] },
          model: { type: ['string', 'null'] },
        },
        required: ['name'],
      },
      45_000,
    )
    const parsed = JSON.parse(res.message.content) as { brand: string | null; name: string | null; model: string | null }
    const query = [parsed.brand, parsed.name, parsed.model].filter(Boolean).join(' ').trim()
      || parsed.name || ''
    if (!query) return null
    return { query, brand: parsed.brand ?? null }
  } catch (e) {
    logger.info(`[shopping/identify] vision identify failed: ${String(e).slice(0, 80)}`)
    return null
  }
}

// ── cross-retailer search for candidates ────────────────────────────────────────────

async function searchCandidates(query: string): Promise<ProductSummary[]> {
  const adapters = searchableAdapters()
  const settled = await Promise.allSettled(adapters.map(a => a.search(query)))
  const out: ProductSummary[] = []
  for (const s of settled) if (s.status === 'fulfilled') out.push(...s.value.slice(0, 4))
  return out
}

/** photoPath = a saved image file; base64 = its contents (already read by the caller). */
export async function identifyFromPhoto(photoPath: string, base64: string, userId: string): Promise<IdentifyResult | { blocked: true }> {
  const verdict = await screenImage(base64)
  if (verdict.flagged) {
    logCsamBlock('shopping identify photo', userId, verdict.reason ?? 'photo')
    return { blocked: true }
  }

  // 1. Barcode path — most precise when present.
  const barcode = await detectBarcode(photoPath)
  const gtin = normalizeGtin(barcode)
  if (gtin) {
    const upc = await upcLookup(gtin)
    if (upc) {
      const candidates = await searchCandidates(upc.title)
      return { barcode: gtin, guess: upc.title, brand: upc.brand, candidates }
    }
    // Barcode read but not in the UPC DB — still let the user search by the raw code.
    const candidates = await searchCandidates(gtin)
    return { barcode: gtin, guess: gtin, brand: null, candidates, note: 'Barcode found but not in the product database — search results may be limited.' }
  }

  // 2. Vision identify path.
  const vision = await visionIdentify(base64)
  if (vision) {
    const candidates = await searchCandidates(vision.query)
    return { barcode: null, guess: vision.query, brand: vision.brand, candidates }
  }

  return { barcode: null, guess: null, brand: null, candidates: [], note: "Couldn't identify a product in that photo — try a clearer shot of the label or barcode." }
}
