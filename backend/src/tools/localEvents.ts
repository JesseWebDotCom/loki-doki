import type { Tool, ToolResult } from './index'
import { patchLocal } from '@/lib/briefing/sources/patch'
import { deriveSlug } from '@/lib/briefing/slug'
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

export const localEventsTool: Tool = {
  id: 'localEvents',
  name: 'Local Events',
  description: 'Find local events, festivals, and community happenings near the user',
  offline: false,
  passMessage: 'query',
  configSchema: [PATCH_SLUG_FIELD, DEFAULT_LOCATION_FIELD],
  dataSources: [
    { name: 'Google News', domain: 'news.google.com', purpose: 'Local event listings search', type: 'rss' },
    { name: 'Patch.com', domain: 'patch.com', purpose: 'Hyperlocal town events and listings', type: 'web' },
  ],
  examples: [
    "what's happening in town this weekend",
    'local events or festivals near me',
    'things to do in my area today',
    'is there a parade, fair, or concert nearby',
    'community events this week',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'localEvents',
      description: 'Find local events and community happenings near the user',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'Optional refinement, e.g. "this weekend" or "kids". Omit for general local events.' },
        },
      },
    },
  },

  async execute(_args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const townLabel = String(config?.['default_location'] ?? '').trim()
    const slugOverride = String(config?.['patch_slug'] ?? '').trim() || null
    const userId = String(config?.['_userId'] ?? '').trim()

    if (!townLabel && !slugOverride) {
      return { success: false, error: 'Set your location in Settings → General to get local events.' }
    }

    // Patch path — richer structured events when a userId is available
    if (userId) {
      try {
        const slug = slugOverride ?? deriveSlug(townLabel)
        const r = await patchLocal({ slug, townLabel: townLabel || slug || '', limit: 6 })
        if (r.events.length) {
          return {
            success: true,
            data: {
              source: r.usedFallback ? 'web' : 'patch',
              events: r.events,
              answer_payload: {
                gist: `Local events near ${townLabel || 'you'}: ${r.events[0]!.title}${r.events[0]!.detail ? ` (${r.events[0]!.detail})` : ''}`,
                highlights: r.events.slice(1, 6).map((e) => (e.detail ? `${e.title} — ${e.detail}` : e.title)),
                sources: r.events.filter((e) => e.url).slice(0, 5).map((e) => ({ url: e.url!, title: e.title.slice(0, 120) })),
                depth_available: false,
              },
            },
          }
        }
      } catch {
        // Fall through to clean path
      }
    }

    // Clean default — Google News RSS search for local events (no scraping)
    try {
      const location = townLabel || slugOverride || ''
      const raw = await googleNewsSearch(`${location} local events this week`, 5, 7000)
      if (!raw.length) {
        return { success: true, data: { events: [], answer_payload: { gist: "I couldn't find any local events right now." } } }
      }
      const events = raw.map((r) => ({ title: r.title, url: r.url, detail: r.source || undefined }))
      return {
        success: true,
        data: {
          source: 'web',
          events,
          answer_payload: {
            gist: `Local events near ${location || 'you'}: ${events[0]!.title}`,
            highlights: events.slice(1, 5).map((e) => e.title),
            sources: events.filter((e) => e.url).slice(0, 5).map((e) => ({ url: e.url!, title: e.title.slice(0, 120) })),
            depth_available: false,
          },
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
