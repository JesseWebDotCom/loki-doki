// Text-quote highlight anchoring for the bookmarks reader.
//
// Capture: on selection, compute the quote plus ~32 chars of surrounding plain text
// (prefix/suffix) from a TreeWalker index of the prose container.
// Reapply: find every indexOf(quote) candidate in the container's full text, score by
// prefix/suffix agreement (disambiguates duplicate phrases), then wrap the winning range
// in <mark data-hl-id> — splitting text nodes as needed. Quotes not found at all are
// ORPHANED (content changed since the highlight was made) and surface in the panel with
// a badge instead of being silently dropped — auto-watched pages re-archive often.
//
// The index is rebuilt between highlights: splitText() invalidates prior offsets, and at
// household annotation volume (tens of highlights) the rebuild cost is negligible.

import { useCallback, useEffect, useState } from 'react'
import type { Highlight, HighlightColor } from '@/lib/bookmarks/api'

const CONTEXT_CHARS = 32

// design-ok(raw-palette-semantic): user-selectable highlighter color palette (real highlighter-pen
// hues), the fixed swatch set is itself the feature, not incidental UI chrome
export const HIGHLIGHT_MARK_CLASS: Record<HighlightColor, string> = {
  yellow: 'bg-yellow-400/30',
  green: 'bg-emerald-400/30',
  blue: 'bg-sky-400/30',
  pink: 'bg-pink-400/30',
  // design-ok(banned-palette): user-selectable highlighter color palette, needs a violet swatch distinct from other 4 hues and from --brand; not a UI accent
  purple: 'bg-violet-400/30',
}

export interface PendingSelection {
  quote: string
  prefix: string
  suffix: string
  /** Viewport rect of the selection (position the floating toolbar). */
  rect: DOMRect
}

interface TextIndex {
  full: string
  nodes: Text[]
  starts: number[] // global start offset of each text node
}

function buildIndex(container: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let full = ''
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    // Skip our own <mark> wrappers' internals? No — marks wrap the SAME text, so the
    // index stays identical whether or not marks are applied. Keep everything.
    nodes.push(node)
    starts.push(full.length)
    full += node.data
  }
  return { full, nodes, starts }
}

/** Global [start, end) of a DOM Range within the index; null if outside the container. */
function rangeToOffsets(index: TextIndex, range: Range): { start: number; end: number } | null {
  const locate = (node: Node, offset: number): number | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const i = index.nodes.indexOf(node as Text)
      if (i === -1) return null
      return index.starts[i]! + offset
    }
    // Element container: resolve to the start of the offset-th child's first text.
    let target: Node | null = node.childNodes[offset] ?? null
    if (!target) {
      // Past the last child — use the end of the element's last text node.
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      while (walker.nextNode()) last = walker.currentNode as Text
      if (!last) return null
      const i = index.nodes.indexOf(last)
      return i === -1 ? null : index.starts[i]! + last.data.length
    }
    while (target && target.nodeType !== Node.TEXT_NODE) {
      target = target.firstChild ?? target.nextSibling
    }
    if (!target) return null
    const i = index.nodes.indexOf(target as Text)
    return i === -1 ? null : index.starts[i]!
  }
  const start = locate(range.startContainer, range.startOffset)
  const end = locate(range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null
  return { start, end }
}

