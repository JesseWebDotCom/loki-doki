import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createConnection } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'bun'
import { logger } from '@/lib/logger'

export const ollamaUrl = () => process.env.OLLAMA_URL ?? 'http://localhost:11434'

// A connected-but-silent Ollama would otherwise hang the caller forever and,
// for chat jobs, never free the genQueue slot. These bound that wait.
//  - CHAT: total wall-clock cap for the non-streaming request/response.
//  - STREAM_IDLE: inactivity cap for streams (resets on every byte received),
//    so long generations are fine but a stalled socket is killed.
const OLLAMA_CHAT_TIMEOUT_MS = 120_000
const OLLAMA_STREAM_IDLE_MS = 60_000
// Generous deadline for the FIRST byte: a cold model load into VRAM can take a
// while before any token appears, and that gap must not count as a stall.
const OLLAMA_FIRST_BYTE_MS = 300_000

export interface OllamaModel {
  name: string
  size: number
  digest: string
  modified_at: string
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  images?: string[] // base64-encoded image data (no data: prefix), vision models only
}

export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface OllamaChatChunk {
  model: string
  message: OllamaChatMessage
  done: boolean
  done_reason?: string
  // Stats present only on the final done=true chunk
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  total_duration?: number
  load_duration?: number
}

export async function ollamaHealthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function ollamaList(): Promise<OllamaModel[]> {
  const res = await fetch(`${ollamaUrl()}/api/tags`)
  if (!res.ok) throw new Error('Failed to list Ollama models')
  const data = (await res.json()) as { models: OllamaModel[] }
  return data.models
}

export async function ollamaEmbed(model: string, input: string): Promise<number[]> {
  const res = await fetch(`${ollamaUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, keep_alive: -1 }),
  })
  if (!res.ok) throw new Error('Embedding request failed')
  const data = (await res.json()) as { embeddings: number[][] }
  const embedding = data.embeddings[0]
  if (!embedding) throw new Error('Empty embedding response')
  return embedding
}

export async function ollamaChat(
  model: string,
  messages: OllamaChatMessage[],
  tools?: OllamaTool[],
  options?: Record<string, unknown>,
  format?: unknown,
): Promise<OllamaChatChunk> {
  const res = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(OLLAMA_CHAT_TIMEOUT_MS),
    // think: false — Gemma 4 and other thinking models spend hidden tokens on reasoning
    // before emitting visible content. With num_predict capped those tokens get consumed
    // before any content appears, producing silent/empty responses. Disable it globally.
    body: JSON.stringify({ model, messages, tools, stream: false, keep_alive: -1, options, think: false, ...(format !== undefined && { format }) }),
  })
  if (!res.ok) throw new Error('Chat request failed')
  return res.json() as Promise<OllamaChatChunk>
}

// Uses Bun.connect (raw TCP) to completely bypass Bun's HTTP client stack.
// Both Bun's `fetch` and its `node:http` compat layer share the same internal
// buffer that holds ~80% of generation before emitting any data. With a raw
// TCP socket the `data` callback fires on every segment Ollama sends, giving
// true per-token streaming. Falls back to node:http for HTTPS.
export function ollamaChatStream(
  model: string,
  messages: OllamaChatMessage[],
  options?: Record<string, unknown>,
): AsyncGenerator<OllamaChatChunk> {
  const payload = JSON.stringify({ model, messages, stream: true, keep_alive: -1, options, think: false })
  const base = new URL(ollamaUrl())

  // HTTPS falls back to node:http — Bun.connect TLS needs cert config
  if (base.protocol === 'https:') {
    return nodeHttpChatStream(payload, base)
  }

  const host = base.hostname
  const port = base.port ? parseInt(base.port) : 11434

  const queue: (OllamaChatChunk | Error | null)[] = []
  let notify: (() => void) | null = null
  // Diagnostic counters. After the stream closes, log shows:
  //   tcp_segs=N  — TCP data() callbacks fired
  //   ndjson_chunks=M  — JSON objects emitted
  // If tcp_segs << ndjson_chunks (e.g. 1-2 segs for 100 chunks), data is batched by
  // Ollama or kernel. tcp_segs ≈ ndjson_chunks means true per-token streaming.
  let tcpSegs = 0
  let ndjsonChunks = 0
  function push(item: OllamaChatChunk | Error | null) {
    if (item !== null && !(item instanceof Error)) ndjsonChunks++
    queue.push(item)
    notify?.()
    notify = null
  }

  const httpReq =
    `POST /api/chat HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    `Connection: close\r\n` +
    `\r\n` +
    payload

  const decoder = new TextDecoder()
  let headerBuf = ''    // accumulates bytes until \r\n\r\n
  let headersDone = false
  let isChunked = false
  let chunkedBuf = ''   // unparsed bytes after headers (chunked frame parser state)
  let ndjsonBuf = ''    // partial NDJSON line

  function emitLines(text: string) {
    ndjsonBuf += text
    const lines = ndjsonBuf.split('\n')
    ndjsonBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) {
        try { push(JSON.parse(line) as OllamaChatChunk) } catch { /* skip malformed */ }
      }
    }
  }

  // Parses HTTP/1.1 chunked transfer encoding.
  // Each chunk: <hex-size>\r\n<data>\r\n  — terminal chunk is 0\r\n\r\n
  function parseChunked(raw: string) {
    chunkedBuf += raw
    while (chunkedBuf.length > 0) {
      const crlfIdx = chunkedBuf.indexOf('\r\n')
      if (crlfIdx === -1) break
      const chunkSize = parseInt(chunkedBuf.slice(0, crlfIdx), 16)
      if (isNaN(chunkSize)) { push(new Error('Bad chunked encoding')); return }
      if (chunkSize === 0) {
        // Flush any partial NDJSON line that arrived without a trailing \n
        // (Ollama's final done:true chunk sometimes omits it). Must happen
        // before push(null) or the generator ends before consuming it.
        if (ndjsonBuf.trim()) {
          try { push(JSON.parse(ndjsonBuf) as OllamaChatChunk) } catch {}
          ndjsonBuf = ''
        }
        push(null)
        return
      }
      const dataStart = crlfIdx + 2
      const dataEnd   = dataStart + chunkSize
      if (chunkedBuf.length < dataEnd + 2) break               // wait for more data
      emitLines(chunkedBuf.slice(dataStart, dataEnd))
      chunkedBuf = chunkedBuf.slice(dataEnd + 2)               // skip trailing \r\n
    }
  }

  // node:net with noDelay:true — disables Nagle on our socket and suppresses
  // macOS delayed-ACK (200ms timer) that causes the remote to batch tokens while
  // waiting for acknowledgment. Bun.connect has no equivalent option.
  const sock = createConnection({ host, port, noDelay: true })

  // Two-phase guard so a hung Ollama can't make the generator await forever, while
  // a slow cold-start (no first token yet) isn't mistaken for a stall: a generous
  // deadline for the first byte, then a tight inactivity timeout once tokens flow.
  let firstByteSeen = false
  const firstByteTimer = setTimeout(() => {
    push(new Error('Ollama did not respond in time'))
    sock.destroy()
  }, OLLAMA_FIRST_BYTE_MS)
  sock.on('timeout', () => {
    push(new Error('Ollama stream stalled'))
    sock.destroy()
  })

  sock.on('connect', () => { sock.write(httpReq) })

  sock.on('data', (raw: Buffer) => {
    if (!firstByteSeen) {
      firstByteSeen = true
      clearTimeout(firstByteTimer)
      sock.setTimeout(OLLAMA_STREAM_IDLE_MS) // fires the 'timeout' handler above
    }
    tcpSegs++
    const text = decoder.decode(raw, { stream: true })

    if (!headersDone) {
      headerBuf += text
      const sep = headerBuf.indexOf('\r\n\r\n')
      if (sep === -1) return

      const headers = headerBuf.slice(0, sep)
      const body    = headerBuf.slice(sep + 4)
      headerBuf = ''

      const statusCode = parseInt((headers.split('\r\n')[0] ?? '').split(' ')[1] ?? '0')
      if (statusCode >= 400) { push(new Error(`Chat stream failed: ${statusCode}`)); return }

      isChunked = /transfer-encoding:\s*chunked/i.test(headers)
      headersDone = true

      if (body.length > 0) {
        if (isChunked) parseChunked(body)
        else emitLines(body)
      }
      return
    }

    if (isChunked) parseChunked(text)
    else emitLines(text)
  })

  sock.on('error', (err: Error) => { clearTimeout(firstByteTimer); push(err) })

  sock.on('close', () => {
    clearTimeout(firstByteTimer)
    if (ndjsonBuf.trim()) {
      try { push(JSON.parse(ndjsonBuf) as OllamaChatChunk) } catch {}
    }
    // tcp_segs ≈ ndjson_chunks → true per-token streaming.
    // tcp_segs << ndjson_chunks → Ollama is batching tokens into large chunks.
    logger.info(`[OLLAMA-TCP] tcp_segs=${tcpSegs} ndjson_chunks=${ndjsonChunks}`)
    push(null)
  })

  return (async function* () {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => { notify = r })
      }
      const item = queue.shift()!
      if (item === null) return
      if (item instanceof Error) throw item
      yield item
    }
  })()
}

