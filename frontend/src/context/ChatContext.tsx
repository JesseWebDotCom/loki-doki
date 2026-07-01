import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Message } from '@/components/chat/ChatMessage'
import type { Block } from '@/components/chat/blocks/BlockRenderer'
import type { Source } from '@/lib/transformCitations'
import { useUIContext } from '@/context/UIContextProvider'
import { getActiveCompanionId } from '@/hooks/useActiveCompanion'
import { toast } from '@/lib/toast'
import { useRadio } from '@/context/RadioContext'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { applyPlayDirective, parsePlayDirective, type PlayMediaDirective } from '@/lib/playDirective'

// ── Projects ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  icon: string | null
  color: string | null
  instructions: string | null
  description: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ProjectInput {
  name: string
  icon: string | null
  color: string | null
  instructions: string | null
  description: string | null
}

// ── Conversations ─────────────────────────────────────────────────────────────

export interface Conversation {
  id: string
  title: string
  preview: string
  pinned: boolean
  projectId: string | null
  updatedAt: Date
  createdAt: Date
}

// ── Context shape ─────────────────────────────────────────────────────────────

interface ChatContextValue {
  messages: Message[]
  isGenerating: boolean
  /** > 0 while waiting for a generation slot; 0 when active; null when idle */
  queuePosition: number | null
  input: string
  setInput: (v: string) => void
  submit: (characterId?: string, textOverride?: string) => void
  regenerateMessage: (assistantMessageId: string) => void
  stop: () => void

  /** Documents attached to the next message (extracted text, sent + persisted on submit). */
  attachedDocs: { filename: string; text: string; chars: number }[]
  attachDocument: (file: File) => Promise<void>
  removeAttachedDoc: (index: number) => void
  attachingDoc: boolean
  /** Navigate to /chat and auto-submit a prompt as a fresh conversation. */
  queuePrompt: (text: string) => void
  pendingAutoPrompt: string | null
  clearPendingAutoPrompt: () => void

  conversationId: string | null
  conversations: Conversation[]
  loadConversation: (id: string) => Promise<void>
  newConversation: () => void
  deleteConversation: (id: string) => Promise<void>
  pinConversation: (id: string, pinned: boolean) => Promise<void>
  refreshConversations: () => Promise<void>

  projects: Project[]
  currentProject: Project | null
  setCurrentProject: (p: Project | null) => void
  createProject: (data: ProjectInput) => Promise<Project | null>
  updateProject: (id: string, data: Partial<ProjectInput>) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  refreshProjects: () => Promise<void>
}

const ChatContext = createContext<ChatContextValue | null>(null)

// ── Session-storage helpers for cross-navigation genId persistence ────────────

interface PendingGen {
  genId: string
  assistantMessageId: string
  lastSeq: number
}

function savePendingGen(conversationId: string, gen: PendingGen): void {
  try { sessionStorage.setItem(`pendingGen:${conversationId}`, JSON.stringify(gen)) } catch { /* ignore */ }
}

function loadPendingGen(conversationId: string): PendingGen | null {
  try {
    const raw = sessionStorage.getItem(`pendingGen:${conversationId}`)
    return raw ? JSON.parse(raw) as PendingGen : null
  } catch { return null }
}

