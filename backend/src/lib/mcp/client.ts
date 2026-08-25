// Outbound MCP client: let the companion consume tools from external Model Context
// Protocol servers (a calendar server, a home-automation bridge, a media server, a
// community tool) WITHOUT writing a bespoke tool adapter for each. Discovered tools are
// wrapped as normal entries in the tool registry, so the existing router, per-tool
// permission gating, and function-calling path treat them exactly like built-ins.
//
// Transport is MCP "Streamable HTTP": JSON-RPC 2.0 POSTed to one endpoint, with the
// response arriving either as application/json or as a text/event-stream (SSE) whose
// data: lines carry the JSON-RPC messages. A server may hand back an Mcp-Session-Id on
// initialize that must be echoed on later calls; we capture and reuse it per server.
//
// This is admin-configured and opt-in (no servers by default). Failures are contained:
// a server that is down or misbehaves simply contributes no tools, and never breaks a
// companion turn.

import { getAppSetting, setAppSetting } from '@/lib/settings'
import { toolRegistry, type Tool } from '@/tools'
import { logger } from '@/lib/logger'

export interface McpClientServer {
  id: string // stable slug, namespaces its tools
  name: string // display name
  url: string // JSON-RPC HTTP endpoint
  headers?: Record<string, string> // e.g. { Authorization: 'Bearer ...' }
  enabled: boolean
}

export interface McpClientConfig {
  servers: McpClientServer[]
}

const CONFIG_KEY = 'mcp.client'
const TOOL_ID_PREFIX = 'mcp__'
const PROTOCOL_VERSION = '2024-11-05'

export const DEFAULT_MCP_CLIENT_CONFIG: McpClientConfig = { servers: [] }

export async function getMcpClientConfig(): Promise<McpClientConfig> {
  const stored = (await getAppSetting(CONFIG_KEY)) as Partial<McpClientConfig> | null
  const servers = Array.isArray(stored?.servers) ? stored!.servers : []
  return { servers }
}

export async function setMcpClientConfig(cfg: McpClientConfig): Promise<void> {
  await setAppSetting(CONFIG_KEY, cfg)
}

export function sanitizeServerId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server'
}

// ── JSON-RPC over Streamable HTTP ───────────────────────────────────────────────

interface RpcResult {
  result?: unknown
  error?: { code: number; message: string }
  sessionId?: string
}

let rpcCounter = 1

async function rpc(server: McpClientServer, method: string, params: Record<string, unknown> | undefined, sessionId: string | null): Promise<RpcResult> {
  const id = rpcCounter++
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(server.headers ?? {}),
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20_000),
  })
  const newSession = res.headers.get('Mcp-Session-Id') ?? undefined
  if (!res.ok) return { error: { code: res.status, message: `HTTP ${res.status}` }, sessionId: newSession }

  const ctype = res.headers.get('content-type') ?? ''
  const text = await res.text()
  const message = ctype.includes('text/event-stream') ? parseSseForId(text, id) : parseJsonForId(text, id)
  if (!message) return { error: { code: -32603, message: 'No matching JSON-RPC response' }, sessionId: newSession }
  return { result: message.result, error: message.error, sessionId: newSession }
}

interface RpcMessage { id?: unknown; result?: unknown; error?: { code: number; message: string } }

function parseJsonForId(text: string, id: number): RpcMessage | null {
  try {
    const parsed = JSON.parse(text) as RpcMessage | RpcMessage[]
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.find((m) => m && m.id === id) ?? list.find((m) => m && ('result' in m || 'error' in m)) ?? null
  } catch {
    return null
  }
}

function parseSseForId(text: string, id: number): RpcMessage | null {
  const messages: RpcMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!trimmed) continue
    try {
      const m = JSON.parse(trimmed) as RpcMessage
      if (m && ('result' in m || 'error' in m)) messages.push(m)
    } catch { /* skip non-JSON data lines */ }
  }
  return messages.find((m) => m.id === id) ?? messages[messages.length - 1] ?? null
}

/** Fire-and-forget a JSON-RPC notification (no id, no response expected). */
async function notify(server: McpClientServer, method: string, sessionId: string | null): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(server.headers ?? {}) }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method }), signal: AbortSignal.timeout(10_000) }).catch(() => {})
}

interface DiscoveredTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface HandshakeResult {
  sessionId: string | null
  tools: DiscoveredTool[]
}

