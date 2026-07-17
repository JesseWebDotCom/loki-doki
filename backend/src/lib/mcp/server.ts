// Expose a curated slice of Loki Doki's tool registry over the Model Context
// Protocol, so a household member's own AI client (Claude Desktop, etc.) can query
// their hub: "what's on my calendar", "search my notes", "what did the camera see".
//
// This is opt-in and token-gated. Requests run as ONE configured user, so tool
// permissions, content dials, and per-user data scoping all apply exactly as they
// do in chat. Only non-core, allow-listed tools are exposed; core companion
// plumbing (memory writes, status, alerts) is never reachable.

import { db } from '@/db'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { toolRegistry, type Tool } from '@/tools'
import { getAllowedToolIds, resolveToolConfig } from '@/lib/toolConfig'
import { loadUserPrefs } from '@/lib/companionTurn'
import { getLocaleSettings } from '@/routes/adminLocale'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

export interface McpConfig {
  enabled: boolean
  token: string | null
  userId: string | null // which household member requests act as
  exposedToolIds: string[] // allow-list; empty = none
}

export const DEFAULT_MCP_CONFIG: McpConfig = { enabled: false, token: null, userId: null, exposedToolIds: [] }

const CONFIG_KEY = 'mcp.config'

export async function getMcpConfig(): Promise<McpConfig> {
  const stored = (await getAppSetting(CONFIG_KEY)) as Partial<McpConfig> | null
  return { ...DEFAULT_MCP_CONFIG, ...(stored ?? {}) }
}

export async function setMcpConfig(cfg: McpConfig): Promise<void> {
  await setAppSetting(CONFIG_KEY, cfg)
}

export function generateMcpToken(): string {
  return `ld_mcp_${crypto.randomUUID().replace(/-/g, '')}`
}

/** Tools eligible for MCP exposure: non-core, and callable outside chat (they must
 *  not depend on directives/streaming). We expose the read-ish, self-contained set
 *  and let the admin pick from it. */
export function eligibleTools(): Tool[] {
  return toolRegistry.filter((t) => !t.core)
}

// ── JSON-RPC handling ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

function ok(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result }
}

function err(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } }
}

async function buildToolConfig(toolId: string, userId: string, isAdmin: boolean, rawArgsMessage: string): Promise<Record<string, unknown>> {
  const [cfg, prefs, locale] = await Promise.all([
    resolveToolConfig(toolId, userId),
    loadUserPrefs(userId),
    getLocaleSettings(),
  ])
  cfg['_userId'] = userId
  cfg['_isAdmin'] = isAdmin
  cfg['_rawMessage'] = rawArgsMessage
  cfg['_conversationId'] = `mcp:${userId}`
  cfg['_temperature_unit'] = locale.temperature
  cfg['_measurement'] = locale.measurement
  cfg['_currency'] = locale.currency
  const loc = prefs['user.location'] as { displayName?: string; lat?: number; lng?: number } | undefined
  if (loc?.displayName && !cfg['default_location']) cfg['default_location'] = loc.displayName
  if (loc?.lat !== undefined) { cfg['_lat'] = loc.lat; cfg['_lng'] = loc.lng }
  return cfg
}

/** Handle one JSON-RPC message. Returns the response object, or null for a
 *  notification (no id) that needs no reply. */
export async function handleMcpMessage(body: JsonRpcRequest, cfg: McpConfig): Promise<object | null> {
  if (body?.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return err(body?.id ?? null, -32600, 'Invalid Request')
  }

  switch (body.method) {
    case 'initialize':
      return ok(body.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'loki-doki', version: '1.0.0' },
      })

    case 'notifications/initialized':
      return null // notification, no reply

    case 'ping':
      return ok(body.id, {})

    case 'tools/list': {
      if (!cfg.userId) return err(body.id, -32000, 'No user configured for MCP access.')
      const allowed = await getAllowedToolIds(cfg.userId)
      const exposed = new Set(cfg.exposedToolIds)
      const tools = eligibleTools()
        .filter((t) => exposed.has(t.id) && allowed.has(t.id))
        .map((t) => ({
          name: t.id,
          description: t.description,
          inputSchema: t.toolDefinition.function.parameters,
        }))
      return ok(body.id, { tools })
    }

    case 'tools/call': {
      if (!cfg.userId) return err(body.id, -32000, 'No user configured for MCP access.')
      const name = String(body.params?.['name'] ?? '')
      const args = (body.params?.['arguments'] ?? {}) as Record<string, unknown>
      const exposed = new Set(cfg.exposedToolIds)
      const allowed = await getAllowedToolIds(cfg.userId)
      const tool = eligibleTools().find((t) => t.id === name)
      if (!tool || !exposed.has(name) || !allowed.has(name)) {
        return err(body.id, -32602, `Tool "${name}" is not available.`)
      }
      const [user] = await db.select().from(users).where(eq(users.id, cfg.userId)).limit(1)
      if (!user) return err(body.id, -32000, 'Configured MCP user no longer exists.')
      try {
        // passMessage tools take the raw message as one arg; give them a sensible
        // string from the provided arguments.
        const rawMessage = typeof args['query'] === 'string' ? args['query']
          : typeof args[tool.passMessage ?? ''] === 'string' ? String(args[tool.passMessage!])
          : JSON.stringify(args)
        const toolConfig = await buildToolConfig(tool.id, cfg.userId, user.role === 'admin', rawMessage)
        const callArgs = tool.passMessage ? { [tool.passMessage]: rawMessage } : args
        const result = await tool.execute(callArgs, toolConfig)
        const text = result.directReply
          ?? (result.success ? JSON.stringify(result.data ?? { ok: true }) : (result.error ?? 'The tool reported a failure.'))
        return ok(body.id, {
          content: [{ type: 'text', text: String(text) }],
          isError: !result.success,
        })
      } catch (e) {
        logger.warn(`[mcp] tool ${name} threw: ${e instanceof Error ? e.message : e}`)
        return err(body.id, -32603, 'The tool failed to run.')
      }
    }

    default:
      return err(body.id, -32601, `Method not found: ${body.method}`)
  }
}
