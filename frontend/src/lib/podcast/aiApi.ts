// Client for the AI-native podcast endpoints: episode transcripts (feed-provided or
// Whisper-made), AI summary + auto-chapters, snips, and library-wide transcript search.

const J = { 'Content-Type': 'application/json' }
const opts: RequestInit = { credentials: 'include' }

async function jsonOrError<T>(r: Response, fallback: string): Promise<T> {
  const d = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!r.ok) throw new Error(d?.error || fallback)
  return d as T
}

// ── Transcript ─────────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  startSec: number
  endSec: number
  text: string
  speaker?: string
}

/** 'none' = nothing yet (offer Transcribe); pending/processing = a Whisper job is in
 *  flight; ready = segments are present; failed = the job gave up. */
export type TranscriptStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed'

export interface EpisodeTranscriptResponse {
  transcript: { segments: TranscriptSegment[]; source: 'feed' | 'whisper'; format: string | null } | null
  status: TranscriptStatus
  error?: string | null
  canTranscribe: boolean
  progress: { note: string | null; percent: number | null } | null
}

export async function getEpisodeTranscript(episodeId: string): Promise<EpisodeTranscriptResponse> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/transcript`, opts)
  return jsonOrError<EpisodeTranscriptResponse>(r, 'Could not load the transcript.')
}

export async function transcribeEpisode(episodeId: string): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/transcribe`, { ...opts, method: 'POST' })
  await jsonOrError(r, 'Could not start transcription.')
}

export interface TranscriptSearchHit {
  startSec: number
  endSec: number
  snippet: string
  text: string
}

export async function searchEpisodeTranscript(episodeId: string, q: string): Promise<TranscriptSearchHit[]> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/transcript/search?q=${encodeURIComponent(q)}`, opts)
  if (!r.ok) return []
  return (await r.json() as { hits?: TranscriptSearchHit[] }).hits ?? []
}

// ── AI summary + auto-chapters ─────────────────────────────────────────────────────

export interface EpisodeInsights {
  summary: string | null
  takeaways: string[]
  chaptersGenerated: boolean
  model: string | null
}

export async function getEpisodeInsights(episodeId: string): Promise<{ insights: EpisodeInsights | null; transcriptStatus: TranscriptStatus }> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/insights`, opts)
  return jsonOrError(r, 'Could not load the summary.')
}

export async function generateEpisodeInsights(episodeId: string, force = false): Promise<EpisodeInsights> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/insights${force ? '?force=1' : ''}`, { ...opts, method: 'POST' })
  const d = await jsonOrError<{ insights: EpisodeInsights }>(r, 'Could not generate the summary.')
  return d.insights
}

// ── Ad detection ───────────────────────────────────────────────────────────────────

export interface AdSegment {
  id: string
  startSec: number
  endSec: number
  kind: 'sponsor' | 'ad' | 'promo'
  confidence: number
}

/** 'none' = never scanned (the player requests one lazily when skip-ads is on). */
export type AdScanStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed'

export interface AdSegmentsResponse {
  status: AdScanStatus
  error: string | null
  segments: AdSegment[]
}

export async function getAdSegments(episodeId: string): Promise<AdSegmentsResponse> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/ad-segments`, opts)
  return jsonOrError<AdSegmentsResponse>(r, 'Could not load ad segments.')
}

export async function requestAdScan(episodeId: string, force = false): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/ad-scan${force ? '?force=1' : ''}`, { ...opts, method: 'POST' })
  await jsonOrError(r, 'Could not start the ad scan.')
}

export type AdCorrection =
  | { kind: 'not_ad'; startSec: number; endSec: number }
  | { kind: 'missed'; positionSec: number }

export async function reportAdCorrection(episodeId: string, body: AdCorrection): Promise<void> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/ad-reports`, {
    ...opts, method: 'POST', headers: J, body: JSON.stringify(body),
  })
  await jsonOrError(r, 'Could not send the report.')
}

// ── Snips ──────────────────────────────────────────────────────────────────────────

export interface Snip {
  id: string
  episodeId: string
  episodeTitle: string
  showId: string
  showName: string
  startSec: number
  endSec: number
  title: string
  summary: string | null
  transcriptText: string
  noteId: string | null
  createdAt: string | number
}

