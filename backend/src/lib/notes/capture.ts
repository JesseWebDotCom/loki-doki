// Shared companion note-capture pipeline. Two callers land procedural/reference
// facts here: the explicit "remember that..." tool (tools/memory.ts) and the passive
// memory judge (memory/judge.ts). One implementation keeps the paths from diverging:
// append-vs-create selection, duplicate suppression, and Home Inventory device
// linking all behave identically no matter how the fact arrived.

import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/db'
import { homeDevices, noteChunks, noteLinks, notes } from '@/db/schema'
import { cosineSimilarity, cachedVector } from '@/llm/embed'
import { createNote, appendToNote } from './store'

// Append floor: best-matching editable note at/above this cosine gets the fact
// appended; below it a new note is started.
export const NOTE_APPEND_COSINE = 0.60
// Duplicate ceiling: a chunk of the target note at/above this cosine means the fact
// is already written down; skip silently. Mirrors the memories DUPLICATE_COSINE.
export const NOTE_DUPLICATE_COSINE = 0.88

// Generic product words that shouldn't count toward a device match on their own.
const DEVICE_TOKEN_STOPLIST = new Set(['bundle', 'pack', 'edition', 'licensed', 'universal', 'upgrade'])

// Match a captured fact against Home Inventory devices so the note can be linked to
// the device sheet (note_links targetType 'device'). Conservative token scoring: a
// model or full-name substring hit counts double; otherwise at least two distinct
// name/brand/model tokens must appear in the fact. A tie between two devices links
// nothing (ambiguous beats wrong). Exported for tests.
export async function findDeviceTarget(fact: string): Promise<{ id: string; name: string } | null> {
  const devices = await db
    .select({ id: homeDevices.id, name: homeDevices.name, brand: homeDevices.brand, model: homeDevices.model })
    .from(homeDevices)
  if (!devices.length) return null

  const factLower = fact.toLowerCase()
  const factTokens = new Set(factLower.split(/\W+/).filter((t) => t.length >= 4))

  let best: { id: string; name: string; score: number } | null = null
  let runnerUp = 0
  for (const d of devices) {
    let score = 0
    const model = d.model?.toLowerCase().trim() ?? ''
    if (model.length >= 4 && factLower.includes(model)) score += 2
    if (factLower.includes(d.name.toLowerCase().trim())) score += 2
    const deviceTokens = new Set(
      `${d.name} ${d.brand ?? ''} ${d.model ?? ''}`.toLowerCase().split(/\W+/)
        .filter((t) => t.length >= 4 && !DEVICE_TOKEN_STOPLIST.has(t)),
    )
    for (const t of deviceTokens) if (factTokens.has(t)) score += 1
    if (best && score > best.score) { runnerUp = best.score; best = { id: d.id, name: d.name, score } }
    else if (!best) best = { id: d.id, name: d.name, score }
    else if (score > runnerUp) runnerUp = score
  }
  if (!best || best.score < 2 || best.score === runnerUp) return null
  return { id: best.id, name: best.name }
}

/** Link a note to a device (idempotent). Returns true when a new link was created. */
export async function ensureDeviceLink(noteId: string, deviceId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: noteLinks.id })
    .from(noteLinks)
    .where(and(eq(noteLinks.noteId, noteId), eq(noteLinks.targetType, 'device'), eq(noteLinks.targetId, deviceId)))
    .limit(1)
  if (existing) return false
  await db.insert(noteLinks).values({
    id: crypto.randomUUID(),
    noteId,
    targetType: 'device',
    targetId: deviceId,
    createdAt: new Date(),
  })
  return true
}

