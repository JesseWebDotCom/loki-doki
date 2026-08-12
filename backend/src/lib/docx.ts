// Minimal .docx text extraction with zero new dependencies. A .docx is a zip
// containing word/document.xml; we parse the zip central directory by hand,
// inflate that one entry via node:zlib, and strip the WordprocessingML down to
// plain text with paragraph breaks. Deliberately not a general zip library —
// just enough to read a well-formed Office file; anything malformed returns ''.

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CDFH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // EOCD sits at the end, possibly preceded by a comment (max 65535 bytes).
  const scanStart = Math.max(0, buf.length - 22 - 65_535)
  let eocd = -1
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) return []

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CDFH_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localHeaderOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    entries.push({ name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntryData(buf: Buffer, entry: ZipEntry): Buffer | null {
  const at = entry.localHeaderOffset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LFH_SIG) return null
  // The local header's name/extra lengths can differ from the central ones.
  const nameLen = buf.readUInt16LE(at + 26)
  const extraLen = buf.readUInt16LE(at + 28)
  const dataStart = at + 30 + nameLen + extraLen
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  try {
    if (entry.method === 0) return Buffer.from(raw)          // stored
    if (entry.method === 8) return inflateRawSync(raw)       // deflate
  } catch { /* corrupt entry */ }
  return null
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
}

/** Extract plain text from a .docx file's bytes. Returns '' when unreadable. */
export function extractDocxText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = readCentralDirectory(buf)
  // Some zip writers (notably Windows) use backslash separators in entry names.
  const doc = entries.find((e) => e.name.replace(/\\/g, '/') === 'word/document.xml')
  if (!doc) return ''
  const xmlBuf = readEntryData(buf, doc)
  if (!xmlBuf) return ''
  const xml = xmlBuf.toString('utf8')

  // Paragraphs → newlines, tabs/breaks → their characters, then drop all tags.
  // Only <w:t> runs carry document text; everything else is formatting metadata.
  const text = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, t: string) => decodeXmlEntities(t))
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return text.trim()
}
