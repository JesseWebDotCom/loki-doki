// Blocklist storage + matching. Lists are downloaded (hosts-file format) into
// data/dns/<category>.txt and loaded into a Set of exact domains; a query is
// blocked if its name or any parent domain is in the set (so blocking
// doubleclick.net also blocks ads.doubleclick.net). Custom allow rules win over
// any blocklist; custom deny rules block even when no list contains the domain.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface BlocklistCategory {
  id: string
  label: string
  description: string
  url: string
}

// Well-known, widely-used hosts-format lists. Kept small and reputable; the admin
// opts into each. URLs are fetched on demand, never at import.
export const BLOCKLIST_CATEGORIES: BlocklistCategory[] = [
  {
    id: 'ads-trackers',
    label: 'Ads & trackers',
    description: 'StevenBlack unified hosts: advertising and tracking domains.',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
  },
  {
    id: 'malware',
    label: 'Malware & phishing',
    description: 'URLhaus malicious host list.',
    url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
  },
  {
    id: 'adult',
    label: 'Adult content',
    description: 'StevenBlack porn-extended hosts (for the kids profile).',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
  },
]

const dnsDir = join(dataDir, 'dns')

function listPath(categoryId: string): string {
  return join(dnsDir, `${categoryId}.txt`)
}

// categoryId -> Set of blocked domains, loaded lazily and cached in memory.
const loaded = new Map<string, Set<string>>()

/** Parse a hosts-format file into a domain set. Lines look like `0.0.0.0 domain`
 *  or bare `domain`; comments and localhost entries are skipped. */
function parseHosts(text: string): Set<string> {
  const set = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    // `0.0.0.0 domain` / `127.0.0.1 domain`, or a bare domain.
    const domain = (parts.length >= 2 ? parts[1] : parts[0])!.toLowerCase()
    if (!domain || domain === 'localhost' || domain === 'localhost.localdomain' || domain.includes('/')) continue
    if (!domain.includes('.')) continue
    set.add(domain)
  }
  return set
}

export async function downloadBlocklist(category: BlocklistCategory): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    await mkdir(dnsDir, { recursive: true })
    const res = await fetch(category.url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return { ok: false, error: `Download failed (HTTP ${res.status}).` }
    const text = await res.text()
    const set = parseHosts(text)
    await writeFile(listPath(category.id), [...set].join('\n'))
    loaded.set(category.id, set)
    logger.info(`[dns] blocklist ${category.id}: ${set.size} domains`)
    return { ok: true, count: set.size }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function loadBlocklist(categoryId: string): Promise<Set<string>> {
  const cached = loaded.get(categoryId)
  if (cached) return cached
  const path = listPath(categoryId)
  if (!existsSync(path)) return new Set()
  try {
    const text = await readFile(path, 'utf8')
    const set = new Set(text.split('\n').map((d) => d.trim()).filter(Boolean))
    loaded.set(categoryId, set)
    return set
  } catch {
    return new Set()
  }
}

export function isBlocklistDownloaded(categoryId: string): boolean {
  return existsSync(listPath(categoryId))
}

export function blocklistCount(categoryId: string): number {
  return loaded.get(categoryId)?.size ?? 0
}

/** True if `name` or any parent domain is in `set`. */
export function matchesDomain(set: Set<string>, name: string): boolean {
  if (set.size === 0) return false
  let candidate = name
  while (candidate.includes('.')) {
    if (set.has(candidate)) return true
    candidate = candidate.slice(candidate.indexOf('.') + 1)
  }
  return set.has(candidate)
}

/** Drop the in-memory cache (after a re-download or config change). */
export function invalidateBlocklists(): void {
  loaded.clear()
}
