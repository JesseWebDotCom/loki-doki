// Shared "route the prompt → run the tool → fold its data into the user turn"
// helper, so the companion (off-chat / voice) path gets the same news / web /
// weather / etc. tools as the main chat route — without the chat machinery
// (persistence, block/source UI events).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { routePrompt } from '@/llm/router'
import { isToolAllowed, resolveToolConfig } from '@/lib/toolConfig'
import type { OllamaChatMessage } from '@/llm/ollama'

export interface ToolTurn {
  /** The user message content, with any tool data appended for the LLM. */
  userContent: string
  toolId: string | null
  /** A finished, speakable reply the caller should emit verbatim (skipping the
   *  LLM), e.g. an alarm confirmation. Mirrors the chat route's snappy path. */
  directReply?: string
}

// A tool ran successfully but returned no findings — e.g. web search with an empty
// `results` array. Used to send a "found nothing, don't make it up" instruction to
// the model rather than the normal "use this data" one.
function isEmptyResult(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as { results?: unknown }
  return Array.isArray(d.results) && d.results.length === 0
}

async function userLocationPref(userId: string): Promise<{ displayName?: string; lat?: number; lng?: number } | null> {
  try {
    const [row] = await db
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, 'user.location')))
      .limit(1)
    return row ? (JSON.parse(row.value) as { displayName?: string; lat?: number; lng?: number }) : null
  } catch {
    return null
  }
}

export async function runToolTurn(opts: {
  message: string
  history: OllamaChatMessage[]
  userId: string
  userRole: string
  model?: string
  offline?: boolean
}): Promise<ToolTurn> {
  let tool, args
  try {
    ;({ tool, args } = await routePrompt(opts.message, opts.history, opts.model))
  } catch {
    return { userContent: opts.message, toolId: null }
  }
  if (!tool || !(await isToolAllowed(tool.id, opts.userId))) {
    return { userContent: opts.message, toolId: null }
  }
  if (opts.offline && !tool.offline) {
    return {
      userContent: `${opts.message}\n\n[system]: Internet access is disabled so ${tool.name} cannot run. Answer entirely from your own training knowledge — do not mention offline mode, connectivity, or tools.`,
      toolId: tool.id,
    }
  }

  const toolConfig = await resolveToolConfig(tool.id, opts.userId)
  toolConfig['_userId'] = opts.userId
  toolConfig['_isAdmin'] = opts.userRole === 'admin'
  toolConfig['_rawMessage'] = opts.message
  const loc = await userLocationPref(opts.userId)
  if (loc?.displayName && !toolConfig['default_location']) toolConfig['default_location'] = loc.displayName
  if (loc?.lat !== undefined) { toolConfig['_lat'] = loc.lat; toolConfig['_lng'] = loc.lng }

  try {
    const result = await tool.execute(args, toolConfig)
    if (result.offline) {
      return { userContent: `${opts.message}\n\n[${tool.name}]: The service is offline right now. Tell the user this tool is unavailable and to try again later.`, toolId: tool.id }
    }
    if (result.success) {
      if (typeof result.directReply === 'string' && result.directReply.trim()) {
        return { userContent: opts.message, toolId: tool.id, directReply: result.directReply.trim() }
      }
      // The tool ran fine but found nothing (e.g. a web search on a name that came
      // through garbled from speech — "Vinnie Jones" → "vunny jones"). Without an
      // explicit signal the model treats the empty payload as license to answer from
      // its own memory and confidently deny the subject exists ("never heard of him").
      // Tell it the search came up empty and to recover gracefully instead.
      if (isEmptyResult(result.data)) {
        return {
          userContent: `${opts.message}\n\n[${tool.name}]: No results found. Do NOT claim the subject doesn't exist or that you've never heard of it — the name may be misspelled or misheard from speech. Briefly say you couldn't find anything on it, and if it closely resembles someone or something well-known, ask if that's who they meant.`,
          toolId: tool.id,
        }
      }
      return { userContent: `${opts.message}\n\n[${tool.name} data]: ${JSON.stringify(result.data)}\n\nUse this data to answer in your own voice, conversationally.`, toolId: tool.id }
    }
    return { userContent: `${opts.message}\n\n[${tool.name} error]: ${result.error ?? 'failed'}. Acknowledge briefly and suggest an alternative.`, toolId: tool.id }
  } catch {
    return { userContent: opts.message, toolId: null }
  }
}