/** Best match position of quote in full text, scored by prefix/suffix agreement. */
function findQuote(full: string, h: { quote: string; prefix: string; suffix: string }): number | null {
  if (!h.quote) return null
  const candidates: number[] = []
  let pos = full.indexOf(h.quote)
  while (pos !== -1 && candidates.length < 50) {
    candidates.push(pos)
    pos = full.indexOf(h.quote, pos + 1)
  }
  if (!candidates.length) return null
  if (candidates.length === 1) return candidates[0]!
  let best = candidates[0]!
  let bestScore = -1
  for (const c of candidates) {
    const before = full.slice(Math.max(0, c - h.prefix.length), c)
    const after = full.slice(c + h.quote.length, c + h.quote.length + h.suffix.length)
    let score = 0
    if (h.prefix && before === h.prefix) score += 2
    else if (h.prefix) score += overlapFraction(before, h.prefix)
    if (h.suffix && after === h.suffix) score += 2
    else if (h.suffix) score += overlapFraction(after, h.suffix)
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best
}

function overlapFraction(a: string, b: string): number {
  if (!a || !b) return 0
  let n = 0
  const min = Math.min(a.length, b.length)
  // Compare from the boundary inward (suffix of prefix / prefix of suffix agreement).
  for (let i = 0; i < min; i++) if (a[a.length - 1 - i] === b[b.length - 1 - i]) n++
  return n / min
}

/** Wrap [start, end) in <mark> elements (one per intersected text node). */
function wrapRange(container: HTMLElement, start: number, end: number, hl: Highlight, onClick: (id: string) => void): void {
  const index = buildIndex(container)
  // Find intersecting nodes via binary search on starts.
  for (let i = 0; i < index.nodes.length; i++) {
    const nodeStart = index.starts[i]!
    const node = index.nodes[i]!
    const nodeEnd = nodeStart + node.data.length
    if (nodeEnd <= start) continue
    if (nodeStart >= end) break
    if (node.parentElement?.dataset.hlId === hl.id) continue // already wrapped

    const from = Math.max(start, nodeStart) - nodeStart
    const to = Math.min(end, nodeEnd) - nodeStart
    let target = node
    if (from > 0) target = target.splitText(from)
    if (to - from < target.data.length) target.splitText(to - from)

    const mark = document.createElement('mark')
    mark.dataset.hlId = hl.id
    mark.className = `${HIGHLIGHT_MARK_CLASS[hl.color] ?? HIGHLIGHT_MARK_CLASS.yellow} cursor-pointer rounded-[2px] px-0 text-inherit`
    if (hl.note) mark.title = hl.note
    target.parentNode?.replaceChild(mark, target)
    mark.appendChild(target)
    mark.addEventListener('click', (e) => { e.stopPropagation(); onClick(hl.id) })
    // splitText invalidated our index — restart the scan for the remainder.
    return wrapRange(container, Math.min(end, nodeEnd), end, hl, onClick)
  }
}

export function useHighlightAnchoring(
  containerRef: React.RefObject<HTMLDivElement | null>,
  highlights: Highlight[],
  opts: {
    enabled: boolean
    contentKey: string | null | undefined // re-run marker (contentHtml identity)
    onMarkClick: (id: string) => void
  },
): {
  orphanedIds: Set<string>
  pendingSelection: PendingSelection | null
  clearSelection: () => void
} {
  const [orphanedIds, setOrphanedIds] = useState<Set<string>>(new Set())
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null)
  const { enabled, contentKey, onMarkClick } = opts

  // ── Reapply marks whenever content or highlights change ──
  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    // Strip any prior marks (from a previous highlights array) before re-applying:
    // React re-rendered dangerouslySetInnerHTML only if contentKey changed, so stale
    // marks can survive a highlights-only update.
    for (const mark of Array.from(container.querySelectorAll('mark[data-hl-id]'))) {
      const parent = mark.parentNode
      while (mark.firstChild) parent?.insertBefore(mark.firstChild, mark)
      parent?.removeChild(mark)
      parent?.normalize()
    }

    const orphans = new Set<string>()
    for (const hl of highlights) {
      if (hl.kind !== 'highlight' || !hl.quote) continue
      const index = buildIndex(container)
      const pos = findQuote(index.full, hl)
      if (pos === null) { orphans.add(hl.id); continue }
      wrapRange(container, pos, pos + hl.quote.length, hl, onMarkClick)
    }
    setOrphanedIds(orphans)
  }, [containerRef, highlights, enabled, contentKey, onMarkClick])

  // ── Capture selections ──
  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    const onMouseUp = () => {
      // Let the browser finalize the selection first.
      requestAnimationFrame(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setPendingSelection(null); return }
        const range = sel.getRangeAt(0)
        if (!container.contains(range.commonAncestorContainer)) return
        const index = buildIndex(container)
        const offsets = rangeToOffsets(index, range)
        if (!offsets) return
        const quote = index.full.slice(offsets.start, offsets.end)
        if (!quote.trim() || quote.length > 2000) { setPendingSelection(null); return }
        setPendingSelection({
          quote,
          prefix: index.full.slice(Math.max(0, offsets.start - CONTEXT_CHARS), offsets.start),
          suffix: index.full.slice(offsets.end, offsets.end + CONTEXT_CHARS),
          rect: range.getBoundingClientRect(),
        })
      })
    }
    const onMouseDown = () => setPendingSelection(null)

    container.addEventListener('mouseup', onMouseUp)
    container.addEventListener('mousedown', onMouseDown)
    return () => {
      container.removeEventListener('mouseup', onMouseUp)
      container.removeEventListener('mousedown', onMouseDown)
    }
  }, [containerRef, enabled, contentKey])

  return {
    orphanedIds,
    pendingSelection,
    clearSelection: useCallback(() => setPendingSelection(null), []),
  }
}

/** Scroll the reader to a highlight's mark (panel click-through). */
export function scrollToHighlight(container: HTMLElement | null, id: string): void {
  const mark = container?.querySelector(`mark[data-hl-id="${CSS.escape(id)}"]`)
  mark?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