function clearPendingGen(conversationId: string): void {
  try { sessionStorage.removeItem(`pendingGen:${conversationId}`) } catch { /* ignore */ }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ChatProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages]             = useState<Message[]>([])
  const [input, setInput]                   = useState('')
  const [isGenerating, setIsGenerating]     = useState(false)
  const [attachedDocs, setAttachedDocs]     = useState<{ filename: string; text: string; chars: number }[]>([])
  const [attachingDoc, setAttachingDoc]     = useState(false)
  const [queuePosition, setQueuePosition]   = useState<number | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations]   = useState<Conversation[]>([])
  const [projects, setProjects]             = useState<Project[]>([])
  const [currentProject, setCurrentProjectState] = useState<Project | null>(null)
  const [pendingAutoPrompt, setPendingAutoPrompt] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const currentProjectRef = useRef<Project | null>(null)
  const pendingGenRef = useRef<{ genId: string; convId: string; assistantMsgId: string; lastSeq: number } | null>(null)
  // RAF-based token buffer: accumulate tokens between animation frames so each frame
  // gets one batched setState instead of one per token (fixes "all at once" on fast models).
  const tokenBufRef = useRef<{ text: string; msgId: string } | null>(null)
  const tokenRafRef = useRef<number | null>(null)
  const { getContextBlock } = useUIContext()
  const radio = useRadio()
  const youtube = useYoutubePlayback()
  // Playback directives from a chat turn ("play heavy metal") drive the global
  // mini-player in place — no navigation. Kept in a ref so `submit` stays stable.
  const applyDirectiveRef = useRef<(d: PlayMediaDirective) => void>(() => {})
  applyDirectiveRef.current = (d: PlayMediaDirective) =>
    applyPlayDirective(d, { playExpanded: youtube.playExpanded, startStation: radio.start })

  useEffect(() => {
    refreshProjects()
    refreshConversations()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Projects API ────────────────────────────────────────────────────────────

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects', { credentials: 'include' })
      if (!res.ok) return
      const rows = await res.json() as Array<{
        id: string; name: string; icon: string | null; color: string | null
        instructions: string | null; description: string | null
        createdAt: number; updatedAt: number | null
      }>
      setProjects(rows.map((r) => ({
        id: r.id,
        name: r.name,
        icon: r.icon,
        color: r.color,
        instructions: r.instructions,
        description: r.description,
        createdAt: new Date(r.createdAt * 1000),
        updatedAt: new Date((r.updatedAt ?? r.createdAt) * 1000),
      })))
    } catch { /* API not available yet */ }
  }, [])

  const createProject = useCallback(async (data: ProjectInput): Promise<Project | null> => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) return null
      const r = await res.json() as {
        id: string; name: string; icon: string | null; color: string | null
        instructions: string | null; description: string | null
        createdAt: number; updatedAt: number | null
      }
      const project: Project = {
        id: r.id, name: r.name, icon: r.icon, color: r.color,
        instructions: r.instructions, description: r.description,
        createdAt: new Date(r.createdAt * 1000),
        updatedAt: new Date((r.updatedAt ?? r.createdAt) * 1000),
      }
      setProjects((prev) => [project, ...prev])
      return project
    } catch {
      return null
    }
  }, [])

  const updateProject = useCallback(async (id: string, data: Partial<ProjectInput>): Promise<void> => {
    try {
      await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      setProjects((prev) => prev.map((p) => p.id === id ? { ...p, ...data } : p))
      if (currentProjectRef.current?.id === id) {
        setCurrentProjectState((prev) => prev ? { ...prev, ...data } : null)
        currentProjectRef.current = currentProjectRef.current
          ? { ...currentProjectRef.current, ...data }
          : null
      }
    } catch { /* ignore */ }
  }, [])

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE', credentials: 'include' })
      setProjects((prev) => prev.filter((p) => p.id !== id))
      if (currentProjectRef.current?.id === id) {
        currentProjectRef.current = null
        setCurrentProjectState(null)
      }
      // The deleted project's chats move to "no project" (FK set null) — refresh
      // so their projectId is updated in the global list.
      refreshConversations()
    } catch { /* ignore */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // currentProject only controls which project NEW conversations are filed under
  // (and which project landing page is active). It never replaces the sidebar's
  // conversation list — that list is always the full, global set of chats.
  function setCurrentProject(p: Project | null) {
    currentProjectRef.current = p
    setCurrentProjectState(p)
  }

  // ── Conversations API ───────────────────────────────────────────────────────

  // Always fetches the full set of conversations (across all projects). The
  // sidebar shows a recent slice; project pages filter this list by projectId.
  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/conversations', { credentials: 'include' })
      if (!res.ok) return
      const rows = await res.json() as Array<{
        id: string; title: string | null; preview: string | null
        pinned: boolean; projectId?: string | null; createdAt: number; updatedAt: number | null
      }>
      setConversations(rows.map((r) => ({
        id: r.id,
        title: r.title ?? 'Untitled',
        preview: r.preview ?? '',
        pinned: r.pinned,
        projectId: r.projectId ?? null,
        updatedAt: new Date((r.updatedAt ?? r.createdAt) * 1000),
        createdAt: new Date(r.createdAt * 1000),
      })))
    } catch { /* offline or not authed yet */ }
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json() as { messages: Array<{ id: string; role: string; content: string }> }
      const loadedMsgs = data.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content }))

      setConversationId(id)
      setMessages(loadedMsgs)

      // Check if there's an in-flight generation we should reconnect to
      const pending = loadPendingGen(id)
      if (!pending) return

      // See if the assistant message in the DB looks complete (has non-empty content)
      const lastMsg = loadedMsgs[loadedMsgs.length - 1]
      const isComplete = lastMsg?.id === pending.assistantMessageId && lastMsg.content.length > 0
      if (isComplete) {
        clearPendingGen(id)
        return
      }

      // Attempt reconnect — 404 means the job GC'd; fall back to the loaded messages
      const controller = new AbortController()
      abortRef.current = controller
      setIsGenerating(true)
      setQueuePosition(null)

      const assistantId = pending.assistantMessageId

      // Ensure the placeholder exists in the messages array
      setMessages((prev) => {
        if (prev.find((m) => m.id === assistantId)) return prev
        return [...prev, { id: assistantId, role: 'assistant' as const, content: '' }]
      })

      pendingGenRef.current = { genId: pending.genId, convId: id, assistantMsgId: assistantId, lastSeq: pending.lastSeq }

      streamResume(
        pending.genId,
        pending.lastSeq,
        controller.signal,
        {
          onQueue: (position) => setQueuePosition(position > 0 ? position : null),
          onToken: (token) => {
            if (tokenBufRef.current?.msgId === assistantId) {
              tokenBufRef.current.text += token
            } else {
              tokenBufRef.current = { text: token, msgId: assistantId }
            }
            if (tokenRafRef.current === null) {
              tokenRafRef.current = requestAnimationFrame(() => {
                tokenRafRef.current = null
                const buf = tokenBufRef.current
                if (!buf) return
                tokenBufRef.current = null
                setMessages((prev) =>
                  prev.map((m) => m.id === buf.msgId ? { ...m, content: m.content + buf.text } : m),
                )
              })
            }
          },
          onBlock: (block) => {
            setMessages((prev) =>
              prev.map((m) => m.id === assistantId ? { ...m, blocks: [...(m.blocks ?? []), block] } : m),
            )
          },
          onSources: (sources) => {
            setMessages((prev) =>
              prev.map((m) => m.id === assistantId ? { ...m, sources } : m),
            )
          },
          onDone: () => {
            if (tokenRafRef.current !== null) {
              cancelAnimationFrame(tokenRafRef.current)
              tokenRafRef.current = null
            }
            const doneBuf = tokenBufRef.current
            if (doneBuf) {
              tokenBufRef.current = null
              setMessages((prev) =>
                prev.map((m) => m.id === doneBuf.msgId ? { ...m, content: m.content + doneBuf.text } : m),
              )
            }
            setIsGenerating(false)
            setQueuePosition(null)
            clearPendingGen(id)
            pendingGenRef.current = null
            abortRef.current = null
          },
          onError: () => {
            // On error or 404, just leave the messages as-is (DB state is the source of truth)
            setIsGenerating(false)
            setQueuePosition(null)
            clearPendingGen(id)
            pendingGenRef.current = null
            abortRef.current = null
          },
        },
      )
    } catch { /* ignore */ }
  }, [])

  const newConversation = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    pendingGenRef.current = null
    if (tokenRafRef.current !== null) {
      cancelAnimationFrame(tokenRafRef.current)
      tokenRafRef.current = null
    }
    tokenBufRef.current = null
    setConversationId(null)
    setMessages([])
    setInput('')
    setIsGenerating(false)
    setQueuePosition(null)
  }, [])

  const clearPendingAutoPrompt = useCallback(() => setPendingAutoPrompt(null), [])

  const queuePrompt = useCallback((text: string) => {
    abortRef.current?.abort()
    abortRef.current = null
    pendingGenRef.current = null
    if (tokenRafRef.current !== null) {
      cancelAnimationFrame(tokenRafRef.current)
      tokenRafRef.current = null
    }
    tokenBufRef.current = null
    setConversationId(null)
    setMessages([])
    setInput('')
    setIsGenerating(false)
    setQueuePosition(null)
    setPendingAutoPrompt(text)
  }, [])

  const deleteConversation = useCallback(async (id: string) => {
    await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE', credentials: 'include' })
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (conversationId === id) newConversation()
  }, [conversationId, newConversation])

  const pinConversation = useCallback(async (id: string, pinned: boolean) => {
    await fetch(`/api/chat/conversations/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    })
    setConversations((prev) => prev.map((c) => c.id === id ? { ...c, pinned } : c))
  }, [])

  // ── Document attachments ─────────────────────────────────────────────────────

  const attachDocument = useCallback(async (file: File) => {
    setAttachingDoc(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/chat/extract', { method: 'POST', credentials: 'include', body: fd })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((data as { error?: string }).error ?? 'Could not read that file')
      const d = data as { filename: string; text: string; chars: number }
      setAttachedDocs((prev) => [...prev, { filename: d.filename, text: d.text, chars: d.chars }])
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAttachingDoc(false)
    }
  }, [])

  const removeAttachedDoc = useCallback((index: number) => {
    setAttachedDocs((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ── Submit / Stream ─────────────────────────────────────────────────────────

  const submit = useCallback((characterId?: string, textOverride?: string) => {
    const text = (textOverride ?? input).trim()
    if (!text || isGenerating) return
    // Default to the active companion so chatting from the main composer (which passes
    // no characterId) actually talks to the selected companion, with their persona/voice.
    const charId = characterId ?? getActiveCompanionId() ?? undefined

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setIsGenerating(true)
    setQueuePosition(null)

    // Snapshot + clear attachments — they're persisted to the conversation on this turn.
    const sendAttachments = attachedDocs.map((d) => ({ filename: d.filename, text: d.text }))
    setAttachedDocs([])

    const uiContext = getContextBlock()
    // Placeholder with a temp id; server will confirm the real assistantMessageId via gen event
    const placeholderId = crypto.randomUUID()
    setMessages((prev) => [...prev, { id: placeholderId, role: 'assistant', content: '' }])

    const controller = new AbortController()
    abortRef.current = controller

    const currentConvId = conversationId
    const currentProjectId = currentProjectRef.current?.id ?? undefined

    streamChat(
      { message: text, conversationId: currentConvId ?? undefined, characterId: charId, uiContext, projectId: currentProjectId, attachments: sendAttachments.length ? sendAttachments : undefined },
      controller.signal,
      {
        onGen: ({ genId, conversationId: serverConvId, assistantMessageId }) => {
          // Replace placeholder id with the server-assigned assistantMessageId
          setMessages((prev) =>
            prev.map((m) => m.id === placeholderId ? { ...m, id: assistantMessageId } : m),
          )
          // Persist gen info so we can reconnect after navigation
          const convId = serverConvId ?? currentConvId ?? ''
          pendingGenRef.current = { genId, convId, assistantMsgId: assistantMessageId, lastSeq: 0 }
          savePendingGen(convId, { genId, assistantMessageId, lastSeq: 0 })
          // Add the conversation to the sidebar immediately so it appears before done fires
          if (serverConvId && serverConvId !== currentConvId) {
            setConversationId(serverConvId)
            setConversations((prev) => {
              if (prev.some((c) => c.id === serverConvId)) return prev
              return [{
                id: serverConvId,
                title: 'New conversation',
                preview: '',
                pinned: false,
                projectId: currentProjectId ?? null,
                updatedAt: new Date(),
                createdAt: new Date(),
              }, ...prev]
            })
          }
        },
        onQueue: (position) => {
          setQueuePosition(position > 0 ? position : null)
        },
        onSeq: (seq) => {
          // Track cursor so reconnect can resume from the right spot
          if (pendingGenRef.current) {
            pendingGenRef.current.lastSeq = seq
            const pg = pendingGenRef.current
            savePendingGen(pg.convId, { genId: pg.genId, assistantMessageId: pg.assistantMsgId, lastSeq: seq })
          }
        },
        onRouting: (toolId) => {
          const label = routingLabelFor(toolId)
          if (!label) return
          const msgId = pendingGenRef.current?.assistantMsgId ?? placeholderId
          setMessages((prev) =>
            prev.map((m) => m.id === msgId ? { ...m, routingLabel: label } : m),
          )
        },
        onToken: (token) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? placeholderId
          if (tokenBufRef.current?.msgId === msgId) {
            tokenBufRef.current.text += token
          } else {
            tokenBufRef.current = { text: token, msgId }
          }
          if (tokenRafRef.current === null) {
            tokenRafRef.current = requestAnimationFrame(() => {
              tokenRafRef.current = null
              const buf = tokenBufRef.current
              if (!buf) return
              tokenBufRef.current = null
              setMessages((prev) =>
                prev.map((m) => m.id === buf.msgId ? { ...m, content: m.content + buf.text } : m),
              )
            })
          }
        },
        onBlock: (block) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? placeholderId
          setMessages((prev) =>
            prev.map((m) => m.id === msgId
              ? { ...m, blocks: [...(m.blocks ?? []), block] }
              : m),
          )
        },
        onSources: (sources) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? placeholderId
          setMessages((prev) =>
            prev.map((m) => m.id === msgId ? { ...m, sources } : m),
          )
        },
        onDirective: (directive) => applyDirectiveRef.current(directive),
        onDone: ({ conversationId: newConvId, title }) => {
          // Flush any RAF-buffered tokens before clearing generating state so there's
          // no blank frame where isGenerating=false but content is still empty.
          if (tokenRafRef.current !== null) {
            cancelAnimationFrame(tokenRafRef.current)
            tokenRafRef.current = null
          }
          const doneBuf = tokenBufRef.current
          if (doneBuf) {
            tokenBufRef.current = null
            setMessages((prev) =>
              prev.map((m) => m.id === doneBuf.msgId ? { ...m, content: m.content + doneBuf.text } : m),
            )
          }
          setIsGenerating(false)
          setQueuePosition(null)
          abortRef.current = null
          // Clear the persisted gen — generation is complete
          if (pendingGenRef.current) clearPendingGen(pendingGenRef.current.convId)
          pendingGenRef.current = null
          if (newConvId) {
            setConversations((prev) =>
              prev.map((c) => c.id === newConvId
                ? { ...c, title: title ?? c.title, preview: text, updatedAt: new Date() }
                : c,
              ),
            )
          }
        },
        onError: (err) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? placeholderId
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, content: m.content || `_(Error: ${err})_` } : m,
            ),
          )
          setIsGenerating(false)
          setQueuePosition(null)
          abortRef.current = null
          if (pendingGenRef.current) clearPendingGen(pendingGenRef.current.convId)
          pendingGenRef.current = null
        },
      },
    )
  }, [input, isGenerating, conversationId, getContextBlock, attachedDocs])

  // Re-run the turn that produced `assistantMessageId` in place — same streaming/token
  // buffering pattern as submit() (see its comments), but no new user bubble and no
  // conversation-preview/title update. The server replaces the old reply only once the
  // new one completes, so a failed regenerate leaves the prior answer intact on reload.
  const regenerateMessage = useCallback((assistantMessageId: string) => {
    if (isGenerating || !conversationId) return
    setMessages((prev) => prev.map((m) =>
      m.id === assistantMessageId ? { id: m.id, role: 'assistant', content: '' } : m))
    setIsGenerating(true)
    setQueuePosition(null)

    const controller = new AbortController()
    abortRef.current = controller
    const currentConvId = conversationId

    streamRegenerate(
      { conversationId: currentConvId, assistantMessageId },
      controller.signal,
      {
        onGen: ({ genId, assistantMessageId: newId }) => {
          setMessages((prev) => prev.map((m) => m.id === assistantMessageId ? { ...m, id: newId } : m))
          pendingGenRef.current = { genId, convId: currentConvId, assistantMsgId: newId, lastSeq: 0 }
          savePendingGen(currentConvId, { genId, assistantMessageId: newId, lastSeq: 0 })
        },
        onQueue: (position) => setQueuePosition(position > 0 ? position : null),
        onSeq: (seq) => {
          if (pendingGenRef.current) {
            pendingGenRef.current.lastSeq = seq
            const pg = pendingGenRef.current
            savePendingGen(pg.convId, { genId: pg.genId, assistantMessageId: pg.assistantMsgId, lastSeq: seq })
          }
        },
        onRouting: (toolId) => {
          const label = routingLabelFor(toolId)
          if (!label) return
          const msgId = pendingGenRef.current?.assistantMsgId ?? assistantMessageId
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, routingLabel: label } : m))
        },
        onToken: (token) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? assistantMessageId
          if (tokenBufRef.current?.msgId === msgId) {
            tokenBufRef.current.text += token
          } else {
            tokenBufRef.current = { text: token, msgId }
          }
          if (tokenRafRef.current === null) {
            tokenRafRef.current = requestAnimationFrame(() => {
              tokenRafRef.current = null
              const buf = tokenBufRef.current
              if (!buf) return
              tokenBufRef.current = null
              setMessages((prev) => prev.map((m) => m.id === buf.msgId ? { ...m, content: m.content + buf.text } : m))
            })
          }
        },
        onBlock: (block) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? assistantMessageId
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, blocks: [...(m.blocks ?? []), block] } : m))
        },
        onSources: (sources) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? assistantMessageId
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, sources } : m))
        },
        onDirective: (directive) => applyDirectiveRef.current(directive),
        onDone: () => {
          if (tokenRafRef.current !== null) {
            cancelAnimationFrame(tokenRafRef.current)
            tokenRafRef.current = null
          }
          const doneBuf = tokenBufRef.current
          if (doneBuf) {
            tokenBufRef.current = null
            setMessages((prev) => prev.map((m) => m.id === doneBuf.msgId ? { ...m, content: m.content + doneBuf.text } : m))
          }
          setIsGenerating(false)
          setQueuePosition(null)
          abortRef.current = null
          if (pendingGenRef.current) clearPendingGen(pendingGenRef.current.convId)
          pendingGenRef.current = null
        },
        onError: (err) => {
          const msgId = pendingGenRef.current?.assistantMsgId ?? assistantMessageId
          setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content: m.content || `_(Error: ${err})_` } : m))
          setIsGenerating(false)
          setQueuePosition(null)
          abortRef.current = null
          if (pendingGenRef.current) clearPendingGen(pendingGenRef.current.convId)
          pendingGenRef.current = null
        },
      },
    )
  }, [isGenerating, conversationId])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const pending = pendingGenRef.current
    if (pending) {
      clearPendingGen(pending.convId)
      // Tell the server to actually stop generating and free the queue slot;
      // dropping the SSE connection alone leaves the job running by design.
      fetch(`/api/chat/stream/${pending.genId}/cancel`, { method: 'POST', credentials: 'include' }).catch(() => {})
    }
    pendingGenRef.current = null
    // Flush any buffered tokens immediately so partial content is visible on stop.
    if (tokenRafRef.current !== null) {
      cancelAnimationFrame(tokenRafRef.current)
      tokenRafRef.current = null
    }
    const buf = tokenBufRef.current
    if (buf) {
      tokenBufRef.current = null
      setMessages((prev) =>
        prev.map((m) => m.id === buf.msgId ? { ...m, content: m.content + buf.text } : m),
      )
    }
    setIsGenerating(false)
    setQueuePosition(null)
  }, [])

  // Every sibling context/route re-render otherwise hands consumers a brand-new object
  // (same values, new reference), forcing all ~15 useChatContext() consumers to
  // re-render even when nothing they read actually changed. Deps mirror the object
  // literal exactly, so this recomputes precisely when something in it does.
  const value = useMemo(() => ({
    messages, isGenerating, queuePosition, input, setInput, submit, regenerateMessage, stop,
    attachedDocs, attachDocument, removeAttachedDoc, attachingDoc,
    queuePrompt, pendingAutoPrompt, clearPendingAutoPrompt,
    conversationId, conversations,
    loadConversation, newConversation, deleteConversation, pinConversation, refreshConversations,
    projects, currentProject, setCurrentProject,
    createProject, updateProject, deleteProject, refreshProjects,
  }), [
    messages, isGenerating, queuePosition, input, setInput, submit, regenerateMessage, stop,
    attachedDocs, attachDocument, removeAttachedDoc, attachingDoc,
    queuePrompt, pendingAutoPrompt, clearPendingAutoPrompt,
    conversationId, conversations,
    loadConversation, newConversation, deleteConversation, pinConversation, refreshConversations,
    projects, currentProject, setCurrentProject,
    createProject, updateProject, deleteProject, refreshProjects,
  ])

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChatContext() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider')
  return ctx
}

// ── SSE stream helpers ────────────────────────────────────────────────────────

// Transient "what the assistant is doing" labels, shown while a tool runs before any
// tokens arrive. Tools not listed here just show the plain typing dots.
const ROUTING_LABELS: Record<string, string> = {
  document_edit: '📎 Reading your document',
  search:        '🔎 Searching the web',
  image_gen:     '🎨 Generating an image',
  video_gen:     '🎬 Generating a video',
}

function routingLabelFor(toolId: string): string | null {
  return ROUTING_LABELS[toolId] ?? null
}

interface StreamCallbacks {
  onGen: (meta: { genId: string; conversationId?: string; assistantMessageId: string }) => void
  onQueue: (position: number) => void
  onSeq: (seq: number) => void
  onRouting: (toolId: string) => void
  onToken: (token: string) => void
  onBlock: (block: Block) => void
  onSources: (sources: Source[]) => void
  onDirective: (directive: PlayMediaDirective) => void
  onDone: (meta: { conversationId?: string; title?: string }) => void
  onError: (err: string) => void
}

interface ResumeCallbacks {
  onQueue: (position: number) => void
  onToken: (token: string) => void
  onBlock: (block: Block) => void
  onSources: (sources: Source[]) => void
  onDone: () => void
  onError: () => void
}

/**
 * Parse an SSE stream from a ReadableStream reader.
 * Handles event:, data:, id: lines and dispatches to callbacks.
 */
async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (eventName: string, data: string, id: string | null) => boolean,  // returns true to stop
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []
  let lastId: string | null = null

  function processLines(lines: string[]): boolean {
    for (const line of lines) {
      if (line === '') {
        if (dataLines.length > 0) {
          const data = dataLines.join('\n')
          dataLines = []
          const done = onEvent(eventName, data, lastId)
          if (done) return true
        }
        eventName = 'message'
        lastId = null
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const raw = line.charAt(5) === ' ' ? line.slice(6) : line.slice(5)
        dataLines.push(raw)
      } else if (line.startsWith('id:')) {
        lastId = line.slice(3).trim()
      }
    }
    return false
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      if (buffer) processLines(buffer.split('\n'))
      if (dataLines.length > 0 && eventName === 'token') onEvent('token', dataLines.join('\n'), lastId)
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    if (processLines(lines)) return
  }
}

/** Start a new chat generation (POST). */
async function streamChat(
  body: { message: string; conversationId?: string; characterId?: string; uiContext: string | null; projectId?: string; attachments?: { filename: string; text: string }[] },
  signal: AbortSignal,
  { onGen, onQueue, onSeq, onRouting, onToken, onBlock, onSources, onDirective, onDone, onError }: StreamCallbacks,
) {
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
      signal,
    })
    if (!res.ok) { onError(`HTTP ${res.status}`); return }
    const reader = res.body?.getReader()
    if (!reader) { onError('No response body'); return }

    await consumeSSEStream(reader, (eventName, data, id) => {
      if (id !== null) {
        const seq = parseInt(id, 10)
        if (!isNaN(seq)) onSeq(seq)
      }
      if (eventName === 'gen') {
        try { onGen(JSON.parse(data) as { genId: string; conversationId?: string; assistantMessageId: string }) } catch { /* malformed */ }
      } else if (eventName === 'queue') {
        try { const q = JSON.parse(data) as { position: number }; onQueue(q.position) } catch { /* malformed */ }
      } else if (eventName === 'routing') {
        try { const r = JSON.parse(data) as { tool: string }; if (r.tool) onRouting(r.tool) } catch { /* malformed */ }
      } else if (eventName === 'token') {
        onToken(data)
      } else if (eventName === 'block') {
        try { onBlock(JSON.parse(data) as Block) } catch { /* malformed */ }
      } else if (eventName === 'sources') {
        try { onSources(JSON.parse(data) as Source[]) } catch { /* malformed */ }
      } else if (eventName === 'directive') {
        try { const d = parsePlayDirective(JSON.parse(data)); if (d) onDirective(d) } catch { /* malformed */ }
      } else if (eventName === 'done') {
        try { onDone(JSON.parse(data) as { conversationId?: string; title?: string }) } catch { onDone({}) }
        return true
      } else if (eventName === 'error') {
        onError(data); return true
      } else if (eventName === 'cancelled') {
        onDone({}); return true
      }
      return false
    })

    onDone({})
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      onError((err as Error).message ?? 'Stream failed')
    } else {
      onDone({})
    }
  }
}

/** Re-run the turn behind an existing assistant reply (POST). Same SSE event shape as
 *  streamChat, so it reuses StreamCallbacks — the `gen` event just carries a fresh
 *  assistantMessageId (the client swaps the local id to match) instead of a new one
 *  plus a conversationId. */
async function streamRegenerate(
  body: { conversationId: string; assistantMessageId: string },
  signal: AbortSignal,
  { onGen, onQueue, onSeq, onRouting, onToken, onBlock, onSources, onDirective, onDone, onError }: StreamCallbacks,
) {
  try {
    const res = await fetch('/api/chat/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
      signal,
    })
    if (!res.ok) { onError(`HTTP ${res.status}`); return }
    const reader = res.body?.getReader()
    if (!reader) { onError('No response body'); return }

    await consumeSSEStream(reader, (eventName, data, id) => {
      if (id !== null) {
        const seq = parseInt(id, 10)
        if (!isNaN(seq)) onSeq(seq)
      }
      if (eventName === 'gen') {
        try { onGen(JSON.parse(data) as { genId: string; conversationId?: string; assistantMessageId: string }) } catch { /* malformed */ }
      } else if (eventName === 'queue') {
        try { const q = JSON.parse(data) as { position: number }; onQueue(q.position) } catch { /* malformed */ }
      } else if (eventName === 'routing') {
        try { const r = JSON.parse(data) as { tool: string }; if (r.tool) onRouting(r.tool) } catch { /* malformed */ }
      } else if (eventName === 'token') {
        onToken(data)
      } else if (eventName === 'block') {
        try { onBlock(JSON.parse(data) as Block) } catch { /* malformed */ }
      } else if (eventName === 'sources') {
        try { onSources(JSON.parse(data) as Source[]) } catch { /* malformed */ }
      } else if (eventName === 'directive') {
        try { const d = parsePlayDirective(JSON.parse(data)); if (d) onDirective(d) } catch { /* malformed */ }
      } else if (eventName === 'done') {
        try { onDone(JSON.parse(data) as { conversationId?: string; title?: string }) } catch { onDone({}) }
        return true
      } else if (eventName === 'error') {
        onError(data); return true
      } else if (eventName === 'cancelled') {
        onDone({}); return true
      }
      return false
    })

    onDone({})
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      onError((err as Error).message ?? 'Stream failed')
    } else {
      onDone({})
    }
  }
}

/** Reconnect to an existing in-flight generation (GET). */
async function streamResume(
  genId: string,
  sinceSeq: number,
  signal: AbortSignal,
  { onQueue, onToken, onBlock, onSources, onDone, onError }: ResumeCallbacks,
) {
  try {
    const res = await fetch(`/api/chat/stream/${encodeURIComponent(genId)}?since=${sinceSeq}`, {
      credentials: 'include',
      signal,
    })
    if (!res.ok) { onError(); return }  // 404 = job GC'd, caller falls back to DB
    const reader = res.body?.getReader()
    if (!reader) { onError(); return }

    await consumeSSEStream(reader, (eventName, data) => {
      if (eventName === 'queue') {
        try { const q = JSON.parse(data) as { position: number }; onQueue(q.position) } catch { /* malformed */ }
      } else if (eventName === 'token') {
        onToken(data)
      } else if (eventName === 'block') {
        try { onBlock(JSON.parse(data) as Block) } catch { /* malformed */ }
      } else if (eventName === 'sources') {
        try { onSources(JSON.parse(data) as Source[]) } catch { /* malformed */ }
      } else if (eventName === 'done' || eventName === 'cancelled') {
        onDone(); return true
      } else if (eventName === 'error') {
        onError(); return true
      }
      return false
    })

    onDone()
  } catch (err) {
    if ((err as Error).name !== 'AbortError') onError()
    else onDone()
  }
}
