import { detectVoice } from "@/utils/VoiceDetector"

type SpeechRecognitionConstructor = new () => SpeechRecognition
type BrowserVoice = SpeechSynthesisVoice
type SpeechCallbacks = {
  onStart?: () => void
  onEnd?: () => void
  onError?: (message: string) => void
}

type SpeechRecognitionEventLike = Event & {
  results: SpeechRecognitionResultList
}

type SpeechRecognitionErrorEventLike = Event & {
  error?: string
  message?: string
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }

  interface SpeechRecognition extends EventTarget {
    continuous: boolean
    interimResults: boolean
    lang: string
    onend: ((event: Event) => void) | null
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
    onresult: ((event: SpeechRecognitionEventLike) => void) | null
    start(): void
    stop(): void
  }

  interface SpeechRecognitionAlternative {
    transcript: string
  }

  interface SpeechRecognitionResult {
    isFinal: boolean
    length: number
    [index: number]: SpeechRecognitionAlternative
  }

  interface SpeechRecognitionResultList {
    length: number
    [index: number]: SpeechRecognitionResult
  }
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null
  }
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

export function supportsVoiceInput(): boolean {
  return speechRecognitionConstructor() !== null
}

export function supportsVoiceOutput(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined"
}

export function listVoiceOutputOptions(): BrowserVoice[] {
  if (!supportsVoiceOutput()) {
    return []
  }
  return window.speechSynthesis.getVoices()
}

export function createPushToTalkRecognizer(
  onTranscript: (text: string) => void,
  onError: (message: string) => void,
  onListeningChange: (listening: boolean) => void
): { start: () => void; stop: () => void } | null {
  const Recognition = speechRecognitionConstructor()
  if (!Recognition) {
    return null
  }

  const recognition = new Recognition()
  recognition.continuous = false
  recognition.interimResults = false
  recognition.lang = "en-US"
  recognition.onresult = (event) => {
    if (!event.results || event.results.length === 0) {
      onError("No speech was detected. Try again.")
      return
    }
    const transcript = Array.from({ length: event.results.length }, (_, index) => event.results[index]?.[0]?.transcript || "")
      .join(" ")
      .trim()
    if (transcript) {
      onTranscript(transcript)
    } else {
      onError("No speech was detected. Try holding the button a little longer.")
    }
  }
  recognition.onerror = (event) => {
    const detail = event.error || event.message || "Voice capture failed."
    if (detail === "not-allowed") {
      onError("Microphone permission was denied.")
      return
    }
    onError(`Voice capture failed: ${detail}.`)
  }
  recognition.onend = () => {
    onListeningChange(false)
  }

  return {
    start: () => {
      onListeningChange(true)
      recognition.start()
    },
    stop: () => {
      recognition.stop()
    },
  }
}

export function prepareSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function speakText(text: string, voiceURI?: string, callbacks?: SpeechCallbacks): void {
  if (!supportsVoiceOutput()) {
    return
  }
  window.speechSynthesis.cancel()
  const prepared = prepareSpeechText(text)
  const utterance = new SpeechSynthesisUtterance(prepared)
  if (voiceURI) {
    const selectedVoice = listVoiceOutputOptions().find((voice) => voice.voiceURI === voiceURI)
    if (selectedVoice) {
      utterance.voice = selectedVoice
      utterance.lang = selectedVoice.lang
    }
  }
  utterance.rate = 1
  utterance.pitch = 1
  utterance.onstart = () => callbacks?.onStart?.()
  utterance.onend = () => callbacks?.onEnd?.()
  utterance.onerror = (event) => callbacks?.onError?.(event.error || "Browser voice playback failed.")
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (!supportsVoiceOutput()) {
    return
  }
  window.speechSynthesis.cancel()
}

export async function primeAudioPlayback(): Promise<void> {
  if (typeof window === "undefined") {
    return
  }
  try {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      return
    }
    const ctx = new AudioContextCtor()
    const buffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    await ctx.resume()
    source.start(0)
    source.stop(0)
    await ctx.close()
  } catch {
    // Best-effort unlock for browsers with strict autoplay rules.
  }
}


