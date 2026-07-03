// Global Canvas artifact store - a module singleton (companionState / voicePlaybackStore
// pattern) so any surface can drive the canvas without prop-drilling, and so the
// companion can open an artifact whether or not the chat page is mounted. The pane
// (ArtifactPane) is mounted once globally in AppShell and reads this store.
//
// Streaming: when the companion creates an artifact, the backend emits an
// `open_artifact` directive (→ openFromDirective, pane opens in a "streaming" state)
// followed by `artifact_token` events (→ appendToken) and a final `artifact_done`
// (→ finishStreaming, persisted content). The SSE plumbing (ChatContext,
// useCompanionStream) calls these functions directly.

import { useSyncExternalStore } from 'react'

export type ArtifactType = 'code' | 'document' | 'html'

export interface ArtifactSummary {
  id: string
  type: ArtifactType
  language: string | null
  title: string
  currentContent: string
  pinned: boolean
  updatedAt: string | number
}

export interface ArtifactVersion {
  id: string
  content: string
  summary: string | null
  author: 'assistant' | 'user'
  createdAt: string | number
}

export interface OpenArtifact {
  id: string
  type: ArtifactType
  language: string | null
  title: string
  content: string
  versions: ArtifactVersion[]
  /** True while the body is still streaming in from the companion. */
  streaming: boolean
  /** True when an edit came from the local editor and hasn't been saved yet. */
  dirty: boolean
}

interface State {
  paneOpen: boolean
  open: OpenArtifact | null
  recent: ArtifactSummary[]
  /** Count of artifacts created since the tray was last viewed (bell/tray badge). */
  unseen: number
}

let state: State = { paneOpen: false, open: null, recent: [], unseen: 0 }
const subs = new Set<() => void>()
const notify = () => subs.forEach((fn) => fn())
function set(patch: Partial<State>) { state = { ...state, ...patch }; notify() }

export function getArtifactState(): State { return state }
export function subscribeArtifacts(fn: () => void): () => void { subs.add(fn); return () => subs.delete(fn) }

// ── Reads ──────────────────────────────────────────────────────────────────────
export function useArtifactState(): State {
  return useSyncExternalStore(subscribeArtifacts, getArtifactState, getArtifactState)
}

async function fetchArtifact(id: string): Promise<{ artifact: ArtifactSummary; versions: ArtifactVersion[] } | null> {
  try {
    const r = await fetch(`/api/artifacts/${id}`, { credentials: 'include' })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

/** Load the tray list from the server. */
export async function refreshArtifacts(): Promise<void> {
  try {
    const r = await fetch('/api/artifacts', { credentials: 'include' })
    if (!r.ok) return
    const { artifacts } = await r.json() as { artifacts: ArtifactSummary[] }
    set({ recent: artifacts })
  } catch { /* offline / not signed in */ }
}

// ── Opening ──────────────────────────────────────────────────────────────────
/** Open an existing artifact by id (from the tray, a chat card, or a deep link):
 *  fetches its content and shows the pane. */
export async function openArtifact(id: string): Promise<void> {
  set({ paneOpen: true })
  const data = await fetchArtifact(id)
  if (!data) return
  const a = data.artifact
  set({
    open: { id: a.id, type: a.type, language: a.language, title: a.title, content: a.currentContent, versions: data.versions, streaming: false, dirty: false },
  })
}

/** Open a just-created artifact from the companion's `open_artifact` directive. The
 *  body streams in next, so start empty + streaming. Also bumps the tray badge. */
export function openFromDirective(d: { artifactId: string; artifactType: ArtifactType; title: string }): void {
  set({
    paneOpen: true,
    open: { id: d.artifactId, type: d.artifactType, language: null, title: d.title, content: '', versions: [], streaming: true, dirty: false },
    unseen: state.unseen + 1,
  })
}

// ── Streaming ─────────────────────────────────────────────────────────────────
export function appendToken(artifactId: string, token: string): void {
  const o = state.open
  if (!o || o.id !== artifactId) return
  set({ open: { ...o, content: o.content + token, streaming: true } })
}

export function finishStreaming(artifactId: string, content: string): void {
  const o = state.open
  if (!o || o.id !== artifactId) { void refreshArtifacts(); return }
  // The final `content` (fence-stripped, persisted) is authoritative over the raw
  // accumulated tokens.
  set({ open: { ...o, content: content || o.content, streaming: false } })
  void refreshArtifacts()
  // A directive-opened artifact (create or focused edit) started with no version
  // list; reload it so the history dropdown + revert work right after streaming.
  void fetchArtifact(artifactId).then((d) => {
    const cur = state.open
    if (d && cur && cur.id === artifactId) set({ open: { ...cur, versions: d.versions, language: d.artifact.language } })
  })
}

// ── Local editing ─────────────────────────────────────────────────────────────
export function setLocalContent(content: string): void {
  const o = state.open
  if (!o) return
  set({ open: { ...o, content, dirty: true } })
}

/** Persist the current content as a new user version. */
export async function saveArtifact(): Promise<void> {
  const o = state.open
  if (!o || !o.dirty) return
  try {
    await fetch(`/api/artifacts/${o.id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: o.content, author: 'user' }),
    })
    set({ open: { ...state.open!, dirty: false } })
    void refreshArtifacts()
  } catch { /* keep dirty; retry on next edit */ }
}

// ── Assistant editing ("make it shorter") ──────────────────────────────────────
/** Ask the assistant to edit the open artifact. Marks it busy (reuses the streaming
 *  flag for a read-only editor + spinner), then swaps in the new version. */
export async function askEdit(instruction: string): Promise<boolean> {
  const o = state.open
  if (!o || !instruction.trim()) return false
  set({ open: { ...o, streaming: true } })
  try {
    const r = await fetch(`/api/artifacts/${o.id}/edit`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    })
    if (!r.ok) return false
    const { artifact } = await r.json() as { artifact: ArtifactSummary }
    const data = await fetchArtifact(o.id)
    set({ open: { ...state.open!, content: artifact.currentContent, versions: data?.versions ?? state.open!.versions, streaming: false, dirty: false } })
    void refreshArtifacts()
    return true
  } catch {
    return false
  } finally {
    if (state.open?.streaming) set({ open: { ...state.open!, streaming: false } })
  }
}

/** Non-destructively revert to a prior version (adds a new version copying it). */
export async function revertToVersion(versionId: string): Promise<void> {
  const o = state.open
  if (!o) return
  try {
    const r = await fetch(`/api/artifacts/${o.id}/revert`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    })
    if (!r.ok) return
    const { artifact } = await r.json() as { artifact: ArtifactSummary }
    const data = await fetchArtifact(o.id)
    set({ open: { ...state.open!, content: artifact.currentContent, versions: data?.versions ?? state.open!.versions, dirty: false } })
  } catch { /* leave as-is */ }
}

export function closePane(): void { set({ paneOpen: false }) }
export function clearUnseen(): void { if (state.unseen) set({ unseen: 0 }) }
