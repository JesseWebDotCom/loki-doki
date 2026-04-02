import { detectVoice } from "./utils/VoiceDetector"

type BargeInSample = {
  audioBase64: string
  mimeType: string
}

type BargeInOptions = {
  minSpeechFrames?: number
  maxSilenceFrames?: number
  cooldownMs?: number
  maxCaptureMs?: number
  preRollMs?: number
  onSpeechStart?: () => void
  onInterimSample?: (payload: BargeInSample & { isFinal: boolean }) => void
}

type FrameStats = {
  pcm16: Int16Array
  rms: number
  peak: number
  voiced: boolean
}

export function createBargeInMonitor(
  onSample: (payload: BargeInSample) => void,
  onError: (message: string) => void,
  onMonitoringChange: (monitoring: boolean) => void,
  options: BargeInOptions = {}
): { start: () => Promise<void>; stop: () => void; isMonitoring: () => boolean } | null {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return null
  }

  const minSpeechFrames = options.minSpeechFrames ?? 4
  const maxSilenceFrames = options.maxSilenceFrames ?? 20
  const cooldownMs = options.cooldownMs ?? 1200
  const maxCaptureMs = options.maxCaptureMs ?? 9000
  const preRollMs = options.preRollMs ?? 650

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let processor: ScriptProcessorNode | null = null
  let monitoring = false
  let isSpeaking = false
  let speechFrames = 0
  let silenceFrames = 0
  let capturing = false
  let captureStartedAt = 0
  let cooldownUntil = 0
  let preRollChunks: Int16Array[] = []
  let preRollSamples = 0
  let capturedChunks: Int16Array[] = []
  let lastTelemetryAt = 0

  function resetCapture() {
    speechFrames = 0
    silenceFrames = 0
    capturing = false
    captureStartedAt = 0
    capturedChunks = []
  }

  function cleanup() {
    monitoring = false
    resetCapture()
    preRollChunks = []
    preRollSamples = 0
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

  function appendPreRoll(chunk: Int16Array, sampleRate: number) {
    preRollChunks.push(chunk)
    preRollSamples += chunk.length
    const maxSamples = Math.max(1, Math.round((sampleRate * preRollMs) / 1000))
    while (preRollSamples > maxSamples && preRollChunks.length > 0) {
      const removed = preRollChunks.shift()
      preRollSamples -= removed?.length || 0
    }
  }

  function finishCapture(sampleRate: number) {
    const payload = pcm16ChunksToWavBase64(capturedChunks, sampleRate)
    cooldownUntil = Date.now() + cooldownMs
    cleanup()
    onSample(payload)
  }

  function emitInterimSample(sampleRate: number, isFinal: boolean) {
    if (!capturedChunks.length || !options.onInterimSample) {
      return
    }
    options.onInterimSample({
      ...pcm16ChunksToWavBase64(capturedChunks, sampleRate),
      isFinal,
    })
  }

  function emitVADTelemetry(stats: FrameStats) {
    const now = Date.now()
    if (now - lastTelemetryAt < 200) {
      return
    }
    lastTelemetryAt = now
    window.dispatchEvent(
      new CustomEvent("voice-vad", {
        detail: {
          isSpeaking,
          speechFrames,
          silenceFrames,
          capturing,
          rms: stats.rms,
          peak: stats.peak,
        },
      })
    )
  }

  return {
    start: async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        context = new AudioContext({ latencyHint: "interactive" })
        if (context.state === "suspended") {
          await context.resume()
        }
        source = context.createMediaStreamSource(stream)
        analyser = context.createAnalyser()
        analyser.fftSize = 1024
        processor = context.createScriptProcessor(2048, 1, 1)
        
        const freqData = new Uint8Array(analyser.frequencyBinCount)
        
        processor.onaudioprocess = (event) => {
          if (!monitoring || !analyser) {
            return
          }
          
          analyser.getByteFrequencyData(freqData)
          const voice = detectVoice(freqData, {
             sampleRate: context!.sampleRate,
             fftSize: analyser.fftSize,
             sensitivity: 1.0,
             isSpeaking
          })
          
          isSpeaking = voice.isVocalDetected
          const stats = analyzeFrame(event.inputBuffer.getChannelData(0))
          stats.voiced = isSpeaking
          emitVADTelemetry(stats)
          
          if (stats.pcm16.length === 0) {
            return
          }
          const sampleRate = event.inputBuffer.sampleRate
          appendPreRoll(stats.pcm16, sampleRate)

          if (!capturing) {
            if (Date.now() < cooldownUntil) {
              return
            }
            if (stats.voiced) {
              speechFrames += 1
            } else {
              speechFrames = 0
            }
            if (speechFrames < minSpeechFrames) {
              return
            }
            capturing = true
            captureStartedAt = Date.now()
            silenceFrames = 0
            capturedChunks = [...preRollChunks]
            options.onSpeechStart?.()
            return
          }

          capturedChunks.push(stats.pcm16)
          if (stats.voiced) {
            silenceFrames = 0
          } else {
            silenceFrames += 1
          }
          if (capturedChunks.length % 6 === 0) {
            emitInterimSample(sampleRate, false)
          }
          if (silenceFrames >= maxSilenceFrames || Date.now() - captureStartedAt >= maxCaptureMs) {
            emitInterimSample(sampleRate, true)
            finishCapture(sampleRate)
          }
        }
        source.connect(analyser)
        source.connect(processor)
        processor.connect(context.destination)
        monitoring = true
        onMonitoringChange(true)
      } catch (error) {
        cleanup()
        onError(error instanceof Error ? error.message : "Barge-in microphone access failed.")
      }
    },
    stop: () => {
      cleanup()
    },
    isMonitoring: () => monitoring,
  }
}

function analyzeFrame(samples: Float32Array): FrameStats {
  if (samples.length === 0) {
    return {
      pcm16: new Int16Array(0),
      rms: 0,
      peak: 0,
      voiced: false,
    }
  }
  const pcm16 = new Int16Array(samples.length)
  let energy = 0
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0))
    const magnitude = Math.abs(sample)
    energy += sample * sample
    peak = Math.max(peak, magnitude)
    pcm16[index] = sample < 0 ? sample * 32768 : sample * 32767
  }
  const rms = Math.sqrt(energy / samples.length)
  const voiced = (rms >= 0.032 && peak >= 0.12) || rms >= 0.05
  return { pcm16, rms, peak, voiced }
}

function pcm16ChunksToWavBase64(chunks: Int16Array[], sampleRate: number): BargeInSample {
  const totalSamples = chunks.reduce((count, chunk) => count + chunk.length, 0)
  const wavBuffer = new ArrayBuffer(44 + totalSamples * 2)
  const view = new DataView(wavBuffer)
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + totalSamples * 2, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, totalSamples * 2, true)

  let offset = 44
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      view.setInt16(offset, chunk[index] || 0, true)
      offset += 2
    }
  }

  const bytes = new Uint8Array(wavBuffer)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return {
    audioBase64: btoa(binary),
    mimeType: "audio/wav",
  }
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}
