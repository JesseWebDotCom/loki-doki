// Watch conditions for monitored bookmarks: scope the diff to a CSS selector and turn
// "the page changed" into a real condition ("price dropped below 500", "'in stock'
// appeared"). Selector extraction uses Bun's built-in HTMLRewriter (native lol-html —
// zero deps, real CSS-selector matching, streaming so no DOM is built). It must run on
// the RAW page HTML: the archive sanitizer strips class/id attributes.

import { logger } from '@/lib/logger'

export type WatchMode = 'any_change' | 'keyword_appears' | 'keyword_disappears' | 'number_below' | 'number_above'

export interface WatchConfig {
  selector: string | null // null/empty = whole page (reader text)
  mode: WatchMode
  keyword: string | null
  threshold: number | null
}

export const WATCH_MODES: readonly WatchMode[] = ['any_change', 'keyword_appears', 'keyword_disappears', 'number_below', 'number_above']

// Cap stored extracts: the whole-page fallback would otherwise duplicate contentText.
const MAX_WATCH_VALUE_CHARS = 2000

/** Concatenated text content of elements matching `selector` in the raw page HTML.
 *  Falls back to `fallbackText` (the reader text) when the selector is null, invalid,
 *  or matches nothing — a misconfigured watcher degrades to whole-page, never goes dead.
 *  Note: lol-html supports tag/#id/.class/[attr]/descendant selectors, not :nth-child. */
export async function extractWatchText(rawHtml: string, selector: string | null, fallbackText: string): Promise<string> {
  const sel = selector?.trim()
  const fallback = normalizeWatchText(fallbackText)
  if (!sel) return fallback
  try {
    let out = ''
    const rewriter = new HTMLRewriter().on(sel, {
      text(t) { out += t.text },
    })
    await rewriter.transform(new Response(rawHtml)).text()
    const normalized = normalizeWatchText(out)
    return normalized || fallback
  } catch (err) {
    logger.warn(`[bookmarks] watch selector "${sel}" failed (falling back to whole page): ${err}`)
    return fallback
  }
}

export function normalizeWatchText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_WATCH_VALUE_CHARS)
}

/** First number in the extract, tolerant of currency symbols and thousands separators
 *  ("$1,299.99" → 1299.99). Returns the raw matched token too, for human messages. */
export function firstNumber(text: string): { value: number; raw: string } | null {
  const m = /[-–]?\s*[$€£]?\s*\d[\d,]*(?:\.\d+)?/.exec(text)
  if (!m) return null
  const raw = m[0].trim()
  const value = Number.parseFloat(raw.replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(value) ? { value, raw } : null
}

function hasKeyword(text: string | null, keyword: string): boolean {
  return (text ?? '').toLowerCase().includes(keyword.toLowerCase())
}

export interface WatchVerdict {
  triggered: boolean
  message: string
}

/** Edge-triggered condition evaluation: fires only on the TRANSITION into the condition
 *  (prev didn't satisfy it, next does), so a met condition doesn't re-alert every
 *  5-minute check. `prev === null` (first capture) never triggers — it sets the baseline. */
export function evaluateWatch(prev: string | null, next: string, cfg: WatchConfig, title: string): WatchVerdict {
  const name = title.length > 60 ? `${title.slice(0, 57)}…` : title
  switch (cfg.mode) {
    case 'keyword_appears': {
      const kw = cfg.keyword?.trim()
      if (!kw) return { triggered: false, message: '' }
      return {
        triggered: prev !== null && !hasKeyword(prev, kw) && hasKeyword(next, kw),
        message: `"${kw}" appeared on "${name}"`,
      }
    }
    case 'keyword_disappears': {
      const kw = cfg.keyword?.trim()
      if (!kw) return { triggered: false, message: '' }
      return {
        triggered: prev !== null && hasKeyword(prev, kw) && !hasKeyword(next, kw),
        message: `"${kw}" disappeared from "${name}"`,
      }
    }
    case 'number_below': {
      const t = cfg.threshold
      if (t == null) return { triggered: false, message: '' }
      const now = firstNumber(next)
      const before = prev === null ? null : firstNumber(prev)
      const crossed = now !== null && now.value < t && (before === null || before.value >= t)
      return {
        triggered: prev !== null && crossed,
        message: now ? `Dropped to ${now.raw} on "${name}"` : '',
      }
    }
    case 'number_above': {
      const t = cfg.threshold
      if (t == null) return { triggered: false, message: '' }
      const now = firstNumber(next)
      const before = prev === null ? null : firstNumber(prev)
      const crossed = now !== null && now.value > t && (before === null || before.value <= t)
      return {
        triggered: prev !== null && crossed,
        message: now ? `Rose to ${now.raw} on "${name}"` : '',
      }
    }
    case 'any_change':
    default:
      return {
        triggered: prev !== null && normalizeWatchText(prev) !== normalizeWatchText(next),
        message: cfg.selector ? `Watched section of "${name}" changed` : `"${name}" changed`,
      }
  }
}
