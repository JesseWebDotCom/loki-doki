// LibriVox public-domain audiobooks, sourced via Internet Archive's `librivoxaudio`
// collection rather than LibriVox's own API (librivox.org's /api/feed endpoint is
// behind Cloudflare and timed out on every attempt during development — archive.org
// is where LibriVox actually hosts its audio and metadata, and it's reliable).
//
// Verified live (2026-07-03): items in this collection are not access-restricted
// and carry a public-domain-mark license; each chapter is its own MP3 file served
// with `Access-Control-Allow-Origin: *` and `Accept-Ranges: bytes`, so chapters can
// stream directly from archive.org's CDN — no local download/storage needed, unlike
// the EPUB sources (see `library.ts`'s `bookLibrary` "ready" for a librivox `books`
// row: it's set immediately, there is no download job).

import { safeFetch } from '@/lib/ssrfGuard'
import { createTtlCache } from '@/lib/ttlCache'

export interface LibrivoxSearchResult {
  identifier: string
  title: string
  author: string | null
  language: string | null
  coverUrl: string | null
  runtime: string | null
  description?: string | null
  subjects?: string[]
}

export interface LibrivoxChapter {
  title: string
  url: string
  durationSec: number | null
}

export interface LibrivoxCategory {
  label: string
  subject: string
}

/** Curated genre shelves for the Audiobook Store — LibriVox items tag a `subject`
 *  field (semicolon-separated) verified live to include genuinely useful genre
 *  words like "Gothic", "horror", "literature" alongside reader/project metadata. */
export const LIBRIVOX_CATEGORIES: LibrivoxCategory[] = [
  { label: 'Classic Fiction', subject: 'fiction' },
  { label: 'Mystery & Detective', subject: 'mystery' },
  { label: 'Science Fiction', subject: 'science fiction' },
  { label: 'Romance', subject: 'romance' },
  { label: 'Horror & Gothic', subject: 'horror' },
  { label: 'History', subject: 'history' },
  { label: 'Philosophy', subject: 'philosophy' },
  { label: 'Poetry', subject: 'poetry' },
  { label: "Children's Literature", subject: 'children' },
  { label: 'Adventure', subject: 'adventure' },
]

interface IaSearchDoc {
  identifier: string
  title: string
  creator?: string | string[]
  language?: string | string[]
  runtime?: string
  description?: string | string[]
  subject?: string | string[]
}

function firstOf(v: string | string[] | undefined): string | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

function stripDescriptionHtml(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v.join(' ') : v
  if (!s) return null
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) || null
}

function subjectsOf(v: string | string[] | undefined): string[] {
  if (!v) return []
  const list = Array.isArray(v) ? v : v.split(/[;,]/)
  return [...new Set(list.map((s) => s.trim()).filter((s) => s && !/librivox|audiobook/i.test(s)))].slice(0, 4)
}

const RESULT_FIELDS = ['identifier', 'title', 'creator', 'language', 'runtime', 'description', 'subject']

function toResult(d: IaSearchDoc): LibrivoxSearchResult {
  return {
    identifier: d.identifier,
    title: d.title,
    author: firstOf(d.creator),
    language: firstOf(d.language),
    coverUrl: `https://archive.org/services/img/${d.identifier}`,
    runtime: d.runtime ?? null,
    description: stripDescriptionHtml(d.description),
    subjects: subjectsOf(d.subject),
  }
}

