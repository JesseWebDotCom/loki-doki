import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireAdmin } from '@/middleware/auth'
import { routePrompt } from '@/llm/router'
import type { AppEnv } from '@/types'

export interface RouterTestCase {
  id: string
  category: string
  prompt: string
  expectedTools: string[]  // empty = should NOT route (conversational)
  // Optional: key arg fields that must be present (case-insensitive substring match)
  checkArgs?: Record<string, string>
}

export interface RouterTestResult {
  id: string
  category: string
  prompt: string
  expectedTools: string[]
  actualTool: string | null
  actualArgs: Record<string, unknown>
  toolCorrect: boolean
  argsCorrect: boolean | null  // null if no arg check defined
  durationMs: number
  tier: 'T0' | 'T1' | 'T2' | 'unknown'
}

// Covers natural rephrasings of the same intent — the hard accuracy test.
// expectedTools: empty array = must return no tool (conversational/null)
const TEST_CASES: RouterTestCase[] = [
  // ── Weather: multiple rephrasings ─────────────────────────────────────────
  { id: 'weather-explicit',  category: 'weather', prompt: "what's the weather in London?",            expectedTools: ['weather'], checkArgs: { location: 'london' } },
  { id: 'weather-rain-q',    category: 'weather', prompt: "is it going to rain today?",               expectedTools: ['weather'] },
  { id: 'weather-umbrella',  category: 'weather', prompt: "should I bring an umbrella?",              expectedTools: ['weather'] },
  { id: 'weather-coat',      category: 'weather', prompt: "do I need a coat outside?",                expectedTools: ['weather'] },
  { id: 'weather-raining',   category: 'weather', prompt: "is it raining in Paris?",                  expectedTools: ['weather'], checkArgs: { location: 'paris' } },
  { id: 'weather-forecast',  category: 'weather', prompt: "5-day forecast for Tokyo",                 expectedTools: ['weather'], checkArgs: { location: 'tokyo' } },

  // ── Calculator ─────────────────────────────────────────────────────────────
  { id: 'calc-explicit',     category: 'calculator', prompt: "what is 17 × 23?",                      expectedTools: ['calculator'] },
  { id: 'calc-tip',          category: 'calculator', prompt: "how much is a 20% tip on $85?",         expectedTools: ['calculator'] },
  { id: 'calc-natural',      category: 'calculator', prompt: "if I split a $120 bill 3 ways how much do I owe?", expectedTools: ['calculator'] },

  // ── Dictionary ─────────────────────────────────────────────────────────────
  { id: 'dict-explicit',     category: 'dictionary', prompt: "what does ephemeral mean?",             expectedTools: ['dictionary'], checkArgs: { word: 'ephemeral' } },
  { id: 'dict-natural',      category: 'dictionary', prompt: "define melancholy",                     expectedTools: ['dictionary'], checkArgs: { word: 'melancholy' } },
  { id: 'dict-how',          category: 'dictionary', prompt: "how do you pronounce serendipity?",     expectedTools: ['dictionary'] },

  // ── Unit conversion ────────────────────────────────────────────────────────
  { id: 'unit-miles',        category: 'unit_conversion', prompt: "how many km is 5 miles?",          expectedTools: ['unit_conversion'] },
  { id: 'unit-temp',         category: 'unit_conversion', prompt: "convert 98.6°F to Celsius",        expectedTools: ['unit_conversion'] },
  { id: 'unit-natural',      category: 'unit_conversion', prompt: "I'm 6 foot 2, what is that in cm?", expectedTools: ['unit_conversion'] },

  // ── Datetime ───────────────────────────────────────────────────────────────
  { id: 'datetime-until',    category: 'datetime', prompt: "how many days until Christmas?",          expectedTools: ['datetime'] },
  { id: 'datetime-day',      category: 'datetime', prompt: "what day of the week is March 15th?",     expectedTools: ['datetime'] },
  { id: 'datetime-tz',       category: 'datetime', prompt: "what time is it in Tokyo right now?",     expectedTools: ['datetime'] },

  // ── Passthrough tools (T1 passMessage) ─────────────────────────────────────
  { id: 'news-explicit',     category: 'news', prompt: "what's in the news today?",                   expectedTools: ['news'] },
  { id: 'news-topic',        category: 'news', prompt: "latest news about AI",                        expectedTools: ['news', 'search'] },
  { id: 'search-person',     category: 'search', prompt: "who is Ada Lovelace?",                      expectedTools: ['search'] },
  { id: 'youtube-how',       category: 'youtube', prompt: "show me how to make sourdough bread",      expectedTools: ['youtube'] },
  { id: 'recipes-make',      category: 'recipes', prompt: "how do I make pasta carbonara?",           expectedTools: ['recipes'] },
  { id: 'jokes-tell',        category: 'jokes', prompt: "tell me a joke",                             expectedTools: ['jokes'] },
  { id: 'tvshows-query',     category: 'tvshows', prompt: "how many seasons does Breaking Bad have?", expectedTools: ['tvshows', 'search'] },

  // ── Conversational — must NOT route ────────────────────────────────────────
  { id: 'convo-greeting',    category: 'conversational', prompt: "hey, how are you?",                 expectedTools: [] },
  { id: 'convo-thanks',      category: 'conversational', prompt: "thanks!",                           expectedTools: [] },
  { id: 'convo-opinion',     category: 'conversational', prompt: "that's really interesting",         expectedTools: [] },
  { id: 'convo-chatty',      category: 'conversational', prompt: "you're pretty smart",               expectedTools: [] },

  // ── Misfire regressions — self/social questions must NOT be web-searched ───
  // (these exact phrasings used to hit the SEARCH_INTENT fast path)
  { id: 'misfire-feel',      category: 'misfire', prompt: "how do you feel today?",                   expectedTools: [] },
  { id: 'misfire-who-are',   category: 'misfire', prompt: "who are you?",                             expectedTools: [] },
  { id: 'misfire-wrong',     category: 'misfire', prompt: "what is wrong with you",                   expectedTools: [] },
  // Reactions must stay conversational even with a question mark.
  { id: 'misfire-really',    category: 'misfire', prompt: "really?",                                  expectedTools: [] },
  { id: 'misfire-noway',     category: 'misfire', prompt: "no way!",                                  expectedTools: [] },
  // "can you check the weather" used to be hijacked into a search-only Tier 2.
  { id: 'misfire-checkwx',   category: 'misfire', prompt: "can you check the weather?",               expectedTools: ['weather'] },

  // ── Smart home ──────────────────────────────────────────────────────────────
  { id: 'ha-lights-off',     category: 'homeAssistant', prompt: "turn off the living room lights",    expectedTools: ['homeAssistant'] },
  { id: 'ha-dim',            category: 'homeAssistant', prompt: "dim the bedroom to 30%",             expectedTools: ['homeAssistant'] },

  // ── Playback vs browse confusables ──────────────────────────────────────────
  { id: 'play-artist',       category: 'play_music', prompt: "play some led zeppelin",                expectedTools: ['play_music'] },
  { id: 'play-station',      category: 'play_music', prompt: "put on a jazz station",                 expectedTools: ['play_music'] },

  // ── Explicit memory control ─────────────────────────────────────────────────
  { id: 'mem-remember',      category: 'memory', prompt: "remember that I park in garage spot 14",    expectedTools: ['remember'] },
  { id: 'mem-forget',        category: 'memory', prompt: "forget what I said about my old job",       expectedTools: ['forget'] },
]

