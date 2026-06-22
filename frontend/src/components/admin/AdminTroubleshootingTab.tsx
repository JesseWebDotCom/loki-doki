import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Circle, Copy, Loader2, Play, PlayCircle, RotateCcw, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

// ─── Types ────────────────────────────────────────────────────────────────────

type LayerStatus = 'idle' | 'running' | 'ok' | 'warn' | 'error'

interface LayerDef {
  id: string
  label: string
  description: string
}

interface LayerState {
  status: LayerStatus
  durationMs?: number
  detail?: string
}

interface LatencyResult {
  id: string
  durationMs: number
  status: 'ok' | 'warn' | 'error'
  detail?: string
}

// ─── Layer definitions ────────────────────────────────────────────────────────

const LAYERS: LayerDef[] = [
  {
    id: 'ollama-ping',
    label: 'Ollama ping',
    description: 'Raw HTTP round-trip to Ollama. Rules out network/socket issues.',
  },
  {
    id: 'model-residency',
    label: 'Model residency',
    description: 'Checks whether the chat model and embed model are loaded in VRAM. Cold models add 5–10 s on first use.',
  },
  {
    id: 'embed',
    label: 'Embed call',
    description: 'Single nomic-embed-text inference. Used on every message for routing and memory recall.',
  },
  {
    id: 'llm-first-token',
    label: 'LLM first token (bare)',
    description: 'Time until the first token arrives from the chat model with no system prompt, memory, or tools — pure model latency.',
  },
  {
    id: 'memory-recall',
    label: 'Memory recall',
    description: 'Embed + database query + cosine scoring over your stored memories. Runs in parallel with routing.',
  },
  {
    id: 'tier1-routing',
    label: 'Tier 1 routing (cosine)',
    description: 'Semantic similarity check against tool examples using the precomputed embedding. No LLM call.',
  },
  {
    id: 'tier2-routing',
    label: 'Tier 2 routing (LLM)',
    description: 'Full LLM call for intent classification and argument extraction. Only fires for ambiguous prompts or structured-arg tools.',
  },
  {
    id: 'full-pipeline',
    label: 'Realistic pipeline',
    description: 'Uses your actual most recent conversation: real history (token-budget trimmed), real character prompt, real memory block, full response generated. The total time shown is what you actually wait for.',
  },
]

const INITIAL_STATE = Object.fromEntries(LAYERS.map(l => [l.id, { status: 'idle' as LayerStatus }]))

// ─── Component ────────────────────────────────────────────────────────────────

// ─── Chat Benchmark types ─────────────────────────────────────────────────────

interface ChatBenchResult {
  id: string
  label: string
  wallMs: number          // wall-clock total (fetch round-trip)
  prefillMs: number | null    // Ollama prompt_eval_duration (0 = KV cache hit)
  genMs: number | null        // Ollama eval_duration
  loadMs: number | null       // Ollama load_duration
  tps: number | null          // tokens/sec
  promptTokens: number | null
  genTokens: number | null
  detail: string
  status: 'ok' | 'error'
  error?: string
}

type BenchState = { status: 'idle' | 'running' } | ({ status: 'done' | 'error' } & ChatBenchResult)

const BENCH_IDS = [
  'bare-llm',
  'system-only',
  'with-memory',
  'with-history',
  'full-context',
  'routing-t1',
  'routing-t2',
  'kv-cache-1',
  'kv-cache-2',
]

