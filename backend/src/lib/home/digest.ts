// AI digest for a home device: common issues, recalls, care tips, and key specs —
// all grounded in web-search snippets and optional manual text. Distilled by the
// fast model (same snippet-grounded pattern as lib/titles/reviews.ts).
//
// Best-effort: no search corpus → null; model failure → partial result.

import { webSearch } from '@/lib/webSearch'
import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'

const J = (s: string) => s.match(/\{[\s\S]*\}/)?.[0]
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => (x as string).trim()).filter(Boolean) : []

export interface DeviceDigest {
  summary: string
  commonIssues: string[]
  recalls: string[]
  careTips: string[]
  hasRecall: boolean
}

export async function getDeviceDigest(
  device: { name: string; brand: string | null; model: string | null; category: string; manualText?: string | null },
): Promise<DeviceDigest | null> {
  const { brand, model, name, category, manualText } = device
  if (!brand && !model) return null

  const key = `${brand?.toLowerCase() ?? ''}:${model?.toLowerCase() ?? ''}:${name.toLowerCase()}`
  return cachedLookup('home-device-digest', key, THIRTY_DAYS_MS, async () => {
    const subject = [brand, model].filter(Boolean).join(' ')
    const [problems, recalls, specs] = await Promise.allSettled([
      webSearch(`${subject} common problems issues complaints`, 4),
      webSearch(`${subject} recall safety notice`, 3),
      webSearch(`${subject} ${category} specifications review`, 3),
    ])

    const snippets = [
      ...(problems.status === 'fulfilled' ? problems.value.map(w => `${w.title}: ${w.snippet}`) : []),
      ...(recalls.status === 'fulfilled'  ? recalls.value.map(w => `${w.title}: ${w.snippet}`)  : []),
      ...(specs.status === 'fulfilled'    ? specs.value.map(w => `${w.title}: ${w.snippet}`)    : []),
      ...(manualText ? [`Manual excerpt: ${manualText.slice(0, 3000)}`] : []),
    ]

    const corpus = snippets.join('\n\n').slice(0, 8000)
    if (!corpus.trim()) return null

    const recallHit = recalls.status === 'fulfilled' && recalls.value.some(w =>
      /recall|cpsc|safety notice|hazard|injury|fire risk/i.test(`${w.title} ${w.snippet}`)
    )

    let summary = '', commonIssues: string[] = [], careTips: string[] = [], recallItems: string[] = []
    try {
      const model_ = await getFastModel()
      const SYSTEM =
        `You summarize information about a ${category} device for an owner who wants to know what to watch out for. ` +
        'From the snippets, extract: a 1-2 sentence summary of what this device is known for, up to 4 common issues/complaints, ' +
        'up to 3 recalls or safety notices (only if present in the snippets), and up to 3 care/maintenance tips. ' +
        'Base everything ONLY on the provided snippets — do NOT invent. If information is not present, leave the list empty. ' +
        'Return ONLY JSON: {"summary":"...","commonIssues":["..."],"recalls":["..."],"careTips":["..."]}'
      const resp = await ollamaChat(
        model_,
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Device: "${name}" (${brand ?? ''} ${model ?? ''}, ${category})\n\nSnippets:\n${corpus}` },
        ],
        undefined,
        { temperature: 0.3, num_ctx: 8192, num_predict: 500 },
      )
      const j = J(resp.message?.content ?? '')
      if (j) {
        const p = JSON.parse(j) as { summary?: unknown; commonIssues?: unknown; recalls?: unknown; careTips?: unknown }
        summary      = typeof p.summary === 'string' ? p.summary.trim() : ''
        commonIssues = strs(p.commonIssues).slice(0, 4)
        recallItems  = strs(p.recalls).slice(0, 3)
        careTips     = strs(p.careTips).slice(0, 3)
      }
    } catch { /* model unavailable — return empty digest */ }

    if (!summary && !commonIssues.length && !recallItems.length && !careTips.length) return null
    return { summary, commonIssues, recalls: recallItems, careTips, hasRecall: recallHit || recallItems.length > 0 }
  })
}