export async function getSnips(episodeId?: string): Promise<Snip[]> {
  const r = await fetch(`/api/podcasts/snips${episodeId ? `?episodeId=${encodeURIComponent(episodeId)}` : ''}`, opts)
  if (!r.ok) throw new Error('snips')
  return (await r.json() as { snips: Snip[] }).snips ?? []
}

export async function createSnip(episodeId: string, positionSec: number): Promise<Snip> {
  const r = await fetch('/api/podcasts/snips', {
    ...opts, method: 'POST', headers: J,
    body: JSON.stringify({ episodeId, positionSec: Math.floor(positionSec) }),
  })
  const d = await jsonOrError<{ snip: Snip }>(r, 'Could not save the snip.')
  return d.snip
}

export async function deleteSnip(id: string): Promise<void> {
  const r = await fetch(`/api/podcasts/snips/${id}`, { ...opts, method: 'DELETE' })
  await jsonOrError(r, 'Could not delete the snip.')
}

// ── Moments ──────────────────────────────────────────────────────────────────────
// The household social layer for an episode — same shape as Video's/Music's Moments.
export interface EpisodeMoment {
  id: string; userId: string; atSec: number; emoji: string | null; note: string | null
  by: string; mine: boolean; createdAt: number
}
export async function listEpisodeMoments(episodeId: string): Promise<{ moments: EpisodeMoment[] }> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/moments`, opts)
  return jsonOrError(r, 'Could not load moments.')
}
export async function addEpisodeMoment(episodeId: string, atSec: number, body: { emoji?: string; note?: string }): Promise<{ id: string }> {
  const r = await fetch(`/api/podcasts/episodes/${episodeId}/moments`, {
    ...opts, method: 'POST', headers: J, body: JSON.stringify({ atSec, ...body }),
  })
  return jsonOrError(r, 'Could not save that moment.')
}
export async function removeEpisodeMoment(momentId: string): Promise<{ ok: true }> {
  const r = await fetch(`/api/podcasts/moments/${momentId}`, { ...opts, method: 'DELETE' })
  return jsonOrError(r, 'Could not remove that moment.')
}

// ── Library-wide transcript search ─────────────────────────────────────────────────

export interface TranscriptSearchResult {
  episodeId: string
  title: string
  showId: string
  showName: string
  durationSec: number | null
  publishedAt: string | number | null
  hits: { startSec: number; endSec: number; snippet: string }[]
}

export async function searchTranscripts(q: string): Promise<{ results: TranscriptSearchResult[]; reranked: boolean }> {
  const r = await fetch(`/api/podcasts/search/transcripts?q=${encodeURIComponent(q)}`, opts)
  if (!r.ok) throw new Error('transcript-search')
  const d = await r.json() as { results?: TranscriptSearchResult[]; reranked?: boolean }
  return { results: d.results ?? [], reranked: d.reranked === true }
}

// ── Per-show auto-transcribe ───────────────────────────────────────────────────────

export async function setAutoTranscribe(showId: string, autoTranscribe: boolean): Promise<void> {
  const r = await fetch(`/api/podcasts/subscriptions/${showId}/auto-transcribe`, {
    ...opts, method: 'PUT', headers: J, body: JSON.stringify({ autoTranscribe }),
  })
  await jsonOrError(r, 'Could not update auto-transcribe.')
}

// ── Ask the episode ────────────────────────────────────────────────────────────────

export interface AskMessage { role: 'user' | 'assistant'; content: string }

/**
 * Stream an answer grounded in the episode transcript. Follows the app's SSE pattern
 * (`data: {"token"|"done"|"error"}` lines). `onToken` fires per token; the promise
 * resolves when the stream ends.
 */
export async function askEpisode(
  episodeId: string,
  question: string,
  history: AskMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/podcasts/episodes/${episodeId}/ask`, {
    ...opts, method: 'POST', headers: J, signal,
    body: JSON.stringify({ question, history }),
  })
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(d?.error || 'Could not ask this episode.')
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
      try { payload = JSON.parse(line.slice(6)) } catch { continue }
      if (payload.error) throw new Error(payload.error)
      if (payload.token) onToken(payload.token)
      if (payload.done) return
    }
  }
}
