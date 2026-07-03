// CBR (RAR) → CBZ (ZIP) conversion, so the reader only ever has to handle one
// comic-archive format client-side (CBZ, unzipped in-browser with fflate — see
// frontend/src/pages/books/ComicReaderPage.tsx). RAR has no efficient
// random-access extraction the way ZIP does, so this is a one-time, full
// extract-and-rezip pass at ingestion time, not a per-page operation.

import { readFile, writeFile } from 'node:fs/promises'
import { createExtractorFromData } from 'node-unrar-js'
import { zipSync } from 'fflate'

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i

export async function convertCbrToCbz(cbrPath: string, cbzPath: string): Promise<void> {
  const buf = await readFile(cbrPath)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const extractor = await createExtractorFromData({ data: arrayBuffer })
  const { files } = extractor.extract()

  const entries: Record<string, Uint8Array> = {}
  for (const f of files) {
    if (f.fileHeader.flags.directory) continue
    if (!f.extraction) continue
    if (!IMAGE_EXT.test(f.fileHeader.name)) continue
    entries[f.fileHeader.name] = f.extraction
  }
  if (Object.keys(entries).length === 0) throw new Error('No image pages found in this CBR archive')

  // level 0: page images are already compressed (JPEG/PNG) — re-compressing wastes CPU.
  const zipped = zipSync(entries, { level: 0 })
  await writeFile(cbzPath, zipped)
}
