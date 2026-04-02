import { VoiceStreamer } from "@/utils/VoiceStreamer"

export type VoicePipelineStatus = "idle" | "connecting" | "streaming" | "speaking" | "error"

type VoicePipelineCallbacks = {
  onVisemeChange?: (viseme: string) => void
  onStatusChange?: (status: VoicePipelineStatus) => void
  onFirstChunk?: () => void
  onPlaybackStart?: () => void
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
  onError?: (message: string) => void
}

type StartSpeechOptions = {
  text: string
  token: string
  voiceId?: string
  signal?: AbortSignal
}

export class VoicePipeline {
  private readonly streamer: VoiceStreamer
  private readonly callbacks: VoicePipelineCallbacks
  private status: VoicePipelineStatus = "idle"
  private controller: AbortController | null = null

  constructor(callbacks: VoicePipelineCallbacks = {}) {
    this.callbacks = callbacks
    this.streamer = new VoiceStreamer(
      (viseme) => {
        this.callbacks.onVisemeChange?.(viseme)
      },
      () => {
        this.setStatus("idle")
        this.callbacks.onSpeechEnd?.()
      }
    )
  }

  async prepare(): Promise<void> {
    await this.streamer.prepare()
  }

  async startSpeech({ text, token, voiceId, signal }: StartSpeechOptions): Promise<void> {
    this.stopSpeech()
    this.setStatus("connecting")

    const controller = new AbortController()
    this.controller = controller
    const teardown = relayAbort(signal, controller)
    let started = false

    try {
      await this.streamer.stream(text, {
        token,
        voiceId,
        signal: controller.signal,
        onChunkScheduled: () => {
          if (!started) {
            started = true
            this.callbacks.onFirstChunk?.()
            this.callbacks.onSpeechStart?.()
          }
          this.setStatus("streaming")
        },
        onPlaybackStart: () => {
          this.callbacks.onPlaybackStart?.()
          this.setStatus("speaking")
        },
      })
    } catch (error) {
      if (isAbortError(error)) {
        this.setStatus("idle")
        return
      }
      this.setStatus("error")
      this.callbacks.onError?.(error instanceof Error ? error.message : "Voice streaming failed.")
      throw error
    } finally {
      teardown()
      if (this.controller === controller) {
        this.controller = null
      }
    }
  }

  stopSpeech(): void {
    this.controller?.abort()
    this.controller = null
    this.streamer.stop()
    this.setStatus("idle")
  }

  async destroy(): Promise<void> {
    this.stopSpeech()
    await this.streamer.destroy()
  }

  private setStatus(nextStatus: VoicePipelineStatus): void {
    if (this.status === nextStatus) {
      return
    }
    this.status = nextStatus
    this.callbacks.onStatusChange?.(nextStatus)
  }
}

function relayAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => {}
  }
  if (signal.aborted) {
    controller.abort()
    return () => {}
  }
  const handleAbort = () => controller.abort()
  signal.addEventListener("abort", handleAbort)
  return () => signal.removeEventListener("abort", handleAbort)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}
