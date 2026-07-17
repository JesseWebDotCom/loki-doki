// MCP endpoint (public, Bearer-token authed) + admin config routes.
//
// The public POST /api/mcp speaks JSON-RPC per the Model Context Protocol; an MCP
// client points at it with the configured token. Admin routes under
// /api/admin/mcp manage enablement, the token, the acting user, and the tool
// allow-list.

import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { db } from '@/db'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import {
  eligibleTools, generateMcpToken, getMcpConfig, handleMcpMessage, setMcpConfig, type McpConfig,
} from '@/lib/mcp/server'

// ── Public MCP JSON-RPC endpoint ────────────────────────────────────────────
export const mcpPublic = new Hono()

mcpPublic.post('/', async (c) => {
  const cfg = await getMcpConfig()
  if (!cfg.enabled || !cfg.token) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP is disabled.' } }, 503)
  const auth = c.req.header('authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (token !== cfg.token) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized.' } }, 401)

  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }, 400)
  const response = await handleMcpMessage(body, cfg)
  // Notifications get a 202 with no body.
  if (response === null) return c.body(null, 202)
  return c.json(response)
})

// ── Admin config ────────────────────────────────────────────────────────────
export const mcpAdmin = new Hono()
mcpAdmin.use('*', requireAdmin)

mcpAdmin.get('/', async (c) => {
  const cfg = await getMcpConfig()
  const memberRows = await db.select({ id: users.id, firstName: users.firstName, nickname: users.nickname }).from(users)
  return c.json({
    config: cfg,
    tools: eligibleTools().map((t) => ({ id: t.id, name: t.name, description: t.description })),
    users: memberRows.map((u) => ({ id: u.id, name: u.nickname?.trim() || u.firstName })),
  })
})

mcpAdmin.put('/config', async (c) => {
  const body = await c.req.json().catch(() => null) as Partial<McpConfig> | null
  if (!body) return c.json({ ok: false, error: 'Invalid request body.' }, 400)
  const current = await getMcpConfig()
  const eligibleIds = new Set(eligibleTools().map((t) => t.id))
  const next: McpConfig = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    token: current.token, // rotated only through the explicit endpoint below
    userId: body.userId === undefined ? current.userId : body.userId,
    exposedToolIds: Array.isArray(body.exposedToolIds)
      ? body.exposedToolIds.filter((id): id is string => typeof id === 'string' && eligibleIds.has(id))
      : current.exposedToolIds,
  }
  // Enabling requires a token and an acting user.
  if (next.enabled) {
    if (!next.token) next.token = generateMcpToken()
    if (!next.userId) return c.json({ ok: false, error: 'Choose which household member MCP requests act as.' }, 400)
  }
  await setMcpConfig(next)
  return c.json({ ok: true, config: next })
})

mcpAdmin.post('/rotate-token', async (c) => {
  const cfg = await getMcpConfig()
  const next = { ...cfg, token: generateMcpToken() }
  await setMcpConfig(next)
  return c.json({ ok: true, token: next.token })
})

export default mcpAdmin
