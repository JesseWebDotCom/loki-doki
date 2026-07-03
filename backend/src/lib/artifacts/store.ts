// Canvas artifacts store — the single source of truth for creating, versioning,
// reading, and exporting the companion's editable "canvas" outputs (code snippets,
// markdown documents, small HTML pages). Both the HTTP route (routes/artifacts.ts)
// and the `canvas` tool go through here so the write path (append-a-version +
// denormalize currentContent) stays consistent.

import { eq, and, desc, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { artifacts, artifactVersions } from '@/db/schema'

export type ArtifactType = 'code' | 'document' | 'html'

export interface ArtifactRow {
  id: string
  userId: string
  conversationId: string | null
  messageId: string | null
  type: ArtifactType
  language: string | null
  title: string
  currentContent: string
  pinned: boolean
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Create an empty artifact (version comes later via appendVersion, so the body can
 *  stream in). Returns the new row. */
export async function createArtifact(input: {
  userId: string
  type: ArtifactType
  title: string
  language?: string | null
  conversationId?: string | null
  messageId?: string | null
  content?: string
}): Promise<ArtifactRow> {
  const now = new Date()
  const id = crypto.randomUUID()
  await db.insert(artifacts).values({
    id,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
    type: input.type,
    language: input.language ?? null,
    title: input.title,
    currentContent: input.content ?? '',
    pinned: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  })
  // If seeded with content, record it as version 1 so history is never empty.
  if (input.content && input.content.length > 0) {
    await appendVersion(id, input.content, 'assistant')
  }
  return (await getArtifact(id, input.userId))!
}

/** Append a new immutable version and denormalize it onto the artifact's
 *  currentContent. `author` distinguishes assistant generation/edits from the
 *  user's own hand edits. */
export async function appendVersion(
  artifactId: string,
  content: string,
  author: 'assistant' | 'user',
  summary?: string | null,
): Promise<void> {
  const now = new Date()
  await db.insert(artifactVersions).values({
    id: crypto.randomUUID(),
    artifactId,
    content,
    summary: summary ?? null,
    author,
    createdAt: now,
  })
  await db.update(artifacts)
    .set({ currentContent: content, updatedAt: now })
    .where(eq(artifacts.id, artifactId))
}

function rowToArtifact(r: typeof artifacts.$inferSelect): ArtifactRow {
  return { ...r, type: r.type as ArtifactType }
}

/** Fetch one artifact, scoped to its owner (returns null if not found or not theirs). */
export async function getArtifact(id: string, userId: string): Promise<ArtifactRow | null> {
  const r = await db.select().from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
    .limit(1)
  return r[0] ? rowToArtifact(r[0]) : null
}

export interface ArtifactVersionRow {
  id: string
  content: string
  summary: string | null
  author: 'assistant' | 'user'
  createdAt: Date
}

/** Version history for an artifact, newest first. */
export async function listVersions(artifactId: string): Promise<ArtifactVersionRow[]> {
  const rows = await db.select().from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.createdAt))
  return rows.map((r) => ({ ...r, author: r.author as 'assistant' | 'user' }))
}

/** The user's artifacts for the tray/list — non-archived, most-recently-updated first. */
export async function listArtifacts(userId: string, limit = 50): Promise<ArtifactRow[]> {
  const rows = await db.select().from(artifacts)
    .where(and(eq(artifacts.userId, userId), isNull(artifacts.archivedAt)))
    .orderBy(desc(artifacts.updatedAt))
    .limit(limit)
  return rows.map(rowToArtifact)
}

/** Copy a prior version's content forward as a new current version (non-destructive
 *  revert — history is preserved). */
export async function revertTo(artifactId: string, versionId: string, userId: string): Promise<ArtifactRow | null> {
  const owned = await getArtifact(artifactId, userId)
  if (!owned) return null
  const v = await db.select().from(artifactVersions)
    .where(and(eq(artifactVersions.id, versionId), eq(artifactVersions.artifactId, artifactId)))
    .limit(1)
  if (!v[0]) return null
  await appendVersion(artifactId, v[0].content, 'user', 'Reverted to an earlier version')
  return getArtifact(artifactId, userId)
}

export async function setPinned(id: string, userId: string, pinned: boolean): Promise<void> {
  await db.update(artifacts).set({ pinned, updatedAt: new Date() })
    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
}

export async function setTitle(id: string, userId: string, title: string): Promise<void> {
  await db.update(artifacts).set({ title, updatedAt: new Date() })
    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
}

/** Soft-delete (archive) so it drops out of the tray/list but history survives. */
export async function archiveArtifact(id: string, userId: string): Promise<void> {
  await db.update(artifacts).set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
}
