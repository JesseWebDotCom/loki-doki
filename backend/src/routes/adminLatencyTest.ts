import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import { ollamaChatStream } from '@/llm/ollama'
import { embed, getEmbedModel } from '@/llm/embed'
import { recallMemories, formatMemoriesForPrompt, countActiveMemories } from '@/memory/recall'
import { routePrompt } from '@/llm/router'
import { getModel } from '@/lib/models'
import { db } from '@/db'
import { conversations, messages, characters } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import type { AppEnv } from '@/types'

const ollamaUrl = () => process.env.OLLAMA_URL ?? 'http://localhost:11434'

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

export interface LatencyResult {
  id: string
  durationMs: number
  status: 'ok' | 'warn' | 'error'
  detail?: string
}

// Helper — times an async fn, returns durationMs + any thrown error message
async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; durationMs: number; error?: string }> {
  const start = performance.now()
  try {
    const value = await fn()
    return { value, durationMs: Math.round(performance.now() - start) }
  } catch (err) {
    return { durationMs: Math.round(performance.now() - start), error: err instanceof Error ? err.message : String(err) }
  }
}

const adminLatencyTest = new Hono<AppEnv>()

/**
 * GET /api/admin/latency-test/stream?layers=id1,id2,...
 *
 * SSE stream — emits one `result` event per layer as it completes, then `done`.
 * Omit `layers` to run all tests in sequence.
 */
