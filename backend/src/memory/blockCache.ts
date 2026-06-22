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
// subsequent turns. Both the chat route (keyed by conversation) and the companion
// route (keyed by user+character, since it is ephemeral and has no conversation)
// share this one tuned implementation.

interface MemCacheEntry {
  memoryBlock: string | null
  expiresAt: number
}

const cache = new Map<string, MemCacheEntry>()

// 30 min — aligns with the background memory sweep's idle window.
export const MEMORY_BLOCK_TTL_MS = 30 * 60 * 1000

/**
 * Fresh cached block for `key`, or null on miss/expiry. The returned object's
 * `memoryBlock` may itself be null (a valid "no memories" result) — the object
 * wrapper is what distinguishes a hit from a miss.
 */
export function getCachedMemoryBlock(key: string): { memoryBlock: string | null } | null {
  const entry = cache.get(key)
  if (entry && entry.expiresAt > Date.now()) return { memoryBlock: entry.memoryBlock }
  return null
}

export function setCachedMemoryBlock(key: string, memoryBlock: string | null): void {
  cache.set(key, { memoryBlock, expiresAt: Date.now() + MEMORY_BLOCK_TTL_MS })
}

/** Drop a cached block so the next turn recomputes it (e.g. after extracting new memories). */
export function invalidateMemoryBlock(key: string): void {
  cache.delete(key)
}
