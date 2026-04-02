import React, { useEffect, useState } from "react"
import { Brain, MessageSquareText, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react"

import { Button } from "./ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"

export interface UserMemoryFact {
  character_id: string
  character_name: string
  key: string
  value: string
  confidence: number
  source: string
  updated_at: string
}

export interface HouseholdMemoryFact {
  key: string
  value: string
  updated_at: string
  node_id: string
}

export interface SessionMemoryFact {
  scope: "session"
  chat_id: string
  key: string
  value: string
  updated_at: string
}

interface MemoryContextPayload {
  context: {
    session: string
    long_term: string
    combined: string
  }
  recent_activity: Array<{
    scope: string
    operation: string
    key: string
    value: string
    source: string
    character_id: string
    timestamp: string
  }>
  recent_promoted_facts: Array<{
    key: string
    value: string
    confidence: number
  }>
  stats: {
    session_count: number
    person_count: number
    household_count: number
    session_applied: boolean
    long_term_applied: boolean
  }
}

interface MemoryManagementPanelProps {
  isAdmin?: boolean
  activeChatId?: string
  activeCharacterId?: string
  token?: string
}

interface SettingsChatStatePayload {
  active_chat_id?: string
  chats?: Array<{
    id: string
    title?: string
  }>
}

interface ChatOption {
  id: string
  title: string
}

interface EditingMemoryState {
  scope: "session" | "person"
  key: string
  value: string
  characterId?: string
}

function personMemorySourceLabel(source: string): string {
  if (source === "extracted") {
    return "extracted"
  }
  if (source === "explicit") {
    return "explicit"
  }
  if (source === "api") {
    return "api"
  }
  return source || "unknown"
}

function formatMemoryTimestamp(value: string): string {
  if (!value) {
    return ""
  }
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return value
  }
  return timestamp.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function sessionMemoryLabel(key: string): string {
  if (key === "summary:session") {
    return "Session summary"
  }
  if (key === "summary:latest_user") {
    return "Latest user goal"
  }
  if (key.startsWith("recent:") && key.endsWith(":user")) {
    return "Recent user turn"
  }
  if (key.startsWith("recent:") && key.endsWith(":assistant")) {
    return "Recent assistant turn"
  }
  return "Session memory"
}

function sessionMemoryBadge(key: string): string {
  if (key.startsWith("summary:")) {
    return "summary"
  }
  if (key.startsWith("recent:") && key.endsWith(":user")) {
    return "user"
  }
  if (key.startsWith("recent:") && key.endsWith(":assistant")) {
    return "assistant"
  }
  return key
}

function suggestionKeyFromSession(memory: SessionMemoryFact): string {
  if (memory.key === "summary:latest_user") {
    return "latest_user_goal"
  }
  if (memory.key.startsWith("recent:") && memory.key.endsWith(":user")) {
    return "remembered_user_note"
  }
  if (memory.key.startsWith("recent:") && memory.key.endsWith(":assistant")) {
    return "remembered_assistant_note"
  }
  return memory.key.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "remembered_fact"
}

export function MemoryManagementPanel({
  isAdmin = false,
  activeChatId = "",
  activeCharacterId = "",
  token = "",
}: MemoryManagementPanelProps) {
  const [activeTab, setActiveTab] = useState<"session" | "user" | "household">(activeChatId ? "session" : "user")
  const [chatOptions, setChatOptions] = useState<ChatOption[]>([])
  const [selectedChatId, setSelectedChatId] = useState("")
  const [selectedCharacterFilter, setSelectedCharacterFilter] = useState("all")
  const [resolvedChatId, setResolvedChatId] = useState("")
  const [resolvedChatTitle, setResolvedChatTitle] = useState("")
  const [userMemories, setUserMemories] = useState<UserMemoryFact[]>([])
  const [householdMemories, setHouseholdMemories] = useState<HouseholdMemoryFact[]>([])
  const [sessionMemories, setSessionMemories] = useState<SessionMemoryFact[]>([])
  const [memoryContext, setMemoryContext] = useState<MemoryContextPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [chatOptionsLoading, setChatOptionsLoading] = useState(true)
  const [newSessionKey, setNewSessionKey] = useState("")
  const [newSessionValue, setNewSessionValue] = useState("")
  const [newPersonKey, setNewPersonKey] = useState("")
  const [newPersonValue, setNewPersonValue] = useState("")
  const [newHouseholdKey, setNewHouseholdKey] = useState("")
  const [newHouseholdValue, setNewHouseholdValue] = useState("")
  const [autoSelectedSession, setAutoSelectedSession] = useState(false)
  const [editingMemory, setEditingMemory] = useState<EditingMemoryState | null>(null)

  const effectiveChatId = selectedChatId || activeChatId || resolvedChatId
  const visibleChatOptions = chatOptions.length
    ? chatOptions
    : effectiveChatId
      ? [{ id: effectiveChatId, title: resolvedChatTitle || "Current chat" }]
      : []
  const characterOptions = Array.from(
    new Map(
      userMemories.map((memory) => [
        memory.character_id,
        { id: memory.character_id, name: memory.character_name || memory.character_id },
      ]),
    ).values(),
  )
  const filteredUserMemories = selectedCharacterFilter === "all"
    ? userMemories
    : userMemories.filter((memory) => memory.character_id === selectedCharacterFilter)

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}

  const resolveActiveChat = async (): Promise<{ chatId: string; chatTitle: string }> => {
    setChatOptionsLoading(true)
    try {
      const res = await fetch("/api/settings", { headers: authHeaders })
      const result = (await res.json()) as SettingsChatStatePayload
      const nextOptions = Array.isArray(result.chats)
        ? result.chats.map((chat) => ({
            id: String(chat.id),
            title: String(chat.title || "Untitled chat"),
          }))
        : []
      setChatOptions(nextOptions)
      const defaultChatId = String(result.active_chat_id || "")
      const nextChatId = selectedChatId || activeChatId || defaultChatId
      const matchingChat = nextOptions.find((chat) => chat.id === nextChatId)
      setResolvedChatId(nextChatId)
      const nextChatTitle = String(matchingChat?.title || "")
      setResolvedChatTitle(nextChatTitle)
      setChatOptionsLoading(false)
      return { chatId: nextChatId, chatTitle: nextChatTitle }
    } catch (err) {
      console.error("Failed to resolve active chat", err)
      setChatOptions([])
      setResolvedChatId("")
      setResolvedChatTitle("")
      setChatOptionsLoading(false)
      return { chatId: "", chatTitle: "" }
    }
  }

  const fetchSessionMemories = async (chatId: string) => {
    if (!chatId) {
      setSessionMemories([])
      return
    }
    try {
      const params = new URLSearchParams({
        scope: "session",
        chat_id: chatId,
      })
      const res = await fetch(`/api/memory?${params.toString()}`, { headers: authHeaders })
      const result = await res.json()
      if (result.ok) {
        setSessionMemories(result.memories)
      }
    } catch (err) {
      console.error("Failed to load session memories", err)
    }
  }

  const fetchMemoryContext = async (chatId: string) => {
    try {
      const params = new URLSearchParams()
      if (chatId) {
        params.set("chat_id", chatId)
      }
      if (activeCharacterId) {
        params.set("character_id", activeCharacterId)
      }
      const suffix = params.toString() ? `?${params.toString()}` : ""
      const res = await fetch(`/api/memory/context${suffix}`, { headers: authHeaders })
      const result = await res.json()
      if (result.ok) {
        setMemoryContext({
          context: result.context,
          recent_activity: result.recent_activity || [],
          recent_promoted_facts: result.recent_promoted_facts || [],
          stats: result.stats,
        })
      }
    } catch (err) {
      console.error("Failed to load memory context", err)
    }
  }

  const fetchUserMemories = async () => {
    try {
      const res = await fetch("/api/memory/user", { headers: authHeaders })
      const result = await res.json()
      if (result.ok) {
        setUserMemories(result.memories)
      }
    } catch (err) {
      console.error("Failed to load user memories", err)
    }
  }

  const fetchHouseholdMemories = async () => {
    try {
      const res = await fetch("/api/memory/household", { headers: authHeaders })
      const result = await res.json()
      if (result.ok) {
        setHouseholdMemories(result.memories)
      }
    } catch (err) {
      console.error("Failed to load household memories", err)
    }
  }

  const refreshMemories = async () => {
    setLoading(true)
    const { chatId: nextChatId } = await resolveActiveChat()
    await Promise.all([
      fetchSessionMemories(nextChatId),
      fetchUserMemories(),
      fetchMemoryContext(nextChatId),
      isAdmin ? fetchHouseholdMemories() : Promise.resolve(),
    ])
    setLoading(false)
  }

  useEffect(() => {
    if (!effectiveChatId && activeTab === "session") {
      setActiveTab("user")
    }
  }, [effectiveChatId, activeTab])

  useEffect(() => {
    if (activeChatId) {
      setSelectedChatId(activeChatId)
      setResolvedChatId(activeChatId)
      setResolvedChatTitle((current) => current || "Current chat")
    }
  }, [activeChatId])

  useEffect(() => {
    if (effectiveChatId && !autoSelectedSession) {
      setActiveTab("session")
      setAutoSelectedSession(true)
    }
  }, [effectiveChatId, autoSelectedSession])

  useEffect(() => {
    if (activeCharacterId && characterOptions.some((option) => option.id === activeCharacterId)) {
      setSelectedCharacterFilter(activeCharacterId)
      return
    }
    if (selectedCharacterFilter !== "all" && !characterOptions.some((option) => option.id === selectedCharacterFilter)) {
      setSelectedCharacterFilter("all")
    }
  }, [activeCharacterId, characterOptions, selectedCharacterFilter])

  useEffect(() => {
    void refreshMemories()
  }, [activeChatId, selectedChatId, activeCharacterId, isAdmin])

  const deleteSessionMemory = async (key: string) => {
    if (!effectiveChatId) return
    try {
      const params = new URLSearchParams({
        scope: "session",
        key,
        chat_id: effectiveChatId,
      })
      const res = await fetch(`/api/memory?${params.toString()}`, { method: "DELETE", headers: authHeaders })
      const result = await res.json()
      if (result.ok) {
        setSessionMemories(result.memories)
      }
    } catch (err) {
      console.error("Delete failed", err)
    }
  }

  const deleteUserMemory = async (characterId: string, key: string) => {
    try {
      const res = await fetch(`/api/memory/user/${encodeURIComponent(characterId)}/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: authHeaders,
      })
      const result = await res.json()
      if (result.ok) {
        setUserMemories(result.memories)
      }
    } catch (err) {
      console.error("Delete failed", err)
    }
  }

  const deleteHouseholdMemory = async (key: string) => {
    try {
      const res = await fetch(`/api/memory/household/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: authHeaders,
      })
      const result = await res.json()
      if (result.ok) {
        setHouseholdMemories(result.memories)
      }
    } catch (err) {
      console.error("Delete failed", err)
    }
  }

  const addHouseholdMemory = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!newHouseholdKey.trim() || !newHouseholdValue.trim()) return
    try {
      const res = await fetch("/api/memory/household", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ key: newHouseholdKey.trim(), value: newHouseholdValue.trim() }),
      })
      const result = await res.json()
      if (result.ok) {
        setHouseholdMemories(result.memories)
        setNewHouseholdKey("")
        setNewHouseholdValue("")
      }
    } catch (err) {
      console.error("Failed to add household memory", err)
    }
  }

  const addSessionMemory = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!effectiveChatId || !newSessionKey.trim() || !newSessionValue.trim()) return
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          scope: "session",
          key: newSessionKey.trim(),
          value: newSessionValue.trim(),
          chat_id: effectiveChatId,
        }),
      })
      const result = await res.json()
      if (result.ok) {
        setSessionMemories(result.memories)
        setNewSessionKey("")
        setNewSessionValue("")
        await fetchMemoryContext(effectiveChatId)
      }
    } catch (err) {
      console.error("Failed to add session memory", err)
    }
  }

  const addPersonMemory = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!activeCharacterId || !newPersonKey.trim() || !newPersonValue.trim()) return
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          scope: "person",
          key: newPersonKey.trim(),
          value: newPersonValue.trim(),
          character_id: activeCharacterId,
        }),
      })
      const result = await res.json()
      if (result.ok) {
        setUserMemories(result.memories)
        setNewPersonKey("")
        setNewPersonValue("")
        await fetchMemoryContext(effectiveChatId)
      }
    } catch (err) {
      console.error("Failed to add personal memory", err)
    }
  }

  const saveEditedMemory = async () => {
    if (!editingMemory || !editingMemory.value.trim()) return
    try {
      const payload: Record<string, string> = {
        scope: editingMemory.scope,
        key: editingMemory.key,
        value: editingMemory.value.trim(),
      }
      if (editingMemory.scope === "session") {
        if (!effectiveChatId) return
        payload.chat_id = effectiveChatId
      }
      if (editingMemory.scope === "person" && editingMemory.characterId) {
        payload.character_id = editingMemory.characterId
      }
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(payload),
      })
      const result = await res.json()
      if (!result.ok) {
        return
      }
      if (editingMemory.scope === "session") {
        setSessionMemories(result.memories)
      } else {
        setUserMemories(result.memories)
      }
      setEditingMemory(null)
      await fetchMemoryContext(effectiveChatId)
    } catch (err) {
      console.error("Failed to save edited memory", err)
    }
  }

  return (
    <Card className="border-white/8 bg-zinc-950/96 text-zinc-100 shadow-2xl">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              Memory
            </CardTitle>
            <div className="mt-1 text-sm text-zinc-500">
              Inspect what LokiDoki stored for this chat, for you, and for the household.
            </div>
            {effectiveChatId ? (
              <div className="mt-2 text-xs text-zinc-500">
                Inspecting session memory for {resolvedChatTitle ? `"${resolvedChatTitle}"` : effectiveChatId}.
              </div>
            ) : null}
            <div className="mt-3 max-w-md">
              <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                Session Memory Chat
              </label>
              <select
                className="flex h-10 w-full rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                disabled={visibleChatOptions.length === 0}
                onChange={(event) => {
                  setSelectedChatId(event.target.value)
                  setActiveTab("session")
                }}
                value={effectiveChatId}
              >
                {visibleChatOptions.length === 0 ? (
                  <option value="">
                    {chatOptionsLoading ? "Loading chats..." : "No chats available"}
                  </option>
                ) : null}
                {visibleChatOptions.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Button className="h-9 rounded-full px-3 text-xs" onClick={() => void refreshMemories()} type="button" variant="outline">
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
        <div className="flex max-w-xl rounded-xl bg-white/[0.04] p-1">
          <button
            className={`flex-1 rounded-lg px-3 py-2 text-sm transition ${activeTab === "session" ? "bg-white/[0.09] text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
            onClick={() => setActiveTab("session")}
            type="button"
          >
            Chat Sessions
          </button>
          <button
            className={`flex-1 rounded-lg px-3 py-2 text-sm transition ${activeTab === "user" ? "bg-white/[0.09] text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
            onClick={() => setActiveTab("user")}
            type="button"
          >
            My Memory
          </button>
          {isAdmin ? (
            <button
              className={`flex-1 rounded-lg px-3 py-2 text-sm transition ${activeTab === "household" ? "bg-white/[0.09] text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
              onClick={() => setActiveTab("household")}
              type="button"
            >
              Household
            </button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-5 sm:p-6">
        {memoryContext ? (
          <div className="grid gap-3 lg:grid-cols-5">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Session entries</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{memoryContext.stats.session_count}</div>
              <div className="mt-1 text-xs text-zinc-500">{memoryContext.stats.session_applied ? "Injected into active chat" : "Not injected right now"}</div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Personal entries</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{memoryContext.stats.person_count}</div>
              <div className="mt-1 text-xs text-zinc-500">{memoryContext.stats.long_term_applied ? "Available to prompt injection" : "No long-term memory active"}</div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Household entries</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{memoryContext.stats.household_count}</div>
              <div className="mt-1 text-xs text-zinc-500">Shared across the local environment</div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 lg:col-span-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Current injection status</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className={`rounded-full px-3 py-1 text-xs ${memoryContext.stats.session_applied ? "bg-cyan-500/15 text-cyan-200" : "bg-white/[0.05] text-zinc-500"}`}>
                  Session {memoryContext.stats.session_applied ? "applied" : "idle"}
                </span>
                <span className={`rounded-full px-3 py-1 text-xs ${memoryContext.stats.long_term_applied ? "bg-cyan-500/15 text-cyan-200" : "bg-white/[0.05] text-zinc-500"}`}>
                  Long-term {memoryContext.stats.long_term_applied ? "applied" : "idle"}
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {memoryContext ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 lg:col-span-2">
              <div className="text-sm font-medium text-zinc-100">Recent Memory Activity</div>
              <div className="mt-1 text-xs text-zinc-500">
                Latest durable-memory writes and deletes recorded through the local sync queue.
              </div>
              {memoryContext.recent_activity.length === 0 ? (
                <div className="mt-3 rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-500">
                  No recent durable-memory activity yet.
                </div>
              ) : (
                <div className="mt-3 grid gap-2">
                  {memoryContext.recent_activity.map((item, index) => (
                    <div key={`${item.key}-${item.timestamp}-${index}`} className="rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-300">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-zinc-100">{item.key}</span>
                        <span className="rounded-md bg-white/[0.06] px-2 py-0.5 uppercase tracking-[0.12em] text-zinc-400">
                          {item.scope}
                        </span>
                        <span className="rounded-md bg-white/[0.06] px-2 py-0.5 uppercase tracking-[0.12em] text-zinc-400">
                          {item.operation}
                        </span>
                        {item.source ? (
                          <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 uppercase tracking-[0.12em] text-cyan-200">
                            {item.source}
                          </span>
                        ) : null}
                      </div>
                      {item.value ? <div className="mt-1 whitespace-pre-wrap break-words">{item.value}</div> : null}
                      <div className="mt-1 text-zinc-500">{formatMemoryTimestamp(item.timestamp)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 lg:col-span-2">
              <div className="text-sm font-medium text-zinc-100">Recent Promoted Facts</div>
              <div className="mt-1 text-xs text-zinc-500">
                These are the latest durable facts automatically promoted from the selected chat into personal memory.
              </div>
              {memoryContext.recent_promoted_facts.length === 0 ? (
                <div className="mt-3 rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-500">
                  No facts were recently promoted from this chat.
                </div>
              ) : (
                <div className="mt-3 grid gap-2">
                  {memoryContext.recent_promoted_facts.map((fact, index) => (
                    <div key={`${fact.key}-${index}`} className="rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-300">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-zinc-100">{fact.key}</span>
                        <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-cyan-200">
                          {Math.round(Number(fact.confidence || 0) * 100)}%
                        </span>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-words">{fact.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-zinc-100">Exact Session Block</div>
              <div className="mt-1 text-xs text-zinc-500">This is the active chat memory block available to the next reply.</div>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-300">
                {memoryContext.context.session || "No session block for the active chat."}
              </pre>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-zinc-100">Exact Long-Term Block</div>
              <div className="mt-1 text-xs text-zinc-500">This is the personal and household memory block available to the next reply.</div>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-300">
                {memoryContext.context.long_term || "No long-term memory block for the active selection."}
              </pre>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 lg:col-span-2">
              <div className="text-sm font-medium text-zinc-100">Combined Injected Context</div>
              <div className="mt-1 text-xs text-zinc-500">This is the exact combined memory payload the chat helpers can append to the next prompt.</div>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-white/8 bg-zinc-950/80 p-3 text-xs text-zinc-300">
                {memoryContext.context.combined || "No combined memory context is currently available."}
              </pre>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="flex h-32 items-center justify-center text-zinc-500">Loading memories...</div>
        ) : null}

        {!loading && activeTab === "session" ? (
          <div className="grid gap-3">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-zinc-100">Choose Chat</div>
              <div className="mt-1 text-xs text-zinc-500">
                Pick any saved chat to inspect its session memory and injected context.
              </div>
              <select
                className="mt-3 flex h-10 w-full rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                disabled={visibleChatOptions.length === 0}
                onChange={(event) => setSelectedChatId(event.target.value)}
                value={effectiveChatId}
              >
                {visibleChatOptions.length === 0 ? (
                  <option value="">
                    {chatOptionsLoading ? "Loading chats..." : "No chats available"}
                  </option>
                ) : null}
                {visibleChatOptions.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.title}
                  </option>
                ))}
              </select>
            </div>
            <form className="flex gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3" onSubmit={addSessionMemory}>
              <input
                className="flex h-10 flex-1 rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setNewSessionKey(event.target.value)}
                placeholder="e.g. topic_focus"
                value={newSessionKey}
              />
              <input
                className="flex h-10 flex-1 rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setNewSessionValue(event.target.value)}
                placeholder="e.g. Everybody Loves Raymond"
                value={newSessionValue}
              />
              <Button
                className="h-10 shrink-0 rounded-full px-4 text-xs"
                disabled={!effectiveChatId || !newSessionKey.trim() || !newSessionValue.trim()}
                type="submit"
                variant="outline"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Session Memory
              </Button>
            </form>
            {!effectiveChatId ? (
              <p className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-center text-sm italic text-zinc-500">
                Open a chat first to inspect session memory.
              </p>
            ) : sessionMemories.length === 0 ? (
              <p className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-center text-sm italic text-zinc-500">
                No session memory has been stored for this chat yet.
              </p>
            ) : (
              sessionMemories.map((memory) => (
                <div key={`${memory.chat_id}-${memory.key}`} className="flex items-start justify-between rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="min-w-0 flex-1 space-y-2 pr-6">
                    <div className="flex items-center gap-2">
                      <MessageSquareText className="h-4 w-4 text-cyan-300" />
                      <span className="text-sm font-medium text-zinc-100">{sessionMemoryLabel(memory.key)}</span>
                      <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">
                        {sessionMemoryBadge(memory.key)}
                      </span>
                    </div>
                    {editingMemory?.scope === "session" && editingMemory.key === memory.key ? (
                      <div className="space-y-2">
                        <textarea
                          className="flex min-h-[96px] w-full rounded-xl border border-white/8 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 shadow-sm outline-none"
                          onChange={(event) => setEditingMemory({ ...editingMemory, value: event.target.value })}
                          value={editingMemory.value}
                        />
                        <div className="flex gap-2">
                          <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void saveEditedMemory()} type="button" variant="outline">
                            Save
                          </Button>
                          <Button className="h-8 rounded-full px-3 text-xs" onClick={() => setEditingMemory(null)} type="button" variant="ghost">
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words text-sm text-zinc-300">{memory.value}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      className="h-8 w-8 rounded-full text-emerald-300 hover:bg-emerald-500/10"
                      onClick={() => {
                        setNewPersonKey(suggestionKeyFromSession(memory))
                        setNewPersonValue(memory.value)
                        setActiveTab("user")
                      }}
                      size="icon"
                      title="Copy to personal memory"
                      type="button"
                      variant="ghost"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                      className="h-8 w-8 rounded-full text-cyan-300 hover:bg-cyan-500/10"
                      onClick={() => setEditingMemory({ scope: "session", key: memory.key, value: memory.value })}
                      size="icon"
                      title="Edit session memory"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      className="h-8 w-8 rounded-full text-rose-300 hover:bg-rose-500/10"
                      onClick={() => deleteSessionMemory(memory.key)}
                      size="icon"
                      title="Delete session memory"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {!loading && activeTab === "user" ? (
          <div className="grid gap-3">
            <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="text-sm font-medium text-zinc-100">Filter Character</div>
              <div className="mt-1 text-xs text-zinc-500">
                Narrow personal memory to one character or inspect all extracted facts together.
              </div>
              <select
                className="mt-3 flex h-10 w-full rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setSelectedCharacterFilter(event.target.value)}
                value={selectedCharacterFilter}
              >
                <option value="all">All characters</option>
                {characterOptions.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
            </div>
            <form className="flex gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3" onSubmit={addPersonMemory}>
              <input
                className="flex h-10 flex-1 rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setNewPersonKey(event.target.value)}
                placeholder="e.g. favorite_show"
                value={newPersonKey}
              />
              <input
                className="flex h-10 flex-1 rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setNewPersonValue(event.target.value)}
                placeholder="e.g. Everybody Loves Raymond"
                value={newPersonValue}
              />
              <Button
                className="h-10 shrink-0 rounded-full px-4 text-xs"
                disabled={!activeCharacterId || !newPersonKey.trim() || !newPersonValue.trim()}
                type="submit"
                variant="outline"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Personal Memory
              </Button>
            </form>
            {filteredUserMemories.length === 0 ? (
              <p className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-center text-sm italic text-zinc-500">
                No personal memories have been stored yet.
              </p>
            ) : (
              filteredUserMemories.map((memory) => (
                <div key={`${memory.character_id}-${memory.key}`} className="flex items-start justify-between rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="min-w-0 flex-1 space-y-2 pr-6">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-cyan-300">{memory.character_name} remembers</span>
                      <span className="rounded-md bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">
                        {Math.round(memory.confidence * 100)}%
                      </span>
                      <span className={`rounded-md px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${memory.source === "extracted" ? "bg-cyan-500/15 text-cyan-200" : "bg-white/[0.06] text-zinc-400"}`}>
                        {personMemorySourceLabel(memory.source)}
                      </span>
                    </div>
                    {editingMemory?.scope === "person" && editingMemory.key === memory.key && editingMemory.characterId === memory.character_id ? (
                      <div className="space-y-2">
                        <div className="text-sm text-zinc-300">
                          <span className="font-semibold text-zinc-100">{memory.key}</span>
                        </div>
                        <textarea
                          className="flex min-h-[96px] w-full rounded-xl border border-white/8 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 shadow-sm outline-none"
                          onChange={(event) => setEditingMemory({ ...editingMemory, value: event.target.value })}
                          value={editingMemory.value}
                        />
                        <div className="flex gap-2">
                          <Button className="h-8 rounded-full px-3 text-xs" onClick={() => void saveEditedMemory()} type="button" variant="outline">
                            Save
                          </Button>
                          <Button className="h-8 rounded-full px-3 text-xs" onClick={() => setEditingMemory(null)} type="button" variant="ghost">
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-zinc-300">
                        <span className="font-semibold text-zinc-100">{memory.key}</span> = {memory.value}
                      </div>
                    )}
                    <div className="text-xs text-zinc-500">
                      Saved {formatMemoryTimestamp(memory.updated_at)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      className="h-8 w-8 rounded-full text-cyan-300 hover:bg-cyan-500/10"
                      onClick={() => setEditingMemory({ scope: "person", key: memory.key, value: memory.value, characterId: memory.character_id })}
                      size="icon"
                      title="Edit personal memory"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      className="h-8 w-8 rounded-full text-rose-300 hover:bg-rose-500/10"
                      onClick={() => deleteUserMemory(memory.character_id, memory.key)}
                      size="icon"
                      title="Delete personal memory"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {!loading && activeTab === "household" ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-amber-900/40 bg-amber-950/20 p-3 text-xs font-medium text-amber-200">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              Household memory is shared across the local environment.
            </div>

            <form className="flex gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-3" onSubmit={addHouseholdMemory}>
              <input
                className="flex h-10 flex-1 rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setNewHouseholdKey(event.target.value)}
                placeholder="e.g. pizza_night"
                value={newHouseholdKey}
              />
              <input
                className="flex h-10 flex-1 rounded-xl border border-white/8 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none"
                onChange={(event) => setNewHouseholdValue(event.target.value)}
                placeholder="e.g. Tuesday"
                value={newHouseholdValue}
              />
              <Button className="h-10 shrink-0 rounded-full px-4 text-xs" disabled={!newHouseholdKey.trim() || !newHouseholdValue.trim()} type="submit" variant="outline">
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </form>

            {householdMemories.length === 0 ? (
              <p className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-center text-sm italic text-zinc-500">
                No household memories have been stored yet.
              </p>
            ) : (
              householdMemories.map((memory) => (
                <div key={memory.key} className="flex items-start justify-between rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="min-w-0 flex-1 space-y-1 pr-6">
                    <div className="text-sm font-medium text-cyan-300">Shared household memory</div>
                    <div className="text-sm text-zinc-300">
                      <span className="font-semibold text-zinc-100">{memory.key}</span> = {memory.value}
                    </div>
                  </div>
                  <Button
                    className="h-8 w-8 shrink-0 rounded-full text-rose-300 hover:bg-rose-500/10"
                    onClick={() => deleteHouseholdMemory(memory.key)}
                    size="icon"
                    title="Delete household memory"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
