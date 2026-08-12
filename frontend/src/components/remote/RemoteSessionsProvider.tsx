import { createContext, useContext, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'

// Open remote sessions live as tabs that stay MOUNTED (hidden via CSS when inactive) inside
// RemoteLayout, so a terminal/desktop keeps running while you switch between them. It's the same
// "keep the live thing mounted above the view" idea as the AI Radio engine. This provider
// only tracks the tab list + which is active; each session component owns its own live
// WebSocket / xterm / RFB / RDP objects for as long as its tab exists.

export type SessionKind = 'ssh' | 'vnc' | 'rdp' | 'host-shell' | 'claude-code'

export interface RemoteSession {
  id: string
  kind: SessionKind
  hostId?: string
  hostShellToken?: string
  /** Which persistent server-side shell this tab attaches to ('default' or a slot id). */
  shellSlot?: string
  // "This server" (loopback) VNC/RDP: single-use WS token + the creds the browser client needs.
  selfToken?: string
  selfVncPassword?: string
  selfRdp?: { username: string; password: string; security: string }
  title: string
  subtitle?: string
}

interface Ctx {
  sessions: RemoteSession[]
  activeId: string | null
  open: (s: Omit<RemoteSession, 'id'>) => string
  close: (id: string) => void
  focus: (id: string) => void
}

const RemoteCtx = createContext<Ctx | null>(null)

export function RemoteSessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const counter = useRef(0)

  const open = useCallback((s: Omit<RemoteSession, 'id'>) => {
    const id = `s${++counter.current}`
    setSessions((prev) => [...prev, { ...s, id }])
    setActiveId(id)
    return id
  }, [])

  const close = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      setActiveId((cur) => (cur === id ? (next[next.length - 1]?.id ?? null) : cur))
      return next
    })
  }, [])

  const focus = useCallback((id: string) => setActiveId(id), [])

  const value = useMemo<Ctx>(() => ({ sessions, activeId, open, close, focus }), [sessions, activeId, open, close, focus])
  return <RemoteCtx.Provider value={value}>{children}</RemoteCtx.Provider>
}

export function useRemoteSessions(): Ctx {
  const ctx = useContext(RemoteCtx)
  if (!ctx) throw new Error('useRemoteSessions must be used within RemoteSessionsProvider')
  return ctx
}
