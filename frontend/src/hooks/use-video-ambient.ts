// Live ambient color from the playing video (YouTube's "ambient mode"): sample the frame
// into a tiny offscreen canvas every couple of seconds and average it, so the cinema
// backdrop breathes with the content instead of sitting on the static thumbnail.
//
// Only possible on NATIVE playback (the privacy-proxy stream, offline files): drawing a
// cross-origin <video> taints the canvas and getImageData throws, and the embed iframe has
// no readable pixels at all. Callers fall back to the thumbnail palette when this yields
// null, which is exactly what the embed path does.

import { useEffect, useRef, useState, type RefObject } from 'react'

const SAMPLE_MS = 2500
const SIZE = 8   // 8x8 average: cheap, and blurs past letterboxing/noise

export function useVideoAmbient(
  mediaRef: RefObject<HTMLMediaElement | null>,
  enabled: boolean,
): string | null {
  const [color, setColor] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Once a draw taints the canvas (cross-origin frames), it can never be read: stop
  // sampling entirely rather than throwing on every tick.
  const dead = useRef(false)

  useEffect(() => {
    if (!enabled) { setColor(null); return }
    dead.current = false
    let raf = 0

    const sample = () => {
      const el = mediaRef.current
      if (dead.current || !el || !(el instanceof HTMLVideoElement)) return
      if (el.readyState < 2 || el.paused || el.videoWidth === 0) return
      try {
        let canvas = canvasRef.current
        if (!canvas) {
          canvas = document.createElement('canvas')
          canvas.width = SIZE; canvas.height = SIZE
          canvasRef.current = canvas
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) { dead.current = true; return }
        ctx.drawImage(el, 0, 0, SIZE, SIZE)
        const { data } = ctx.getImageData(0, 0, SIZE, SIZE)
        let r = 0, g = 0, b = 0
        const px = data.length / 4
        for (let i = 0; i < data.length; i += 4) { r += data[i]!; g += data[i + 1]!; b += data[i + 2]! }
        r = Math.round(r / px); g = Math.round(g / px); b = Math.round(b / px)
        // Lift very dark frames so the glow stays perceptible without washing out.
        const lift = (v: number) => Math.min(255, Math.round(v * 1.25) + 12)
        setColor(`rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`)
      } catch {
        // Tainted canvas (cross-origin frame) or a decode hiccup: give up for this source.
        dead.current = true
        setColor(null)
      }
    }

    const iv = setInterval(() => { raf = requestAnimationFrame(sample) }, SAMPLE_MS)
    raf = requestAnimationFrame(sample)
    return () => { clearInterval(iv); cancelAnimationFrame(raf) }
  }, [mediaRef, enabled])

  return color
}
