// OPDS 1.2 catalog server (token-authed, no app session). A reader configured with
// /api/opds/<token> browses the owning user's library and pulls files/covers through
// the same token. See lib/books/opdsServer.ts for the feed generator.

import { Hono } from 'hono'
import { createReadStream, statSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookLibrary } from '@/db/schema'
import { acquireRead, blobAbsPath, releaseRead } from '@/lib/content/store'
import { getReadyAssetBlobHash, getOrExtractBookCover } from '@/lib/books/library'
import { buildOpdsFeed, resolveOpdsToken } from '@/lib/books/opdsServer'
import type { AppEnv } from '@/types'

export const opds = new Hono<AppEnv>()

const EBOOK_CONTENT_TYPE: Record<string, string> = {
  epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip',
}

/** Confirm the token's user actually has this book in their library (a token must
 *  not be able to pull arbitrary catalog books). */
async function ownsBook(userId: string, bookId: string): Promise<boolean> {
  const [row] = await db.select({ id: bookLibrary.bookId }).from(bookLibrary)
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1)
  return Boolean(row)
}

opds.get('/:token', async (c) => {
  const userId = await resolveOpdsToken(c.req.param('token'))
  if (!userId) return c.text('Unauthorized', 401)
  const xml = await buildOpdsFeed(userId, `/api/opds/${c.req.param('token')}`)
  return c.body(xml, 200, { 'Content-Type': 'application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8' })
})

opds.get('/:token/download/:bookId', async (c) => {
  const userId = await resolveOpdsToken(c.req.param('token'))
  if (!userId) return c.text('Unauthorized', 401)
  const bookId = c.req.param('bookId')
  if (!(await ownsBook(userId, bookId))) return c.text('Not found', 404)
  const asset = await getReadyAssetBlobHash(bookId, 'ebook')
  if (!asset) return c.text('Not ready', 404)
  const absPath = await blobAbsPath(asset.hash)
  let stat: ReturnType<typeof statSync>
  try { stat = statSync(absPath) } catch { return c.text('File missing', 404) }
  acquireRead(asset.hash)
  const stream = createReadStream(absPath)
  const release = () => releaseRead(asset.hash)
  stream.once('close', release); stream.once('error', release)
  return new Response(stream as any, {
    headers: {
      'Content-Type': EBOOK_CONTENT_TYPE[asset.format] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${bookId}.${asset.format}"`,
    },
  })
})

opds.get('/:token/cover/:bookId', async (c) => {
  const userId = await resolveOpdsToken(c.req.param('token'))
  if (!userId) return c.text('Unauthorized', 401)
  const bookId = c.req.param('bookId')
  if (!(await ownsBook(userId, bookId))) return c.text('Not found', 404)
  const cover = await getOrExtractBookCover(bookId)
  if (!cover) return c.text('No cover', 404)
  c.header('Content-Type', cover.mime)
  c.header('Cache-Control', 'private, max-age=86400')
  return c.body(cover.bytes as any)
})
