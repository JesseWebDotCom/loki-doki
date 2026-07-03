// Companion coding tool: lets chat kick off a task in the user's sandboxed OpenCode
// workspace, but never approves file edits or shell commands on its own: that's the
// deliberate "chat starts it, app approves" contract. Every household member's
// workspace and its sessions are entirely managed by OpenCode's own web UI (open the
// Coding app to review): this tool has no project/session bookkeeping of its own.

import type { Tool, ToolResult } from './index'
import { getUserWorkspace, markWorkspaceBusy } from '@/lib/codingServer'
import { isOpenCodeInstalled } from '@/lib/opencode'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

interface CodingArgs { task?: string }

// The coding turn is fired async (prompt_async) and runs in the background needing
// approval, so — especially when the request came by voice with no chat/Coding app
// open — the user needs a nudge when there's something to review. Poll the session's
// message list until it stops growing (API-shape-agnostic: just needs a JSON array),
// then drop a bell notification linking to the Coding app. Best-effort + bounded:
// any error or timeout just stops quietly (no false notifications).
async function watchCodingCompletion(url: string, authHeader: string, sessionId: string, userId: string): Promise<void> {
  const deadline = Date.now() + 5 * 60_000
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let lastCount = -1, stable = 0, grew = false
  while (Date.now() < deadline) {
    await sleep(4_000)
    let count: number
    try {
      const r = await fetch(`${url}/session/${sessionId}/message`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!r.ok) return
      const body = await r.json() as unknown
      const arr = Array.isArray(body) ? body
        : Array.isArray((body as { messages?: unknown }).messages) ? (body as { messages: unknown[] }).messages
        : Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data
        : null
      if (!arr) return
      count = arr.length
    } catch { return }
    if (count > lastCount) { grew = true; stable = 0 } else if (count === lastCount) { stable++ }
    lastCount = count
    // Grew (agent produced output) then held steady for ~8s → the turn has settled.
    if (grew && stable >= 2 && count > 0) {
      await emitNotification({
        type: 'system',
        userId,
        title: 'Coding update',
        body: 'The coding agent finished working — open the Coding app to review and approve changes.',
        url: '/coding',
        dedupeKey: `coding-done:${sessionId}`,
      }).catch(() => {})
      return
    }
  }
}

async function execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
  const { task } = (args ?? {}) as CodingArgs
  const userId = config?._userId as string | undefined
  if (!userId) return { success: false, error: 'Coding tasks need a signed-in user.' }
  if (!task?.trim()) return { success: false, error: 'What should the coding agent do?' }
  if (!isOpenCodeInstalled()) {
    return { success: true, directReply: "Coding isn't installed yet. An admin can turn it on in Admin → Features." }
  }

  try {
    const { url, authHeader } = await getUserWorkspace(userId)
    markWorkspaceBusy(userId, true)
    try {
      // Accept is load-bearing: without it the server's content negotiation falls
      // back to serving its own web UI's HTML shell instead of a real JSON response.
      const sessionRes = await fetch(`${url}/session`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title: task.slice(0, 60) }),
      })
      if (!sessionRes.ok) throw new Error(`opencode session create failed: ${sessionRes.status}`)
      const session = await sessionRes.json() as { id: string }

      // prompt_async, not the synchronous /message: that endpoint blocks server-side
      // until the whole turn finishes, including waiting out a mid-turn permission
      // approval nobody's watching for from a background chat-triggered task.
      const res = await fetch(`${url}/session/${session.id}/prompt_async`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: task }] }),
      })
      if (!res.ok) throw new Error(`opencode message failed: ${res.status}`)

      // Background: nudge the user (bell → Coding app) once the agent settles, since
      // the work runs async and may need approval — the key signal when the request
      // came by voice with no chat/Coding app open. Detached; never blocks the reply.
      void watchCodingCompletion(url, authHeader, session.id, userId)
        .catch((e) => logger.warn(`[coding] completion watcher failed: ${e}`))
    } finally {
      markWorkspaceBusy(userId, false)
    }

    // Deliberately no result summary here: file edits/commands may still be pending
    // approval, so "review in the Coding app" is the only accurate thing to say.
    return {
      success: true,
      directReply: "I've started on that in the Coding app. Open it to review and approve any file changes or commands.",
    }
  } catch {
    return { success: false, error: "I couldn't reach the coding agent. Check that its sidecar is running in Admin → Features." }
  }
}

export const codingTool: Tool = {
  id: 'coding',
  name: 'Coding',
  description: 'Kick off a MULTI-FILE coding project — build/scaffold a whole app, or work across an existing codebase (fix bugs, add features, refactor, run commands) — in your sandboxed workspace. File edits and shell commands pause for approval in the Coding app. For a single standalone snippet/file, use Canvas instead.',
  examples: [
    'build me a simple todo app',
    'scaffold a new express project with a database',
    'add a login page to my project',
    'fix the failing tests in my repo',
    'refactor the auth module in my codebase',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'coding',
      description: 'Start a MULTI-FILE coding project or work on an existing codebase with the sandboxed coding agent. Not for a single self-contained snippet or file (use the canvas tool for that).',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to build, fix, or explain' },
        },
        required: ['task'],
      },
    },
  },
  offline: true,
  passMessage: 'task',
  dataSources: [],
  execute,
}
