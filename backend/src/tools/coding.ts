// Companion coding tool: lets chat kick off a task in the user's sandboxed Claude
// Code workspace. Runs as a separate, one-shot HEADLESS invocation (`claude -p`),
// independent of the user's own live interactive tmux session (see codingServer.ts) —
// this avoids fighting over control of the same pane. It auto-accepts edits/commands
// (no interactive prompt is possible in headless mode) because the OS-user sandbox
// already contains the blast radius to that user's own workspace; the tradeoff is that
// this activity isn't visible in the terminal until it finishes, only the completion
// notification is.

import { spawn } from 'node:child_process'
import type { Tool, ToolResult } from './index'
import { buildHeadlessClaudeCommand } from '@/lib/codingServer'
import { isClaudeCodeInstalled } from '@/lib/claudeCode'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

interface CodingArgs { task?: string }

const TASK_TIMEOUT_MS = 5 * 60_000

interface ClaudeJsonResult { result?: string; is_error?: boolean }

async function runHeadlessTask(userId: string, task: string): Promise<void> {
  const { bin, args, cwd } = await buildHeadlessClaudeCommand(userId, task)
  let stdout = ''
  let stderr = ''
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* already gone */ } }, TASK_TIMEOUT_MS)
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
  })

  let summary = 'The coding agent finished working — open the Coding app to review the result.'
  try {
    const parsed = JSON.parse(stdout) as ClaudeJsonResult
    if (parsed.result) summary = parsed.result.slice(0, 500)
  } catch {
    // Non-JSON output (a crash before Claude Code could emit its own JSON envelope) —
    // fall back to the generic message; stderr still gets logged below for debugging.
  }
  if (exitCode !== 0) logger.warn(`[coding] headless task for user ${userId} exited ${exitCode}: ${stderr.slice(0, 500)}`)

  await emitNotification({
    type: 'system',
    userId,
    title: 'Coding update',
    body: summary,
    url: '/coding',
    dedupeKey: `coding-done:${userId}:${Date.now()}`,
  }).catch(() => {})
}

async function execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
  const { task } = (args ?? {}) as CodingArgs
  const userId = config?._userId as string | undefined
  if (!userId) return { success: false, error: 'Coding tasks need a signed-in user.' }
  if (!task?.trim()) return { success: false, error: 'What should the coding agent do?' }
  if (!isClaudeCodeInstalled()) {
    return { success: true, directReply: "Coding isn't installed yet. An admin can turn it on in Admin → Features." }
  }

  // Detached: never blocks the reply. Errors are logged, not surfaced to the caller,
  // since by the time anything fails the direct reply has already been sent.
  void runHeadlessTask(userId, task).catch((e) => logger.warn(`[coding] headless task failed: ${e}`))

  // Deliberately no result summary here: the task runs in the background — "review in
  // the Coding app" (or wait for the completion notification) is the only accurate
  // thing to say up front.
  return {
    success: true,
    directReply: "I've started on that — I'll let you know when it's done. You can also open the Coding app to work alongside it.",
  }
}

export const codingTool: Tool = {
  id: 'coding',
  name: 'Coding',
  description: 'Kick off a MULTI-FILE coding project — build/scaffold a whole app, or work across an existing codebase (fix bugs, add features, refactor, run commands) — in your sandboxed workspace using Claude Code. File edits and shell commands run automatically (sandboxed to your own workspace, not interactively approved) since this runs headless in the background. For a single standalone snippet/file, use Canvas instead.',
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
      description: 'Start a MULTI-FILE coding project or work on an existing codebase with the sandboxed Claude Code agent. Not for a single self-contained snippet or file (use the canvas tool for that).',
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