// HTTPS fallback — kept for remote Ollama endpoints behind TLS proxies
function nodeHttpChatStream(
  payload: string,
  base: URL,
): AsyncGenerator<OllamaChatChunk> {
  const isHttps  = base.protocol === 'https:'
  const requester = isHttps ? httpsRequest : httpRequest
  const port     = base.port ? parseInt(base.port) : (isHttps ? 443 : 80)

  const queue: (OllamaChatChunk | Error | null)[] = []
  let notify: (() => void) | null = null
  function push(item: OllamaChatChunk | Error | null) {
    queue.push(item)
    notify?.()
    notify = null
  }

  const req = requester(
    { hostname: base.hostname, port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (res: IncomingMessage) => {
      if ((res.statusCode ?? 0) >= 400) { push(new Error(`Chat stream failed: ${res.statusCode}`)); return }
      const decoder = new TextDecoder()
      let buf = ''
      res.on('data', (chunk: Buffer) => {
        buf += decoder.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) {
            try { push(JSON.parse(line) as OllamaChatChunk) } catch {}
          }
        }
      })
      res.on('end', () => push(null))
      res.on('error', (err: Error) => push(err))
    },
  )
  req.on('error', (err: Error) => push(err))
  req.on('socket', (sock) => (sock as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true))
  // Socket inactivity timeout (resets on each chunk). Generous enough to cover a
  // cold model load before the first byte, then bounds any mid-stream stall.
  req.setTimeout(OLLAMA_FIRST_BYTE_MS, () => {
    push(new Error('Ollama stream timed out (no data)'))
    req.destroy()
  })
  req.write(payload)
  req.end()

  return (async function* () {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((r) => { notify = r })
      }
      const item = queue.shift()!
      if (item === null) return
      if (item instanceof Error) throw item
      yield item
    }
  })()
}
