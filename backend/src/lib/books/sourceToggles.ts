// On/off switches for the three built-in (keyless, code-defined) book sources —
// Gutenberg, Internet Archive, and LibriVox. Stored in the existing generic
// tool_global_config table (toolId: 'books'), same mechanism as the old indexer
// singleton used, but these three keys are booleans defaulting to true (unset =
// enabled) since most households want all built-ins on. Custom OPDS indexers have
// their own per-row `enabled` column instead (see indexer.ts) — they're separate
// rows you add/remove, not a fixed toggle set.

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'

const TOOL_ID = 'books'
export type BuiltinSource = 'gutenberg' | 'archiveorg' | 'librivox'
const KEYS: Record<BuiltinSource, string> = {
  gutenberg: 'gutenberg_enabled',
  archiveorg: 'archiveorg_enabled',
  librivox: 'librivox_enabled',
}

export interface BuiltinSourceToggles {
  gutenberg: boolean
  archiveorg: boolean
  librivox: boolean
}

export async function getBuiltinSourceToggles(): Promise<BuiltinSourceToggles> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, TOOL_ID))
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const read = (key: string): boolean => {
    const raw = byKey.get(key)
    if (raw === undefined) return true // unset = enabled by default
    try { return JSON.parse(raw) !== false } catch { return true }
  }
  return { gutenberg: read(KEYS.gutenberg), archiveorg: read(KEYS.archiveorg), librivox: read(KEYS.librivox) }
}

export async function isSourceEnabled(source: BuiltinSource): Promise<boolean> {
  const toggles = await getBuiltinSourceToggles()
  return toggles[source]
}

export async function setBuiltinSourceToggle(source: BuiltinSource, enabled: boolean): Promise<void> {
  const key = KEYS[source]
  const now = new Date()
  await db.insert(toolGlobalConfig).values({ id: randomUUID(), toolId: TOOL_ID, key, value: JSON.stringify(enabled), updatedAt: now })
    .onConflictDoUpdate({ target: [toolGlobalConfig.toolId, toolGlobalConfig.key], set: { value: JSON.stringify(enabled), updatedAt: now } })
}
