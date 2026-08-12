import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import { ollamaChat } from '@/llm/ollama'
import type { OllamaChatMessage } from '@/llm/ollama'
import { embed } from '@/llm/embed'
import { recallMemories, formatMemoriesForPrompt } from '@/memory/recall'
import { routePrompt } from '@/llm/router'
import { getModel } from '@/lib/models'
import { db } from '@/db'
import { conversations, messages } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import type { AppEnv } from '@/types'

export interface ChatBenchResult {
  id: string
  label: string
  wallMs: number         // wall-clock total (fetch round-trip)
  prefillMs: number | null   // Ollama prompt_eval_duration (0 = KV cache hit)
  genMs: number | null       // Ollama eval_duration
  loadMs: number | null      // Ollama load_duration
  tps: number | null         // tokens/sec during generation
  promptTokens: number | null
  genTokens: number | null
  detail: string
  status: 'ok' | 'error'
  error?: string
}

const adminChatBenchmark = new Hono<AppEnv>()

const TEST_MESSAGE = 'hi'
const ROUTE_MESSAGE = 'what is the weather in paris'
const GEN_OPTS = { num_ctx: 8192, num_predict: 300 } as const

/**
 * GET /api/admin/chat-benchmark/stream
 *
 * 9 sequential non-streaming Ollama calls with progressively more context.
 * Uses ollamaChat (stream:false + Bun fetch) — avoids the chunked-encoding
 * fragility of the TCP socket path. Reports wall-clock time AND Ollama's own
 * prefill/generation breakdown so you can see exactly where time is spent.
 */
