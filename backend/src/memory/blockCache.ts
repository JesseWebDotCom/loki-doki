// Shared memory-block cache.
//
// Recalling long-term memory (embed the message → vector search → format a prompt
// block) is one of the few things that gates time-to-first-token: the block has to
// be in the system prompt before generation can start, so its latency lands
// squarely between "prompt sent" and "first word spoken". Within a short window the
// recalled set barely changes, so re-computing it per message is pure waste.
//
// Caching it also keeps the system-prompt prefix byte-identical across turns, which
// lets Ollama reuse its KV cache for the history portion — the key to fast
// subsequent turns.
//
// Staleness controls (the original conversation-keyed cache froze recall to the
// FIRST message of a conversation for 30 minutes — mention Artie at turn 3 and his
// facts never surfaced):
//   - each entry records WHICH entity ids its block was built from; the caller
//     runs the cheap deterministic entity pass every turn and treats a newly
//     mentioned entity as a miss (recompute)
//   - each entry counts turns served and expires after MEMORY_BLOCK_MAX_TURNS,
//     bounding topic drift the entity pass can't see
//   - `invalidateMemoryBlocksForUser` drops all of a user's blocks after the
//     judge writes new facts (sweep + overlay both call it)

interface MemCacheEntry {
  memoryBlock: string | null
  /** Entity ids the cached block was computed against. */
  entityIds: Set<string>
  /** Owner — lets a judge write invalidate every conversation block for the user. */
  userId: string | null
  turnsServed: number
  expiresAt: number
}

const cache = new Map<string, MemCacheEntry>()

// 30 min — aligns with the background memory sweep's idle window.
export const MEMORY_BLOCK_TTL_MS = 30 * 60 * 1000

// Recompute the block after this many served turns even when no new entity was
// mentioned — bounds gradual topic drift within a long conversation.
export const MEMORY_BLOCK_MAX_TURNS = 8

/**
 * Fresh cached block for `key`, or null on miss/expiry. The returned object's
 * `memoryBlock` may itself be null (a valid "no memories" result) — the object
 * wrapper is what distinguishes a hit from a miss.
 *
 * Pass `currentEntityIds` (from the per-turn entity pass) to enforce the
 * entity-staleness rule: a prompt mentioning an entity the block wasn't built
 * from is a MISS, so "would Artie like this?" surfaces Artie's facts even
 * mid-conversation.
 */
export function getCachedMemoryBlock(
  key: string,
  currentEntityIds?: Set<string>,
): { memoryBlock: string | null } | null {
  const entry = cache.get(key)
  if (!entry || entry.expiresAt <= Date.now()) return null
  if (entry.turnsServed >= MEMORY_BLOCK_MAX_TURNS) { cache.delete(key); return null }
  if (currentEntityIds) {
    for (const id of currentEntityIds) {
      if (!entry.entityIds.has(id)) { cache.delete(key); return null }
    }
  }
  entry.turnsServed++
  return { memoryBlock: entry.memoryBlock }
}

export function setCachedMemoryBlock(
  key: string,
  memoryBlock: string | null,
  opts?: { entityIds?: Set<string>; userId?: string },
): void {
  cache.set(key, {
    memoryBlock,
    entityIds: opts?.entityIds ?? new Set(),
    userId: opts?.userId ?? null,
    turnsServed: 0,
    expiresAt: Date.now() + MEMORY_BLOCK_TTL_MS,
  })
}

/** Drop a cached block so the next turn recomputes it (e.g. after extracting new memories). */
export function invalidateMemoryBlock(key: string): void {
  cache.delete(key)
}

/** Drop ALL of a user's cached blocks — call after the judge writes to their shared brain. */
export function invalidateMemoryBlocksForUser(userId: string): void {
  for (const [key, entry] of cache) {
    if (entry.userId === userId) cache.delete(key)
  }
}

/** Drop EVERY cached block — call when the HOUSEHOLD scope changes (those facts
 *  appear in every user's recall). */
export function invalidateAllMemoryBlocks(): void {
  cache.clear()
}
