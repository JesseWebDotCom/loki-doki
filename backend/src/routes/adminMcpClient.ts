import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import {
  discoverServer,
  getMcpClientConfig,
  sanitizeServerId,
  setMcpClientConfig,
  syncMcpClientTools,
  type McpClientServer,
} from '@/lib/mcp/client'

// Admin control for the OUTBOUND MCP client (servers the companion consumes tools from).
// Distinct from /api/admin/mcp, which configures the INBOUND server (exposing our tools).
const adminMcpClient = new Hono<AppEnv>()

function coerceServer(raw: unknown, i: number): McpClientServer | null {
  const s = (raw ?? {}) as Partial<McpClientServer>
  const url = typeof s.url === 'string' ? s.url.trim() : ''
  if (!url) return null
  const name = (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : `Server ${i + 1}`
  const id = sanitizeServerId(typeof s.id === 'string' && s.id.trim() ? s.id : name)
  const headers = (s.headers && typeof s.headers === 'object')
    ? Object.fromEntries(Object.entries(s.headers).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
    : undefined
  return { id, name, url, enabled: s.enabled !== false, ...(headers && Object.keys(headers).length ? { headers } : {}) }
}

// GET /api/admin/mcp-client — saved servers.
adminMcpClient.get('/', requireAdmin, async (c) => {
  return c.json(await getMcpClientConfig())
})

// POST /api/admin/mcp-client/test — probe one server (no save): list the tools it offers.
adminMcpClient.post('/test', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<McpClientServer>
  const server = coerceServer(body, 0)
  if (!server) return c.json({ ok: false, error: 'A server URL is required.' }, 400)
  try {
    const { tools } = await discoverServer(server)
    return c.json({ ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? '' })) })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'Could not reach the server.' })
  }
})

// PUT /api/admin/mcp-client — save the full server list, then re-sync the registry.
adminMcpClient.put('/', requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { servers?: unknown[] }
  const servers = Array.isArray(body.servers)
    ? body.servers.map((s, i) => coerceServer(s, i)).filter((s): s is McpClientServer => s !== null).slice(0, 20)
    : []
  // Dedupe ids so tool namespacing stays unambiguous.
  const seen = new Set<string>()
  for (const s of servers) {
    let id = s.id
    while (seen.has(id)) id = `${s.id}-${seen.size}`
    s.id = id
    seen.add(id)
  }
  await setMcpClientConfig({ servers })
  const sync = await syncMcpClientTools()
  return c.json({ servers, sync })
})

export { adminMcpClient }
