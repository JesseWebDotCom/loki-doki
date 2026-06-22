import { useEffect, useRef, useState } from 'react'
import { Bookmark, Copy, Check } from 'lucide-react'
import { toast } from '@/lib/toast'

// "Save to Loki" — a draggable bookmarklet (and the share-target hint) that captures the
// current page into the right app via the same-origin /save popup. ORIGIN is derived at
// runtime so the bookmark is correct for whatever address this deployment is reached at.

function buildBookmarklet(origin: string): string {
  return `javascript:(function(){var u=encodeURIComponent(location.href);var t=encodeURIComponent(document.title);var s=encodeURIComponent((''+(window.getSelection?window.getSelection():'')).slice(0,500));var w=window.open('${origin}/save?url='+u+'&title='+t+'&text='+s,'loki_save','width=440,height=620,menubar=no,toolbar=no');if(w)w.focus();})();`
}

export function SettingsSaveToLokiTab() {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const code = buildBookmarklet(origin)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const [copied, setCopied] = useState(false)

  // JSX/bundlers strip javascript: hrefs — set it on the DOM node after mount.
  useEffect(() => { linkRef.current?.setAttribute('href', code) }, [code])

  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { toast.error('Copy failed') }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">Save to Loki</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Save any web page to Loki from your browser — no extension needed.</p>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="mb-3 text-sm font-medium">1. Drag this button to your bookmarks bar</p>
        {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
        <a ref={linkRef} onClick={(e) => e.preventDefault()}
          className="inline-flex cursor-grab items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground active:cursor-grabbing">
          <Bookmark className="size-4" /> Save to Loki
        </a>
        <p className="mt-3 text-xs text-muted-foreground">
          2. On any page, click the bookmark to save it. YouTube pages offer offline / watch-later;
          everything else can be saved as a live bookmark or an offline article.
        </p>
        <button onClick={copy} className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          {copied ? <><Check className="size-3.5" /> Copied</> : <><Copy className="size-3.5" /> Copy bookmarklet code</>}
        </button>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <p className="text-sm font-medium">On mobile</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Install Loki as an app (Add to Home Screen). It then appears in your phone's <span className="font-medium text-foreground">Share</span> sheet —
          share any page to Loki to save it.
        </p>
      </div>
    </div>
  )
}
