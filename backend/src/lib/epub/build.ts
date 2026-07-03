// Minimal EPUB3 writer — the inverse of parse.ts. Builds a real, valid EPUB from
// plain-text chapters (AI-generated prose has no source file) so the existing
// reader (epub.js) and TTS pipeline (openEpub/readSpineChapters/readChapterText)
// work completely unmodified on AI-written books, matching the codebase's existing
// hand-rolled, no-XML-DOM style (see parse.ts's header comment).

import { randomUUID } from 'node:crypto'
import { zipSync, type Zippable } from 'fflate'

export interface EpubChapterInput {
  title: string
  text: string // plain text, paragraphs separated by blank lines
}

export interface EpubBuildInput {
  title: string
  author?: string | null
  language?: string | null
  chapters: EpubChapterInput[]
  // Embedded as a cover-image manifest item — parse.ts's readMetadata() already knows how
  // to find this (properties="cover-image"), so the existing GET /:id/cover route serves
  // it with zero changes, for every household member, with no per-user auth scoping issue
  // a generatedImages-served URL would have.
  coverImage?: { bytes: Uint8Array; mime: string }
}

const encoder = new TextEncoder()

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function textToXhtmlBody(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  return paragraphs.map((p) => `<p>${escapeXml(p).replace(/\n/g, '<br/>')}</p>`).join('\n')
}

function chapterXhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(title)}</title><meta charset="utf-8"/></head>
<body>
<h1>${escapeXml(title)}</h1>
${body}
</body>
</html>`
}

/** Builds a real EPUB3 zip container in memory. Returned buffer is stored through
 *  the same content-addressed blob-store path uploadBookFile() uses for real files. */
export function synthesizeEpub(book: EpubBuildInput): Buffer {
  const bookId = randomUUID()
  const chapterFiles = book.chapters.map((ch, i) => ({
    id: `chapter${i + 1}`,
    href: `chapter${i + 1}.xhtml`,
    title: ch.title || `Chapter ${i + 1}`,
    xhtml: chapterXhtml(ch.title || `Chapter ${i + 1}`, textToXhtmlBody(ch.text)),
  }))

  const manifestItems = chapterFiles
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spineItems = chapterFiles.map((c) => `<itemref idref="${c.id}"/>`).join('\n')
  const navItems = chapterFiles
    .map((c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a></li>`)
    .join('\n')

  const coverExt = book.coverImage?.mime === 'image/jpeg' ? 'jpg' : 'png'
  const coverManifestItem = book.coverImage
    ? `<item id="cover-image" href="cover.${coverExt}" media-type="${book.coverImage.mime}" properties="cover-image"/>`
    : ''

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:uuid:${bookId}</dc:identifier>
<dc:title>${escapeXml(book.title)}</dc:title>
${book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}
<dc:language>${escapeXml(book.language || 'en')}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${coverManifestItem}
${manifestItems}
</manifest>
<spine>
${spineItems}
</spine>
</package>`

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title><meta charset="utf-8"/></head>
<body>
<nav epub:type="toc"><h1>Contents</h1><ol>
${navItems}
</ol></nav>
</body>
</html>`

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const files: Zippable = {
    mimetype: [encoder.encode('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': encoder.encode(container),
    'OEBPS/content.opf': encoder.encode(opf),
    'OEBPS/nav.xhtml': encoder.encode(nav),
  }
  for (const c of chapterFiles) files[`OEBPS/${c.href}`] = encoder.encode(c.xhtml)
  if (book.coverImage) files[`OEBPS/cover.${coverExt}`] = book.coverImage.bytes

  return Buffer.from(zipSync(files, { level: 6 }))
}
