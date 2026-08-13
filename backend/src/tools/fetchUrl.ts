// Open Link: fetch a user-supplied URL and answer from the page's extracted text.
// Users paste links constantly ("what does this article say?", "summarize this");
// without this tool a pasted URL either routed to web search (which searched for
// the URL string) or was answered from stale weights. Reuses the bookmarks
// extraction stack: assertPublicUrl SSRF guard, direct fetch → Wayback fallback,
// readability extraction. Page text is folded as quoted outside material - the
// injection framing in the presentation policy applies to it.

import type { Tool, ToolResult } from './index'
import { extractArticle } from '@/lib/content/extract'

const URL_RE = /https?:\/\/[^\s<>"')\]]+/i

// Cap what reaches the prompt: enough for a solid summary without blowing prefill.
const PAGE_TEXT_BUDGET = 6_000

export const fetchUrlTool: Tool = {
  id: 'fetch_url',
  name: 'Open Link',
  description: 'Fetch a link the user pasted and answer questions about that page or article',
  offline: false,
  dataSources: [
    { name: 'The linked site', domain: 'user-provided', purpose: 'Fetches the exact page the user asked about', type: 'web' },
    { name: 'Wayback Machine', domain: 'web.archive.org', purpose: 'Public-archive fallback when the site blocks direct fetches', type: 'web' },
  ],
  examples: [
    'summarize this article for me (with a pasted link)',
    'what does this page say',
    'read this link and tell me the key points',
    'open this url and answer my question about it',
    'tl;dr of this article link',
    'what is this website about',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the content of a URL the user provided and answer from it. Only for messages that contain an explicit link.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            description: 'The full http(s) URL to fetch, exactly as the user provided it',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { url: argUrl } = args as { url?: string }
    // Fall back to the raw message - small models sometimes mangle long URLs
    // during arg extraction, and the message is the ground truth anyway.
    const raw = (config?.['_rawMessage'] as string | undefined) ?? ''
    const url = (argUrl && URL_RE.test(argUrl) ? argUrl.match(URL_RE)![0] : null) ?? raw.match(URL_RE)?.[0] ?? null
    if (!url) return { success: false, error: 'No URL found in the message' }

    try {
      const article = await extractArticle(url, 10_000)
      const text = (article.contentText ?? '').trim()
      if (!text) return { success: false, error: 'The page had no readable text (it may need JavaScript or be behind a login)' }

      const title = article.title || new URL(url).hostname
      const clipped = text.length > PAGE_TEXT_BUDGET
      return {
        success: true,
        data: {
          url,
          title,
          siteName: article.siteName,
          byline: article.byline,
          answer_payload: {
            gist: `Content of "${title}"${article.siteName ? ` (${article.siteName})` : ''}${clipped ? ', longer than shown - say so if asked about parts beyond this excerpt' : ''}:`,
            page_text: text.slice(0, PAGE_TEXT_BUDGET),
            sources: [{ n: 1, title, url }],
          },
        },
      }
    } catch (err) {
      return { success: false, error: `Could not fetch that page: ${err instanceof Error ? err.message : err}` }
    }
  },
}
