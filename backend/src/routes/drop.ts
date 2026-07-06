// Device-to-device "Drop" — AirDrop for the household. Server-relay: a sender device
// uploads bytes (or a text/link), the server stashes them and pushes an "incoming"
// event to the target device's live SSE stream (plus a notification as an offline
// fallback). The recipient pulls the bytes back down and the drop is cleaned up.
//
// v1 scope: same-user only (your own devices), browsers only, server-relay only.
// Deferred: cross-household targeting, screen-Pod targets, WebRTC P2P for large files.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { eq, and, desc, isNull, or } from 'drizzle-orm'
import type { AppEnv } from '@/types'
import { requireAuth } from '@/middleware/auth'
import { db } from '@/db'
import { fileDrops } from '@/db/schema'
import { emitNotification } from '@/lib/notify'
import {
  registerDropDevice,
  sendToDropDevice,
  listDropDevices,
  isDeviceOnline,
  type DropEvent,
} from '@/lib/drop/presence'
import {
  DROP_TTL_MS,
  ensureDropsDir,
  dropFilePath,
  toPreview,
  purgeDrop,
} from '@/lib/drop/service'

const drop = new Hono<AppEnv>()

// Cap a single drop at 2 GB — well past any real household transfer, and a guard
// against a runaway upload filling the disk.
const MAX_DROP_BYTES = 2 * 1024 * 1024 * 1024

// GET /api/drop/stream?deviceId=..&label=.. — the receive channel. Registers this
// browser as an addressable device and holds an SSE stream open for pushed drops.
drop.get('/stream', requireAuth, (c) => {
  const user = c.get('user')
  const deviceId = (c.req.query('deviceId') || '').trim()
  const label = (c.req.query('label') || 'A device').trim().slice(0, 60)
  if (!deviceId) return c.json({ error: 'deviceId required' }, 400)

  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    const send = (evt: DropEvent) => {
      void stream.writeSSE({ event: 'drop', data: JSON.stringify(evt) }).catch(() => {})
    }
    const unregister = registerDropDevice(user.id, deviceId, label, send)
    send({ type: 'hello' })
    try {
      while (!stream.closed) {
        await stream.sleep(30_000)
        if (stream.closed) break
        await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }
    } finally {
      unregister()
    }
  })
})

// GET /api/drop/devices — the user's other online browser devices, for the picker.
// The caller passes its own deviceId so we can exclude it from the list.
drop.get('/devices', requireAuth, (c) => {
  const user = c.get('user')
  const self = (c.req.query('self') || '').trim()
  const devices = listDropDevices(user.id).filter((d) => d.deviceId !== self)
  return c.json({ devices })
})

// GET /api/drop/inbox — pending drops targeted at this user (this device or broadcast).
drop.get('/inbox', requireAuth, async (c) => {
  const user = c.get('user')
  const deviceId = (c.req.query('deviceId') || '').trim()
  const rows = await db
    .select()
    .from(fileDrops)
    .where(
      and(
        eq(fileDrops.targetUserId, user.id),
        eq(fileDrops.status, 'pending'),
        deviceId
          ? or(isNull(fileDrops.targetDeviceId), eq(fileDrops.targetDeviceId, deviceId))
          : undefined,
      ),
    )
    .orderBy(desc(fileDrops.createdAt))
    .limit(50)
  return c.json({ drops: rows.map(toPreview) })
})