export function supportsPushToTalkRecording(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia
}


export async function recordPushToTalkSample(): Promise<{ audioBase64: string; mimeType: string }> {
  if (!supportsPushToTalkRecording()) {
    throw new Error("Push-to-talk recording is unavailable in this browser.")
  }
  const mimeType = _preferredRecordingMimeType()
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  return new Promise((resolve, reject) => {
    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }
    recorder.onerror = () => {
      reject(new Error("Push-to-talk recording failed."))
    }
    recorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" })
        const buffer = await blob.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ""
        for (const byte of bytes) {
          binary += String.fromCharCode(byte)
        }
        resolve({
          audioBase64: btoa(binary),
          mimeType: blob.type || "audio/webm",
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Recorded audio could not be prepared."))
      } finally {
        stream.getTracks().forEach((track) => track.stop())
      }
    }
    recorder.start()
    window.setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop()
      }
    }, 7000)
  })
}


function _preferredRecordingMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate
    }
  }
  return ""
}

export async function fileToBase64(file: File): Promise<{ audioBase64: string; mimeType: string }> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return {
    audioBase64: btoa(binary),
    mimeType: file.type || "audio/mp4",
  }
}

export function createPushToTalkRecorder(
  onSample: (payload: { audioBase64: string; mimeType: string }) => void,
  onInterimSample: (payload: { audioBase64: string; mimeType: string; sequence: number; isFinal: boolean }) => void,
  onError: (message: string) => void,
  onListeningChange: (listening: boolean) => void,
  onStreamChange?: (stream: MediaStream | null) => void
): { start: () => Promise<void>; stop: () => void; isRecording: () => boolean; getStream: () => MediaStream | null } | null {
  if (!supportsPushToTalkRecording()) {
    return null
  }

  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: BlobPart[] = []
  let liveSequence = 0
  let lastInterimSentAt = 0
  let interimPending = false
  let interimQueued = false

  async function cleanup() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      stream = null
      onStreamChange?.(null)
    }
    recorder = null
    chunks = []
    liveSequence = 0
    lastInterimSentAt = 0
    interimPending = false
    interimQueued = false
    onListeningChange(false)
  }

  async function emitInterim(isFinal: boolean) {
    if (interimPending) {
      interimQueued = true
      return
    }
    interimPending = true
    try {
      if (chunks.length === 0) {
        return
      }
      const mimeType = recorder?.mimeType || _preferredRecordingMimeType() || "audio/webm"
      const blob = new Blob(chunks, { type: mimeType })
      const file = new File([blob], "speech", { type: blob.type || "audio/webm" })
      liveSequence += 1
      onInterimSample({
        ...(await fileToBase64(file)),
        sequence: liveSequence,
        isFinal,
      })
      lastInterimSentAt = Date.now()
    } catch (error) {
      onError(error instanceof Error ? error.message : "Live transcription sample could not be prepared.")
    } finally {
      interimPending = false
      if (interimQueued && !isFinal) {
        interimQueued = false
        void emitInterim(false)
      }
    }
  }

  return {
    start: async () => {
      try {
        const mimeType = _preferredRecordingMimeType()
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        onStreamChange?.(stream)
        chunks = []
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data)
            if (Date.now() - lastInterimSentAt >= 900) {
              void emitInterim(false)
            }
          }
        }
        recorder.onerror = () => {
          onError("Push-to-talk recording failed.")
          void cleanup()
        }
        recorder.onstop = async () => {
          try {
            await emitInterim(true)
            const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" })
            const file = new File([blob], "speech", { type: blob.type || "audio/webm" })
            onSample(await fileToBase64(file))
          } catch (error) {
            onError(error instanceof Error ? error.message : "Recorded audio could not be prepared.")
          } finally {
            await cleanup()
          }
        }
        recorder.start(350)
        onListeningChange(true)
      } catch (error) {
        onError(error instanceof Error ? error.message : "Microphone access failed.")
        await cleanup()
      }
    },
    stop: () => {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop()
      }
    },
    isRecording: () => Boolean(recorder && recorder.state !== "inactive"),
    getStream: () => stream,
  }
}

