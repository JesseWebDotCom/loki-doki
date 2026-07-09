// Editor state for the Create studio: EDL document + selection + playhead, with
// snapshot-based undo/redo (the EDL is small JSON, so history is cheap) and a
// debounced autosave PUT. Context + useReducer per house style (no zustand in repo).

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { toast } from '@/lib/toast'
import { uuid } from '@/lib/uuid'
import { saveStudioProject } from '@/lib/videos/studioApi'
import { locate, type StudioEdl, type StudioVideoClip } from '@/components/videostudio/edl'

interface EditorState {
  edl: StudioEdl
  selectedClipId: string | null
  playheadSec: number
  past: StudioEdl[]
  future: StudioEdl[]
  dirty: boolean
}

type Action =
  | { type: 'load'; edl: StudioEdl }
  | { type: 'select'; clipId: string | null }
  | { type: 'playhead'; sec: number }
  | { type: 'edit'; edl: StudioEdl }          // any document mutation (snapshots for undo)
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'saved' }

const MAX_HISTORY = 100

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'load':
      return { edl: action.edl, selectedClipId: null, playheadSec: 0, past: [], future: [], dirty: false }
    case 'select':
      return { ...state, selectedClipId: action.clipId }
    case 'playhead':
      return { ...state, playheadSec: Math.max(0, action.sec) }
    case 'edit':
      return {
        ...state,
        edl: action.edl,
        past: [...state.past.slice(-MAX_HISTORY + 1), state.edl],
        future: [],
        dirty: true,
      }
    case 'undo': {
      const prev = state.past[state.past.length - 1]
      if (!prev) return state
      return { ...state, edl: prev, past: state.past.slice(0, -1), future: [state.edl, ...state.future], dirty: true }
    }
    case 'redo': {
      const next = state.future[0]
      if (!next) return state
      return { ...state, edl: next, past: [...state.past, state.edl], future: state.future.slice(1), dirty: true }
    }
    case 'saved':
      return { ...state, dirty: false }
  }
}

interface EditorApi {
  state: EditorState
  select: (clipId: string | null) => void
  setPlayhead: (sec: number) => void
  undo: () => void
  redo: () => void
  appendClip: (assetId: string, durationSec: number | null) => void
  removeClip: (clipId: string) => void
  moveClip: (clipId: string, dir: -1 | 1) => void
  trimClip: (clipId: string, edge: 'in' | 'out', sourceSec: number) => void
  splitAtPlayhead: () => void
  setClipSpeed: (clipId: string, speed: number) => void
  toggleMute: (clipId: string) => void
}

const EditorCtx = createContext<EditorApi | null>(null)

export function useEditor(): EditorApi {
  const ctx = useContext(EditorCtx)
  if (!ctx) throw new Error('useEditor must be inside StudioEditorProvider')
  return ctx
}

export function StudioEditorProvider({ projectId, initial, children }: {
  projectId: string
  initial: StudioEdl
  children: React.ReactNode
}) {
  const [state, dispatch] = useReducer(reducer, {
    edl: initial, selectedClipId: null, playheadSec: 0, past: [], future: [], dirty: false,
  })

  // Debounced autosave: quiet for 1.2s after the last edit → PUT.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(state.edl)
  latest.current = state.edl
  useEffect(() => {
    if (!state.dirty) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void saveStudioProject(projectId, { edl: latest.current })
        .then(() => dispatch({ type: 'saved' }))
        .catch((err) => toast.error(err instanceof Error ? err.message : 'Autosave failed'))
    }, 1200)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [state.edl, state.dirty, projectId])

  const edit = useCallback((mutate: (edl: StudioEdl) => StudioEdl) => {
    dispatch({ type: 'edit', edl: mutate(latest.current) })
  }, [])

  const api = useMemo<EditorApi>(() => ({
    state,
    select: (clipId) => dispatch({ type: 'select', clipId }),
    setPlayhead: (sec) => dispatch({ type: 'playhead', sec }),
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),

    appendClip: (assetId, durationSec) => edit((edl) => ({
      ...edl,
      video: [...edl.video, {
        id: uuid(), assetId,
        in: 0, out: Math.max(0.5, durationSec ?? 10), speed: 1, muted: false,
      }],
    })),

    removeClip: (clipId) => edit((edl) => ({ ...edl, video: edl.video.filter((c) => c.id !== clipId) })),

    moveClip: (clipId, dir) => edit((edl) => {
      const i = edl.video.findIndex((c) => c.id === clipId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= edl.video.length) return edl
      const video = [...edl.video]
      ;[video[i], video[j]] = [video[j]!, video[i]!]
      return { ...edl, video }
    }),

    trimClip: (clipId, edge, sourceSec) => edit((edl) => ({
      ...edl,
      video: edl.video.map((c) => {
        if (c.id !== clipId) return c
        if (edge === 'in') return { ...c, in: Math.max(0, Math.min(sourceSec, c.out - 0.1)) }
        return { ...c, out: Math.max(c.in + 0.1, sourceSec) }
      }),
    })),

    splitAtPlayhead: () => {
      const loc = locate(latest.current, state.playheadSec)
      if (!loc) return
      edit((edl) => {
        const c = edl.video[loc.index]
        if (!c) return edl
        // No split when the playhead sits at (or within 100ms of) a clip edge.
        if (loc.sourceSec <= c.in + 0.1 || loc.sourceSec >= c.out - 0.1) return edl
        const left: StudioVideoClip = { ...c, out: loc.sourceSec }
        const right: StudioVideoClip = { ...c, id: uuid(), in: loc.sourceSec }
        const video = [...edl.video]
        video.splice(loc.index, 1, left, right)
        return { ...edl, video }
      })
    },

    setClipSpeed: (clipId, speed) => edit((edl) => ({
      ...edl,
      video: edl.video.map((c) => (c.id === clipId ? { ...c, speed: Math.min(4, Math.max(0.25, speed)) } : c)),
    })),

    toggleMute: (clipId) => edit((edl) => ({
      ...edl,
      video: edl.video.map((c) => (c.id === clipId ? { ...c, muted: !c.muted } : c)),
    })),
  }), [state, edit])

  // Keyboard shortcuts: undo/redo, split, delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); api.undo() }
      else if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); api.redo() }
      else if (e.key === 's' && !meta) { api.splitAtPlayhead() }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedClipId) { api.removeClip(state.selectedClipId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, state.selectedClipId])

  return <EditorCtx.Provider value={api}>{children}</EditorCtx.Provider>
}
