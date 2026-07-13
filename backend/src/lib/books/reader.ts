// Reader ecosystem glue: per-user Send-to-Kindle email + the OPDS/KOSync URLs the
// Books settings surface shows. Send-to-Kindle reuses the existing SMTP adapter to
// email the book file as an attachment (Kindle/Kobo email-in accepts EPUB directly).

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { books, userPreferences } from '@/db/schema'
import { blobAbsPath } from '@/lib/content/store'
import { sendEmailWithAttachment } from '@/lib/notify/adapters/email'
import { getReadyAssetBlobHash } from './library'
import { getOrCreateOpdsToken } from './opdsServer'

const KINDLE_EMAIL_PREF = 'books.kindle_email'

const EBOOK_MIME: Record<string, string> = {
  epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip',
}

export async function getKindleEmail(userId: string): Promise<string | null> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, KINDLE_EMAIL_PREF))).limit(1)
  if (!row?.value) return null
  try { const v = JSON.parse(row.value); return typeof v === 'string' && v.trim() ? v.trim() : null } catch { return null }
}

export async function setKindleEmail(userId: string, email: string): Promise<void> {
  const now = new Date()
  await db.insert(userPreferences).values({ id: randomUUID(), userId, key: KINDLE_EMAIL_PREF, value: JSON.stringify(email.trim()), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(email.trim()), updatedAt: now } })
}

/** Everything the Books "Reading sync" settings panel needs. `opdsPath` is relative;
 *  the client prefixes it with the server origin. */
export async function getReaderSyncInfo(userId: string): Promise<{ opdsPath: string; kosyncPath: string; kindleEmail: string | null }> {
  const token = await getOrCreateOpdsToken(userId)
  return { opdsPath: `/api/opds/${token}`, kosyncPath: '/api/kosync', kindleEmail: await getKindleEmail(userId) }
}

function safeFilename(title: string, ext: string): string {
  return `${title.replace(/[/\\?%*:|"<>]/g, '').trim().slice(0, 120) || 'book'}.${ext}`
}

/** Email a ready ebook to the user's configured Kindle/eReader address. */
export async function sendBookToKindle(userId: string, bookId: string): Promise<{ ok: boolean; error?: string }> {
  const to = await getKindleEmail(userId)
  if (!to) return { ok: false, error: 'No Send-to-Kindle email configured' }
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, bookId)).limit(1)
  if (!book) return { ok: false, error: 'Book not found' }
  const asset = await getReadyAssetBlobHash(bookId, 'ebook')
  if (!asset) return { ok: false, error: 'No downloaded file to send (download it offline first)' }
  const path = await blobAbsPath(asset.hash)
  try {
    await sendEmailWithAttachment(to, book.title, `Sent from your library: ${book.title}`, {
      filename: safeFilename(book.title, asset.format), path, contentType: EBOOK_MIME[asset.format] ?? 'application/octet-stream',
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Send failed' }
  }
}
