import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Upload, Check, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { generateThemedVariants, coverBlob, type CoverVariant } from '@/lib/podcast/cover'

type Tab = 'designed' | 'upload'

/**
 * Cover chooser with two instant, keyless sources: topic-themed designs (gradient
 * + OpenMoji glyph + title, rendered on a canvas) or an uploaded image. Reports the
 * chosen cover as a PNG Blob (+ preview URL) for the editor to PUT.
 */
export function CoverPicker({ title, topicText = '', imageUrl, onChange }: {
  title: string
  topicText?: string
  /** Optional source photo (e.g. channel avatar) composited into ~half the designs. */
  imageUrl?: string
  onChange: (blob: Blob | null, previewUrl: string | null) => void
}) {
  const [tab, setTab] = useState<Tab>('designed')
  const [offset, setOffset] = useState(0)
  const [variants, setVariants] = useState<CoverVariant[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const regenerate = useCallback(async (off: number) => {
    setLoading(true); setSelected(null)
    try { setVariants(await generateThemedVariants(title || 'New Show', topicText, 6, 320, off, imageUrl)) }
    catch { setVariants([]) }
    finally { setLoading(false) }
  }, [title, topicText, imageUrl])

  // (Re)generate when on the Designed tab and the title/topic/image changes (debounced).
  useEffect(() => {
    if (tab !== 'designed') return
    const id = setTimeout(() => void regenerate(offset), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, title, topicText, imageUrl])

  async function pickVariant(i: number) {
    const v = variants[i]; if (!v) return
    setSelected(i); setUploadPreview(null)
    const { blob, dataUrl } = await coverBlob({ title: title || 'New Show', kicker: v.kicker, palette: v.palette, emojiHex: v.emojiHex, emojis: v.emojis, layout: v.layout, image: v.image, size: 512 })
    onChange(blob, dataUrl)
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setSelected(null)
    const url = URL.createObjectURL(file)
    setUploadPreview(url); onChange(file, url)
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-4 border-b border-border/40">
        {([['designed', 'Designed', Sparkles], ['upload', 'Upload', Upload]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 pb-2 text-sm font-semibold transition-colors',
              tab === id ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === 'designed' ? (
        <>
          {loading ? (
            <div className="grid grid-cols-3 gap-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="aspect-square animate-pulse rounded-xl bg-muted/60" />)}</div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {variants.map((v, i) => (
                <button key={v.key} type="button" onClick={() => void pickVariant(i)}
                  className={cn('relative aspect-square overflow-hidden rounded-xl ring-2 transition-all',
                    selected === i ? 'ring-brand' : 'ring-transparent hover:ring-border')}>
                  <img src={v.dataUrl} alt="" className="size-full object-cover" />
                  {selected === i && <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-brand text-brand-foreground"><Check className="size-3" strokeWidth={3} /></span>}
                </button>
              ))}
            </div>
          )}
          <button type="button" disabled={loading}
            onClick={() => { const n = offset + 6; setOffset(n); void regenerate(n) }}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Regenerate Covers
          </button>
        </>
      ) : (
        <div className="space-y-3">
          {uploadPreview ? (
            <img src={uploadPreview} alt="" className="mx-auto aspect-square w-40 rounded-xl object-cover" />
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()}
              className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 text-muted-foreground hover:bg-muted/40">
              <Upload className="size-6" /><span className="text-sm">Click to upload an image</span>
            </button>
          )}
          {uploadPreview && <button type="button" onClick={() => fileRef.current?.click()} className="w-full text-center text-xs text-brand hover:underline">Choose a different image</button>}
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        </div>
      )}
    </div>
  )
}
