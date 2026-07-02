// Router accuracy/latency eval — runs the adminRouterBenchmark fixture set
// through routePrompt directly (no HTTP/auth) and prints a scoreboard.
//
// Usage:
//   bun run scripts/eval/router-eval.ts            # T2 with configured model
//   bun run scripts/eval/router-eval.ts --t1-only  # cosine tiers only, no LLM
//   bun run scripts/eval/router-eval.ts --json out.json
import { routePrompt } from '@/llm/router'
import { getModel } from '@/lib/models'
import { TEST_CASES } from '@/routes/adminRouterBenchmark'

const t1Only = process.argv.includes('--t1-only')
const jsonIdx = process.argv.indexOf('--json')
const jsonPath = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : null

const model = t1Only ? undefined : await getModel()
console.log(`Router eval — ${TEST_CASES.length} cases, model=${model ?? '(T1 only)'}\n`)

interface Row {
  id: string
  category: string
  prompt: string
  expected: string[]
  actual: string | null
  args: Record<string, unknown>
  path: string
  ok: boolean
  argsOk: boolean | null
  ms: number
}

const rows: Row[] = []
for (const tc of TEST_CASES) {
  const start = performance.now()
  let actual: string | null = null
  let args: Record<string, unknown> = {}
  let path = 'error'
  try {
    const r = await routePrompt(tc.prompt, [], model)
    actual = r.tool?.id ?? null
    args = (r.args as Record<string, unknown>) ?? {}
    path = r.path ?? 'unknown'
  } catch (err) {
    path = `error: ${err instanceof Error ? err.message : err}`
  }
  const ms = Math.round(performance.now() - start)
  const ok = tc.expectedTools.length === 0
    ? actual === null
    : actual !== null && tc.expectedTools.includes(actual)
  let argsOk: boolean | null = null
  if (ok && tc.checkArgs) {
    argsOk = Object.entries(tc.checkArgs).every(([k, v]) =>
      String(args[k] ?? '').toLowerCase().includes(v.toLowerCase()))
  }
  rows.push({ id: tc.id, category: tc.category, prompt: tc.prompt, expected: tc.expectedTools, actual, args, path, ok, argsOk, ms })
  const mark = ok && argsOk !== false ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${tc.id.padEnd(20)} → ${String(actual).padEnd(16)} (want ${tc.expectedTools.join('|') || 'none'}) [${path}] ${ms}ms${argsOk === false ? ' ARGS-BAD args=' + JSON.stringify(args) : ''}`)
}

const passed = rows.filter(r => r.ok && r.argsOk !== false).length
const byPath = new Map<string, number>()
for (const r of rows) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1)
const msSorted = rows.map(r => r.ms).sort((a, b) => a - b)
const p = (q: number) => msSorted[Math.min(msSorted.length - 1, Math.floor(q * msSorted.length))]

console.log(`\n${passed}/${rows.length} passed (${Math.round(passed / rows.length * 100)}%)`)
console.log(`latency ms: p50=${p(0.5)} p90=${p(0.9)} max=${msSorted.at(-1)}`)
console.log('paths:', Object.fromEntries(byPath))
console.log('\nFailures:')
for (const r of rows.filter(r => !(r.ok && r.argsOk !== false))) {
  console.log(`  ${r.id}: "${r.prompt}" → ${r.actual} [${r.path}] want ${r.expected.join('|') || 'none'}`)
}

if (jsonPath) await Bun.write(jsonPath, JSON.stringify(rows, null, 2))
process.exit(0)
