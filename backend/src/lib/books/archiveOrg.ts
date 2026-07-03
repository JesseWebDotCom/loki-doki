// Internet Archive text search, restricted to items explicitly marked public domain.
//
// IMPORTANT (verified live against the real API before writing this): IA's search
// `format:EPUB` field is NOT a signal that a file is freely downloadable — most
// EPUB-tagged text items are lending-library books (`access-restricted-item: true`)
// whose "epub"/"pdf" files are actually DRM-wrapped (`_encrypted.pdf`, `_lcp.epub`)
// and will not open. The only reliable public-domain signal is a genuine
// `licenseurl` (e.g. creativecommons.org/publicdomain/...) AND the item not being
// access-restricted — both checked here and re-checked at download-resolve time.

import { safeFetch } from '@/lib/ssrfGuard'
import type { BookSearchResult, ResolvedDownload } from './types'

interface IaSearchDoc {
  identifier: string
  title: string
  creator?: string | string[]
  language?: string | string[]
  licenseurl?: string
  description?: string | string[]
  subject?: string | string[]
}

function firstOf(v: string | string[] | undefined): string | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

// IA descriptions are free-text metadata some uploaders write with raw HTML.
function stripDescriptionHtml(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v.join(' ') : v
  if (!s) return null
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) || null
}

function subjectsOf(v: string | string[] | undefined): string[] {
  if (!v) return []
  const list = Array.isArray(v) ? v : v.split(/[;,]/)
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 4)
}

export async function searchArchiveOrg(query: string): Promise<BookSearchResult[]> {
  const q = `title:(${query}) AND mediatype:(texts) AND licenseurl:(*publicdomain*)`
  const params = new URLSearchParams({
    q, rows: '20', page: '1', output: 'json',
  })
  params.append('fl[]', 'identifier')
  params.append('fl[]', 'title')
  params.append('fl[]', 'creator')
  params.append('fl[]', 'language')
  params.append('fl[]', 'licenseurl')
  params.append('fl[]', 'description')
  params.append('fl[]', 'subject')

  try {
    const res = await safeFetch(`https://archive.org/advancedsearch.php?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!res.ok) return []
    const data = (await res.json()) as { response?: { docs?: IaSearchDoc[] } }
    return (data.response?.docs ?? []).map((d) => ({
      source: 'archiveorg' as const,
      sourceRef: d.identifier,
      title: d.title,
      author: firstOf(d.creator),
      language: firstOf(d.language),
      coverUrl: `https://archive.org/services/img/${d.identifier}`,
      description: stripDescriptionHtml(d.description),
      subjects: subjectsOf(d.subject),
    }))
  } catch {
    return []
  }
}

interface IaFile { name: string; format?: string }
interface IaMetadata { metadata?: { 'access-restricted-item'?: string | boolean; licenseurl?: string }; files?: IaFile[] }

const RESTRICTED_MARKERS = ['_encrypted.', '_lcp.', 'daisy_encrypted']

export async function resolveArchiveOrgDownload(identifier: string): Promise<ResolvedDownload> {
  const res = await safeFetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {}, { timeoutMs: 10_000 })
  if (!res.ok) throw new Error(`Internet Archive lookup failed (${res.status})`)
  const meta = (await res.json()) as IaMetadata

  const restricted = meta.metadata?.['access-restricted-item']
  if (restricted === true || restricted === 'true') throw new Error('This item is lending-restricted, not freely downloadable')
  if (!meta.metadata?.licenseurl?.includes('publicdomain')) throw new Error('This item is not marked public domain')

  const epubFile = (meta.files ?? []).find((f) =>
    f.name.toLowerCase().endsWith('.epub') && !RESTRICTED_MARKERS.some((m) => f.name.toLowerCase().includes(m)))
  if (!epubFile) throw new Error('No freely-downloadable EPUB file found for this item')

  return { url: `https://archive.org/download/${identifier}/${encodeURIComponent(epubFile.name)}`, format: 'epub' }
}
