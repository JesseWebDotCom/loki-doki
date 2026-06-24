import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig, toolUserConfig, toolUserPermissions } from '@/db/schema'
import { toolRegistry } from '@/tools'
import { isPlexConfigured } from '@/lib/plex'

// Merges: schema defaults → global config → user config (highest priority)
// The internal __enabled key is excluded — tools never see it.
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
    if (row.key === '__enabled') continue
    config[row.key] = JSON.parse(row.value)
  }
  for (const row of userRows) config[row.key] = JSON.parse(row.value)

  return config
}

// Returns false if the tool is globally disabled OR the user is explicitly denied.
// Default (no records) = allowed.
export async function isToolAllowed(toolId: string, userId: string): Promise<boolean> {
  const [enabledRow, permRow] = await Promise.all([
    db.select({ value: toolGlobalConfig.value })
      .from(toolGlobalConfig)
      .where(and(eq(toolGlobalConfig.toolId, toolId), eq(toolGlobalConfig.key, '__enabled')))
      .limit(1),
    db.select({ state: toolUserPermissions.state })
      .from(toolUserPermissions)
      .where(and(eq(toolUserPermissions.userId, userId), eq(toolUserPermissions.toolId, toolId)))
      .limit(1),
  ])

  if (enabledRow[0] && JSON.parse(enabledRow[0].value) === false) return false
  if (permRow[0]?.state === 'deny') return false
  // Plex stays disabled until a server URL + token are configured (Admin → Features → Plex).
  if (toolId === 'plex' && !(await isPlexConfigured())) return false
  return true
}
