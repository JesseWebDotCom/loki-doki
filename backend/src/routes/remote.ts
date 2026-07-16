// Remote app API — a first-class, all-users connection manager (SSH/VNC/RDP + terminals +
// SFTP). Machines are either SHARED (userId null, admin-published, visible to everyone) or
// PERSONAL (owned by a user, private), following the nullable-owner scope pattern used by
// feedFolders/bookmarks. Any authenticated user can connect to machines they can access;
// publishing/editing shared machines, and opening a shell on THIS server, require admin.
//
// HTTP routes use requireAuth (requireAdmin where noted). WebSocket routes can't use
// middleware (it doesn't run on the upgraded socket, same as routes/coding.ts), so they
// resolve the session cookie and enforce access at upgrade time themselves.

import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { createBunWebSocket } from 'hono/bun'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { networkInterfaces } from 'node:os'
import { Client as SshClient, type SFTPWrapper } from 'ssh2'
import { db } from '@/db'
import { homelabHosts, adminAuditLog, profilePins, remoteFolders, remoteSnippets, userPreferences } from '@/db/schema'
import { requireAuth, requireAdmin, resolveSession } from '@/middleware/auth'
import { isFeatureEnabled, userMayUseCapability } from '@/lib/featureGate'
import { verifyPin } from '@/lib/pin'
import { encryptSecret, decryptSecret } from '@/lib/secrets'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { openTcpBridge } from '@/lib/tcpBridge'
import { startWsKeepalive } from '@/lib/wsKeepalive'
import { createRdpCleanPath, type RdpCleanPathController } from '@/lib/rdpCleanPath'
import { isSandboxUserInstalled } from '@/lib/codingSandboxUser'
import { buildHostShellSpawnParams } from '@/lib/codingServer'
import { ensureCodingPtySidecarReady, codingPtySidecarWsUrl } from '@/lib/codingPtySidecar'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'
import type { AppEnv, User } from '@/types'

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket']
type HostRow = typeof homelabHosts.$inferSelect