export async function searchLibrivox(query: string): Promise<LibrivoxSearchResult[]> {
  const q = `title:(${query}) AND collection:(librivoxaudio) AND mediatype:(audio)`
  const params = new URLSearchParams({ q, rows: '20', page: '1', output: 'json' })
  for (const f of RESULT_FIELDS) params.append('fl[]', f)

  try {
    const res = await safeFetch(`https://archive.org/advancedsearch.php?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!res.ok) return []
    const data = (await res.json()) as { response?: { docs?: IaSearchDoc[] } }
    return (data.response?.docs ?? []).map(toResult)
  } catch {
    return []
  }
}

// Same rationale as Gutenberg's category cache (gutenberg.ts): the Audiobook Store
// landing page re-renders all 10 genre rows on every visit, and archive.org's
// download-count ranking doesn't meaningfully shift minute to minute.
const CATEGORY_TTL_MS = 30 * 60 * 1000
const categoryCache = createTtlCache<LibrivoxSearchResult[]>(CATEGORY_TTL_MS)

/** Genre-shelf browse for the Audiobook Store landing page — sorted by download
 *  count (Internet Archive's popularity signal) so each shelf leads with titles
 *  people actually listen to. Cached per subject (see CATEGORY_TTL_MS). */
export async function browseLibrivoxByCategory(subject: string, limit = 12): Promise<LibrivoxSearchResult[]> {
  return categoryCache.getOrCompute(subject, () => fetchLibrivoxCategory(subject, limit))
}

/** All curated shelves in one round trip (fetched in parallel server-side) — what
 *  the Audiobook Store landing page actually calls, instead of 10 separate requests. */
export async function browseAllLibrivoxCategories(): Promise<{ category: LibrivoxCategory; results: LibrivoxSearchResult[] }[]> {
  return Promise.all(
    LIBRIVOX_CATEGORIES.map(async (category) => ({ category, results: await browseLibrivoxByCategory(category.subject) })),
  )
}

async function fetchLibrivoxCategory(subject: string, limit: number): Promise<LibrivoxSearchResult[]> {
  const q = `subject:(${subject}) AND collection:(librivoxaudio) AND mediatype:(audio)`
  const params = new URLSearchParams({ q, rows: String(limit), page: '1', output: 'json', sort: 'downloads desc' })
  for (const f of RESULT_FIELDS) params.append('fl[]', f)

  try {
    const res = await safeFetch(`https://archive.org/advancedsearch.php?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!res.ok) return []
    const data = (await res.json()) as { response?: { docs?: IaSearchDoc[] } }
    return (data.response?.docs ?? []).map(toResult)
  } catch {
    return []
  }
}

interface IaFile { name: string; format?: string; length?: string; title?: string }
interface IaMetadata {
  metadata?: { title?: string; creator?: string | string[]; language?: string | string[]; description?: string; 'access-restricted-item'?: string | boolean }
  files?: IaFile[]
}

function parseDurationSec(len: string | undefined): number | null {
  if (!len) return null
  if (/^\d+(\.\d+)?$/.test(len)) return parseFloat(len)
  const parts = len.split(':').map(Number)
  if (!parts.length || parts.some(Number.isNaN)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export interface LibrivoxAudiobook {
  title: string
  author: string | null
  description: string | null
  language: string | null
  chapters: LibrivoxChapter[]
}

/** Fetches an item's metadata and picks one MP3 rendition per chapter (64kbps
 *  preferred for consistent size; falls back to the higher-bitrate VBR rip if a
 *  64kbps derivative wasn't generated for some reason). */
export async function getLibrivoxAudiobook(identifier: string): Promise<LibrivoxAudiobook> {
  const res = await safeFetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {}, { timeoutMs: 10_000 })
  if (!res.ok) throw new Error(`Internet Archive lookup failed (${res.status})`)
  const meta = (await res.json()) as IaMetadata

  const restricted = meta.metadata?.['access-restricted-item']
  if (restricted === true || restricted === 'true') throw new Error('This item is lending-restricted, not freely downloadable')

  const files = meta.files ?? []
  const mp3Files = files.filter((f) => f.name.toLowerCase().endsWith('.mp3'))
  const preferred = mp3Files.filter((f) => f.format === '64Kbps MP3')
  const chapterFiles = (preferred.length ? preferred : mp3Files.filter((f) => f.format === 'VBR MP3'))
    .sort((a, b) => naturalCompare(a.name, b.name))

  if (!chapterFiles.length) throw new Error('No playable audio files found for this item')

  const chapters: LibrivoxChapter[] = chapterFiles.map((f, i) => ({
    title: f.title && !/^\d+$/.test(f.title) ? f.title : `Chapter ${i + 1}`,
    url: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
    durationSec: parseDurationSec(f.length),
  }))

  return {
    title: meta.metadata?.title ?? identifier,
    author: firstOf(meta.metadata?.creator),
    description: meta.metadata?.description ?? null,
    language: firstOf(meta.metadata?.language),
    chapters,
  }
}
