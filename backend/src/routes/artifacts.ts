// Canvas artifacts API — CRUD + export for the editable side-pane artifacts the
// companion produces (see lib/artifacts/store.ts and tools/canvas.ts). Everything is
// scoped to the signed-in user; the store enforces ownership on every read/write.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import {
  createArtifact, getArtifact, listArtifacts, listVersions, appendVersion,
  revertTo, setPinned, setTitle, archiveArtifact, type ArtifactType,
} from '@/lib/artifacts/store'
import { exportArtifact } from '@/lib/artifacts/export'
import { editArtifactContent } from '@/lib/artifacts/edit'
import type { AppEnv } from '@/types'

const artifactsRoute = new Hono<AppEnv>()

const TYPES: ArtifactType[] = ['code', 'document', 'html']

// List the user's artifacts (tray + /canvas page).
artifactsRoute.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  return c.json({ artifacts: await listArtifacts(user.id) })
})

// One artifact + its version history.
artifactsRoute.get('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const art = await getArtifact(c.req.param('id'), user.id)
  if (!art) return c.json({ error: 'Not found' }, 404)
  return c.json({ artifact: art, versions: await listVersions(art.id) })
})

// Manual create (e.g. "New document" from the UI). The companion path creates via
// the canvas tool, not this route.
artifactsRoute.post('/', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({})) as {
    type?: string; title?: string; language?: string; content?: string
  }
  const type = TYPES.includes(body.type as ArtifactType) ? (body.type as ArtifactType) : 'document'
  const art = await createArtifact({
    userId: user.id,
    type,
    title: (body.title?.trim() || 'Untitled').slice(0, 120),
    language: body.language ?? (type === 'document' ? 'markdown' : null),
    content: body.content ?? '',
  })
  return c.json({ artifact: art }, 201)
})

// Save a new version (a user hand-edit, or a re-generated body). Denormalizes onto
// currentContent via the store.
artifactsRoute.put('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const art = await getArtifact(id, user.id)
  if (!art) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as { content?: string; summary?: string; author?: string }
  if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400)
  await appendVersion(id, body.content, body.author === 'assistant' ? 'assistant' : 'user', body.summary)
  return c.json({ artifact: await getArtifact(id, user.id) })
})

// "Ask the assistant to edit this canvas" — LLM edit pass over the current content,
// saved as a new assistant version. Returns the updated artifact.
artifactsRoute.post('/:id/edit', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const art = await getArtifact(id, user.id)
  if (!art) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as { instruction?: string }
  if (!body.instruction?.trim()) return c.json({ error: 'instruction required' }, 400)
  try {
    const content = await editArtifactContent(art, body.instruction)
    await appendVersion(id, content, 'assistant', body.instruction.trim().slice(0, 200))
    return c.json({ artifact: await getArtifact(id, user.id) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Edit failed' }, 500)
  }
})

artifactsRoute.post('/:id/revert', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({})) as { versionId?: string }
  if (!body.versionId) return c.json({ error: 'versionId required' }, 400)
  const art = await revertTo(c.req.param('id'), body.versionId, user.id)
  if (!art) return c.json({ error: 'Not found' }, 404)
  return c.json({ artifact: art })
})

// Title / pin edits.
artifactsRoute.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const art = await getArtifact(id, user.id)
  if (!art) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as { title?: string; pinned?: boolean }
  if (typeof body.title === 'string' && body.title.trim()) await setTitle(id, user.id, body.title.trim().slice(0, 120))
  if (typeof body.pinned === 'boolean') await setPinned(id, user.id, body.pinned)
  return c.json({ artifact: await getArtifact(id, user.id) })
})

artifactsRoute.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user')
  await archiveArtifact(c.req.param('id'), user.id)
  return c.json({ ok: true })
})

// Export to a downloadable file (md/txt/html/pdf). PDF reuses the Playwright
// renderer (see lib/artifacts/export.ts).
artifactsRoute.get('/:id/export', requireAuth, async (c) => {
  const user = c.get('user')
  const art = await getArtifact(c.req.param('id'), user.id)
  if (!art) return c.json({ error: 'Not found' }, 404)
  const format = (c.req.query('format') ?? 'md').toLowerCase()
  try {
    const { bytes, mime, filename } = await exportArtifact(art, format)
    return new Response(bytes, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Export failed' }, 400)
  }
})

export { artifactsRoute }