const BENCH_DESCRIPTIONS: Record<string, string> = {
  'bare-llm':     'No system prompt, no history — baseline model speed.',
  'system-only':  'Date-only system prompt. Shows overhead of minimal context.',
  'with-memory':  'Date + recalled memory block. Shows cost of memory injection.',
  'with-history': 'Date + real conversation history. Shows prefill scaling with context.',
  'full-context': 'Date + memory + history. Realistic context minus routing.',
  'routing-t1':   'Cosine-only routing (embed + vector match). No LLM call.',
  'routing-t2':   'Full LLM routing call (intent extraction). Largest routing overhead.',
  'kv-cache-1':   'Same context as #5, first call — primes the KV cache.',
  'kv-cache-2':   'Identical context repeated — prefill:0 means Ollama reused its KV cache.',
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

interface Verdict {
  level: 'ok' | 'warn' | 'error'
  text: string
}

function computeVerdicts(states: Record<string, BenchState>): Verdict[] {
  const get = (id: string): ChatBenchResult | null => {
    const s = states[id]
    return s && (s.status === 'done' || s.status === 'error') ? s as ChatBenchResult : null
  }
  const verdicts: Verdict[] = []

  const bare = get('bare-llm')
  const full = get('full-context')
  const kv1 = get('kv-cache-1')
  const kv2 = get('kv-cache-2')
  const t1 = get('routing-t1')
  const t2 = get('routing-t2')

  // Generation speed — always show if we have data
  if (bare?.tps != null) {
    if (bare.tps < 8) {
      verdicts.push({ level: 'error', text: `Generation: ${bare.tps} tok/s — very slow. Model may not be on GPU. Run \`ollama ps\` to check.` })
    } else if (bare.tps < 18) {
      verdicts.push({ level: 'warn', text: `Generation: ${bare.tps} tok/s — slower than expected. Check VRAM headroom (ollama ps).` })
    } else {
      verdicts.push({ level: 'ok', text: `Generation: ${bare.tps} tok/s — normal.` })
    }
  } else if (bare) {
    verdicts.push({ level: 'warn', text: `Generation speed unavailable — Ollama didn't return eval stats.` })
  }

  // Prefill / context cost — always show delta
  if (bare && full) {
    const overhead = full.wallMs - bare.wallMs
    const prefillFull = full.prefillMs
    if (overhead > 2000) {
      verdicts.push({ level: 'warn', text: `Context overhead: +${overhead}ms vs bare (prefill ${prefillFull != null ? prefillFull + 'ms' : '?'}). Try reducing memory block or history budget.` })
    } else {
      verdicts.push({ level: 'ok', text: `Context overhead: +${overhead}ms vs bare — acceptable.` })
    }
  }

  // KV cache — always show result
  if (kv1 && kv2) {
    if (kv2.prefillMs === 0) {
      verdicts.push({ level: 'ok', text: `KV cache: hit — 2nd identical call had 0ms prefill. Cache is working.` })
    } else if (kv2.prefillMs != null && kv1.prefillMs != null) {
      const saved = kv1.prefillMs - kv2.prefillMs
      if (saved > kv1.prefillMs * 0.5) {
        verdicts.push({ level: 'ok', text: `KV cache: partial hit — prefill dropped from ${kv1.prefillMs}ms to ${kv2.prefillMs}ms on repeat call.` })
      } else {
        verdicts.push({ level: 'warn', text: `KV cache: miss — 2nd call prefill ${kv2.prefillMs}ms (same as 1st: ${kv1.prefillMs}ms). Check Ollama keep_alive and num_ctx match.` })
      }
    }
  }

  // Chat time extrapolation — show what real responses actually cost
  if (bare?.tps != null && bare.tps > 0) {
    const prefill = bare.prefillMs ?? 0
    const est = (tokens: number) => fmt(Math.round(tokens / bare.tps! * 1000) + prefill)
    verdicts.push({
      level: 'ok',
      text: `Estimated chat wait at ${bare.tps} tok/s: 100-token reply ≈ ${est(100)} · 300-token ≈ ${est(300)} · 500-token ≈ ${est(500)}. If responses feel slow, add a brevity instruction to the system prompt.`,
    })
  }

  // Routing overhead — always show both
  if (t1) {
    verdicts.push({ level: t1.wallMs > 200 ? 'warn' : 'ok', text: `Routing T1 (cosine): ${t1.wallMs}ms${t1.detail ? ` — ${t1.detail}` : ''}.` })
  }
  if (t2) {
    if (t2.wallMs > 3000) {
      verdicts.push({ level: 'warn', text: `Routing T2 (LLM): ${fmt(t2.wallMs)} — large overhead for tool calls. Consider raising T1 threshold.` })
    } else {
      verdicts.push({ level: t2.wallMs > 1000 ? 'warn' : 'ok', text: `Routing T2 (LLM): ${fmt(t2.wallMs)} — fires for ambiguous/tool prompts.` })
    }
  }

  return verdicts
}

function buildCopyText(states: Record<string, BenchState>, verdicts: Verdict[]): string {
  const lines: string[] = ['Chat Benchmark Results', '======================', '']

  for (const id of BENCH_IDS) {
    const s = states[id]
    if (!s || s.status === 'idle' || s.status === 'running') continue
    const r = s as ChatBenchResult
    const isRouting = id.startsWith('routing-')

    const parts: string[] = [`${r.label}: ${fmt(r.wallMs)}`]
    if (!isRouting) {
      if (r.prefillMs != null) parts.push(`prefill:${r.prefillMs === 0 ? '0ms(cached)' : r.prefillMs + 'ms'}`)
      if (r.genMs != null) parts.push(`gen:${r.genMs}ms`)
      if (r.tps != null) parts.push(`${r.tps}tok/s`)
      if (r.promptTokens != null) parts.push(`in:${r.promptTokens} out:${r.genTokens ?? '?'}`)
    }
    if (r.detail) parts.push(`(${r.detail})`)
    if (r.error) parts.push(`ERROR: ${r.error}`)
    lines.push(parts.join('  '))
  }

  if (verdicts.length > 0) {
    lines.push('', 'Diagnosis', '---------')
    for (const v of verdicts) {
      const icon = v.level === 'ok' ? '✓' : v.level === 'warn' ? '⚠' : '✗'
      lines.push(`${icon} ${v.text}`)
    }
  }

  return lines.join('\n')
}

// ─── Chat Benchmark section ───────────────────────────────────────────────────

function ChatBenchmarkSection() {
  const [states, setStates] = useState<Record<string, BenchState>>(
    Object.fromEntries(BENCH_IDS.map(id => [id, { status: 'idle' }]))
  )
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close any open benchmark stream on unmount so it doesn't leak the
  // connection or fire setState after the component is gone.
  useEffect(() => () => {
    esRef.current?.close()
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
  }, [])

  function cancel() {
    esRef.current?.close()
    esRef.current = null
    setRunning(false)
    setStates(prev => {
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        if (next[id]!.status === 'running') next[id] = { status: 'idle' }
      }
      return next
    })
  }

  function reset() {
    cancel()
    setStates(Object.fromEntries(BENCH_IDS.map(id => [id, { status: 'idle' }])))
  }

  function runAll() {
    esRef.current?.close()
    setRunning(true)
    setStates(Object.fromEntries(BENCH_IDS.map(id => [id, { status: 'running' }])))

    const es = new EventSource('/api/admin/chat-benchmark/stream', { withCredentials: true })
    esRef.current = es

    es.addEventListener('result', (e) => {
      let result: ChatBenchResult
      try { result = JSON.parse(e.data) as ChatBenchResult } catch { return } // skip malformed frame
      setStates(prev => ({
        ...prev,
        [result.id]: { ...result, status: result.error ? 'error' : 'done' },
      }))
    })

    const finish = () => {
      es.close()
      esRef.current = null
      setRunning(false)
      // Reset any still-running tests to idle (stream closed before they ran)
      setStates(prev => {
        const next = { ...prev }
        for (const id of Object.keys(next)) {
          if (next[id]!.status === 'running') next[id] = { status: 'idle' }
        }
        return next
      })
    }
    es.addEventListener('done', finish)
    // A native EventSource "error" event (transient reconnect) carries no
    // `.data` : ignore it so a blip doesn't falsely mark the run finished.
    // Only a real server-sent error frame (which has `.data`) finishes.
    es.addEventListener('error', (e) => { if ('data' in e && (e as MessageEvent).data) finish() })
  }

  // Compute max wallMs for bar scaling (skip routing-only tests which have no gen time)
  const LLM_IDS = BENCH_IDS.filter(id => !id.startsWith('routing-'))
  const maxWall = Math.max(1, ...LLM_IDS.map(id => {
    const s = states[id]
    return s && (s.status === 'done' || s.status === 'error') ? (s as ChatBenchResult).wallMs : 0
  }))

  const anyResult = Object.values(states).some(s => s.status === 'done' || s.status === 'error')

  const baselineWall = (() => {
    const s = states['bare-llm']
    return s && (s.status === 'done' || s.status === 'error') ? (s as ChatBenchResult).wallMs : null
  })()

  const verdicts = anyResult && !running ? computeVerdicts(states) : []

  return (
    <div className="space-y-4 pt-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-muted-foreground" />
          <div>
            <span className="text-sm font-medium">Chat Benchmark</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              9 sequential LLM calls, progressively more context (non-streaming for reliable timing). Shows prefill, generation speed, and KV cache status.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {anyResult && !running && (
            <Button size="sm" variant="outline" onClick={reset}>
              <RotateCcw className="size-3 mr-1.5" />
              Reset
            </Button>
          )}
          {running ? (
            <Button size="sm" variant="outline" onClick={cancel}>Cancel</Button>
          ) : (
            <Button size="sm" onClick={runAll}>
              <PlayCircle className="size-3.5 mr-1.5" />
              Run Benchmark
            </Button>
          )}
        </div>
      </div>

      {/* Test rows */}
      <div className="space-y-1.5">
        {BENCH_IDS.map((id, i) => {
          const state = states[id] ?? { status: 'idle' }
          const result = (state.status === 'done' || state.status === 'error') ? state as ChatBenchResult : null
          const isRoutingOnly = id.startsWith('routing-')
          const barPct = result && !isRoutingOnly
            ? Math.max(3, Math.round((result.wallMs / maxWall) * 100))
            : 0
          const delta = result && baselineWall != null && id !== 'bare-llm' && !isRoutingOnly
            ? result.wallMs - baselineWall
            : null
          const kvCacheHit = id === 'kv-cache-2' && result?.prefillMs === 0

          return (
            <div key={id} className={cn(
              'rounded-lg border bg-card px-4 py-2.5 space-y-2',
              i === 5 && 'mt-3',  // visual gap before routing tests
            )}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  {state.status === 'running'
                    ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    : result?.error
                      ? <AlertCircle className="size-4 text-destructive" />
                      : result
                        ? kvCacheHit
                          ? <CheckCircle2 className="size-4 text-emerald-500" />
                          : <CheckCircle2 className="size-4 text-muted-foreground" />
                        : <Circle className="size-4 text-muted-foreground/40" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  {/* Label row */}
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium">{result?.label ?? id}</span>
                    {result && !isRoutingOnly && (
                      <span className="text-xs tabular-nums font-mono font-semibold text-foreground">
                        {fmt(result.wallMs)}
                      </span>
                    )}
                    {result && isRoutingOnly && (
                      <span className="text-xs tabular-nums font-mono text-foreground">
                        {fmt(result.wallMs)}
                      </span>
                    )}
                    {delta != null && (
                      <span className={cn(
                        'text-xs tabular-nums font-mono',
                        delta <= 100 ? 'text-muted-foreground' :
                        delta <= 500 ? 'text-amber-500' : 'text-destructive',
                      )}>
                        +{delta}ms vs bare
                      </span>
                    )}
                  </div>
                  {/* Metrics row */}
                  {result && !isRoutingOnly && (result.prefillMs != null || result.genMs != null || result.tps != null) && (
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {result.loadMs != null && result.loadMs > 0 && (
                        <span className="text-xs tabular-nums font-mono text-amber-500">
                          load {result.loadMs}ms
                        </span>
                      )}
                      {result.prefillMs != null && (
                        <span className={cn(
                          'text-xs tabular-nums font-mono',
                          result.prefillMs === 0 ? 'text-emerald-500 font-semibold' : 'text-muted-foreground',
                        )}>
                          prefill {result.prefillMs === 0 ? '0ms (cached)' : result.prefillMs + 'ms'}
                        </span>
                      )}
                      {result.genMs != null && (
                        <span className="text-xs tabular-nums font-mono text-muted-foreground">
                          gen {result.genMs}ms
                        </span>
                      )}
                      {result.tps != null && (
                        <span className={cn(
                          'text-xs tabular-nums font-mono font-medium',
                          result.tps < 8 ? 'text-destructive' :
                          result.tps < 18 ? 'text-amber-500' : 'text-muted-foreground',
                        )}>
                          {result.tps} tok/s
                        </span>
                      )}
                      {result.promptTokens != null && (
                        <span className="text-xs tabular-nums font-mono text-muted-foreground/70">
                          {result.promptTokens} in / {result.genTokens ?? '?'} out
                        </span>
                      )}
                    </div>
                  )}
                  {/* Description */}
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {BENCH_DESCRIPTIONS[id]}
                  </p>
                  {/* Detail (routing result or extra context info) */}
                  {result?.detail && (
                    <p className="text-xs font-mono text-muted-foreground mt-0.5">{result.detail}</p>
                  )}
                  {result?.error && (
                    <p className="text-xs font-mono text-destructive mt-0.5">{result.error}</p>
                  )}
                </div>
              </div>
              {/* Bar chart (LLM tests only) */}
              {result && !isRoutingOnly && barPct > 0 && (
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      result.error ? 'bg-destructive' :
                      kvCacheHit ? 'bg-emerald-500' :
                      id === 'bare-llm' ? 'bg-muted-foreground/60' : 'bg-primary/70',
                    )}
                    style={{ width: `${barPct}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Verdict */}
      {verdicts.length > 0 && (
        <div className="rounded-lg border bg-muted/40 px-4 py-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Diagnosis</p>
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => {
                navigator.clipboard.writeText(buildCopyText(states, verdicts)).then(() => {
                  setCopied(true)
                  if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
                  copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
                })
              }}
            >
              <Copy className="size-3" />
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {verdicts.map((v, i) => (
            <div key={i} className="flex items-start gap-2">
              {v.level === 'ok'
                ? <CheckCircle2 className="size-3.5 mt-0.5 shrink-0 text-emerald-500" />
                : v.level === 'warn'
                  ? <AlertCircle className="size-3.5 mt-0.5 shrink-0 text-amber-500" />
                  : <AlertCircle className="size-3.5 mt-0.5 shrink-0 text-destructive" />
              }
              <p className="text-xs leading-relaxed">{v.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Router Benchmark ─────────────────────────────────────────────────────────

interface RouterTestResult {
  id: string
  category: string
  prompt: string
  expectedTools: string[]
  actualTool: string | null
  actualArgs: Record<string, unknown>
  toolCorrect: boolean
  argsCorrect: boolean | null
  durationMs: number
  tier: 'T0' | 'T1' | 'T2' | 'unknown'
}

interface RouterSummary {
  total: number
  correct: number
  accuracyPct: number
  t2Count: number
  t2AvgMs: number | null
}

function RouterBenchmarkSection() {
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [results, setResults] = useState<RouterTestResult[]>([])
  const [summary, setSummary] = useState<RouterSummary | null>(null)
  const [running, setRunning] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    fetch('/api/models', { credentials: 'include' })
      .then(r => r.json())
      .then((models: Array<{ name: string }>) => {
        setAvailableModels(models.map(m => m.name))
      })
      .catch(() => {})
  }, [])

  // Close any open benchmark stream on unmount so it doesn't leak the
  // connection or fire setState after the component is gone.
  useEffect(() => () => { esRef.current?.close() }, [])

  function cancel() {
    esRef.current?.close()
    esRef.current = null
    setRunning(false)
  }

  function reset() {
    cancel()
    setResults([])
    setSummary(null)
  }

  function run() {
    esRef.current?.close()
    setResults([])
    setSummary(null)
    setRunning(true)

    const url = model.trim()
      ? `/api/admin/router-benchmark/stream?model=${encodeURIComponent(model.trim())}`
      : '/api/admin/router-benchmark/stream'
    const es = new EventSource(url, { withCredentials: true })
    esRef.current = es

    es.addEventListener('result', (e) => {
      let r: RouterTestResult
      try { r = JSON.parse(e.data) as RouterTestResult } catch { return } // skip malformed frame
      setResults(prev => [...prev, r])
    })

    es.addEventListener('summary', (e) => {
      try { setSummary(JSON.parse(e.data) as RouterSummary) } catch { /* malformed frame */ }
    })

    const finish = () => {
      es.close()
      esRef.current = null
      setRunning(false)
    }
    es.addEventListener('done', finish)
    // A native EventSource "error" event (transient reconnect) carries no
    // `.data` : ignore it so a blip doesn't falsely mark the run finished.
    es.addEventListener('error', (e) => { if ('data' in e && (e as MessageEvent).data) finish() })
  }

  // Group results by category for display
  const byCategory = results.reduce<Record<string, RouterTestResult[]>>((acc, r) => {
    ;(acc[r.category] ??= []).push(r)
    return acc
  }, {})

  const anyResult = results.length > 0

  return (
    <div className="space-y-4 pt-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <span className="text-sm font-medium">Router Accuracy Benchmark</span>
          <p className="text-xs text-muted-foreground mt-0.5">
            30 prompts with natural-language variations. Tests tool selection accuracy and T2 latency for any Ollama model.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {anyResult && !running && (
            <Button size="sm" variant="outline" onClick={reset}>
              <RotateCcw className="size-3 mr-1.5" />Reset
            </Button>
          )}
          {running
            ? <Button size="sm" variant="outline" onClick={cancel}>Cancel</Button>
            : <Button size="sm" onClick={run}>
                <PlayCircle className="size-3.5 mr-1.5" />Run
              </Button>
          }
        </div>
      </div>

      {/* Model picker */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground whitespace-nowrap">Router model</label>
        <input
          list="router-model-list"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder="leave blank to test T1 only (no LLM)"
          className="flex-1 h-7 rounded border bg-background px-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <datalist id="router-model-list">
          {availableModels.map(m => <option key={m} value={m} />)}
        </datalist>
      </div>

      {/* Summary bar */}
      {summary && (
        <div className="rounded-lg border bg-muted/40 px-4 py-2.5 flex flex-wrap gap-4 items-center">
          <div className="text-center">
            <p className={cn(
              'text-2xl font-bold tabular-nums',
              summary.accuracyPct >= 90 ? 'text-emerald-500' :
              summary.accuracyPct >= 70 ? 'text-amber-500' : 'text-destructive',
            )}>
              {summary.accuracyPct}%
            </p>
            <p className="text-xs text-muted-foreground">{summary.correct}/{summary.total} correct</p>
          </div>
          {summary.t2AvgMs != null && (
            <div className="text-center">
              <p className={cn(
                'text-2xl font-bold tabular-nums',
                summary.t2AvgMs < 300 ? 'text-emerald-500' :
                summary.t2AvgMs < 1000 ? 'text-amber-500' : 'text-destructive',
              )}>
                {fmt(summary.t2AvgMs)}
              </p>
              <p className="text-xs text-muted-foreground">T2 avg ({summary.t2Count} calls)</p>
            </div>
          )}
          {!model.trim() && (
            <p className="text-xs text-muted-foreground italic">T1-only run — no model set, T2 fell back to null</p>
          )}
        </div>
      )}

      {/* Results grouped by category */}
      {Object.entries(byCategory).map(([cat, rows]) => (
        <div key={cat} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">{cat}</p>
          {rows.map(r => {
            const passed = r.toolCorrect && r.argsCorrect !== false
            return (
              <div key={r.id} className={cn(
                'rounded-md border px-3 py-2 flex items-start gap-2.5',
                passed ? 'bg-card' : 'bg-destructive/5 border-destructive/30',
              )}>
                <div className="mt-0.5 shrink-0">
                  {running && results.length < 30 && results.at(-1)?.id === r.id
                    ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    : passed
                      ? <CheckCircle2 className="size-3.5 text-emerald-500" />
                      : <AlertCircle className="size-3.5 text-destructive" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-mono text-foreground">&ldquo;{r.prompt}&rdquo;</span>
                    <span className={cn(
                      'text-xs tabular-nums font-mono',
                      r.tier === 'T2' ? 'text-amber-500' : 'text-muted-foreground/60',
                    )}>
                      {r.tier} {r.durationMs}ms
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {r.expectedTools.length === 0
                      ? <span className="text-xs text-muted-foreground">expected: null</span>
                      : <span className="text-xs text-muted-foreground">expected: {r.expectedTools.join(' | ')}</span>
                    }
                    <span className="text-xs text-muted-foreground/40">→</span>
                    <span className={cn(
                      'text-xs font-mono',
                      r.toolCorrect ? 'text-foreground' : 'text-destructive font-semibold',
                    )}>
                      {r.actualTool ?? 'null'}
                    </span>
                    {r.actualTool && Object.keys(r.actualArgs).length > 0 && (
                      <span className="text-xs font-mono text-muted-foreground">
                        {JSON.stringify(r.actualArgs)}
                      </span>
                    )}
                    {r.argsCorrect === false && (
                      <span className="text-xs text-amber-500">args mismatch</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export function AdminTroubleshootingTab() {
  const [layers, setLayers] = useState<Record<string, LayerState>>(INITIAL_STATE)
  const [globalRunning, setGlobalRunning] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  // Close any open latency-test stream on unmount so it doesn't leak the
  // connection or fire setState after the component is gone.
  useEffect(() => () => { esRef.current?.close() }, [])

  function maxDuration(states: Record<string, LayerState>): number {
    return Math.max(1, ...Object.values(states).map(s => s.durationMs ?? 0))
  }

  function cancel() {
    esRef.current?.close()
    esRef.current = null
    setGlobalRunning(false)
    setLayers(prev => {
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        if (next[id]!.status === 'running') next[id] = { status: 'idle' }
      }
      return next
    })
  }

  function runLayers(ids: string[]) {
    esRef.current?.close()

    // Mark targeted layers as running, keep others unchanged
    setLayers(prev => {
      const next = { ...prev }
      for (const id of ids) next[id] = { status: 'running' }
      return next
    })
    setGlobalRunning(true)

    const url = `/api/admin/latency-test/stream?layers=${ids.join(',')}`
    const es = new EventSource(url, { withCredentials: true })
    esRef.current = es

    es.addEventListener('result', (e) => {
      let result: LatencyResult
      try { result = JSON.parse(e.data) as LatencyResult } catch { return } // skip malformed frame
      setLayers(prev => ({
        ...prev,
        [result.id]: { status: result.status, durationMs: result.durationMs, detail: result.detail },
      }))
    })

    const finish = () => {
      es.close()
      esRef.current = null
      setGlobalRunning(false)
    }
    es.addEventListener('done', finish)
    // A native EventSource "error" event (transient reconnect) carries no
    // `.data` : ignore it so a blip doesn't falsely mark the run finished.
    es.addEventListener('error', (e) => { if ('data' in e && (e as MessageEvent).data) finish() })
  }

  function runAll() {
    setLayers(Object.fromEntries(LAYERS.map(l => [l.id, { status: 'running' as LayerStatus }])))
    setGlobalRunning(true)

    esRef.current?.close()
    const es = new EventSource('/api/admin/latency-test/stream', { withCredentials: true })
    esRef.current = es

    es.addEventListener('result', (e) => {
      let result: LatencyResult
      try { result = JSON.parse(e.data) as LatencyResult } catch { return } // skip malformed frame
      setLayers(prev => ({
        ...prev,
        [result.id]: { status: result.status, durationMs: result.durationMs, detail: result.detail },
      }))
    })

    const finish = () => {
      es.close()
      esRef.current = null
      setGlobalRunning(false)
    }
    es.addEventListener('done', finish)
    // A native EventSource "error" event (transient reconnect) carries no
    // `.data` : ignore it so a blip doesn't falsely mark the run finished.
    es.addEventListener('error', (e) => { if ('data' in e && (e as MessageEvent).data) finish() })
  }

  function reset() {
    cancel()
    setLayers(INITIAL_STATE)
  }

  const max = maxDuration(layers)
  const anyResult = Object.values(layers).some(s => s.status !== 'idle' && s.status !== 'running')

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Runs each layer of the response pipeline independently and times it. Use this to pinpoint where latency is coming from.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {anyResult && !globalRunning && (
            <Button size="sm" variant="outline" onClick={reset}>
              <RotateCcw className="size-3 mr-1.5" />
              Reset
            </Button>
          )}
          {globalRunning ? (
            <Button size="sm" variant="outline" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" onClick={runAll}>
              <PlayCircle className="size-3.5 mr-1.5" />
              Run All
            </Button>
          )}
        </div>
      </div>

      {/* Layer list */}
      <div className="space-y-2">
        {LAYERS.map(layer => {
          const state = layers[layer.id] ?? { status: 'idle' }
          return (
            <LayerRow
              key={layer.id}
              layer={layer}
              state={state}
              max={max}
              globalRunning={globalRunning}
              onRun={() => runLayers([layer.id])}
            />
          )
        })}
      </div>

      {/* Divider */}
      <div className="border-t" />

      {/* Chat Benchmark */}
      <ChatBenchmarkSection />

      {/* Divider */}
      <div className="border-t" />

      {/* Router Benchmark */}
      <RouterBenchmarkSection />

    </div>
  )
}

// ─── LayerRow ─────────────────────────────────────────────────────────────────

function LayerRow({
  layer,
  state,
  max,
  globalRunning,
  onRun,
}: {
  layer: LayerDef
  state: LayerState
  max: number
  globalRunning: boolean
  onRun: () => void
}) {
  const barPct = state.durationMs != null ? Math.max(2, Math.round((state.durationMs / max) * 100)) : 0

  return (
    <div className="rounded-lg border bg-card px-4 py-3 space-y-2">
      <div className="flex items-start gap-3">
        {/* Status icon */}
        <div className="mt-0.5 shrink-0">
          <StatusIcon status={state.status} />
        </div>

        {/* Label + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{layer.label}</span>
            {state.durationMs != null && (
              <span className={cn(
                'text-xs tabular-nums font-mono',
                state.status === 'ok' ? 'text-muted-foreground' :
                state.status === 'warn' ? 'text-amber-500' :
                state.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}>
                {fmt(state.durationMs)}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{layer.description}</p>
          {state.detail && (
            <p className={cn(
              'text-xs mt-1 font-mono',
              state.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}>
              {state.detail}
            </p>
          )}
        </div>

        {/* Run button */}
        <button
          className="shrink-0 mt-0.5 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title="Run this test"
          disabled={globalRunning}
          onClick={onRun}
          aria-label={`Run ${layer.label}`}
        >
          <Play className="size-3" />
        </button>
      </div>

      {/* Timing bar */}
      {state.durationMs != null && state.status !== 'running' && (
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              state.status === 'ok' ? 'bg-emerald-500' :
              state.status === 'warn' ? 'bg-amber-400' : 'bg-destructive',
            )}
            style={{ width: `${barPct}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: LayerStatus }) {
  switch (status) {
    case 'running': return <Loader2 className="size-4 animate-spin text-muted-foreground" />
    case 'ok':      return <CheckCircle2 className="size-4 text-emerald-500" />
    case 'warn':    return <AlertCircle className="size-4 text-amber-500" />
    case 'error':   return <AlertCircle className="size-4 text-destructive" />
    default:        return <Circle className="size-4 text-muted-foreground/40" />
  }
}

function fmt(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms}ms`
}
