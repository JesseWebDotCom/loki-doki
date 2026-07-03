// Companion coding tool: lets chat kick off a task in the user's sandboxed OpenCode
// workspace, but never approves file edits or shell commands on its own: that's the
// deliberate "chat starts it, app approves" contract. Every household member's
// workspace and its sessions are entirely managed by OpenCode's own web UI (open the
// Coding app to review): this tool has no project/session bookkeeping of its own.

import type { Tool, ToolResult } from './index'
import { getUserWorkspace, markWorkspaceBusy } from '@/lib/codingServer'
import { isOpenCodeInstalled } from '@/lib/opencode'

interface CodingArgs { task?: string }

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
  description: 'Kick off a coding task (build/fix/explain code) in your sandboxed workspace. File edits and shell commands always pause for approval in the Coding app.',
  examples: [
    'build me a simple todo app',
    'fix the bug in my script',
    'write a python function to parse CSV files',
    'set up a basic Express server',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'coding',
      description: 'Start a coding task with the local coding agent, running in a sandboxed workspace.',
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
