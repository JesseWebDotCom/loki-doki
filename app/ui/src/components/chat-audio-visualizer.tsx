import { useEffect, useRef } from "react"

import { useVoiceActivityDetector } from "@/hooks/use-voice-activity-detector"

type ChatAudioVisualizerProps = {
  stream: MediaStream | null
  isRecording: boolean
  onClick?: () => void
}

export function ChatAudioVisualizer({ stream, isRecording, onClick }: ChatAudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const { frequencyData } = useVoiceActivityDetector({
    stream,
    isEnabled: Boolean(stream && isRecording),
    sensitivity: 1,
    voiceIsolation: true,
    fftSize: 256,
  })

  useEffect(() => {
    return () => {
      stopVisualization()
    }
  }, [])

  useEffect(() => {
    if (!frequencyData || !isRecording) {
      stopVisualization()
      return
    }
    startVisualization()
    return () => {
      stopVisualization()
    }
  }, [frequencyData, isRecording])

  function stopVisualization() {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }

  function startVisualization() {
    stopVisualization()
    draw()
  }

  function draw() {
    const canvas = canvasRef.current
    if (!canvas || !frequencyData) {
      return
    }
    const context = canvas.getContext("2d")
    if (!context) {
      return
    }
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    context.scale(dpr, dpr)

    const render = () => {
      frameRef.current = requestAnimationFrame(render)
      context.clearRect(0, 0, rect.width, rect.height)
      const barCount = 56
      const step = Math.max(1, Math.floor(frequencyData.length / barCount))
      const barWidth = rect.width / barCount - 2
      for (let index = 0; index < barCount; index += 1) {
        const sample = frequencyData[index * step] || 0
        const normalized = sample / 255
        const height = Math.max(4, normalized * rect.height)
        const x = index * (barWidth + 2)
        const y = (rect.height - height) / 2
        context.fillStyle = `rgba(255,255,255,${0.3 + normalized * 0.7})`
        context.fillRect(x, y, Math.max(2, barWidth), height)
      }
    }

    render()
  }

  return (
    <button className="audio-visualizer-shell" disabled={!onClick} onClick={onClick} type="button">
      <canvas className="h-full w-full" ref={canvasRef} />
    </button>
  )
}
