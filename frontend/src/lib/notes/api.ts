// Typed wrappers around /api/notes/*.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type NoteLinkTarget = 'device' | 'bookmark'

export interface NoteListItem {
  id: string
  title: string
  excerpt: string
  notebookId: string | null
  notebookName: string | null
  tags: string[]
  pinned: boolean
  source: 'user' | 'companion'
  isShared: boolean
  canEdit: boolean
  createdAt: string
  updatedAt: string
}

export interface NoteLink {
  id: string
  targetType: NoteLinkTarget
  targetId: string
  targetTitle: string | null
}

export interface NoteDetail {
  id: string
  ownerId: string | null
  notebookId: string | null
  title: string
  body: string
  pinned: boolean
  source: 'user' | 'companion'
  tags: string[]
  links: NoteLink[]
  isShared: boolean
  canEdit: boolean
  createdAt: string
  updatedAt: string
}

export interface Notebook {
  id: string
  ownerId: string | null
  name: string
  icon: string | null
  color: string | null
  sortOrder: number
  isShared: boolean
  canEdit: boolean
}

export interface NoteTag { name: string; count: number; isShared: boolean }

export interface NotesListParams {
  notebookId?: string
  tag?: string
  scope?: 'personal' | 'household'
  q?: string
}

export async function listNotes(params: NotesListParams = {}): Promise<NoteListItem[]> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()
  const res = await fetch(`/api/notes${qs ? `?${qs}` : ''}`, opts)
  if (!res.ok) throw new Error('Failed to load notes')
  return (await res.json()).items
}

export async function getNote(id: string): Promise<NoteDetail> {
  const res = await fetch(`/api/notes/${id}`, opts)
  if (!res.ok) throw new Error('Failed to load note')
  return (await res.json()).item
}

export async function createNote(body: {
  title?: string
  body?: string
  notebookId?: string | null
  tags?: string[]
  makeShared?: boolean
  links?: { targetType: NoteLinkTarget; targetId: string }[]
}): Promise<NoteDetail> {
  const res = await fetch('/api/notes', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to create note')
  return (await res.json()).item
}

export async function updateNote(id: string, body: Partial<{
  title: string
  body: string
  notebookId: string | null
  tags: string[]
  pinned: boolean
  makeShared: boolean
}>): Promise<void> {
  const res = await fetch(`/api/notes/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Failed to save note')
}

export async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`/api/notes/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete note')
}

export async function setNoteLinks(id: string, links: { targetType: NoteLinkTarget; targetId: string }[]): Promise<NoteLink[]> {
  const res = await fetch(`/api/notes/${id}/links`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ links }) })
  if (!res.ok) throw new Error('Failed to save links')
  return (await res.json()).links
}

export async function listNotebooks(): Promise<Notebook[]> {
  const res = await fetch('/api/notes/notebooks', opts)
  if (!res.ok) throw new Error('Failed to load notebooks')
  return (await res.json()).notebooks
}

export async function createNotebook(body: { name: string; icon?: string; color?: string; makeShared?: boolean }): Promise<Notebook> {
  const res = await fetch('/api/notes/notebooks', { ...opts, method: 'POST', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to create notebook')
  return (await res.json()).notebook
}

export async function updateNotebook(id: string, body: Partial<{ name: string; icon: string | null; color: string | null; makeShared: boolean }>): Promise<void> {
  const res = await fetch(`/api/notes/notebooks/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(body) })
  if (!res.ok) throw new Error('Failed to save notebook')
}

export async function deleteNotebook(id: string): Promise<void> {
  const res = await fetch(`/api/notes/notebooks/${id}`, { ...opts, method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete notebook')
}

export async function listNoteTags(): Promise<NoteTag[]> {
  const res = await fetch('/api/notes/tags', opts)
  if (!res.ok) throw new Error('Failed to load tags')
  return (await res.json()).tags
}

export interface LinkedNote {
  id: string
  title: string
  excerpt: string
  isShared: boolean
  canEdit: boolean
  updatedAt: string
}

export async function notesByTarget(type: NoteLinkTarget, targetId: string): Promise<LinkedNote[]> {
  const res = await fetch(`/api/notes/by-target/${type}/${encodeURIComponent(targetId)}`, opts)
  if (!res.ok) throw new Error('Failed to load linked notes')
  return (await res.json()).items
}