// ── Access model ───────────────────────────────────────────────────────────
// Shared host (userId null): anyone may connect; only admins may edit/delete/publish.
// Personal host: only the owner (or admin) may connect/edit/delete.
function canAccessHost(h: HostRow, user: User): boolean {
  return h.userId === null || h.userId === user.id || user.role === 'admin'
}
function canManageHost(h: HostRow, user: User): boolean {
  return h.userId === null ? user.role === 'admin' : (h.userId === user.id || user.role === 'admin')
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function mapHost(h: HostRow, user: User, favs: Set<string>) {
  return {
    id: h.id,
    label: h.label,
    hostname: h.hostname,
    shared: h.userId === null,
    owned: h.userId === user.id,
    canManage: canManageHost(h, user),
    folderId: h.folderId,
    favorite: favs.has(h.id),
    sortOrder: h.sortOrder,
    ssh: h.sshUser ? { port: h.sshPort ?? 22, user: h.sshUser, auth: h.sshAuth, hasSecret: !!h.sshSecret } : null,
    vnc: h.vncPort != null ? { port: h.vncPort, hasSecret: !!h.vncSecret } : null,
    rdp: h.rdpUser ? { port: h.rdpPort ?? 3389, user: h.rdpUser, security: h.rdpSecurity, hasSecret: !!h.rdpSecret } : null,
  }
}

async function audit(userId: string, action: typeof adminAuditLog.$inferInsert['action'], detail?: unknown): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({ id: crypto.randomUUID(), userId, action, detail: detail === undefined ? null : JSON.stringify(detail), createdAt: new Date() })
  } catch (err) {
    logger.warn(`[remote] audit write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function verifyAdminPin(userId: string, pin: string): Promise<boolean> {
  if (!pin) return false
  const [record] = await db.select().from(profilePins).where(eq(profilePins.userId, userId)).limit(1)
  if (!record) return false
  if (record.lockedUntil && record.lockedUntil > new Date()) return false
  return verifyPin(pin, record.pinHash)
}

// ── "This server" sessions (admin-only, PIN-gated) ──────────────────────────
// The shell, VNC and RDP into THIS host all share one flow: verify the admin PIN over HTTP,
// mint a short-lived single-use token bound to (user, proto), then hand it to the WS (which
// can't prompt for a PIN). VNC/RDP bridge to loopback on admin-configured ports.
type SelfProto = 'shell' | 'vnc' | 'rdp' | 'claude-code'
const selfTokens = new Map<string, { userId: string; proto: SelfProto; expires: number }>()
function mintSelfToken(userId: string, proto: SelfProto): string {
  const token = crypto.randomUUID()
  selfTokens.set(token, { userId, proto, expires: Date.now() + 60_000 })
  return token
}
function consumeSelfToken(token: string, userId: string, proto: SelfProto): boolean {
  const rec = selfTokens.get(token)
  if (!rec) return false
  selfTokens.delete(token)
  return rec.userId === userId && rec.proto === proto && rec.expires > Date.now()
}

// Admin-configured desktop endpoints for THIS server. Defaults to loopback, but the address is
// configurable: a VNC/RDP server bound only to a LAN/Tailscale interface (not 127.0.0.1) must be
// reached at that address, so the admin can point "this server" at whatever it actually listens on.
const SELF_DESKTOP_KEY = 'remote.selfDesktop'
interface SelfDesktopConfig {
  host: string
  vncPort: number
  vncSecret: string | null   // encrypted
  rdpPort: number
  rdpUser: string | null
  rdpSecret: string | null   // encrypted
  rdpSecurity: 'nla' | 'tls' | 'rdp'
}
// This machine's own addresses, so a saved host entry that points at one of them can be
// recognized as "this server" and its port/credentials reused.
function localAddresses(): Set<string> {
  const set = new Set<string>(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) set.add(ni.address.toLowerCase())
  }
  return set
}

// Best-guess desktop settings for "this server" derived from a host entry whose hostname is one
// of this machine's own addresses. Scoped to shared hosts + the requesting admin's own, so we
// never pull another user's private credentials. Encrypted secrets are copied as-is (same key).
async function deriveSelfDesktopFromHosts(forUserId: string | undefined): Promise<Partial<SelfDesktopConfig> | null> {
  const locals = localAddresses()
  const rows = await db.select().from(homelabHosts)
  const mine = rows.filter((h) => (h.userId === null || h.userId === forUserId) && locals.has(h.hostname.trim().toLowerCase()))
  if (mine.length === 0) return null
  const vncH = mine.find((h) => h.vncPort != null)
  const rdpH = mine.find((h) => h.rdpUser != null || h.rdpPort != null)
  const host = (vncH ?? rdpH ?? mine[0]!).hostname.trim()
  return {
    host,
    vncPort: vncH?.vncPort ?? undefined,
    vncSecret: vncH?.vncSecret ?? undefined,
    rdpPort: rdpH?.rdpPort ?? undefined,
    rdpUser: rdpH?.rdpUser ?? undefined,
    rdpSecret: rdpH?.rdpSecret ?? undefined,
    rdpSecurity: (rdpH?.rdpSecurity as SelfDesktopConfig['rdpSecurity'] | null) ?? undefined,
  }
}

// Effective config = saved values, with any field still unset auto-filled from a matching host
// entry (address, ports, and credentials). Pure read (no writes); an explicit save persists the
// user's choices. Auto-fill only kicks in for fields the admin hasn't set themselves.
async function getSelfDesktopConfig(forUserId?: string): Promise<SelfDesktopConfig> {
  const raw = (await getAppSetting(SELF_DESKTOP_KEY)) as Partial<SelfDesktopConfig> | null
  const hasHost = typeof raw?.host === 'string' && !!raw.host.trim()
  const seed = (!hasHost || !raw?.vncSecret || !raw?.rdpSecret) ? await deriveSelfDesktopFromHosts(forUserId) : null
  return {
    host: hasHost ? raw!.host!.trim() : (seed?.host ?? '127.0.0.1'),
    vncPort: typeof raw?.vncPort === 'number' ? raw.vncPort : (seed?.vncPort ?? 5900),
    vncSecret: raw?.vncSecret ?? seed?.vncSecret ?? null,
    rdpPort: typeof raw?.rdpPort === 'number' ? raw.rdpPort : (seed?.rdpPort ?? 3389),
    rdpUser: raw?.rdpUser ?? seed?.rdpUser ?? null,
    rdpSecret: raw?.rdpSecret ?? seed?.rdpSecret ?? null,
    rdpSecurity: raw?.rdpSecurity === 'tls' || raw?.rdpSecurity === 'rdp' ? raw.rdpSecurity
      : (raw?.rdpSecurity === 'nla' ? 'nla' : (seed?.rdpSecurity ?? 'nla')),
  }
}

async function resolveUser(token: string | undefined): Promise<User | null> {
  return token ? resolveSession(token) : null
}

async function loadHost(id: string): Promise<HostRow | null> {
  const [row] = await db.select().from(homelabHosts).where(eq(homelabHosts.id, id)).limit(1)
  return row ?? null
}

/** Load a host and verify the given user can access it (shared, owner, or admin). */
async function loadAccessibleHost(id: string, user: User): Promise<HostRow | null> {
  const h = await loadHost(id)
  return h && canAccessHost(h, user) ? h : null
}

// ── Per-user prefs (favorites, terminal theme) via user_preferences ──
async function getPref<T>(userId: string, key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(userPreferences).where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key))).limit(1)
  if (!row) return fallback
  try { return JSON.parse(row.value) as T } catch { return fallback }
}
async function setPref(userId: string, key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value)
  await db.insert(userPreferences).values({ id: crypto.randomUUID(), userId, key, value: v, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: v, updatedAt: new Date() } })
}
const FAV_KEY = 'remote.favorites'
const TERM_KEY = 'remote.terminal'

// ── SSH/SFTP helpers ──
async function connectSsh(host: HostRow): Promise<SshClient> {
  const secret = host.sshSecret ? await decryptSecret(host.sshSecret) : ''
  return new Promise((resolve, reject) => {
    const client = new SshClient()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    client.connect({
      host: host.hostname, port: host.sshPort ?? 22, username: host.sshUser ?? '', readyTimeout: 15000,
      ...(host.sshAuth === 'key' ? { privateKey: secret } : { password: secret }),
    })
  })
}
function getSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))))
}

export function createRemoteRoute(upgradeWebSocket: UpgradeWebSocket) {
  const r = new Hono<AppEnv>()

  // ── Capabilities ──
  r.get('/capabilities', requireAuth, (c) => {
    const user = c.get('user')
    return c.json({ sandboxInstalled: isSandboxUserInstalled(), isWin: IS_WIN, isAdmin: user.role === 'admin' })
  })

  // ── Hosts (scoped: shared + own) ──
  r.get('/hosts', requireAuth, async (c) => {
    const user = c.get('user')
    const rows = await db.select().from(homelabHosts)
      .where(or(isNull(homelabHosts.userId), eq(homelabHosts.userId, user.id)))
      .orderBy(homelabHosts.sortOrder, homelabHosts.label)
    const favs = new Set(await getPref<string[]>(user.id, FAV_KEY, []))
    return c.json({ hosts: rows.map((h) => mapHost(h, user, favs)) })
  })

  r.post('/hosts', requireAuth, async (c) => {
    const user = c.get('user')
    const b = await c.req.json<HostInput>()
    if (!b.label?.trim() || !b.hostname?.trim()) return c.json({ error: 'label and hostname required' }, 400)
    const shared = !!b.shared
    if (shared && user.role !== 'admin') return c.json({ error: 'Only admins can publish shared machines' }, 403)
    const id = crypto.randomUUID()
    const now = new Date()
    await db.insert(homelabHosts).values({
      id, label: b.label.trim(), hostname: b.hostname.trim(),
      createdBy: user.id, userId: shared ? null : user.id,
      folderId: b.folderId ?? null, favorite: false, sortOrder: 0,
      ...(await encryptHostSecrets(b)), createdAt: now, updatedAt: now,
    })
    if (shared) await audit(user.id, 'host_create', { id, label: b.label })
    const row = await loadHost(id)
    const favs = new Set(await getPref<string[]>(user.id, FAV_KEY, []))
    return c.json({ host: row ? mapHost(row, user, favs) : null })
  })

  r.put('/hosts/:id', requireAuth, async (c) => {
    const user = c.get('user')
    const existing = await loadHost(c.req.param('id'))
    if (!existing) return c.json({ error: 'not found' }, 404)
    if (!canManageHost(existing, user)) return c.json({ error: 'forbidden' }, 403)
    const b = await c.req.json<HostInput>()
    const secretPatch = await encryptHostSecrets(b, { keepExisting: existing })
    await db.update(homelabHosts).set({
      label: b.label?.trim() || existing.label,
      hostname: b.hostname?.trim() || existing.hostname,
      folderId: b.folderId === undefined ? existing.folderId : b.folderId,
      ...secretPatch, updatedAt: new Date(),
    }).where(eq(homelabHosts.id, existing.id))
    if (existing.userId === null) await audit(user.id, 'host_update', { id: existing.id })
    const row = await loadHost(existing.id)
    const favs = new Set(await getPref<string[]>(user.id, FAV_KEY, []))
    return c.json({ host: row ? mapHost(row, user, favs) : null })
  })

  r.delete('/hosts/:id', requireAuth, async (c) => {
    const user = c.get('user')
    const existing = await loadHost(c.req.param('id'))
    if (!existing) return c.json({ error: 'not found' }, 404)
    if (!canManageHost(existing, user)) return c.json({ error: 'forbidden' }, 403)
    await db.delete(homelabHosts).where(eq(homelabHosts.id, existing.id))
    if (existing.userId === null) await audit(user.id, 'host_delete', { id: existing.id })
    return c.json({ ok: true })
  })

  // ── Favorites (per-user, via user_preferences) ──
  r.put('/favorites/:hostId', requireAuth, async (c) => {
    const user = c.get('user')
    const hostId = c.req.param('hostId')
    const { on } = await c.req.json<{ on: boolean }>()
    const favs = new Set(await getPref<string[]>(user.id, FAV_KEY, []))
    if (on) favs.add(hostId); else favs.delete(hostId)
    await setPref(user.id, FAV_KEY, [...favs])
    return c.json({ ok: true, favorite: on })
  })

  // ── Terminal prefs ──
  r.get('/prefs', requireAuth, async (c) => c.json(await getPref(c.get('user').id, TERM_KEY, { fontSize: 13, theme: 'dark' })))
  r.put('/prefs', requireAuth, async (c) => { await setPref(c.get('user').id, TERM_KEY, await c.req.json()); return c.json({ ok: true }) })

  // ── Folders (scoped) ──
  r.get('/folders', requireAuth, async (c) => {
    const user = c.get('user')
    const rows = await db.select().from(remoteFolders)
      .where(or(isNull(remoteFolders.ownerId), eq(remoteFolders.ownerId, user.id)))
      .orderBy(remoteFolders.sortOrder, remoteFolders.name)
    return c.json({ folders: rows.map((f) => ({ ...f, shared: f.ownerId === null, canManage: f.ownerId === null ? user.role === 'admin' : f.ownerId === user.id })) })
  })
  r.post('/folders', requireAuth, async (c) => {
    const user = c.get('user')
    const b = await c.req.json<{ name: string; parentId?: string | null; icon?: string; color?: string; shared?: boolean }>()
    if (!b.name?.trim()) return c.json({ error: 'name required' }, 400)
    if (b.shared && user.role !== 'admin') return c.json({ error: 'Only admins can create shared folders' }, 403)
    const id = crypto.randomUUID(); const now = new Date()
    await db.insert(remoteFolders).values({ id, ownerId: b.shared ? null : user.id, parentId: b.parentId ?? null, name: b.name.trim(), icon: b.icon ?? null, color: b.color ?? null, sortOrder: 0, createdAt: now, updatedAt: now })
    return c.json({ id })
  })
  r.put('/folders/:id', requireAuth, async (c) => {
    const user = c.get('user')
    const [f] = await db.select().from(remoteFolders).where(eq(remoteFolders.id, c.req.param('id'))).limit(1)
    if (!f) return c.json({ error: 'not found' }, 404)
    if (f.ownerId === null ? user.role !== 'admin' : f.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)
    const b = await c.req.json<{ name?: string; parentId?: string | null; icon?: string; color?: string; sortOrder?: number }>()
    await db.update(remoteFolders).set({
      name: b.name?.trim() || f.name, parentId: b.parentId === undefined ? f.parentId : b.parentId,
      icon: b.icon ?? f.icon, color: b.color ?? f.color, sortOrder: b.sortOrder ?? f.sortOrder, updatedAt: new Date(),
    }).where(eq(remoteFolders.id, f.id))
    return c.json({ ok: true })
  })
  r.delete('/folders/:id', requireAuth, async (c) => {
    const user = c.get('user')
    const [f] = await db.select().from(remoteFolders).where(eq(remoteFolders.id, c.req.param('id'))).limit(1)
    if (!f) return c.json({ error: 'not found' }, 404)
    if (f.ownerId === null ? user.role !== 'admin' : f.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)
    // Re-parent this folder's hosts to root rather than deleting them.
    await db.update(homelabHosts).set({ folderId: null }).where(eq(homelabHosts.folderId, f.id))
    await db.delete(remoteFolders).where(eq(remoteFolders.id, f.id))
    return c.json({ ok: true })
  })

  // ── Snippets (scoped) ──
  r.get('/snippets', requireAuth, async (c) => {
    const user = c.get('user')
    const rows = await db.select().from(remoteSnippets)
      .where(or(isNull(remoteSnippets.ownerId), eq(remoteSnippets.ownerId, user.id)))
      .orderBy(remoteSnippets.sortOrder, remoteSnippets.name)
    return c.json({ snippets: rows.map((s) => ({ ...s, shared: s.ownerId === null, canManage: s.ownerId === null ? user.role === 'admin' : s.ownerId === user.id })) })
  })
  r.post('/snippets', requireAuth, async (c) => {
    const user = c.get('user')
    const b = await c.req.json<{ name: string; command: string; shared?: boolean }>()
    if (!b.name?.trim() || !b.command) return c.json({ error: 'name and command required' }, 400)
    if (b.shared && user.role !== 'admin') return c.json({ error: 'Only admins can create shared snippets' }, 403)
    const id = crypto.randomUUID(); const now = new Date()
    await db.insert(remoteSnippets).values({ id, ownerId: b.shared ? null : user.id, name: b.name.trim(), command: b.command, sortOrder: 0, createdAt: now, updatedAt: now })
    return c.json({ id })
  })
  r.delete('/snippets/:id', requireAuth, async (c) => {
    const user = c.get('user')
    const [s] = await db.select().from(remoteSnippets).where(eq(remoteSnippets.id, c.req.param('id'))).limit(1)
    if (!s) return c.json({ error: 'not found' }, 404)
    if (s.ownerId === null ? user.role !== 'admin' : s.ownerId !== user.id) return c.json({ error: 'forbidden' }, 403)
    await db.delete(remoteSnippets).where(eq(remoteSnippets.id, s.id))
    return c.json({ ok: true })
  })

  // ── Display credentials (accessible hosts only) — see note in adminSystem history:
  // noVNC/IronRDP do protocol auth client-side, so the accessing user's browser needs them. ──
  r.get('/display-credentials', requireAuth, async (c) => {
    const user = c.get('user')
    const host = await loadAccessibleHost(c.req.query('host') ?? '', user)
    if (!host) return c.json({ error: 'not found' }, 404)
    const proto = c.req.query('proto')
    if (proto === 'vnc') {
      await audit(user.id, 'credential_reveal', { host: host.hostname, proto: 'vnc', shared: host.userId === null })
      return c.json({ password: host.vncSecret ? await decryptSecret(host.vncSecret) : '' })
    }
    if (proto === 'rdp') {
      await audit(user.id, 'credential_reveal', { host: host.hostname, proto: 'rdp', shared: host.userId === null })
      return c.json({ username: host.rdpUser ?? '', password: host.rdpSecret ? await decryptSecret(host.rdpSecret) : '', security: host.rdpSecurity ?? 'nla' })
    }
    return c.json({ error: 'bad proto' }, 400)
  })

  // ── SFTP over HTTP (accessible hosts) ──
  r.get('/sftp/list', requireAuth, async (c) => {
    const user = c.get('user')
    const host = await loadAccessibleHost(c.req.query('host') ?? '', user)
    if (!host || !host.sshUser) return c.json({ error: 'not found' }, 404)
    const path = c.req.query('path') || '.'
    await audit(user.id, 'sftp_list', { host: host.hostname, path, shared: host.userId === null })
    let client: SshClient | null = null
    try {
      client = await connectSsh(host)
      const sftp = await getSftp(client)
      const cwd = await new Promise<string>((res) => sftp.realpath(path, (e, p) => res(e ? path : p)))
      type Entry = { filename: string; longname: string; attrs: { mode: number; size: number; mtime: number } }
      const list = await new Promise<Entry[]>((res, rej) => sftp.readdir(cwd, (e, l) => (e ? rej(e) : res(l as unknown as Entry[]))))
      const entries = list.map((it) => ({
        name: it.filename,
        dir: (it.attrs.mode & 0o170000) === 0o040000,
        size: it.attrs.size,
        mtime: it.attrs.mtime,
      })).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      return c.json({ path: cwd, entries })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    } finally {
      try { client?.end() } catch { /* ignore */ }
    }
  })

  r.get('/sftp/download', requireAuth, async (c) => {
    const user = c.get('user')
    const host = await loadAccessibleHost(c.req.query('host') ?? '', user)
    if (!host || !host.sshUser) return c.json({ error: 'not found' }, 404)
    const path = c.req.query('path') ?? ''
    if (!path) return c.json({ error: 'path required' }, 400)
    await audit(user.id, 'sftp_download', { host: host.hostname, path, shared: host.userId === null })
    const client = await connectSsh(host)
    const sftp = await getSftp(client)
    const nodeStream = sftp.createReadStream(path)
    const cleanup = () => { try { client.end() } catch { /* ignore */ } }
    nodeStream.on('close', cleanup)
    nodeStream.on('error', cleanup)
    const name = path.split('/').pop() || 'download'
    return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
      headers: { 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`, 'Content-Type': 'application/octet-stream' },
    })
  })

  r.post('/sftp/upload', requireAuth, async (c) => {
    const user = c.get('user')
    const host = await loadAccessibleHost(c.req.query('host') ?? '', user)
    if (!host || !host.sshUser) return c.json({ error: 'not found' }, 404)
    const path = c.req.query('path') ?? '' // full remote path incl. filename
    if (!path) return c.json({ error: 'path required' }, 400)
    const body = c.req.raw.body
    if (!body) return c.json({ error: 'no body' }, 400)
    await audit(user.id, 'sftp_upload', { host: host.hostname, path, shared: host.userId === null })
    const client = await connectSsh(host)
    try {
      const sftp = await getSftp(client)
      await new Promise<void>((resolve, reject) => {
        const out = sftp.createWriteStream(path)
        const nodeIn = Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream)
        out.on('close', () => resolve())
        out.on('error', reject)
        nodeIn.on('error', reject)
        nodeIn.pipe(out)
      })
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
    } finally {
      try { client.end() } catch { /* ignore */ }
    }
  })

  // ── "This server" desktop config (admin-only): loopback ports + optional credentials ──
  r.get('/self/config', requireAdmin, async (c) => {
    const cfg = await getSelfDesktopConfig(c.get('user').id)
    return c.json({
      host: cfg.host,
      vncPort: cfg.vncPort, vncHasSecret: !!cfg.vncSecret,
      rdpPort: cfg.rdpPort, rdpUser: cfg.rdpUser ?? '', rdpHasSecret: !!cfg.rdpSecret, rdpSecurity: cfg.rdpSecurity,
    })
  })
  r.put('/self/config', requireAdmin, async (c) => {
    const b = await c.req.json<{ host?: string; vncPort?: number; vncPassword?: string; rdpPort?: number; rdpUser?: string; rdpPassword?: string; rdpSecurity?: 'nla' | 'tls' | 'rdp' }>()
    const cur = await getSelfDesktopConfig()
    const port = (v: number | undefined, fallback: number) => (typeof v === 'number' && v > 0 && v < 65536 ? Math.floor(v) : fallback)
    // A blank password field keeps the stored secret (same "leave blank to keep" rule as the machine editor).
    const next: SelfDesktopConfig = {
      host: b.host !== undefined ? (b.host.trim() || '127.0.0.1') : cur.host,
      vncPort: port(b.vncPort, cur.vncPort),
      vncSecret: b.vncPassword ? await encryptSecret(b.vncPassword) : cur.vncSecret,
      rdpPort: port(b.rdpPort, cur.rdpPort),
      rdpUser: b.rdpUser !== undefined ? (b.rdpUser.trim() || null) : cur.rdpUser,
      rdpSecret: b.rdpPassword ? await encryptSecret(b.rdpPassword) : cur.rdpSecret,
      rdpSecurity: b.rdpSecurity ?? cur.rdpSecurity,
    }
    await setAppSetting(SELF_DESKTOP_KEY, next)
    return c.json({ ok: true })
  })

  // ── "This server" session authorize (admin-only, PIN-gated) — shell / vnc / rdp ──
  // noVNC/IronRDP auth client-side, so vnc/rdp return the stored loopback credentials to the browser.
  r.post('/self/authorize', requireAdmin, async (c) => {
    const user = c.get('user')
    const { pin, proto } = await c.req.json<{ pin: string; proto: SelfProto }>()
    if (proto !== 'shell' && proto !== 'vnc' && proto !== 'rdp' && proto !== 'claude-code') return c.json({ error: 'bad proto' }, 400)
    if (!(await verifyAdminPin(user.id, pin))) return c.json({ error: 'Invalid PIN' }, 403)
    // Claude Code attaches to the cookie-authed coding terminal (no per-open WS token), so the
    // PIN check alone gates the open — return ok without minting a token.
    if (proto === 'claude-code') return c.json({ ok: true })
    const token = mintSelfToken(user.id, proto)
    if (proto === 'vnc') {
      const cfg = await getSelfDesktopConfig(user.id)
      return c.json({ token, password: cfg.vncSecret ? await decryptSecret(cfg.vncSecret) : '' })
    }
    if (proto === 'rdp') {
      const cfg = await getSelfDesktopConfig(user.id)
      return c.json({ token, username: cfg.rdpUser ?? '', password: cfg.rdpSecret ? await decryptSecret(cfg.rdpSecret) : '', security: cfg.rdpSecurity })
    }
    return c.json({ token })
  })

  r.get('/audit', requireAdmin, async (c) => {
    const rows = await db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(200)
    return c.json({ entries: rows.map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })) })
  })

  // ── WS: admin-only raw host shell on THIS server ──
  r.get('/terminal', upgradeWebSocket(async (c) => {
    const user = await resolveUser(getCookie(c, 'session'))
    const token = c.req.query('token') ?? ''
    let upstream: WebSocket | null = null
    let stopKeepalive = () => { /* not started */ }
    const pending: (string | ArrayBufferLike)[] = []
    return {
      async onOpen(_evt, ws) {
        if (!user || user.role !== 'admin' || !consumeSelfToken(token, user.id, 'shell')) {
          try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }
          return
        }
        if (!(await isFeatureEnabled('remote'))) { try { ws.close(4403, 'feature disabled') } catch { /* ignore */ }; return }
        stopKeepalive = startWsKeepalive(ws)
        try {
          await ensureCodingPtySidecarReady()
          const spawn = buildHostShellSpawnParams(user.id)
          upstream = new WebSocket(codingPtySidecarWsUrl())
          upstream.addEventListener('open', () => {
            try { upstream?.send(JSON.stringify(spawn)); for (const m of pending) upstream?.send(m as string); pending.length = 0 } catch { /* closed */ }
          })
          upstream.addEventListener('message', (e) => { try { ws.send(e.data as string) } catch { /* gone */ } })
          upstream.addEventListener('close', () => { try { ws.close() } catch { /* closed */ } })
          upstream.addEventListener('error', () => { try { ws.close() } catch { /* closed */ } })
          await audit(user.id, 'host_shell_open')
        } catch (err) {
          logger.warn(`[remote] host shell failed: ${err instanceof Error ? err.message : String(err)}`)
          try { ws.close(1011, 'host shell unavailable') } catch { /* ignore */ }
        }
      },
      onMessage(evt) {
        if (upstream?.readyState === WebSocket.OPEN) { try { upstream.send(evt.data as string) } catch { /* gone */ } }
        else pending.push(evt.data as string)
      },
      onClose() { stopKeepalive(); try { upstream?.close() } catch { /* closed */ }; upstream = null },
    }
  }))

  // ── WS: SSH terminal into an accessible host ──
  r.get('/ssh', upgradeWebSocket(async (c) => {
    const user = await resolveUser(getCookie(c, 'session'))
    const hostId = c.req.query('host') ?? ''
    let client: SshClient | null = null
    let stream: import('ssh2').ClientChannel | null = null
    let stopKeepalive = () => { /* not started */ }
    const pending: string[] = []
    return {
      async onOpen(_evt, ws) {
        if (!user) { try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }; return }
        if (!(await isFeatureEnabled('remote'))) { try { ws.close(4403, 'feature disabled') } catch { /* ignore */ }; return }
        if (!(await userMayUseCapability(user, 'remote'))) { try { ws.close(4403, 'forbidden') } catch { /* ignore */ }; return }
        const host = await loadAccessibleHost(hostId, user)
        if (!host || !host.sshUser) { try { ws.close(4404, 'host not found') } catch { /* ignore */ }; return }
        stopKeepalive = startWsKeepalive(ws)
        try {
          client = await connectSsh(host)
          client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, sh) => {
            if (err || !sh) { try { ws.close(1011, 'shell failed') } catch { /* ignore */ }; return }
            stream = sh
            sh.on('data', (d: Buffer) => { try { ws.send(new Uint8Array(d)) } catch { /* gone */ } })
            sh.stderr.on('data', (d: Buffer) => { try { ws.send(new Uint8Array(d)) } catch { /* gone */ } })
            sh.on('close', () => { try { ws.close() } catch { /* closed */ } })
            for (const m of pending) sh.write(m)
            pending.length = 0
          })
          client.on('error', (e) => { logger.warn(`[remote] ssh error ${host.hostname}: ${e.message}`); try { ws.close(1011, 'ssh error') } catch { /* ignore */ } })
          await audit(user.id, 'ssh_open', { host: host.hostname, shared: host.userId === null })
        } catch (err) {
          logger.warn(`[remote] ssh connect failed: ${err instanceof Error ? err.message : String(err)}`)
          try { ws.close(1011, 'ssh unavailable') } catch { /* ignore */ }
        }
      },
      onMessage(evt) {
        const data = evt.data
        if (typeof data === 'string' && data.startsWith('{')) {
          try {
            const ctl = JSON.parse(data) as { type?: string; cols?: number; rows?: number }
            if (ctl.type === 'resize' && ctl.cols && ctl.rows && stream) { stream.setWindow(ctl.rows, ctl.cols, 0, 0); return }
          } catch { /* fall through */ }
        }
        const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString()
        if (stream) stream.write(text); else pending.push(text)
      },
      onClose() { stopKeepalive(); try { stream?.close() } catch { /* closed */ }; try { client?.end() } catch { /* closed */ }; client = null; stream = null },
    }
  }))

  // ── WS: VNC relay ──
  // Either into an accessible host (?host=), or into THIS server's loopback VNC (?self=<token>,
  // admin-only, PIN-authorized).
  r.get('/vnc', upgradeWebSocket(async (c) => {
    const user = await resolveUser(getCookie(c, 'session'))
    const hostId = c.req.query('host') ?? ''
    const selfToken = c.req.query('self') ?? ''
    let bridge: ReturnType<typeof openTcpBridge> | null = null
    let stopKeepalive = () => { /* not started */ }
    return {
      async onOpen(_evt, ws) {
        if (!user) { try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }; return }
        if (!(await isFeatureEnabled('remote'))) { try { ws.close(4403, 'feature disabled') } catch { /* ignore */ }; return }
        if (selfToken) {
          if (user.role !== 'admin' || !consumeSelfToken(selfToken, user.id, 'vnc')) { try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }; return }
          const cfg = await getSelfDesktopConfig(user.id)
          stopKeepalive = startWsKeepalive(ws)
          bridge = openTcpBridge(ws, cfg.host, cfg.vncPort)
          await audit(user.id, 'vnc_open', { host: `${cfg.host}:${cfg.vncPort}`, self: true })
          return
        }
        if (!(await userMayUseCapability(user, 'remote'))) { try { ws.close(4403, 'forbidden') } catch { /* ignore */ }; return }
        const host = await loadAccessibleHost(hostId, user)
        if (!host || host.vncPort == null) { try { ws.close(4404, 'host not found') } catch { /* ignore */ }; return }
        stopKeepalive = startWsKeepalive(ws)
        bridge = openTcpBridge(ws, host.hostname, host.vncPort)
        await audit(user.id, 'vnc_open', { host: host.hostname, shared: host.userId === null })
      },
      onMessage(evt) { bridge?.write(evt.data as ArrayBuffer) },
      onClose() { stopKeepalive(); bridge?.close(); bridge = null },
    }
  }))

  // ── WS: RDP via RDCleanPath ──
  // Either into an accessible host (?host=), or into THIS server's loopback RDP (?self=<token>,
  // admin-only, PIN-authorized).
  r.get('/rdp', upgradeWebSocket(async (c) => {
    const user = await resolveUser(getCookie(c, 'session'))
    const hostId = c.req.query('host') ?? ''
    const selfToken = c.req.query('self') ?? ''
    let ctrl: RdpCleanPathController | null = null
    let started = false
    let stopKeepalive = () => { /* not started */ }
    return {
      async onOpen(_evt, ws) {
        if (!user) { try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }; return }
        if (!(await isFeatureEnabled('remote'))) { try { ws.close(4403, 'feature disabled') } catch { /* ignore */ }; return }
        if (selfToken) {
          if (user.role !== 'admin' || !consumeSelfToken(selfToken, user.id, 'rdp')) { try { ws.close(4401, 'unauthorized') } catch { /* ignore */ }; return }
          const cfg = await getSelfDesktopConfig(user.id)
          stopKeepalive = startWsKeepalive(ws)
          ctrl = createRdpCleanPath(ws, cfg.host, cfg.rdpPort)
          await audit(user.id, 'rdp_open', { host: `${cfg.host}:${cfg.rdpPort}`, self: true })
          return
        }
        if (!(await userMayUseCapability(user, 'remote'))) { try { ws.close(4403, 'forbidden') } catch { /* ignore */ }; return }
        const host = await loadAccessibleHost(hostId, user)
        if (!host || host.rdpPort == null) { try { ws.close(4404, 'host not found') } catch { /* ignore */ }; return }
        stopKeepalive = startWsKeepalive(ws)
        ctrl = createRdpCleanPath(ws, host.hostname, host.rdpPort)
        await audit(user.id, 'rdp_open', { host: host.hostname, shared: host.userId === null })
      },
      onMessage(evt) {
        if (!ctrl) return
        if (!started) { started = true; void ctrl.onFirstMessage(evt.data as ArrayBuffer) }
        else ctrl.onData(evt.data as ArrayBuffer)
      },
      onClose() { stopKeepalive(); ctrl?.close(); ctrl = null },
    }
  }))

  return r
}