adminLatencyTest.get('/stream', requireAdmin, async (c) => {
  const user = c.get('user')
  const filterParam = c.req.query('layers')
  const only = filterParam ? new Set(filterParam.split(',')) : null
  const model = await getModel()

  return streamSSE(c, async (stream) => {
    const emit = async (result: LatencyResult) => {
      if (!only || only.has(result.id)) {
        await stream.writeSSE({ event: 'result', data: JSON.stringify(result) })
      }
    }

    // ── 1. Ollama ping ────────────────────────────────────────────────────────
    if (!only || only.has('ollama-ping')) {
      const { durationMs, error } = await timed(async () => {
        const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      })
      await emit({
        id: 'ollama-ping',
        durationMs,
        status: error ? 'error' : durationMs > 100 ? 'warn' : 'ok',
        detail: error,
      })
    }

    // ── 2. Model residency (are they in VRAM?) ────────────────────────────────
    if (!only || only.has('model-residency')) {
      const { durationMs, value, error } = await timed(async () => {
        const res = await fetch(`${ollamaUrl()}/api/ps`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { models?: Array<{ name: string }> }
        const running = (data.models ?? []).map(m => m.name)
        const chatTag = model.split(':')[0] ?? model
        const chatLoaded = running.some(n => n.startsWith(chatTag))
        const embedLoaded = running.some(n => n.includes('nomic'))
        return { chatLoaded, embedLoaded }
      })
      const detail = error ?? (value
        ? `${model}: ${value.chatLoaded ? 'in VRAM' : 'NOT in VRAM'} | ${getEmbedModel()}: ${value.embedLoaded ? 'in VRAM' : 'NOT in VRAM'}`
        : undefined)
      await emit({
        id: 'model-residency',
        durationMs,
        status: error ? 'error' : (!value?.chatLoaded || !value?.embedLoaded) ? 'warn' : 'ok',
        detail,
      })
    }

    // ── 3. Embed latency ──────────────────────────────────────────────────────
    if (!only || only.has('embed')) {
      const { durationMs, error } = await timed(() => embed('hello'))
      await emit({
        id: 'embed',
        durationMs,
        status: error ? 'error' : durationMs > 300 ? 'warn' : 'ok',
        detail: error,
      })
    }

    // ── 4. LLM first token (bare — no system prompt, no tools) ────────────────
    if (!only || only.has('llm-first-token')) {
      let durationMs = 0
      let llmError: string | undefined
      const start = performance.now()
      try {
        for await (const chunk of ollamaChatStream(model, [{ role: 'user', content: 'hi' }], { num_predict: 8 })) {
          if (chunk.message.content) {
            durationMs = Math.round(performance.now() - start)
            break
          }
        }
        if (!durationMs) durationMs = Math.round(performance.now() - start)
      } catch (err) {
        durationMs = Math.round(performance.now() - start)
        llmError = err instanceof Error ? err.message : String(err)
      }
      await emit({
        id: 'llm-first-token',
        durationMs,
        status: llmError ? 'error' : 'ok',
        detail: llmError,
      })
    }

    // ── 5. Memory recall (embed + DB + cosine) ────────────────────────────────
    if (!only || only.has('memory-recall')) {
      const { durationMs, value, error } = await timed(async () => {
        const [total, embedding] = await Promise.all([
          countActiveMemories(user.id, null),
          embed('hi'),
        ])
        const recalled = await recallMemories('hi', user.id, null, embedding)
        await formatMemoriesForPrompt(recalled, user.id, null, embedding)
        return { recalled: recalled.length, total }
      })
      await emit({
        id: 'memory-recall',
        durationMs,
        status: error ? 'error' : durationMs > 200 ? 'warn' : 'ok',
        detail: error ?? (value !== undefined
          ? `${value.recalled} recalled · ${value.total} total in DB (scored top 150)`
          : undefined),
      })
    }

    // ── 6. Tier 1 routing (cosine only, no LLM) ───────────────────────────────
    if (!only || only.has('tier1-routing')) {
      const { durationMs, value, error } = await timed(async () => {
        // Passing no model forces Tier 1 exit — no Ollama call
        const { tool } = await routePrompt('what is the weather in paris', [], undefined)
        return tool ? `matched → ${tool.id}` : 'no match (below threshold)'
      })
      await emit({
        id: 'tier1-routing',
        durationMs,
        status: error ? 'error' : 'ok',
        detail: error ?? value,
      })
    }

    // ── 7. Tier 2 routing (LLM intent + arg extraction) ───────────────────────
    if (!only || only.has('tier2-routing')) {
      const { durationMs, value, error } = await timed(async () => {
        const { tool } = await routePrompt('what is the weather in paris', [], model)
        return tool ? `routed → ${tool.id}` : 'no tool selected'
      })
      await emit({
        id: 'tier2-routing',
        durationMs,
        status: error ? 'error' : 'ok',
        detail: error ?? value,
      })
    }

    // ── 8. Realistic pipeline — real history + real system prompt + full generation
    //   Uses the admin's most recent conversation so token counts match reality.
    //   Reports TTFB and total time so the number matches what the user actually sees.
    if (!only || only.has('full-pipeline')) {
      let ttfbMs = 0
      let totalMs = 0
      let tokenCount = 0
      let pipelineError: string | undefined
      const start = performance.now()
      try {
        // Load most recent conversation
        const [recentConv] = await db
          .select({ id: conversations.id, characterId: conversations.characterId })
          .from(conversations)
          .where(eq(conversations.userId, user.id))
          .orderBy(desc(conversations.updatedAt))
          .limit(1)

        // History with same token budget as chat.ts
        const TOKEN_HISTORY_BUDGET = 1500
        let historyRows: Array<{ role: string; content: string }> = []
        if (recentConv) {
          historyRows = await db
            .select({ role: messages.role, content: messages.content })
            .from(messages)
            .where(eq(messages.conversationId, recentConv.id))
            .orderBy(desc(messages.createdAt))
            .limit(40)
          historyRows.reverse()
          while (historyRows.length > 4) {
            const tokens = historyRows.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)
            if (tokens <= TOKEN_HISTORY_BUDGET) break
            historyRows.shift()
          }
        }

        // Character prompt if this conversation had one
        let characterPrompt: string | null = null
        if (recentConv?.characterId) {
          const [char] = await db
            .select({ personalityPrompt: characters.personalityPrompt })
            .from(characters)
            .where(eq(characters.id, recentConv.characterId))
            .limit(1)
          characterPrompt = char?.personalityPrompt ?? null
        }

        // Use the last real user message as the test prompt so generation length matches reality.
        // Slice it out of historyRows so it doesn't appear twice in the prompt.
        const lastUserIdx = historyRows.reduce((acc: number, m, i) => m.role === 'user' ? i : acc, -1)
        let testMessage = 'hi'
        if (lastUserIdx !== -1) {
          testMessage = historyRows[lastUserIdx]!.content
          historyRows = historyRows.slice(0, lastUserIdx)
        }

        // Build system prompt exactly as chat.ts does
        const embeddingPromise = embed(testMessage).catch(() => null)
        const memoryPromise = embeddingPromise.then(async (embedding) => {
          if (!embedding) return null
          const recalled = await recallMemories(testMessage, user.id, recentConv?.characterId ?? null, embedding)
          return formatMemoriesForPrompt(recalled, user.id, recentConv?.characterId ?? null, embedding)
        }).catch(() => null)

        // (The old 4-arg call passed a precomputed embedding routePrompt never
        // accepted — silently discarded; the router embeds with its OWN model.)
        await routePrompt(testMessage, [], model)
        const memoryBlock = await memoryPromise

        const _now = new Date()
        const _time = _now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
        const _date = _now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        const systemParts: string[] = [`Today is ${_date}. The current time is ${_time}.`]
        if (characterPrompt) systemParts.push(characterPrompt)
        if (memoryBlock) systemParts.push(memoryBlock)

        const systemTokens = Math.ceil(systemParts.join('\n\n').length / 4)
        const historyTokens = historyRows.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0)

        const ollamaMessages = [
          { role: 'system' as const, content: systemParts.join('\n\n') },
          ...historyRows.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user' as const, content: testMessage },
        ]

        for await (const chunk of ollamaChatStream(model, ollamaMessages, { num_ctx: 8192, num_predict: 500 })) {
          if (chunk.message.content) {
            tokenCount++
            if (!ttfbMs) ttfbMs = Math.round(performance.now() - start)
          }
          if (chunk.done) totalMs = Math.round(performance.now() - start)
        }
        if (!totalMs) totalMs = Math.round(performance.now() - start)

        await emit({
          id: 'full-pipeline',
          durationMs: totalMs,
          status: 'ok',
          detail: [
            `TTFB ${ttfbMs}ms`,
            `total ${fmt(totalMs)}`,
            `${tokenCount} tokens out`,
            `~${systemTokens + historyTokens} tokens in (system: ${systemTokens}, history: ${historyTokens} / ${historyRows.length} msgs)`,
            `msg: "${testMessage.slice(0, 60)}${testMessage.length > 60 ? '…' : ''}"`,
          ].join(' · '),
        })
        return
      } catch (err) {
        totalMs = Math.round(performance.now() - start)
        pipelineError = err instanceof Error ? err.message : String(err)
      }
      await emit({ id: 'full-pipeline', durationMs: totalMs, status: 'error', detail: pipelineError })
    }

    await stream.writeSSE({ event: 'done', data: '{}' })
  })
})

export { adminLatencyTest }
