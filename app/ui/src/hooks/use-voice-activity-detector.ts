import { useEffect, useRef, useState } from "react"

import { detectVoice } from "@/utils/VoiceDetector"

type VoiceActivityOptions = {
  stream?: MediaStream | null
  isEnabled: boolean
  sensitivity?: number
  voiceIsolation?: boolean
  fftSize?: number
}

type VoiceActivityState = {
  isListening: boolean
  isVocalDetected: boolean
  frequencyData: Uint8Array | null
  volume: number
  peakVolume: number
  viseme: string
}

const DEFAULT_STATE: VoiceActivityState = {
  isListening: false,
  isVocalDetected: false,
  frequencyData: null,
  volume: 0,
  peakVolume: 0,
  viseme: "closed",
}

export function useVoiceActivityDetector({
  stream,
  isEnabled,
  sensitivity = 1,
  voiceIsolation = true,
  fftSize = 256,
}: VoiceActivityOptions): VoiceActivityState {
  const [state, setState] = useState<VoiceActivityState>(DEFAULT_STATE)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const ownedStreamRef = useRef<MediaStream | null>(null)
  const volumeRef = useRef(0)
  const speakingRef = useRef(false)
  const centroidBaselineRef = useRef(1200)
  const lastVisemeRef = useRef("closed")
  const lastSwitchTimeRef = useRef(0)

  useEffect(() => {
    if (!isEnabled) {
      stopMonitoring()
      return
    }

    let cancelled = false

    async function startMonitoring() {
      try {
        const targetStream =
          stream ||
          (await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: voiceIsolation,
              autoGainControl: true,
            },
          }))

        if (cancelled) {
          targetStream.getTracks().forEach((track) => track.stop())
          return
        }

        if (!stream) {
          ownedStreamRef.current = targetStream
        }

        const audioContext = new AudioContext({ latencyHint: "interactive" })
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = fftSize
        analyser.smoothingTimeConstant = 0.1

        const source = audioContext.createMediaStreamSource(targetStream)
        source.connect(analyser)

        audioContextRef.current = audioContext
        analyserRef.current = analyser
        sourceRef.current = source

        const dataArray = new Uint8Array(analyser.frequencyBinCount)

        setState((current) => ({
          ...current,
          isListening: true,
        }))

        const update = () => {
          if (!analyserRef.current || !audioContextRef.current) {
            return
          }

          analyserRef.current.getByteFrequencyData(dataArray)

          let sum = 0
          let max = 0
          for (let index = 0; index < dataArray.length; index += 1) {
            const value = dataArray[index] || 0
            sum += value
            if (value > max) {
              max = value
            }
          }

          const normalizedAvg = (sum / dataArray.length) / 255
          const peakVolume = max / 255

          const voice = detectVoice(dataArray, {
            sampleRate: audioContextRef.current.sampleRate,
            fftSize: analyserRef.current.fftSize,
            sensitivity,
            isSpeaking: speakingRef.current,
          })

          const centroid = voice.centroid
          const flux = Math.max(0, normalizedAvg - volumeRef.current)
          volumeRef.current = normalizedAvg
          const isBurst = flux > 0.07

          if (normalizedAvg > 0.1) {
            centroidBaselineRef.current = centroidBaselineRef.current * 0.95 + centroid * 0.05
          }

          const baseline = centroidBaselineRef.current || 1200
          const nextSpeaking = voice.isVocalDetected
          speakingRef.current = nextSpeaking

          let nextViseme = "closed"

          if (nextSpeaking) {
            const scores = { ...voice.score }
            const distFromBaseline = Math.abs(centroid - baseline) / baseline
            if (centroid < baseline * 0.6) {
              scores.m *= 2
            }
            if (centroid < baseline * 0.85) {
              scores.o *= 1.8
            }
            if (centroid > baseline * 1.3) {
              scores.wide *= 1.8
            }
            if (centroid > baseline * 2.2) {
              scores.p *= 2.5
            }
            if (distFromBaseline < 0.2) {
              scores.open *= 1.5
            }
            if (!isBurst) {
              scores.p = 0
              scores.b = 0
            }

            let strongestScore = 0
            const candidates = ["m", "b", "p", "o", "wide", "open"] as const
            nextViseme = "open"
            for (const candidate of candidates) {
              if (scores[candidate] > strongestScore) {
                strongestScore = scores[candidate]
                nextViseme = candidate
              }
            }

            const now = Date.now()
            const isQuickViseme = nextViseme === "b" || nextViseme === "p" || nextViseme === "m"
            const switchThreshold = isQuickViseme ? 20 : 60
            if (nextViseme !== lastVisemeRef.current && now - lastSwitchTimeRef.current > switchThreshold) {
              lastVisemeRef.current = nextViseme
              lastSwitchTimeRef.current = now
            } else {
              nextViseme = lastVisemeRef.current
            }
          } else {
            lastVisemeRef.current = "closed"
            nextViseme = "closed"
          }

          setState({
            isListening: true,
            isVocalDetected: nextSpeaking,
            frequencyData: new Uint8Array(dataArray),
            volume: normalizedAvg,
            peakVolume,
            viseme: nextViseme,
          })

          animationFrameRef.current = requestAnimationFrame(update)
        }

        animationFrameRef.current = requestAnimationFrame(update)
      } catch {
        stopMonitoring()
      }
    }

    void startMonitoring()

    return () => {
      cancelled = true
      stopMonitoring()
    }
  }, [fftSize, isEnabled, sensitivity, stream, voiceIsolation])

  function stopMonitoring() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    sourceRef.current?.disconnect()
    sourceRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (ownedStreamRef.current) {
      ownedStreamRef.current.getTracks().forEach((track) => track.stop())
      ownedStreamRef.current = null
    }
    volumeRef.current = 0
    speakingRef.current = false
    centroidBaselineRef.current = 1200
    lastVisemeRef.current = "closed"
    lastSwitchTimeRef.current = 0
    setState(DEFAULT_STATE)
  }

  return state
}
