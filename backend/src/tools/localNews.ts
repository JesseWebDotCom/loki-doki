import type { Tool, ToolResult } from './index'
import { patchLocal } from '@/lib/briefing/sources/patch'
import { resolvePatchSlug } from '@/lib/briefing/resolveSlug'
import { googleNewsSearch } from '@/lib/briefing/sources/rss'

const PATCH_SLUG_FIELD = {
  key: 'patch_slug',
  label: 'Patch town slug',
  description: 'Override the Patch hyperlocal path, e.g. "connecticut/milford". Leave blank to derive from your location.',
  type: 'string' as const,
  scope: 'both' as const,
  placeholder: 'connecticut/milford',
}

const DEFAULT_LOCATION_FIELD = {
  key: 'default_location',
  label: 'Default Location',
  description: 'Town used when none is mentioned (also taken from Settings → General).',
  type: 'string' as const,
  scope: 'user' as const,
  placeholder: 'e.g. Milford, CT',
}

export const localNewsTool: Tool = {
  id: 'localNews',
  name: 'Local News',
  description: "Get hyperlocal news headlines for the user's town",
  offline: false,
  passMessage: 'query',
  configSchema: [PATCH_SLUG_FIELD, DEFAULT_LOCATION_FIELD],
  dataSources: [
    { name: 'Google News', domain: 'news.google.com', purpose: 'Local headline search', type: 'rss' },
    { name: 'Patch.com', domain: 'patch.com', purpose: 'Hyperlocal town news and articles', type: 'web' },
  ],
  examples: [
    'local news in my town',
    "what's going on around here lately",
    'hyperlocal headlines near me',
    'town news and updates',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'localNews',
      description: "Get hyperlocal news headlines for the user's town",
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'Optional topic refinement. Omit for general local headlines.' },
        },
      },
    },
  },

  async execute(_args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const townLabel = String(config?.['default_location'] ?? '').trim()
    const slugOverride = String(config?.['patch_slug'] ?? '').trim() || null
    const userId = String(config?.['_userId'] ?? '').trim()

    if (!townLabel && !slugOverride) {
      return { success: false, error: 'Set your location in Settings → General to get local news.' }
    }

    // Patch path — richer structured results when a userId is available
    if (userId) {
      try {
        const slug = slugOverride ?? (await resolvePatchSlug(townLabel))
        const r = await patchLocal({ slug, townLabel: townLabel || slug || '', limit: 6 })
        if (r.news.length) {
          return {
            success: true,
            data: {
              source: r.usedFallback ? 'web' : 'patch',
              news: r.news,
              answer_payload: {
                gist: `Local headline${townLabel ? ` for ${townLabel}` : ''}: ${r.news[0]!.title}`,
                highlights: r.news.slice(1, 6).map((n) => n.title),
                sources: r.news.filter((n) => n.url).slice(0, 5).map((n) => ({ url: n.url!, title: n.title.slice(0, 120) })),
                depth_available: false,
              },
            },
          }
        }
      } catch {
        // Fall through to clean path
      }
    }

    // Clean default — Google News RSS search (no scraping, no consent needed)
    try {
      const location = townLabel || slugOverride || ''
      const raw = await googleNewsSearch(`${location} local news`, 6, 7000)
      if (!raw.length) {
        return { success: true, data: { news: [], answer_payload: { gist: "I couldn't find local news right now." } } }
      }
      const news = raw.map((r) => ({ title: r.title, summary: r.detail, source: r.source, url: r.url }))
      return {
        success: true,
        data: {
          source: 'web',
          news,
          answer_payload: {
            gist: `Local headline${townLabel ? ` for ${townLabel}` : ''}: ${news[0]!.title}`,
            highlights: news.slice(1, 6).map((n) => n.title),
            sources: news.filter((n) => n.url).slice(0, 5).map((n) => ({ url: n.url!, title: n.title.slice(0, 120) })),
            depth_available: false,
          },
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