// Best append target among the notes this user can EDIT (own notes always; shared
// notes only when allowSharedAppend, i.e. an admin's explicit capture; the passive
// judge never mutates a household note). rawCos is the best unboosted chunk cosine,
// used by the duplicate check; score adds a title-token bonus for target selection.
async function findAppendTarget(
  userId: string,
  allowSharedAppend: boolean,
  factEmbedding: number[],
  fact: string,
): Promise<{ id: string; title: string; rawCos: number } | null> {
  const editable = allowSharedAppend ? or(isNull(notes.ownerId), eq(notes.ownerId, userId)) : eq(notes.ownerId, userId)
  const rows = await db
    .select({ id: noteChunks.id, noteId: noteChunks.noteId, embedding: noteChunks.embedding, title: notes.title })
    .from(noteChunks)
    .innerJoin(notes, eq(notes.id, noteChunks.noteId))
    .where(editable)
  if (!rows.length) return null

  const factTokens = new Set(fact.toLowerCase().split(/\W+/).filter((t) => t.length >= 4))
  const best = new Map<string, { title: string; score: number; rawCos: number }>()
  for (const r of rows) {
    if (!r.embedding) continue
    const vec = cachedVector(`note:${r.id}`, r.embedding)
    if (!vec) continue
    const rawCos = cosineSimilarity(factEmbedding, vec)
    let score = rawCos
    const titleTokens = r.title.toLowerCase().split(/\W+/)
    if (titleTokens.some((t) => t.length >= 4 && factTokens.has(t))) score += 0.05
    const cur = best.get(r.noteId)
    if (!cur || score > cur.score) {
      best.set(r.noteId, { title: r.title, score, rawCos: Math.max(rawCos, cur?.rawCos ?? 0) })
    } else if (rawCos > cur.rawCos) {
      cur.rawCos = rawCos
    }
  }
  let top: { id: string; title: string; score: number; rawCos: number } | null = null
  for (const [id, v] of best) {
    if (!top || v.score > top.score) top = { id, title: v.title, score: v.score, rawCos: v.rawCos }
  }
  return top && top.score >= NOTE_APPEND_COSINE ? { id: top.id, title: top.title, rawCos: top.rawCos } : null
}

export interface CaptureNoteInput {
  userId: string
  /** Allow appending to household-shared notes (admin's explicit capture only). */
  allowSharedAppend: boolean
  fact: string
  factEmbedding: number[]
  /** Suggested title for a new note (classifier or entity name); falls back to the
   *  matched device name, then the fact itself. */
  title?: string
  /** Force the note's device link to this device instead of inferring it from the
   *  fact text (Phase 2 learned-answers already know the exact device). When set,
   *  findDeviceTarget is skipped. */
  linkDeviceId?: string
}

export interface CaptureNoteResult {
  status: 'appended' | 'created' | 'duplicate'
  noteId: string
  title: string
  device: { id: string; name: string; newlyLinked: boolean } | null
}

/**
 * Land a procedural/reference fact in the Notes app: append to the best-matching
 * editable note or start a new personal one, suppress near-duplicates, and link the
 * note to a named Home Inventory device. Companion-created notes are always personal;
 * sharing with the household stays a deliberate action in the Notes UI.
 */
export async function captureNoteFact(input: CaptureNoteInput): Promise<CaptureNoteResult> {
  const fact = input.fact.trim()
  // A caller-supplied device wins over text inference; look up its name for the
  // reply/title. An unknown id falls back to inferring from the fact text.
  const deviceMatch = input.linkDeviceId
    ? (await db.select({ id: homeDevices.id, name: homeDevices.name })
        .from(homeDevices).where(eq(homeDevices.id, input.linkDeviceId)).limit(1))[0] ?? await findDeviceTarget(fact)
    : await findDeviceTarget(fact)
  const target = await findAppendTarget(input.userId, input.allowSharedAppend, input.factEmbedding, fact)

  const withLink = async (noteId: string): Promise<CaptureNoteResult['device']> => {
    if (!deviceMatch) return null
    const newlyLinked = await ensureDeviceLink(noteId, deviceMatch.id)
    return { ...deviceMatch, newlyLinked }
  }

  if (target) {
    // Already written down: skip the append but still take the device link, so a
    // pre-linking note gets attached to its device the next time the fact comes up.
    if (target.rawCos >= NOTE_DUPLICATE_COSINE) {
      return { status: 'duplicate', noteId: target.id, title: target.title, device: await withLink(target.id) }
    }
    await appendToNote(target.id, fact)
    return { status: 'appended', noteId: target.id, title: target.title, device: await withLink(target.id) }
  }

  const title = input.title?.trim() || deviceMatch?.name || fact.slice(0, 60)
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const note = await createNote({
    ownerId: input.userId,
    createdBy: input.userId,
    title,
    body: `- ${dateStr}: ${fact}`,
    source: 'companion',
  })
  return { status: 'created', noteId: note.id, title, device: await withLink(note.id) }
}
