// STT WebSocket transport for hands-free capture. Ported from v2, decoupled from
// v2's zustand stores/FSM — this is pure transport. The hands-free hook supplies
// callbacks and decides stop-phrase matching, submit, FSM transitions.
//
// Opens /api/stt/stream, ships the `hello` envelope, ships outbound f32le PCM
// frames, and fans server messages (ready/partial/final/vad/no_speech) back to
// the caller's handlers.

export interface SttCaptureHandlers {
  onReady?(): void
  onPartial?(text: string): void
  /** `whispered`: this utterance's average RMS (over genuine speech, not preroll/
   *  hangover) was below the auto whisper-match threshold (design: keen-
   *  percolating-swan). A weak, untuned signal; see sttSession.ts's caveats. */
  onFinal?(text: string, whispered: boolean): void
  onVad?(speaking: boolean, rms: number): void
  onNoSpeech?(): void
  onError?(msg: string): void
  onClose?(): void
}

export interface SttCaptureConfig {
  sttModel?: string
  silenceTimeoutS?: number
  partialIntervalS?: number
  hotwords?: string
}

export class SttCapture {
  private ws: WebSocket | null = null

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  open(handlers: SttCaptureHandlers, config: SttCaptureConfig = {}): boolean {
    if (this.ws) return false
    let ws: WebSocket
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${window.location.host}/api/stt/stream`)
    } catch (err) {
      console.warn('[stt] ws construction failed', err)
      return false
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          sample_rate: 16000,
          format: 'f32le',
          stt_model: config.sttModel ?? 'base.en',
          silence_timeout_s: config.silenceTimeoutS ?? 0.7,
          partial_interval_s: config.partialIntervalS ?? 0.4,
          hotwords: config.hotwords ?? '',
        }),
      )
    }

    ws.onmessage = (event) => {
      let data: { t?: string; v?: unknown; speaking?: unknown; rms?: unknown; whispered?: unknown }
      try {
        data = JSON.parse(String(event.data))
      } catch {
        return
      }
      switch (data.t) {
        case 'ready':
          handlers.onReady?.()
          break
        case 'partial':
          handlers.onPartial?.(String(data.v ?? '').trim())
          break
        case 'final':
          handlers.onFinal?.(String(data.v ?? '').trim(), data.whispered === true)
          this.close()
          break
        case 'vad':
          handlers.onVad?.(data.speaking === true, Number(data.rms ?? 0))
          break
        case 'no_speech':
          handlers.onNoSpeech?.()
          this.close()
          break
        case 'error':
          handlers.onError?.(String(data.v ?? 'stt_error'))
          break
      }
    }

    ws.onerror = (err) => console.warn('[stt] ws error', err)
    ws.onclose = () => {
      this.ws = null
      handlers.onClose?.()
    }
    return true
  }

  /** Ship a mono Float32 PCM frame (f32le). */
  sendFrame(samples: Float32Array): void {
    if (this.isOpen) {
      this.ws!.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength))
    }
  }

  end(): void {
    if (this.isOpen) {
      try {
        this.ws!.send(JSON.stringify({ t: 'end' }))
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
}
