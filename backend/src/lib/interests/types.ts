// Shared interest-modeling engine: per-user "Suggested for you" rails across the media
// apps. Each domain (videos/shows/movies/podcasts/music) contributes a signal adapter
// (recent activity → InterestSignal[]) and a candidate generator; the engine turns
// signals into a weighted InterestProfile (creators + topics + embedding centroids),
// ranks candidates against it, and serves cached pools with watched-item exclusion,
// impression demotion, and explicit "Not interested" dismissals.

export type InterestDomain = 'videos' | 'shows' | 'movies' | 'podcasts' | 'music'

/** One piece of consumed content, normalized. `ref` must be stable and unique within the
 *  domain — it is the exclusion/impression key (e.g. 'youtube:VID', a TVMaze id, a feedUrl). */
export interface InterestSignal {
  ref: string
  title: string
  creatorId: string | null
  /** Channel / artist / network / show author. */
  creatorName: string | null
  /** Topics already known for the item (relatedTopics queries, genres, categories). */
  topics: string[]
  /** 0..1 — completed = 1, else position/duration clamped to [0.05, 1]. Never negative:
   *  a barely-opened item is a WEAK signal, not a downvote (dismiss is the explicit no). */
  engagement: number
  /** Epoch ms of the (latest) consumption. */
  at: number
}

export interface InterestProfile {
  domain: InterestDomain
  builtAt: number
  signalCount: number
  /** Top creators by decayed engagement, weights normalized to max 1. */
  creators: Array<{ id: string | null; name: string; weight: number }>
  /** Top topics/genres by decayed engagement, weights normalized to max 1. */
  topics: Array<{ text: string; weight: number }>
  /** Weighted-mean nomic-embed vectors of engaged titles; null when embedding was
   *  unavailable (Ollama down) — the ranker then scores without the cosine term. */
  recentCentroid: number[] | null
  longCentroid: number[] | null
}

/** Where a candidate came from — feeds a small ranking prior (a related-video or
 *  similar-title hit is a stronger lead than a generic trending item). */
export type CandidateBucket = 'related' | 'topic-search' | 'creator-latest' | 'similar' | 'trending'

export interface Candidate {
  ref: string
  title: string
  creatorId: string | null
  creatorName: string | null
  /** Topics known at generation time (the search query that found it, genres, tags). */
  topics: string[]
  publishedAt: number | null
  bucket: CandidateBucket
  /** The domain-native item (ItVideo, VideoItem, DirectoryResult…), returned verbatim
   *  by the rail so the frontend renders its usual card shape. */
  payload: unknown
}

export interface RankedCandidate extends Candidate {
  score: number
  /** Ranking components, kept for relevance gates: `cos` is null when the candidate
   *  couldn't be embedded (a gate must not mistake "unknown" for "similar"). */
  parts?: { cos: number | null; creator: number; topic: number }
}
