import type { Tool, ToolResult } from './index'
import { zimSearch } from '@/lib/zimSearch'
import { kiwixContentBase } from '@/lib/kiwix'
import { stripHtml } from '@/lib/htmlText'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'

// Companion tool: repair guides. Ported from the v2 app's plugins/repair. Prefers the
// offline iFixit ZIM archive; if it isn't installed, falls back to iFixit's public API.
// Returns guide text (truncated) plus a has_steps flag so the model knows it can walk
// the user through numbered steps.

const MAX_CHARS = 6000
const STEP_RE = /^(?:step\s+)?\d+[.:)]\s+\S/im

interface RepairData {
  title: string
  extract: string
  url: string | null
  source_label: 'iFixit'
  has_steps: boolean
  offline: boolean
}

/** Fetch and clean the body of the top iFixit ZIM article. */
async function fromZim(query: string): Promise<RepairData | null> {
  const hits = await zimSearch(['ifixit'], query, 3)
  const top = hits[0]
  if (!top) return null
  try {
    const res = await fetch(`${kiwixContentBase(top.bookName)}/${top.path}`, {
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const text = stripHtml(html).slice(0, MAX_CHARS)
    return {
      title: top.title,
      extract: text,
      url: `/api/archives/view/${top.sourceId}/${top.path}`,
      source_label: 'iFixit',
      has_steps: STEP_RE.test(text),
      offline: true,
    }
  } catch {
    return null
  }
}

interface IFixitSearchResult {
  title?: string
  url?: string
  type?: string
  guideid?: number
}
interface IFixitGuide {
  title?: string
  url?: string
  introduction_raw?: string
  introduction_rendered?: string
  steps?: Array<{ title?: string; lines?: Array<{ text_raw?: string }> }>
}

/** iFixit public API fallback (online). https://www.ifixit.com/api/2.0/ */
async function fromApi(query: string): Promise<RepairData | null> {
  return cachedLookup('repair_ifixit', query, THIRTY_DAYS_MS, async () => {
    const searchRes = await fetch(
      `https://www.ifixit.com/api/2.0/search/${encodeURIComponent(query)}?filter=guide`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6_000) },
    )
    if (!searchRes.ok) return null
    const search = (await searchRes.json()) as { results?: IFixitSearchResult[] }
    const guide = (search.results ?? []).find((r) => r.type === 'guide' && r.guideid)
    if (!guide?.guideid) return null

    const guideRes = await fetch(`https://www.ifixit.com/api/2.0/guides/${guide.guideid}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    })
    if (!guideRes.ok) return null
    const g = (await guideRes.json()) as IFixitGuide

    const intro = stripHtml(g.introduction_rendered ?? g.introduction_raw ?? '')
    const steps = (g.steps ?? [])
      .map((s, i) => {
        const body = (s.lines ?? []).map((l) => l.text_raw ?? '').filter(Boolean).join(' ')
        return `Step ${i + 1}${s.title ? ` — ${s.title}` : ''}: ${body}`.trim()
      })
      .filter(Boolean)
    const extract = [intro, ...steps].join('\n\n').slice(0, MAX_CHARS)

    return {
      title: g.title ?? guide.title ?? query,
      extract,
      url: g.url ?? guide.url ?? null,
      source_label: 'iFixit' as const,
      has_steps: steps.length > 0,
      offline: false,
    }
  })
}

export const repairTool: Tool = {
  id: 'repair',
  name: 'Repair Guides',
  description:
    'Step-by-step repair and fix-it guides (electronics, appliances, vehicles, household). Uses the offline iFixit library, or iFixit.com when online.',
  offline: true,
  core: true,
  dataSources: [
    { name: 'iFixit', domain: 'ifixit.com', purpose: 'Repair guides (online fallback when the offline library is absent)', type: 'api' },
  ],
  passMessage: 'query',
  examples: [
    'how to fix or repair a device',
    'replace the battery / screen on a phone',
    'repair guide for an appliance',
    'fix a leaky faucet or broken thing at home',
    'troubleshoot and take apart a gadget',
    'step by step disassembly instructions',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'repair',
      description: 'Find a step-by-step repair guide for a device, appliance, vehicle, or household item.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to repair, e.g. "iPhone 12 battery replacement" or "leaky faucet".' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query } = args as { query?: string }
    const q = query?.trim()
    if (!q) return { success: false, error: 'Describe what you want to repair' }

    try {
      const zim = await fromZim(q)
      if (zim) return { success: true, data: zim }

      const api = await fromApi(q)
      if (api) return { success: true, data: api }

      return { success: false, error: `No repair guide found for "${q}"` }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Offline iFixit library not installed and iFixit.com is unreachable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