adminChatBenchmark.get('/stream', requireAdmin, async (c) => {
  const user = c.get('user')
  const model = await getModel()

  return streamSSE(c, async (stream) => {
    const emit = async (result: ChatBenchResult) => {
      await stream.writeSSE({ event: 'result', data: JSON.stringify(result) })
    }

    async function runTest(
      id: string,
      label: string,
      msgs: OllamaChatMessage[],
      extraDetail = '',
    ): Promise<ChatBenchResult> {
      const start = performance.now()
      try {
        const chunk = await ollamaChat(model, msgs, undefined, GEN_OPTS)
        const wallMs = Math.round(performance.now() - start)

        const prefillMs = chunk.prompt_eval_duration != null
          ? (chunk.prompt_eval_duration === 0 ? 0 : Math.round(chunk.prompt_eval_duration / 1e6))
          : null
        const genMs = chunk.eval_duration != null ? Math.round(chunk.eval_duration / 1e6) : null
        const loadMs = chunk.load_duration != null && chunk.load_duration > 0
          ? Math.round(chunk.load_duration / 1e6)
          : null
        const tps = (chunk.eval_count && chunk.eval_duration && chunk.eval_duration > 0)
          ? Math.round(chunk.eval_count / chunk.eval_duration * 1e9)
          : null

        const parts: string[] = []
        if (extraDetail) parts.push(extraDetail)
        if (loadMs) parts.push(`load:${loadMs}ms`)
        if (prefillMs != null) parts.push(`prefill:${prefillMs === 0 ? '0(cached)' : prefillMs + 'ms'}`)
        if (genMs != null) parts.push(`gen:${genMs}ms`)
        if (tps != null) parts.push(`${tps}tok/s`)
        if (chunk.prompt_eval_count) parts.push(`in:${chunk.prompt_eval_count}`)
        if (chunk.eval_count) parts.push(`out:${chunk.eval_count}`)

        return {
          id, label, wallMs, prefillMs, genMs, loadMs, tps,
          promptTokens: chunk.prompt_eval_count ?? null,
          genTokens: chunk.eval_count ?? null,
          detail: parts.join(' · '),
          status: 'ok',
        }
      } catch (err) {
        const wallMs = Math.round(performance.now() - start)
        return {
          id, label, wallMs, prefillMs: null, genMs: null, loadMs: null, tps: null,
          promptTokens: null, genTokens: null,
          detail: extraDetail,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    // ── Shared setup ────────────────────────────────────────────────────────────
    const dateStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    })

    // Load most recent conversation
    const [recentConv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, user.id))
      .orderBy(desc(conversations.updatedAt))
      .limit(1)

    let historyMsgs: OllamaChatMessage[] = []
    let historyTokens = 0
    if (recentConv) {
      const TOKEN_HISTORY_BUDGET = 1200 // keep in sync with chat.ts
      const rows = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, recentConv.id))
        .orderBy(desc(messages.createdAt))
        .limit(40)
      rows.reverse()
      while (rows.length > 4) {
        const toks = rows.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
        if (toks <= TOKEN_HISTORY_BUDGET) break
        rows.shift()
      }
      historyMsgs = rows.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      historyTokens = rows.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
    }

    let memoryBlock: string | null = null
    let memoryTokens = 0
    try {
      const embedding = await embed(TEST_MESSAGE)
      const recalled = await recallMemories(TEST_MESSAGE, user.id, null, embedding)
      memoryBlock = await formatMemoriesForPrompt(recalled, user.id, null, embedding)
      if (memoryBlock) memoryTokens = Math.ceil(memoryBlock.length / 4)
    } catch {}

    // ── 1. Bare LLM ─────────────────────────────────────────────────────────────
    await emit(await runTest('bare-llm', 'Bare LLM',
      [{ role: 'user', content: TEST_MESSAGE }],
    ))

    // ── 2. + System prompt (date) ───────────────────────────────────────────────
    await emit(await runTest('system-only', '+ System prompt',
      [
        { role: 'system', content: `Today is ${dateStr}.` },
        { role: 'user', content: TEST_MESSAGE },
      ],
      '~5 tok sys',
    ))

    // ── 3. + Memory block ───────────────────────────────────────────────────────
    {
      const sys = memoryBlock
        ? `Today is ${dateStr}.\n\n${memoryBlock}`
        : `Today is ${dateStr}.`
      await emit(await runTest('with-memory', '+ Memory',
        [
          { role: 'system', content: sys },
          { role: 'user', content: TEST_MESSAGE },
        ],
        memoryBlock ? `~${memoryTokens} tok mem` : 'no memories',
      ))
    }

    // ── 4. + Conversation history (no memory) ───────────────────────────────────
    await emit(await runTest('with-history', '+ History',
      [
        { role: 'system', content: `Today is ${dateStr}.` },
        ...historyMsgs,
        { role: 'user', content: TEST_MESSAGE },
      ],
      historyMsgs.length > 0 ? `${historyMsgs.length} msgs ~${historyTokens} tok` : 'no history',
    ))

    // ── 5. + History + memory ───────────────────────────────────────────────────
    {
      const sys = memoryBlock
        ? `Today is ${dateStr}.\n\n${memoryBlock}`
        : `Today is ${dateStr}.`
      await emit(await runTest('full-context', '+ History + memory',
        [
          { role: 'system', content: sys },
          ...historyMsgs,
          { role: 'user', content: TEST_MESSAGE },
        ],
        `${historyMsgs.length} msgs + ${memoryBlock ? `~${memoryTokens} tok mem` : 'no mem'}`,
      ))
    }

    // ── 6. Routing T1 (cosine — embed + vector match, no LLM) ──────────────────
    {
      const t1Start = performance.now()
      let t1Detail = ''
      try {
        const { tool } = await routePrompt(ROUTE_MESSAGE, [], undefined)
        t1Detail = tool ? `matched → ${tool.id}` : 'no match'
      } catch (err) {
        t1Detail = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      const t1Ms = Math.round(performance.now() - t1Start)
      await emit({
        id: 'routing-t1',
        label: 'Routing T1 (cosine)',
        wallMs: t1Ms,
        prefillMs: null, genMs: null, loadMs: null, tps: null,
        promptTokens: null, genTokens: null,
        detail: t1Detail,
        status: 'ok',
      })
    }

    // ── 7. Routing T2 (LLM intent extraction) ──────────────────────────────────
    {
      const t2Start = performance.now()
      let t2Detail = ''
      try {
        const { tool } = await routePrompt(ROUTE_MESSAGE, [], model)
        t2Detail = tool ? `matched → ${tool.id}` : 'no match'
      } catch (err) {
        t2Detail = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      const t2Ms = Math.round(performance.now() - t2Start)
      await emit({
        id: 'routing-t2',
        label: 'Routing T2 (LLM)',
        wallMs: t2Ms,
        prefillMs: null, genMs: null, loadMs: null, tps: null,
        promptTokens: null, genTokens: null,
        detail: t2Detail,
        status: 'ok',
      })
    }

    // ── 8 + 9. KV cache check — same prompt twice ───────────────────────────────
    {
      const sys = memoryBlock
        ? `Today is ${dateStr}.\n\n${memoryBlock}`
        : `Today is ${dateStr}.`
      const msgs: OllamaChatMessage[] = [
        { role: 'system', content: sys },
        ...historyMsgs,
        { role: 'user', content: TEST_MESSAGE },
      ]

      await emit(await runTest('kv-cache-1', 'KV cache — 1st call', msgs, 'same ctx as #5'))
      await emit(await runTest('kv-cache-2', 'KV cache — 2nd call', msgs, 'prefill:0 = KV hit'))
    }

    await stream.writeSSE({ event: 'done', data: '{}' })
  })
})

export { adminChatBenchmark }
