import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'
import type { HomeLayout, HomeRow } from '@/routes/homeLayout'

// Auto-generated starter home (#11). A brand-new user with no saved layout gets a screen
// inferred from what is actually installed, instead of one static default for everyone.
//
// Ordered candidates: zero-config widgets that are always populated for a new user come
// first; gated widgets are appended only when their backing tool is installed. `id` is the
// widget id placed in the canvas; `requiredTool` (when present) is the /api/tools tool id
// that must be installed for the widget to appear. Widget ids and their tool gating mirror
// frontend/src/lib/homeWidgets.ts.
const STARTER_CANDIDATES: Array<{ id: string; requiredTool?: string }> = [
  { id: 'morning-briefing' },                          // weather + top story + scores + history, zero config
  { id: 'news', requiredTool: 'news' },
  { id: 'on-this-day', requiredTool: 'onthisday' },
  { id: 'subs-youtube', requiredTool: 'youtube' },
  { id: 'sports', requiredTool: 'sports' },
  { id: 'ha-summary', requiredTool: 'homeAssistant' },
  { id: 'watchlist' },
]

// Keep the starter compact: a hero plus a few rows, never a wall of tiles.
const MAX_STARTER_ROWS = 5

/** A predicate: is a given tool id installed? Default (no config row) = installed, matching
 *  App Store semantics (__enabled absent or true = installed). */
async function installedPredicate(): Promise<(toolId: string) => boolean> {
  const rows = await db
    .select({ toolId: toolGlobalConfig.toolId, value: toolGlobalConfig.value })
    .from(toolGlobalConfig)
    .where(eq(toolGlobalConfig.key, '__enabled'))
  const disabled = new Set<string>()
  for (const r of rows) {
    try { if (JSON.parse(r.value) === false) disabled.add(r.toolId) } catch { /* ignore */ }
  }
  return (toolId: string) => !disabled.has(toolId)
}

/** Build a starter layout, keeping the given base header (so admin header prefs carry) and
 *  replacing the canvas with widgets inferred from installed tools. Falls back to the base
 *  canvas if nothing qualifies (never returns an empty canvas). */
export async function buildStarterLayout(base: HomeLayout): Promise<HomeLayout> {
  const isInstalled = await installedPredicate()
  const rows: HomeRow[] = []
  for (const cand of STARTER_CANDIDATES) {
    if (rows.length >= MAX_STARTER_ROWS) break
    if (cand.requiredTool && !isInstalled(cand.requiredTool)) continue
    rows.push({ id: `starter-${cand.id}`, cols: [{ toolId: cand.id, colSpan: 2 }] })
  }
  return { header: base.header, canvas: rows.length ? rows : base.canvas }
}
