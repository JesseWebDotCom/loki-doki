// Clean Up: the Apple "Clean Up" analog. The user paints a mask over an object in an
// image and the masked region is regenerated (removed, or replaced when a prompt is
// given) via the SDXL inpaint pipeline. Self-contained: it owns a brush-mask canvas
// and its own image-generation stream, POSTing { cleanUp, imageBase64, maskBase64 }
// to /api/image/generate. Everything outside the painted mask is preserved.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useImageGen } from '@/hooks/useImageGen'
import { cn } from '@/lib/cn'

const MAX_DISPLAY = 512

function toBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

export function CleanUpDialog({
  open,
  onOpenChange,
  imageSrc,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  imageSrc: string | null
  onDone?: (newImageId: string) => void
}) {
  const displayRef = useRef<HTMLCanvasElement | null>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)   // natural-resolution mask (black + white strokes)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const natural = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const painting = useRef(false)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

  const [ready, setReady] = useState(false)
  const [brush, setBrush] = useState(40)
  const [prompt, setPrompt] = useState('')
  const [hasMask, setHasMask] = useState(false)
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number }>({ w: MAX_DISPLAY, h: MAX_DISPLAY })

  const { state: gen, generate, reset } = useImageGen()
  const running = gen.status === 'generating'
  const resultId = gen.status === 'done' ? gen.imageId : null

  // Repaint the display: source image, then a translucent brand overlay everywhere the
  // mask is painted.
  const redraw = useCallback(() => {
    const disp = displayRef.current
    const mask = maskRef.current
    const img = imgRef.current
    if (!disp || !mask || !img) return
    const ctx = disp.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, disp.width, disp.height)
    ctx.drawImage(img, 0, 0, disp.width, disp.height)
    // Draw the mask scaled down as a violet wash over painted areas.
    ctx.save()
    ctx.globalAlpha = 0.5
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'oklch(0.72 0.22 290)'
    // Use the mask canvas as an alpha stencil.
    const tmp = document.createElement('canvas')
    tmp.width = disp.width; tmp.height = disp.height
    const tctx = tmp.getContext('2d')
    if (tctx) {
      tctx.drawImage(mask, 0, 0, disp.width, disp.height)
      tctx.globalCompositeOperation = 'source-in'
      tctx.fillStyle = 'oklch(0.72 0.22 290)'
      tctx.fillRect(0, 0, disp.width, disp.height)
      ctx.drawImage(tmp, 0, 0)
    }
    ctx.restore()
  }, [])

  // Load the image when the dialog opens.
  useEffect(() => {
    if (!open || !imageSrc) return
    setReady(false)
    reset()
    setHasMask(false)
    setPrompt('')
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      natural.current = { w: img.naturalWidth, h: img.naturalHeight }
      const scale = Math.min(1, MAX_DISPLAY / Math.max(img.naturalWidth, img.naturalHeight))
      const dw = Math.round(img.naturalWidth * scale)
      const dh = Math.round(img.naturalHeight * scale)
      setDisplaySize({ w: dw, h: dh })
      // Mask canvas at natural resolution, initialised to black (nothing to replace).
      const mask = document.createElement('canvas')
      mask.width = img.naturalWidth; mask.height = img.naturalHeight
      const mctx = mask.getContext('2d')
      if (mctx) { mctx.fillStyle = 'black'; mctx.fillRect(0, 0, mask.width, mask.height) }
      maskRef.current = mask
      setReady(true)
    }
    img.onerror = () => toast.error('Could not load that image for editing.')
    img.src = imageSrc
  }, [open, imageSrc, reset])

  // Paint the display once it and the image are ready.
  useEffect(() => {
    if (ready) requestAnimationFrame(redraw)
  }, [ready, displaySize, redraw])

  const paintAt = useCallback((clientX: number, clientY: number) => {
    const disp = displayRef.current
    const mask = maskRef.current
    if (!disp || !mask) return
    const rect = disp.getBoundingClientRect()
    // Map from on-screen pixels to natural-resolution mask coordinates.
    const nx = ((clientX - rect.left) / rect.width) * mask.width
    const ny = ((clientY - rect.top) / rect.height) * mask.height
    const mctx = mask.getContext('2d')
    if (!mctx) return
    const radius = (brush / rect.width) * mask.width / 2
    mctx.fillStyle = 'white'
    mctx.strokeStyle = 'white'
    mctx.lineWidth = radius * 2
    mctx.lineCap = 'round'
    if (lastPoint.current) {
      mctx.beginPath()
      mctx.moveTo(lastPoint.current.x, lastPoint.current.y)
      mctx.lineTo(nx, ny)
      mctx.stroke()
    }
    mctx.beginPath()
    mctx.arc(nx, ny, radius, 0, Math.PI * 2)
    mctx.fill()
    lastPoint.current = { x: nx, y: ny }
    setHasMask(true)
    redraw()
  }, [brush, redraw])

  const onPointerDown = (e: React.PointerEvent) => {
    if (running || resultId) return
    painting.current = true
    lastPoint.current = null
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    paintAt(e.clientX, e.clientY)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!painting.current) return
    paintAt(e.clientX, e.clientY)
  }
  const onPointerUp = () => { painting.current = false; lastPoint.current = null }

  const clearMask = useCallback(() => {
    const mask = maskRef.current
    if (!mask) return
    const mctx = mask.getContext('2d')
    if (mctx) { mctx.fillStyle = 'black'; mctx.fillRect(0, 0, mask.width, mask.height) }
    setHasMask(false)
    redraw()
  }, [redraw])

  const runCleanUp = useCallback(async () => {
    const mask = maskRef.current
    const img = imgRef.current
    if (!mask || !img || !hasMask) return

    // Export the source at natural resolution.
    const base = document.createElement('canvas')
    base.width = natural.current.w; base.height = natural.current.h
    const bctx = base.getContext('2d')
    if (!bctx) return
    bctx.drawImage(img, 0, 0)
    const imageBase64 = toBase64(base.toDataURL('image/png'))
    const maskBase64 = toBase64(mask.toDataURL('image/png'))

    const id = await generate({ prompt: prompt.trim(), cleanUp: true, imageBase64, maskBase64 })
    if (id) {
      toast.success(prompt.trim() ? 'Replaced the area' : 'Cleaned up')
      onDone?.(id)
    }
  }, [hasMask, prompt, generate, onDone])

  const startOver = useCallback(() => { reset(); clearMask() }, [reset, clearMask])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Eraser className="size-4 text-brand" /> Clean Up</DialogTitle>
          <DialogDescription>
            Paint over the object you want gone. Leave the prompt empty to remove it, or describe something to put there instead.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          <div
            className="relative overflow-hidden rounded-card border border-border/60 bg-muted/30"
            style={{ width: displaySize.w, height: displaySize.h, maxWidth: '100%' }}
          >
            {resultId ? (
              <img src={`/api/image/artifacts/${resultId}`} alt="Result" className="h-full w-full object-contain" />
            ) : (
              <canvas
                ref={displayRef}
                width={displaySize.w}
                height={displaySize.h}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                className={cn('h-full w-full touch-none', running ? 'cursor-wait' : 'cursor-crosshair')}
              />
            )}
            {running && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70">
                <Spinner size="lg" className="text-brand" />
                <p className="text-xs text-muted-foreground">
                  Cleaning up… {gen.totalSteps ? `${Math.round((gen.step / gen.totalSteps) * 100)}%` : ''}
                </p>
              </div>
            )}
          </div>

          {!resultId && (
            <div className="w-full space-y-3">
              <div className="flex items-center gap-3">
                <Label className="shrink-0 text-xs">Brush</Label>
                {/* design-ok(raw-input-element): range slider, the established Imaging pattern */}
                <input
                  type="range" min={10} max={120} step={2} value={brush}
                  onChange={(e) => setBrush(parseInt(e.target.value, 10))}
                  disabled={running}
                  className="w-full accent-primary"
                />
                <Button variant="ghost" size="sm" onClick={clearMask} disabled={running || !hasMask}>
                  <Trash2 className="size-3.5" /> Clear
                </Button>
              </div>
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Optional: what to put there instead (leave empty to remove)"
                disabled={running}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          {resultId ? (
            <>
              <Button variant="secondary" onClick={startOver}>Edit again</Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
              <Button onClick={() => void runCleanUp()} disabled={running || !hasMask || !ready}>
                {running ? <Spinner size="default" /> : <Eraser className="size-4" />}
                {prompt.trim() ? 'Replace' : 'Clean Up'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
