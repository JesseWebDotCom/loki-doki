// Conversational curation session — the short-lived "playlist we're building right now".
//
// "add some Bad Bunny" / "make it more upbeat" / "drop the last one" carry no playlist
// name, so the router can't tell them apart from ordinary chat. Mirroring the Home
// Assistant follow-up pattern (hasRecentHAContext), we remember the last playlist the
// curate_playlist tool touched, per user, in memory. runCompanionTurn consults this to
// force refine-shaped follow-ups back to the tool; the tool consults it to know which
// playlist to edit. In-process only (both live in the backend) and it lapses after a few
// idle minutes, so a stale "add …" never hijacks a fresh, unrelated conversation.

const TTL_MS = 15 * 60 * 1000

interface Session { playlistId: string; name: string; at: number }
const sessions = new Map<string, Session>()

export function setActiveCuration(userId: string, playlistId: string, name: string): void {
  sessions.set(userId, { playlistId, name, at: Date.now() })
}

export function getActiveCuration(userId: string): { playlistId: string; name: string } | null {
  const s = sessions.get(userId)
  if (!s) return null
  if (Date.now() - s.at > TTL_MS) { sessions.delete(userId); return null }
  return { playlistId: s.playlistId, name: s.name }
}

export function clearActiveCuration(userId: string): void {
  sessions.delete(userId)
}

// Refine-shaped follow-ups: only meaningful while a curation session is live. Kept
// tight (anchored) so it never fires on unrelated "add a reminder" / "remove the alarm".
const REFINE_RE =
  /^\s*(?:also |and |then )?(?:can you |could you |please )?(?:add|include|throw in|toss in|put in|remove|take (?:out|off|away)|drop|delete|get rid of|swap|replace|make it (?:more|less)|more of|less of|fewer|a few more|some more)\b/i
// "take that song off the playlist" — "take … off/out" split by the track name.
const REMOVE_SPLIT_RE = /\btake\b[^.?!]*\b(?:off|out)\b/i

export function isCurationFollowUp(message: string): boolean {
  return REFINE_RE.test(message) || REMOVE_SPLIT_RE.test(message)
}