// ── Host input encryption ──────────────────────────────────────────────────
interface HostInput {
  label?: string
  hostname?: string
  shared?: boolean
  folderId?: string | null
  ssh?: { port?: number; user?: string; auth?: 'password' | 'key'; secret?: string } | null
  vnc?: { port?: number; secret?: string } | null
  rdp?: { port?: number; user?: string; security?: 'nla' | 'tls' | 'rdp'; secret?: string } | null
}

async function encryptHostSecrets(b: HostInput, opts?: { keepExisting: HostRow }) {
  const keep = opts?.keepExisting
  const enc = async (val: string | undefined, existing: string | null | undefined) =>
    val ? await encryptSecret(val) : (keep ? existing ?? null : null)
  return {
    sshPort: b.ssh?.port ?? (keep ? keep.sshPort : null),
    sshUser: b.ssh?.user ?? (keep ? keep.sshUser : null),
    sshAuth: b.ssh?.auth ?? (keep ? keep.sshAuth : null),
    sshSecret: await enc(b.ssh?.secret, keep?.sshSecret),
    vncPort: b.vnc?.port ?? (keep ? keep.vncPort : null),
    vncSecret: await enc(b.vnc?.secret, keep?.vncSecret),
    rdpPort: b.rdp?.port ?? (keep ? keep.rdpPort : null),
    rdpUser: b.rdp?.user ?? (keep ? keep.rdpUser : null),
    rdpSecurity: b.rdp?.security ?? (keep ? keep.rdpSecurity : null),
    rdpSecret: await enc(b.rdp?.secret, keep?.rdpSecret),
  }
}
