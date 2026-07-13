// Kid-safe acquisition gating. A household member on a kid-safe content profile
// can't pull book bytes directly — their download turns into a 'requested'
// book_library row that an admin approves (or denies) before it downloads. Adults
// (and admins) download straight through, unchanged. Mirrors the App Store's
// install_request pattern, reusing emitNotification for the admin ping + the
// requester's approved/denied reply.

import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { books, bookLibrary, users } from '@/db/schema'
import { getProfile, getUserProfileSlug } from '@/lib/contentPolicy'
import { emitNotification } from '@/lib/notify'
import type { BookSearchResult } from './types'
import { downloadBookOffline, saveBook } from './offline'

/** True when this user's content profile is kid-safe, so their downloads must be
 *  approved. Admins are never gated (checked by the caller). */
export async function userMustRequestBooks(userId: string): Promise<boolean> {
  const slug = await getUserProfileSlug(userId)
  const profile = await getProfile(slug)
  return profile?.kidSafeMedia === true
}

/** Flip a user's library ref for a known catalog book to 'requested' and ping
 *  admins. Only a fresh save/failed ref becomes a request; anything already in
 *  flight or owned is left alone. Shared by the search-hit and by-id entry points. */
async function markRequested(userId: string, bookId: string, title: string): Promise<{ requested: boolean }> {
  const now = new Date()
  const [ref] = await db.select({ status: bookLibrary.status }).from(bookLibrary)
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1)
  if (ref && ref.status !== 'saved' && ref.status !== 'failed') return { requested: false }
  await db.insert(bookLibrary).values({ id: randomUUID(), userId, bookId, status: 'requested', requestedAt: now, addedAt: now })
    .onConflictDoUpdate({ target: [bookLibrary.userId, bookLibrary.bookId], set: { status: 'requested', requestedAt: now, approvedByUserId: null } })
  const [requester] = await db.select({ name: users.nickname }).from(users).where(eq(users.id, userId)).limit(1)
  await emitNotification({
    type: 'install_request',
    userId: null, // admin-targeted
    title: 'Book requested',
    body: `${requester?.name ?? 'Someone'} requested "${title}"`,
    url: '/admin/books',
    dedupeKey: `book-req:${userId}:${bookId}`,
    payload: { kind: 'book_request', requesterId: userId, bookId },
  })
  return { requested: true }
}

/** Turn a search-hit download intent into a pending request: get-or-create the
 *  catalog row, then mark the ref 'requested'. */
export async function createBookRequest(userId: string, result: BookSearchResult): Promise<{ bookId: string; requested: boolean }> {
  const { bookId } = await saveBook(userId, result) // get-or-create catalog + a 'saved' ref (onConflictDoNothing)
  const { requested } = await markRequested(userId, bookId, result.title)
  return { bookId, requested }
}

/** Request a book already in the catalog (the /:id/download-offline path). */
export async function requestExistingBook(userId: string, bookId: string): Promise<{ requested: boolean }> {
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, bookId)).limit(1)
  if (!book) return { requested: false }
  return markRequested(userId, bookId, book.title)
}

export interface BookRequestRow {
  bookId: string
  userId: string
  userName: string | null
  title: string
  author: string | null
  coverUrl: string | null
  sourceType: string
  requestedAt: number | null
}

/** All outstanding book requests across the household, newest first (admin view). */
export async function listBookRequests(): Promise<BookRequestRow[]> {
  const rows = await db.select({
    bookId: bookLibrary.bookId, userId: bookLibrary.userId, userName: users.nickname,
    title: books.title, author: books.author, coverUrl: books.coverUrl, sourceType: books.sourceType,
    requestedAt: bookLibrary.requestedAt,
  })
    .from(bookLibrary)
    .innerJoin(books, eq(bookLibrary.bookId, books.id))
    .leftJoin(users, eq(bookLibrary.userId, users.id))
    .where(eq(bookLibrary.status, 'requested'))
    .orderBy(desc(bookLibrary.requestedAt))
  return rows.map((r) => ({ ...r, requestedAt: r.requestedAt ? r.requestedAt.getTime() : null }))
}

/** Approve one request: record the approver, then run the normal offline download
 *  for that user (which flips the ref requested→pending and enqueues the job).
 *  Notifies the requester. */
export async function approveBookRequest(adminId: string, userId: string, bookId: string): Promise<{ ok: boolean }> {
  const [ref] = await db.select({ status: bookLibrary.status }).from(bookLibrary)
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1)
  if (!ref || ref.status !== 'requested') return { ok: false }
  // Move to 'saved' first so downloadBookOffline's saved→pending transition fires.
  await db.update(bookLibrary).set({ status: 'saved', approvedByUserId: adminId })
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId)))
  await downloadBookOffline(userId, bookId)
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, bookId)).limit(1)
  await emitNotification({
    type: 'system', userId,
    title: 'Book request approved',
    body: `"${book?.title ?? 'Your book'}" is downloading now`,
    url: `/books/${bookId}`,
  })
  return { ok: true }
}

/** Deny one request: drop the requested ref and tell the requester. */
export async function denyBookRequest(userId: string, bookId: string): Promise<{ ok: boolean }> {
  const [ref] = await db.select({ status: bookLibrary.status }).from(bookLibrary)
    .where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId))).limit(1)
  if (!ref || ref.status !== 'requested') return { ok: false }
  await db.delete(bookLibrary).where(and(eq(bookLibrary.userId, userId), eq(bookLibrary.bookId, bookId)))
  const [book] = await db.select({ title: books.title }).from(books).where(eq(books.id, bookId)).limit(1)
  await emitNotification({
    type: 'system', userId,
    title: 'Book request declined',
    body: `"${book?.title ?? 'Your request'}" wasn't approved`,
    url: '/books',
  })
  return { ok: true }
}
