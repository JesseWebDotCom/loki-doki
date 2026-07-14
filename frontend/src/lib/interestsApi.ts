// Client for the interest engine's "Not interested" endpoints (/api/interests/*).
// One domain-tagged pair serves every "Suggested for you" rail: dismissing hard-excludes
// the ref from future suggestions and nudges its creator down at the next profile build.

export type InterestDomain = 'videos' | 'shows' | 'movies' | 'podcasts' | 'music'

export interface DismissMeta {
  creatorId?: string | null
  creatorName?: string | null
  title?: string | null
}

async function post(path: string, body: unknown): Promise<void> {
  await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function dismissSuggestion(domain: InterestDomain, ref: string, meta?: DismissMeta): Promise<void> {
  return post('/api/interests/dismiss', { domain, ref, ...meta })
}

export function undismissSuggestion(domain: InterestDomain, ref: string): Promise<void> {
  return post('/api/interests/undismiss', { domain, ref })
}
