// Client for the streaming AI Overview endpoint (backend/src/routes/webSearch.ts
// GET /answer). Same `data: {json}` line-parsing shape as askTrack() in
// lib/music/catalogApi.ts, with sources/noAnswer added for a multi-source citation
// answer instead of a single-track Q&A.

export interface SearchSource { title: string; url: string }

export async function streamSearchAnswer(
  query: string,
  onSources: (sources: SearchSource[]) => void,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<{ noAnswer: boolean }> {
  const res = await fetch(`/api/search/web/answer?q=${encodeURIComponent(query)}`, { credentials: 'include', signal })
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(d?.error || 'Could not generate an AI overview right now.')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let noAnswer = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let payload: { sources?: SearchSource[]; token?: string; done?: boolean; noAnswer?: boolean; error?: string }
      try { payload = JSON.parse(line.slice(6)) } catch { continue }
      if (payload.error) throw new Error(payload.error)
      if (payload.sources) onSources(payload.sources)
      if (payload.token) onToken(payload.token)
      if (payload.noAnswer) noAnswer = true
    }
  }
  return { noAnswer }
}