// POST /api/drop/send — multipart. Fields: senderDeviceId, senderLabel, kind,
// targetDeviceId (empty = all my other devices), and either `file` or `body` (text).
drop.post('/send', requireAuth, async (c) => {
  const user = c.get('user')

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ error: 'Expected multipart/form-data' }, 400)
  }

  const senderDeviceId = (form.get('senderDeviceId') as string | null)?.trim()
  const senderLabel = ((form.get('senderLabel') as string | null)?.trim() || 'A device').slice(0, 60)
  const kind = (form.get('kind') as string | null)?.trim()
  const targetRaw = (form.get('targetDeviceId') as string | null)?.trim()
  const targetDeviceId = targetRaw ? targetRaw : null // null = broadcast to my other devices

  if (!senderDeviceId) return c.json({ error: 'senderDeviceId required' }, 400)
  if (kind !== 'file' && kind !== 'text') return c.json({ error: 'kind must be file|text' }, 400)

  // Same-user only in v1: you can only drop to your own devices.
  const targetUserId = user.id

  // A specific target, if named, must currently be online (else the send silently
  // vanishes). Broadcast (null) is allowed even with nothing listening — it lands in
  // the inbox + fires a notification.
  if (targetDeviceId && !isDeviceOnline(targetUserId, targetDeviceId)) {
    return c.json({ error: 'That device is offline' }, 409)
  }

  const id = crypto.randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + DROP_TTL_MS)

  let row: typeof fileDrops.$inferInsert

  if (kind === 'text') {
    const body = (form.get('body') as string | null)?.trim()
    if (!body) return c.json({ error: 'body required for text drop' }, 400)
    row = {
      id, senderUserId: user.id, senderDeviceId, senderLabel,
      targetUserId, targetDeviceId, kind: 'text',
      body: body.slice(0, 20_000),
      status: 'pending', createdAt: now, expiresAt,
    }
  } else {
    const file = form.get('file') as File | null
    if (!file) return c.json({ error: 'file required for file drop' }, 400)
    if (file.size > MAX_DROP_BYTES) return c.json({ error: 'file too large' }, 413)
    await ensureDropsDir()
    const bytes = await file.arrayBuffer()
    await Bun.write(dropFilePath(id), bytes)
    row = {
      id, senderUserId: user.id, senderDeviceId, senderLabel,
      targetUserId, targetDeviceId, kind: 'file',
      fileName: (file.name || 'file').slice(0, 200),
      mime: file.type || 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      relPath: id,
      status: 'pending', createdAt: now, expiresAt,
    }
  }

  await db.insert(fileDrops).values(row)

  const preview = toPreview({ ...row, claimedAt: null } as typeof fileDrops.$inferSelect)
  const reached = sendToDropDevice(
    targetUserId,
    targetDeviceId,
    { type: 'incoming', drop: preview },
    senderDeviceId, // don't echo a broadcast back to the sender
  )

  // Notification as the offline fallback (bell + push per the user's delivery matrix).
  await emitNotification({
    type: 'file_drop',
    userId: targetUserId,
    payload: { dropId: id, kind, fileName: row.fileName ?? null, senderLabel },
    dedupeKey: `file_drop:${id}`,
  })

  return c.json({ id, delivered: reached })
})

// GET /api/drop/:id/blob — download the bytes. Marks the drop claimed and tells the
// sender's devices it landed. Owner-scoped (only the target user can pull).
drop.get('/:id/blob', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(fileDrops).where(eq(fileDrops.id, id)).limit(1)
  if (!row || row.targetUserId !== user.id) return c.json({ error: 'Not found' }, 404)
  if (row.kind !== 'file' || !row.relPath) return c.json({ error: 'Not a file drop' }, 400)

  const file = Bun.file(dropFilePath(row.relPath))
  if (!(await file.exists())) {
    await purgeDrop(id)
    return c.json({ error: 'File no longer available' }, 410)
  }

  if (row.status === 'pending') {
    await db.update(fileDrops)
      .set({ status: 'claimed', claimedAt: new Date() })
      .where(eq(fileDrops.id, id))
    sendToDropDevice(row.senderUserId, row.senderDeviceId, { type: 'claimed', drop: toPreview(row) })
  }

  const safeName = (row.fileName || 'file').replace(/["\r\n]/g, '_')
  return c.body(file.stream(), 200, {
    'Content-Type': row.mime || 'application/octet-stream',
    'Content-Length': String(row.sizeBytes ?? file.size),
    'Content-Disposition': `attachment; filename="${safeName}"`,
  })
})

// POST /api/drop/:id/dismiss — recipient declines a drop; purge it.
drop.post('/:id/dismiss', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(fileDrops).where(eq(fileDrops.id, id)).limit(1)
  // Either party may dismiss (sender recall or recipient decline).
  if (!row || (row.targetUserId !== user.id && row.senderUserId !== user.id)) {
    return c.json({ error: 'Not found' }, 404)
  }
  await purgeDrop(id)
  return c.json({ ok: true })
})

export { drop }
