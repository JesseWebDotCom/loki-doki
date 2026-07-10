// Ship client-side errors to the backend log ring (POST /api/logs/client) so "Something
// went wrong" screens and silent promise rejections leave a trace an admin can actually
// read (Admin → Advanced → logs), instead of dying in a devtools console nobody had open.

const reported = new Map<string, number>()
let sentThisSession = 0
const MAX_PER_SESSION = 30        // a render loop must not turn into a log flood
const DEDUP_WINDOW_MS = 30_000    // same message within 30s → skip

export function reportClientError(kind: string, error: unknown, extra?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? '') : ''
  const now = Date.now()
  const last = reported.get(message)
  if ((last && now - last < DEDUP_WINDOW_MS) || sentThisSession >= MAX_PER_SESSION) return
  reported.set(message, now)
  sentThisSession++
  void fetch('/api/logs/client', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      message: message.slice(0, 1000),
      stack: stack.slice(0, 4000),
      path: window.location.pathname,
      ...extra,
    }),
  }).catch(() => { /* the reporter must never throw */ })
}