/** initialize → initialized → tools/list. Throws on a hard failure. */
export async function discoverServer(server: McpClientServer): Promise<HandshakeResult> {
  const init = await rpc(server, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'maipai-home', version: '1.0.0' },
  }, null)
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`)
  const sessionId = init.sessionId ?? null

  await notify(server, 'notifications/initialized', sessionId)

  const list = await rpc(server, 'tools/list', {}, sessionId)
  if (list.error) throw new Error(`tools/list failed: ${list.error.message}`)
  const tools = (((list.result as { tools?: unknown })?.tools) ?? []) as DiscoveredTool[]
  return { sessionId, tools: Array.isArray(tools) ? tools : [] }
}

/** Call a remote tool and return its text content. */
async function callRemoteTool(server: McpClientServer, toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  // A fresh session per call keeps the client stateless; discovery already proved reach.
  const init = await rpc(server, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'maipai-home', version: '1.0.0' } }, null)
  const sessionId = init.sessionId ?? null
  await notify(server, 'notifications/initialized', sessionId)

  const res = await rpc(server, 'tools/call', { name: toolName, arguments: args }, sessionId)
  if (res.error) return { ok: false, text: res.error.message }
  const result = res.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined
  const text = (result?.content ?? [])
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
    .map((p) => p.text ?? '')
    .join('\n')
    .trim()
  return { ok: !result?.isError, text: text || (result?.isError ? 'The remote tool reported an error.' : 'Done.') }
}

// ── Registry integration ────────────────────────────────────────────────────────

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return 'external' }
}

function sanitizeFnPart(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48)
}

/** Turn one discovered MCP tool into a registry Tool wrapper. */
function wrapTool(server: McpClientServer, t: DiscoveredTool): Tool {
  const id = `${TOOL_ID_PREFIX}${sanitizeFnPart(server.id)}__${sanitizeFnPart(t.name)}`
  const description = (t.description ?? `${t.name} (via ${server.name})`).slice(0, 500)
  // Synthetic routing examples: the description plus the tool name, so Tier-1 semantic
  // routing can surface it; Tier-2 function calling sees it regardless.
  const examples = Array.from(new Set([description, t.name.replace(/[_-]+/g, ' ')].filter(Boolean))).slice(0, 3)
  const parameters = (t.inputSchema && typeof t.inputSchema === 'object')
    ? (t.inputSchema as Record<string, unknown>)
    : { type: 'object', properties: {} }

  return {
    id,
    name: `${server.name}: ${t.name}`,
    description,
    examples,
    offline: false,
    core: false,
    passMessage: undefined,
    dataSources: [{ name: server.name, domain: hostOf(server.url), purpose: 'External MCP tool', type: 'api' }],
    toolDefinition: {
      type: 'function',
      function: { name: id, description, parameters: parameters as never },
    },
    async execute(args: unknown) {
      try {
        const out = await callRemoteTool(server, t.name, (args ?? {}) as Record<string, unknown>)
        return out.ok ? { success: true, data: out.text } : { success: false, error: out.text }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'The MCP server could not be reached.' }
      }
    },
  }
}

export function isMcpClientTool(toolId: string): boolean {
  return toolId.startsWith(TOOL_ID_PREFIX)
}

/** Reconcile the registry so its MCP-client tools exactly match the enabled servers'
 *  currently-discovered tools. Safe to call repeatedly (boot + on config change). */
export async function syncMcpClientTools(): Promise<{ servers: number; tools: number; errors: string[] }> {
  const cfg = await getMcpClientConfig()
  const errors: string[] = []

  // Drop all existing MCP-client tools in place (the array is the live registry).
  for (let i = toolRegistry.length - 1; i >= 0; i--) {
    if (isMcpClientTool(toolRegistry[i]!.id)) toolRegistry.splice(i, 1)
  }

  let toolCount = 0
  let serverCount = 0
  for (const server of cfg.servers) {
    if (!server.enabled || !server.url) continue
    serverCount++
    try {
      const { tools } = await discoverServer(server)
      for (const t of tools) {
        if (!t?.name) continue
        toolRegistry.push(wrapTool(server, t))
        toolCount++
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${server.name}: ${msg}`)
      logger.warn(`[mcp-client] ${server.name} (${server.url}) discovery failed: ${msg}`)
    }
  }
  if (serverCount) logger.info(`[mcp-client] synced ${toolCount} tool(s) from ${serverCount} server(s)`)
  return { servers: serverCount, tools: toolCount, errors }
}