type WakewordMonitorOptions = {
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  onTelemetry?: (payload: { peak: number; rms: number; speechLevel: number }) => void
}

export function createWakewordMonitor(
  onChunk: (payload: { audioBase64: string; sampleRate: number }) => void,
  onError: (message: string) => void,
  onMonitoringChange: (monitoring: boolean) => void,
  options: WakewordMonitorOptions = {}
): { start: () => Promise<void>; stop: () => void; isMonitoring: () => boolean } | null {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return null
  }

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let processor: ScriptProcessorNode | null = null
  let monitoring = false
  let isSpeechLike = false

  function cleanup() {
    monitoring = false
    if (processor) {
      processor.disconnect()
      processor.onaudioprocess = null
      processor = null
    }
    if (source) {
      source.disconnect()
      source = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      stream = null
    }
    if (context) {
      void context.close()
      context = null
    }
    onMonitoringChange(false)
  }

  return {
    start: async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: options.echoCancellation ?? true,
            noiseSuppression: options.noiseSuppression ?? true,
            autoGainControl: options.autoGainControl ?? true,
            channelCount: 1,
          },
        })
        context = new AudioContext({ latencyHint: "interactive" })
        if (context.state === "suspended") {
          await context.resume()
        }
        source = context.createMediaStreamSource(stream)
        analyser = context.createAnalyser()
        analyser.fftSize = 1024
        processor = context.createScriptProcessor(4096, 1, 1)
        const freqData = new Uint8Array(analyser.frequencyBinCount)
        processor.onaudioprocess = (event) => {
          if (!monitoring) {
            return
          }
          const timeDomain = event.inputBuffer.getChannelData(0)
          let peak = 0
          let sumSquares = 0
          for (let index = 0; index < timeDomain.length; index += 1) {
            const sample = Math.abs(timeDomain[index] || 0)
            peak = Math.max(peak, sample)
            sumSquares += sample * sample
          }
          analyser?.getByteFrequencyData(freqData)
          const voice = detectVoice(freqData, {
            sampleRate: event.inputBuffer.sampleRate,
            fftSize: analyser?.fftSize || 1024,
            sensitivity: 1,
            isSpeaking: isSpeechLike,
          })
          isSpeechLike = voice.isVocalDetected
          options.onTelemetry?.({
            peak,
            rms: Math.sqrt(sumSquares / Math.max(1, timeDomain.length)),
            speechLevel: voice.isVocalDetected ? 1 : Math.min(1, peak * 8),
          })
          if (!voice.isVocalDetected && peak < 0.012) {
            return
          }
          const payload = _float32ChunkToBase64(timeDomain)
          if (!payload.audioBase64) {
            return
          }
          onChunk({
            audioBase64: payload.audioBase64,
            sampleRate: event.inputBuffer.sampleRate,
          })
        }
        source.connect(analyser)
        source.connect(processor)
        processor.connect(context.destination)
        monitoring = true
        onMonitoringChange(true)
      } catch (error) {
        cleanup()
        onError(error instanceof Error ? error.message : "Wakeword microphone access failed.")
      }
    },
    stop: () => {
      cleanup()
    },
    isMonitoring: () => monitoring,
  }
}

function _float32ChunkToBase64(samples: Float32Array): { audioBase64: string } {
  if (samples.length === 0) {
    return { audioBase64: "" }
  }
  const pcm16 = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0))
    pcm16[index] = sample < 0 ? sample * 32768 : sample * 32767
  }
  const bytes = new Uint8Array(pcm16.buffer)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return { audioBase64: btoa(binary) }
}
