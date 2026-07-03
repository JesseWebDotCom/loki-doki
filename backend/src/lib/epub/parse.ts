// Minimal EPUB (2 and 3) parser: zip via fflate, hand-rolled OPF/NCX/nav parsing —
// no XML-DOM dependency, matching this codebase's existing text-extraction style
// (see backend/src/lib/content/extract.ts). EPUB is a real ZIP container so fflate
// is the one unavoidable new dependency; the OPF/NCX/nav documents themselves are
// small, well-formed, non-adversarial XML that a regex/tag-walk parser handles fine.

import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { unzipSync } from 'fflate'
import { stripHtml } from '@/lib/htmlText'
import type { EpubMetadata, EpubTocEntry, EpubManifestItem } from './types'

export interface EpubHandle {
  entries: Record<string, Uint8Array>
  opfDir: string
  opfText: string
  manifest: Map<string, EpubManifestItem>
  spine: string[] // manifest ids, in reading order
}

const decoder = new TextDecoder('utf-8')

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) attrs[m[1]!] = m[2]!
  return attrs
}

function findTags(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}\\b[^>]*/?>`, 'gi')
  return xml.match(re) ?? []
}

function findBlock(xml: string, tagName: string): string | null {
  const m = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'))
  return m?.[1] ?? null
}

/** Resolve a zip-relative href (possibly with a `#fragment`) against a base dir,
 *  collapsing `../` segments. EPUB paths are always POSIX-style inside the zip. */
function resolveHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0] ?? href
  return posix.normalize(baseDir ? posix.join(baseDir, clean) : clean)
}

export async function openEpub(absPath: string): Promise<EpubHandle> {
  const bytes = await readFile(absPath)
  const entries = unzipSync(new Uint8Array(bytes))

  const containerXml = entries['META-INF/container.xml']
  if (!containerXml) throw new Error('Invalid EPUB: missing META-INF/container.xml')
  const opfPath = decoder.decode(containerXml).match(/full-path="([^"]+)"/)?.[1]
  if (!opfPath) throw new Error('Invalid EPUB: container.xml has no rootfile')

  const opfBytes = entries[opfPath]
  if (!opfBytes) throw new Error(`Invalid EPUB: OPF file missing at ${opfPath}`)
  const opfText = decoder.decode(opfBytes)
  const opfDir = posix.dirname(opfPath) === '.' ? '' : posix.dirname(opfPath)

  const manifest = new Map<string, EpubManifestItem>()
  const manifestBlock = findBlock(opfText, 'manifest') ?? ''
  for (const tag of findTags(manifestBlock, 'item')) {
    const a = parseAttrs(tag)
    if (!a.id || !a.href) continue
    manifest.set(a.id, {
      id: a.id,
      href: resolveHref(opfDir, a.href),
      mediaType: a['media-type'] ?? '',
      properties: a.properties ?? null,
    })
  }

  const spine: string[] = []
  const spineBlock = findBlock(opfText, 'spine') ?? ''
  for (const tag of findTags(spineBlock, 'itemref')) {
    const a = parseAttrs(tag)
    if (a.idref && a.linear !== 'no') spine.push(a.idref)
  }

  return { entries, opfDir, opfText, manifest, spine }
}

export function readMetadata(handle: EpubHandle): EpubMetadata {
  const metaBlock = findBlock(handle.opfText, 'metadata') ?? handle.opfText
  const title = stripHtml(metaBlock.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '').trim() || 'Untitled'
  const author = stripHtml(metaBlock.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1] ?? '').trim() || null
  const language = metaBlock.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1]?.trim() || null

  // Cover: EPUB3 manifest item with properties="cover-image", else EPUB2's
  // <meta name="cover" content="ITEM_ID"/> pointing at a manifest id.
  let coverHref: string | null = null
  for (const item of handle.manifest.values()) {
    if (item.properties?.includes('cover-image')) { coverHref = item.href; break }
  }
  if (!coverHref) {
    const coverId = metaBlock.match(/<meta\s+name="cover"\s+content="([^"]+)"/i)?.[1]
      ?? metaBlock.match(/<meta\s+content="([^"]+)"\s+name="cover"/i)?.[1]
    if (coverId) coverHref = handle.manifest.get(coverId)?.href ?? null
  }

  return { title, author, language, coverHref }
}

/** EPUB3 nav.xhtml → toc, else EPUB2 toc.ncx → navMap, else the spine itself with
 *  generic titles. Always returns something — a book with no real TOC still needs
 *  chapter navigation and TTS input. */
export function readToc(handle: EpubHandle): EpubTocEntry[] {
  const navItem = [...handle.manifest.values()].find((i) => i.properties?.split(/\s+/).includes('nav'))
  if (navItem) {
    const navBytes = handle.entries[navItem.href]
    if (navBytes) {
      const navHtml = decoder.decode(navBytes)
      const navDir = posix.dirname(navItem.href) === '.' ? '' : posix.dirname(navItem.href)
      const tocBlock = navHtml.match(/<nav[^>]*epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? navHtml
      const entries: EpubTocEntry[] = []
      const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(tocBlock))) {
        const title = stripHtml(m[2]!).trim()
        if (title) entries.push({ title, href: resolveHref(navDir, m[1]!) })
      }
      if (entries.length) return entries
    }
  }

  const ncxItem = [...handle.manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml')
  if (ncxItem) {
    const ncxBytes = handle.entries[ncxItem.href]
    if (ncxBytes) {
      const ncxXml = decoder.decode(ncxBytes)
      const ncxDir = posix.dirname(ncxItem.href) === '.' ? '' : posix.dirname(ncxItem.href)
      const entries: EpubTocEntry[] = []
      const re = /<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\s+src="([^"]+)"/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(ncxXml))) {
        const title = stripHtml(m[1]!).trim()
        if (title) entries.push({ title, href: resolveHref(ncxDir, m[2]!) })
      }
      if (entries.length) return entries
    }
  }

  // Fallback: one entry per spine item, generic titles.
  return handle.spine.map((id, i) => ({
    title: `Chapter ${i + 1}`,
    href: handle.manifest.get(id)?.href ?? '',
  })).filter((e) => e.href)
}

export function readChapterHtml(handle: EpubHandle, href: string): string {
  const bytes = handle.entries[href]
  if (!bytes) throw new Error(`Chapter not found in EPUB: ${href}`)
  return decoder.decode(bytes)
}

export function readChapterText(handle: EpubHandle, href: string): string {
  return stripHtml(readChapterHtml(handle, href))
}

/** Spine-ordered chapters, deduped against the TOC by href, for callers (TTS
 *  conversion, word-count/reading-time estimation) that want the FULL book in
 *  reading order rather than just the named TOC entries (a TOC can skip
 *  front-matter/copyright pages that still need to be read/spoken). */
export function readSpineChapters(handle: EpubHandle): { href: string; title: string }[] {
  const toc = readToc(handle)
  const titleByHref = new Map(toc.map((t) => [t.href, t.title]))
  return handle.spine
    .map((id) => handle.manifest.get(id)?.href)
    .filter((href): href is string => !!href)
    .map((href, i) => ({ href, title: titleByHref.get(href) ?? `Chapter ${i + 1}` }))
}
