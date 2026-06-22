/**
 * Standalone router accuracy + speed benchmark.
 * Run: bun scripts/router-bench.ts [model]
 * Example: bun scripts/router-bench.ts granite4.1:3b
 */
import { initRouter, routePrompt } from '../backend/src/llm/router'

const model = process.argv[2] ?? undefined

const TEST_CASES = [
  // weather
  { id: 'weather-explicit',  category: 'weather',       prompt: "what's the weather in London?",                    expected: ['weather'] },
  { id: 'weather-rain-q',    category: 'weather',       prompt: "is it going to rain today?",                       expected: ['weather'] },
  { id: 'weather-umbrella',  category: 'weather',       prompt: "should I bring an umbrella?",                      expected: ['weather'] },
  { id: 'weather-coat',      category: 'weather',       prompt: "do I need a coat outside?",                        expected: ['weather'] },
  { id: 'weather-raining',   category: 'weather',       prompt: "is it raining in Paris?",                         expected: ['weather'] },
  { id: 'weather-forecast',  category: 'weather',       prompt: "5-day forecast for Tokyo",                        expected: ['weather'] },
  // calculator
  { id: 'calc-explicit',     category: 'calculator',    prompt: "what is 17 × 23?",                                expected: ['calculator'] },
  { id: 'calc-tip',          category: 'calculator',    prompt: "how much is a 20% tip on $85?",                   expected: ['calculator'] },
  { id: 'calc-natural',      category: 'calculator',    prompt: "if I split a $120 bill 3 ways how much do I owe?",expected: ['calculator'] },
  // dictionary
  { id: 'dict-explicit',     category: 'dictionary',    prompt: "what does ephemeral mean?",                       expected: ['dictionary'] },
  { id: 'dict-natural',      category: 'dictionary',    prompt: "define melancholy",                               expected: ['dictionary'] },
  { id: 'dict-how',          category: 'dictionary',    prompt: "how do you pronounce serendipity?",               expected: ['dictionary'] },
  // unit conversion
  { id: 'unit-miles',        category: 'unit_conversion', prompt: "how many km is 5 miles?",                       expected: ['unit_conversion'] },
  { id: 'unit-temp',         category: 'unit_conversion', prompt: "convert 98.6°F to Celsius",                     expected: ['unit_conversion'] },
  { id: 'unit-natural',      category: 'unit_conversion', prompt: "I'm 6 foot 2, what is that in cm?",             expected: ['unit_conversion'] },
  // datetime
  { id: 'datetime-until',    category: 'datetime',      prompt: "how many days until Christmas?",                  expected: ['datetime'] },
  { id: 'datetime-day',      category: 'datetime',      prompt: "what day of the week is March 15th?",             expected: ['datetime'] },
  { id: 'datetime-tz',       category: 'datetime',      prompt: "what time is it in Tokyo right now?",             expected: ['datetime'] },
  // passthrough tools
  { id: 'news-explicit',     category: 'news',          prompt: "what's in the news today?",                       expected: ['news'] },
  { id: 'news-topic',        category: 'news',          prompt: "latest news about AI",                            expected: ['news', 'search'] },
  { id: 'search-person',     category: 'search',        prompt: "who is Ada Lovelace?",                            expected: ['search'] },
  { id: 'youtube-how',       category: 'youtube',       prompt: "show me how to make sourdough bread",             expected: ['youtube'] },
  { id: 'recipes-make',      category: 'recipes',       prompt: "how do I make pasta carbonara?",                  expected: ['recipes'] },
  { id: 'jokes-tell',        category: 'jokes',         prompt: "tell me a joke",                                  expected: ['jokes'] },
  { id: 'tvshows-query',     category: 'tvshows',       prompt: "how many seasons does Breaking Bad have?",        expected: ['tvshows', 'search'] },
  // conversational — must NOT route
  { id: 'convo-greeting',    category: 'conversational', prompt: "hey, how are you?",                              expected: [] },
  { id: 'convo-thanks',      category: 'conversational', prompt: "thanks!",                                        expected: [] },
  { id: 'convo-opinion',     category: 'conversational', prompt: "that's really interesting",                      expected: [] },
  { id: 'convo-chatty',      category: 'conversational', prompt: "you're pretty smart",                            expected: [] },
  { id: 'convo-yo',          category: 'conversational', prompt: "yo",                                             expected: [] },
]

function fmt(ms: number) { return ms >= 1000 ? `${(ms/1000).toFixed(2)}s` : `${ms}ms` }
function pad(s: string, n: number) { return s.slice(0, n).padEnd(n) }

async function main() {
  console.log(`\nRouter Accuracy Benchmark — model: ${model ?? '(T1 only, no LLM)'}`)
  console.log('='.repeat(72))
  console.log('Initializing router index...')
  await initRouter()
  console.log('Ready.\n')

  let correct = 0
  let t2Count = 0, t2Total = 0

  const rows: Array<{ tc: typeof TEST_CASES[0]; actual: string | null; args: unknown; ms: number; tier: string; pass: boolean }> = []

  for (const tc of TEST_CASES) {
    const start = performance.now()
    const { tool, args } = await routePrompt(tc.prompt, [], model)
    const ms = Math.round(performance.now() - start)
    const actual = tool?.id ?? null
    const tier = ms < 30 ? (actual ? 'T1' : 'T0') : 'T2'
    if (tier === 'T2') { t2Count++; t2Total += ms }

    const pass = tc.expected.length === 0
      ? actual === null
      : actual !== null && tc.expected.includes(actual)
    if (pass) correct++

    rows.push({ tc, actual, args, ms, tier, pass })

    const mark = pass ? '✓' : '✗'
    const exp = tc.expected.length === 0 ? 'null' : tc.expected.join('|')
    console.log(`${mark} ${pad(tc.category, 14)} ${pad(tc.id, 20)} [${tier} ${fmt(ms)}]`)
    console.log(`  "${tc.prompt}"`)
    console.log(`  expected: ${exp}  →  got: ${actual ?? 'null'}${args && Object.keys(args as object).length ? '  args: ' + JSON.stringify(args) : ''}`)
    if (!pass) console.log(`  ^^^ WRONG`)
    console.log()
  }

  const pct = Math.round(correct / TEST_CASES.length * 100)
  console.log('='.repeat(72))
  console.log(`Accuracy:  ${correct}/${TEST_CASES.length}  (${pct}%)`)
  if (t2Count > 0) {
    console.log(`T2 avg:    ${fmt(Math.round(t2Total / t2Count))}  (${t2Count} calls)`)
  }

  // Category breakdown
  const cats = [...new Set(TEST_CASES.map(t => t.category))]
  console.log('\nBy category:')
  for (const cat of cats) {
    const catTests = rows.filter(r => r.tc.category === cat)
    const catCorrect = catTests.filter(r => r.pass).length
    const mark = catCorrect === catTests.length ? '✓' : catCorrect === 0 ? '✗' : '~'
    console.log(`  ${mark} ${cat.padEnd(16)} ${catCorrect}/${catTests.length}`)
  }
  console.log()
}

main().catch(err => { console.error(err); process.exit(1) })
