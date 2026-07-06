import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig, toolUserConfig, toolUserPermissions } from '@/db/schema'
import { toolRegistry } from '@/tools'
import { isPlexConfigured } from '@/lib/plex'

// Internal enablement keys on toolGlobalConfig, excluded from tool-visible config:
// __enabled = installed (store), __chat_enabled = companion may use it in chat
// (the "Companion abilities" toggle in app settings). Absent row = true.
const FLAG_KEYS = ['__enabled', '__chat_enabled'] as const

// Merges: schema defaults → global config → user config (highest priority)
// The internal flag keys are excluded — tools never see them.
export async function resolveToolConfig(toolId: string, userId: string): Promise<Record<string, unknown>> {
  const tool = toolRegistry.find(t => t.id === toolId)
  const config: Record<string, unknown> = {}

  for (const field of tool?.configSchema ?? []) {
    if (field.default !== undefined) config[field.key] = field.default
  }

  const [globalRows, userRows] = await Promise.all([
    db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, toolId)),
    db.select().from(toolUserConfig).where(
      and(eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, toolId))
    ),
  ])

  for (const row of globalRows) {
    if ((FLAG_KEYS as readonly string[]).includes(row.key)) continue
    config[row.key] = JSON.parse(row.value)
  }
  for (const row of userRows) config[row.key] = JSON.parse(row.value)

  return config
}

// The full set of tool ids this user may run — the batched form of isToolAllowed,
// computed in 2 queries (plus the Plex config probe) so it can be resolved BEFORE
// routing. Routing filters candidates against this set, so denied tools never
// occupy Tier-1/Tier-2 candidate slots and never silently swallow a turn.
export async function getAllowedToolIds(userId: string): Promise<Set<string>> {
  const [flagRows, permRows] = await Promise.all([
    db.select({ toolId: toolGlobalConfig.toolId, value: toolGlobalConfig.value })
      .from(toolGlobalConfig)
      .where(inArray(toolGlobalConfig.key, [...FLAG_KEYS])),
    db.select({ toolId: toolUserPermissions.toolId, state: toolUserPermissions.state })
      .from(toolUserPermissions)
      .where(eq(toolUserPermissions.userId, userId)),
  ])

  const allowed = new Set(toolRegistry.map((t) => t.id))
  // Either flag parsing to false blocks the tool: not installed OR ability off.
  for (const row of flagRows) {
    try { if (JSON.parse(row.value) === false) allowed.delete(row.toolId) } catch { /* ignore */ }
  }
  for (const row of permRows) {
    if (row.state === 'deny') allowed.delete(row.toolId)
  }
  if (allowed.has('plex') && !(await isPlexConfigured())) allowed.delete('plex')
  return allowed
}

// Returns false if the tool is globally disabled OR the user is explicitly denied.
// Default (no records) = allowed.
export async function isToolAllowed(toolId: string, userId: string): Promise<boolean> {
  const [flagRows, permRow] = await Promise.all([
    db.select({ value: toolGlobalConfig.value })
      .from(toolGlobalConfig)
      .where(and(eq(toolGlobalConfig.toolId, toolId), inArray(toolGlobalConfig.key, [...FLAG_KEYS]))),
    db.select({ state: toolUserPermissions.state })
      .from(toolUserPermissions)
      .where(and(eq(toolUserPermissions.userId, userId), eq(toolUserPermissions.toolId, toolId)))
      .limit(1),
  ])

  if (flagRows.some(r => { try { return JSON.parse(r.value) === false } catch { return false } })) return false
  if (permRow[0]?.state === 'deny') return false
  // Plex stays disabled until a server URL + token are configured (Admin → Features → Plex).
  if (toolId === 'plex' && !(await isPlexConfigured())) return false
  return true
}
