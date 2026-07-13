// Notes recall block for the companion turn (the "internet is slow" path: any
// family member's question retrieves their own + household-shared notes).
//
// Follows the memory-block pattern: embed the message, cosine-scan note chunks,
// format a capped prompt block. The block rides in the SAME per-conversation cache
// entry as the memory block (memory/blockCache.ts), so entity-staleness, MAX_TURNS,
// TTL, and judge-write invalidation all apply to notes for free. Note writes call
// invalidateNoteBlocks so a just-saved note is recallable on the very next turn.

import { retrieveNoteChunks } from './chunks'
import { invalidateMemoryBlocksForUser, invalidateAllMemoryBlocks } from '@/memory/blockCache'

// Reference notes sit between the memory system's thresholds (durable 0.37, vector
// 0.55): high enough to stay quiet on unrelated chatter, low enough that "the
// internet is slow" reaches a "Network troubleshooting" runbook.
const NOTE_MIN_COSINE = 0.50
const MAX_NOTES = 4
const EXCERPT_CHARS = 350
const BLOCK_CHAR_BUDGET = 1200 // memory block gets 2000; notes stay smaller

/** Formatted notes block for the system prompt, or null when nothing relevant. */
export async function recallNotesBlock(
  message: string,
  userId: string,
  promptEmbedding?: number[] | null,
): Promise<string | null> {
  const hits = await retrieveNoteChunks(userId, message, 12, promptEmbedding)
  const relevant = hits.filter((h) => h.score >= NOTE_MIN_COSINE)
  if (!relevant.length) return null

  // Best chunk per note, best notes first.
  const byNote = new Map<string, typeof relevant[number]>()
  for (const h of relevant) {
    const cur = byNote.get(h.noteId)
    if (!cur || h.score > cur.score) byNote.set(h.noteId, h)
  }
  const top = [...byNote.values()].sort((a, b) => b.score - a.score).slice(0, MAX_NOTES)

  const lines: string[] = [
    '## Saved notes',
    '[Reference notes the user or their household saved. Draw on them when relevant and mention the note title when you do.]',
  ]
  let used = lines.join('\n').length
  for (const h of top) {
    const scope = h.ownerId === null ? 'household note' : 'personal note'
    const excerpt = h.text.length > EXCERPT_CHARS ? `${h.text.slice(0, EXCERPT_CHARS)}…` : h.text
    const entry = `### ${h.title || 'Untitled note'} (${scope})\n${excerpt}`
    if (used + entry.length + 1 > BLOCK_CHAR_BUDGET) break
    lines.push(entry)
    used += entry.length + 1
  }
  return lines.length > 2 ? lines.join('\n') : null
}

/** Drop recall caches affected by a note write. Personal notes only appear in their
 *  owner's recall; household notes (ownerId null) appear in everyone's. */
export function invalidateNoteBlocks(ownerId: string | null): void {
  if (ownerId === null) invalidateAllMemoryBlocks()
  else invalidateMemoryBlocksForUser(ownerId)
}