const adminRouterBenchmark = new Hono<AppEnv>()

/**
 * GET /api/admin/router-benchmark/stream?model=MODEL
 *
 * Runs 30 test cases through the full routing pipeline using the specified
 * model for T2 LLM calls. Streams one `result` event per test, then `summary`.
 * Omit `model` to run T0/T1 only (measures pure cosine routing with no LLM).
 */
adminRouterBenchmark.get('/stream', requireAdmin, async (c) => {
  const model = c.req.query('model') ?? undefined

  return streamSSE(c, async (stream) => {
    let correct = 0
    let t2Count = 0
    let t2TotalMs = 0

    for (const tc of TEST_CASES) {
      const start = performance.now()
      let actualTool: string | null = null
      let actualArgs: Record<string, unknown> = {}
      let tier: RouterTestResult['tier'] = 'unknown'

      try {
        const result = await routePrompt(tc.prompt, [], model)
        const durationMs = Math.round(performance.now() - start)

        actualTool = result.tool?.id ?? null
        actualArgs = (result.args as Record<string, unknown>) ?? {}

        // Honest tier attribution from the router's own path label (the old
        // wall-clock heuristic — <30ms ⇒ T1 — mislabeled under load).
        const path = result.path ?? ''
        if (path.startsWith('tier2')) {
          tier = 'T2'
          t2Count++
          t2TotalMs += durationMs
        } else if (actualTool !== null || path === 'denied-tool') {
          tier = 'T1'
        } else {
          tier = 'T0'
        }

        // Tool correctness:
        // - expectedTools empty → correct if no tool returned
        // - expectedTools non-empty → correct if actual tool is in the list
        const toolCorrect = tc.expectedTools.length === 0
          ? actualTool === null
          : actualTool !== null && tc.expectedTools.includes(actualTool)

        // Arg correctness (optional — only for test cases that define checkArgs)
        let argsCorrect: boolean | null = null
        if (toolCorrect && tc.checkArgs) {
          argsCorrect = Object.entries(tc.checkArgs).every(([key, expected]) => {
            const actual = String(actualArgs[key] ?? '').toLowerCase()
            return actual.includes(expected.toLowerCase())
          })
        }

        if (toolCorrect && argsCorrect !== false) correct++

        const res: RouterTestResult = {
          id: tc.id,
          category: tc.category,
          prompt: tc.prompt,
          expectedTools: tc.expectedTools,
          actualTool,
          actualArgs,
          toolCorrect,
          argsCorrect,
          durationMs,
          tier,
        }
        await stream.writeSSE({ event: 'result', data: JSON.stringify(res) })
      } catch (err) {
        const durationMs = Math.round(performance.now() - start)
        const res: RouterTestResult = {
          id: tc.id,
          category: tc.category,
          prompt: tc.prompt,
          expectedTools: tc.expectedTools,
          actualTool: null,
          actualArgs: {},
          toolCorrect: false,
          argsCorrect: null,
          durationMs,
          tier: 'unknown',
        }
        await stream.writeSSE({ event: 'result', data: JSON.stringify(res) })
      }
    }

    await stream.writeSSE({
      event: 'summary',
      data: JSON.stringify({
        total: TEST_CASES.length,
        correct,
        accuracyPct: Math.round((correct / TEST_CASES.length) * 100),
        t2Count,
        t2AvgMs: t2Count > 0 ? Math.round(t2TotalMs / t2Count) : null,
      }),
    })

    await stream.writeSSE({ event: 'done', data: '{}' })
  })
})

export { adminRouterBenchmark, TEST_CASES }
