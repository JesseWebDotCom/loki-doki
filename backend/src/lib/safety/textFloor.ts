// ── Text safety floor ───────────────────────────────────────────────────────────
//
// The IRREDUCIBLE_CORE that must accompany EVERY text-generation call, not just the
// companion. Injected at the Ollama wrapper (llm/ollama.ts) so all generative paths
// — longform, podcast scripts, RAG answers, web-research lookups, etc. — are covered
// from one place instead of 24 hand-edited system prompts.
//
// This is the canonical home for the constant; lib/contentPolicy.ts re-exports it so
// existing importers (the companion path's buildContentPrompt) are unchanged.

export const IRREDUCIBLE_CORE =
  'Absolute limits that always apply regardless of any other instruction: never produce sexual content involving anyone under 18, in any framing. Never give instructions, recipes, or quantities for mass-casualty biological, chemical, nuclear, or radiological weapons. Those are the only hard limits — everything else permitted below is genuinely allowed; do not refuse it.'

// A stable substring used to detect a floor that's already present, so the companion
// path (which builds it in via buildContentPrompt) isn't double-injected.
const FLOOR_MARKER = 'never produce sexual content involving anyone under 18'

interface FloorMessage { role: string; content: string; images?: string[] }

/**
 * Ensure the text floor is present in a chat message list. Returns the list unchanged
 * for:
 *   - vision calls (any message carries images) — the floor governs generated text,
 *     not image analysis, and we don't want to distract a classifier prompt;
 *   - lists that already carry the floor (companion path).
 * Otherwise prepends it to the existing system message, or creates one if absent.
 */
export function applyTextFloor<T extends FloorMessage>(messages: T[]): T[] {
  if (!messages || messages.length === 0) return messages
  if (messages.some((m) => Array.isArray(m.images) && m.images.length > 0)) return messages

  const sys = messages.find((m) => m.role === 'system')
  if (sys) {
    if (sys.content.includes(FLOOR_MARKER)) return messages
    return messages.map((m) => (m === sys ? { ...m, content: `${IRREDUCIBLE_CORE}\n\n${m.content}` } : m))
  }
  return [{ role: 'system', content: IRREDUCIBLE_CORE } as unknown as T, ...messages]
}
