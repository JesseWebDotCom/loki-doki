import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { createBunWebSocket } from 'hono/bun'
import { resolveSession } from '@/middleware/auth'
import { SttSession } from '@/lib/voice/sttSession'
import type { AppEnv } from '@/types'

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket']

interface HelloMsg {
  t: 'hello'
  sample_rate?: number
  silence_timeout_s?: number
  partial_interval_s?: number
  hotwords?: string
}

// WS /api/stt/stream — browser streams f32le PCM frames after a `hello` envelope;
// the server runs VAD endpointing + whisper.cpp and streams transcripts back.
// The FSM (frontend) submits the final transcript through the normal chat path,
// so this route is "just STT" — no LLM brains here.
export function createSttRoute(upgradeWebSocket: UpgradeWebSocket) {
  const stt = new Hono<AppEnv>()

  stt.get(
    '/stream',
    upgradeWebSocket(async (c) => {
      // Resolve the session cookie at upgrade time — middleware doesn't run on
      // the upgraded socket. Close with 4401 if unauthenticated.
      const token = getCookie(c, 'session')
      const user = token ? await resolveSession(token) : null

      let session: SttSession | null = null

      return {
        onOpen(_evt, ws) {
          if (!user) {
            try {
              ws.close(4401, 'unauthorized')
            } catch {
              /* ignore */
            }
            return
          }
          ws.send(JSON.stringify({ t: 'ready', seq: 0 }))
        },
        onMessage(evt, ws) {
          if (!user) return
          const data = evt.data
          if (typeof data === 'string') {
            let msg: { t?: string }
            try {
              msg = JSON.parse(data)
            } catch {
              return
            }
            if (msg.t === 'hello') {
              const h = msg as HelloMsg
              session = new SttSession(
                {
                  sampleRate: h.sample_rate ?? 16000,
                  silenceTimeoutS: h.silence_timeout_s ?? 0.7,
                  partialIntervalS: h.partial_interval_s ?? 0.4,
                  hotwords: h.hotwords ?? '',
                },
                (out) => {
                  try {
                    ws.send(JSON.stringify(out))
                  } catch {
                    /* socket closed */
                  }
                },
              )
            } else if (msg.t === 'end' || msg.t === 'flush') {
              session?.end()
            }
            return
          }
          // Binary frame → f32le mono PCM.
          if (!session) return
          const ab =
            data instanceof ArrayBuffer
              ? data
              : ArrayBuffer.isView(data)
                ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
                : null
          if (!ab) return
          session.pushPcm(new Float32Array(ab))
        },
        onClose() {
          session?.close()
          session = null
        },
      }
    }),
  )

  return stt
}
