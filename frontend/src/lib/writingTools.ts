// Client for the Writing Tools endpoint (POST /api/writing-tools). Streams the
// transformed selection back token-by-token following the app's SSE pattern
// (`data: {"token"|"done"|"error"}` lines), same as askEpisode.

const J = { 'Content-Type': 'application/json' }
const opts: RequestInit = { credentials: 'include' }

export type WritingAction =
  | 'proofread'
  | 'friendly'
  | 'professional'
  | 'concise'
  | 'summarize'
  | 'key_points'
  | 'list'
  | 'translate'

/** Rewrite actions replace the selection in place; derive actions produce a shorter artifact. */
export const REWRITE_ACTIONS: WritingAction[] = ['proofread', 'friendly', 'professional', 'concise']

export async function runWritingTool(
  text: string,
  action: WritingAction,
  onToken: (token: string) => void,
  opts_: { targetLang?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await fetch('/api/writing-tools', {
    ...opts,
    method: 'POST',
    headers: J,
    signal: opts_.signal,
    body: JSON.stringify({ text, action, targetLang: opts_.targetLang }),
  })
  if (!res.ok || !res.body) {
    const d = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(d?.error || 'Writing Tools could not run.')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let payload: { token?: string; done?: boolean; error?: string }
      try {
        payload = JSON.parse(line.slice(6))
      } catch {
        continue
      }
      if (payload.error) throw new Error(payload.error)
      if (payload.token) onToken(payload.token)
      if (payload.done) return
    }
  }
}
