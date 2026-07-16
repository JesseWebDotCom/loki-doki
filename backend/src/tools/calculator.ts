import type { Tool, ToolResult } from './index'

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI }

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { const t = b; b = a % b; a = t }
  return a
}

const FUNCS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  log: Math.log10, log2: Math.log2, log10: Math.log10, ln: Math.log, exp: Math.exp,
  pow: Math.pow, min: Math.min, max: Math.max, sign: Math.sign,
  gcd,
  lcm: (a, b) => Math.abs(a * b) / gcd(a, b),
  factorial: (n) => {
    if (n < 0 || !Number.isInteger(n)) throw new Error('Factorial requires a non-negative integer')
    if (n > 170) throw new Error('Factorial overflow')
    let r = 1; for (let i = 2; i <= n; i++) r *= i; return r
  },
}

type TKind = 'num' | 'id' | '+' | '-' | '*' | '/' | '%' | '^' | '(' | ')' | ',' | 'eof'
interface Token { kind: TKind; value: string }

function normalize(raw: string): string {
  let s = raw.trim().replace(/[?.]+$/, '')
  s = s.replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
  s = s.replace(/\*\*/g, '^').replace(/√\s*/g, 'sqrt ').replace(/π/g, 'pi')
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/gi, '($1/100)*$2')
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
  return s
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < input.length && input[i + 1] >= '0' && input[i + 1] <= '9')) {
      let j = i
      while (j < input.length && ((input[j] >= '0' && input[j] <= '9') || input[j] === '.')) j++
      if (j < input.length && (input[j] === 'e' || input[j] === 'E')) {
        const saved = j++
        if (j < input.length && (input[j] === '+' || input[j] === '-')) j++
        const ds = j
        while (j < input.length && input[j] >= '0' && input[j] <= '9') j++
        if (j === ds) j = saved
      }
      tokens.push({ kind: 'num', value: input.slice(i, j) }); i = j; continue
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i
      while (j < input.length && ((input[j] >= 'a' && input[j] <= 'z') || (input[j] >= 'A' && input[j] <= 'Z') || (input[j] >= '0' && input[j] <= '9') || input[j] === '_')) j++
      tokens.push({ kind: 'id', value: input.slice(i, j).toLowerCase() }); i = j; continue
    }

    const single: Record<string, TKind> = { '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '^': '^', '(': '(', ')': ')', ',': ',' }
    if (ch in single) { tokens.push({ kind: single[ch], value: ch }); i++; continue }

    throw new Error(`Unexpected character: '${ch}'`)
  }
  tokens.push({ kind: 'eof', value: '' })
  return tokens
}

class CalcParser {
  private pos = 0
  constructor(private tokens: Token[]) {}
  private peek(): TKind { return this.tokens[this.pos].kind }
  private val(): string { return this.tokens[this.pos].value }
  private advance(): Token { return this.tokens[this.pos++] }
  private expect(k: TKind): void { if (this.peek() !== k) throw new Error(`Expected '${k}', got '${this.val()}'`); this.advance() }

  parse(): number {
    const r = this.expr()
    if (this.peek() !== 'eof') throw new Error(`Unexpected: '${this.val()}'`)
    return r
  }

  private expr(): number {
    let v = this.term()
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.advance().kind; const r = this.term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  private term(): number {
    let v = this.power()
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.advance().kind; const r = this.power()
      if (op === '*') v *= r
      else if (op === '/') { if (r === 0) throw new Error('Division by zero'); v /= r }
      else v %= r
    }
    return v
  }

  private power(): number {
    const base = this.unary()
    if (this.peek() === '^') { this.advance(); return Math.pow(base, this.power()) }
    return base
  }

  private unary(): number {
    if (this.peek() === '-') { this.advance(); return -this.primary() }
    if (this.peek() === '+') { this.advance(); return this.primary() }
    return this.primary()
  }

  private primary(): number {
    if (this.peek() === 'num') {
      const n = parseFloat(this.advance().value)
      if (isNaN(n)) throw new Error('Invalid number')
      return n
    }
    if (this.peek() === '(') {
      this.advance(); const v = this.expr(); this.expect(')'); return v
    }
    if (this.peek() === 'id') {
      const name = this.advance().value
      if (this.peek() === '(') {
        this.advance()
        const args: number[] = []
        if (this.peek() !== ')') {
          args.push(this.expr())
          while (this.peek() === ',') { this.advance(); args.push(this.expr()) }
        }
        this.expect(')')
        const fn = FUNCS[name]
        if (!fn) throw new Error(`Unknown function: ${name}`)
        return fn(...args)
      }
      if (name in CONSTS) return CONSTS[name]
      throw new Error(`Unknown identifier: ${name}`)
    }
    throw new Error(`Unexpected: '${this.val()}'`)
  }
}

function fmtResult(n: number): string {
  if (!isFinite(n)) return String(n)
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  return parseFloat(n.toPrecision(10)).toString()
}

function safeEval(expression: string): { result: number; normalized: string; resultStr: string } {
  const normalized = normalize(expression)
  const tokens = tokenize(normalized)
  const result = new CalcParser(tokens).parse()
  return { result, normalized, resultStr: fmtResult(result) }
}

export const calculatorTool: Tool = {
  id: 'calculator',
  name: 'Calculator',
  description: 'Evaluate math expressions: arithmetic, percentages, powers, and common math functions',
  offline: true,
  core: true,
  dataSources: [],
  examples: [
    'perform arithmetic, algebra, or math calculations',
    'compute a percentage, tip, or split of a dollar amount',
    'evaluate a numeric expression or equation',
    'do the math on a financial estimate or savings calculation',
    'calculate square roots, powers, or trigonometric functions',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a math expression. Supports +, -, *, /, % (modulo), ^ (power), parentheses, functions (sqrt, sin, cos, log, etc.), and constants (pi, e, tau).',
      parameters: {
        type: 'object',
        required: ['expression'],
        properties: {
          expression: {
            type: 'string',
            description: 'Math expression to evaluate, e.g. "sqrt(144)" or "15/100 * 250". Compute the exact quantity asked for: a tip question wants the tip amount ("20% of 85"), not the total.',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { expression } = args as { expression: string }
    if (!expression?.trim()) return { success: false, error: 'Expression is required' }
    try {
      const { result, normalized, resultStr } = safeEval(expression.trim())
      return {
        success: true,
        data: {
          expression: expression.trim(),
          normalized,
          result,
          result_str: resultStr,
          answer_payload: { gist: `${expression.trim()} = ${resultStr}` },
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Invalid expression' }
    }
  },
}
