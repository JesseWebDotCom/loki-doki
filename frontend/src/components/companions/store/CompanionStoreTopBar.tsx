import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Search } from 'lucide-react'

/** Companion-store top bar: history nav + global search that drives the Browse view. */
export function CompanionStoreTopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const inputRef = useRef<HTMLInputElement>(null)
  const onBrowse = location.pathname === '/companions/browse'
  const initialQ = onBrowse ? new URLSearchParams(location.search).get('q') ?? '' : ''
  const [value, setValue] = useState(initialQ)

  useEffect(() => {
    if (onBrowse) setValue(new URLSearchParams(location.search).get('q') ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, onBrowse])

  useEffect(() => {
    const q = value.trim()
    if (!q && !onBrowse) return
    const t = setTimeout(() => {
      navigate(`/companions/browse${q ? `?q=${encodeURIComponent(q)}` : ''}`, { replace: onBrowse })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-border/40 bg-background/85 px-5 py-3 backdrop-blur-xl">
      <div className="flex gap-1">
        <button onClick={() => navigate(-1)} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" aria-label="Back">
          <ArrowLeft className="size-4" />
        </button>
        <button onClick={() => navigate(1)} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" aria-label="Forward">
          <ArrowRight className="size-4" />
        </button>
      </div>

      <div className="relative mx-auto w-full max-w-xl">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search companions by name, vibe, or category..."
          className="w-full rounded-xl border border-border/40 bg-muted/40 py-2 pl-10 pr-4 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-border focus:bg-muted/60 transition-colors"
        />
      </div>
    </div>
  )
}
