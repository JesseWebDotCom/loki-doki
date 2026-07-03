// Reading sample for sources that publish clean full text but can't be iframed
// (Gutenberg, Standard Ebooks). The opening paragraphs are fetched + de-boilerplated
// server-side (see backend/src/lib/books/preview.ts) and rendered here same-origin,
// with a soft fade at the end signalling there's more once you add/download the book.

import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { getBookSample, type BookSample } from '@/lib/books/api'

export function BookTextPreview({ source, sourceRef, title }: { source: string; sourceRef: string; title: string }) {
  const [sample, setSample] = useState<BookSample | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void getBookSample(source, sourceRef).then((s) => {
      if (cancelled) return
      if (s && s.paragraphs.length) { setSample(s); setState('ready') }
      else setState('empty')
    })
    return () => { cancelled = true }
  }, [source, sourceRef])

  if (state === 'empty') return null

  return (
    <section>
      <h2 className="mb-3 text-lg font-bold">Read a sample</h2>
      {state === 'loading' ? (
        <div className="flex h-40 items-center justify-center rounded-card border border-border bg-card"><Spinner /></div>
      ) : (
        <>
          <div className="relative max-h-[min(70vh,720px)] overflow-hidden rounded-card border border-border bg-card">
            <div className="max-h-[min(70vh,720px)] overflow-y-auto px-6 py-6 sm:px-10">
              <article className="mx-auto max-w-prose space-y-4 text-[15px] leading-relaxed text-foreground/90">
                {sample!.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
              </article>
            </div>
            {sample!.truncated && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {sample!.truncated ? 'Opening excerpt' : 'Full text preview'} of “{title}”. Save or download to read the whole book.
          </p>
        </>
      )}
    </section>
  )
}
