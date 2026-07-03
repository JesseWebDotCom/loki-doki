// "How do I get more books, turn sources on and off, or add more?" One page
// answering all three. Built-in on/off toggles (Gutenberg, Internet Archive,
// LibriVox) are here for any household member; adding custom OPDS indexers needs
// credentials, so that section is admin-only (shared IndexerManager component,
// also reachable at Admin > Integrations > Books).

import { useCallback, useEffect, useState } from 'react'
import { BookAudio, Globe, Mic2 } from 'lucide-react'
import { AppSettingsPage } from '@/components/shared/AppSettingsPage'
import { IndexerManager } from '@/components/books/IndexerManager'
import { Spinner } from '@/components/ui/spinner'
import { getBookSources, setBookSourceToggle, type BuiltinSource, type BuiltinSourceToggles } from '@/lib/books/api'
import { getAppByPath } from '@/lib/appCategories'

const BOOKS_GRADIENT = getAppByPath('/books')!.gradient

const BUILTINS: { key: BuiltinSource; label: string; desc: string; icon: typeof BookAudio }[] = [
  { key: 'gutenberg', label: 'Project Gutenberg', desc: 'Public-domain ebooks with real descriptions and genre shelves.', icon: BookAudio },
  { key: 'archiveorg', label: 'Internet Archive', desc: 'Public-domain scanned books.', icon: Globe },
  { key: 'librivox', label: 'LibriVox', desc: 'Public-domain audiobooks read by volunteers.', icon: Mic2 },
]

function ToggleRow({ item, enabled, onChange }: { item: typeof BUILTINS[number]; enabled: boolean; onChange: (v: boolean) => void }) {
  const Icon = item.icon
  return (
    <div className="flex items-center gap-3 rounded-card border border-border p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-secondary">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.label}</p>
        <p className="text-xs text-muted-foreground">{item.desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? 'bg-[var(--books-accent)]' : 'bg-secondary'}`}
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

export function BooksSourcesPage() {
  const [toggles, setToggles] = useState<BuiltinSourceToggles | null>(null)

  const load = useCallback(async () => {
    const d = await getBookSources()
    setToggles(d.toggles)
  }, [])

  useEffect(() => { void load() }, [load])

  const flip = useCallback(async (source: BuiltinSource, enabled: boolean) => {
    setToggles((t) => t ? { ...t, [source]: enabled } : t) // optimistic
    await setBookSourceToggle(source, enabled)
  }, [])

  return (
    <AppSettingsPage
      title="Sources"
      backTo="/books"
      backLabel="Book Store"
      icon={BookAudio}
      gradient={BOOKS_GRADIENT}
      adminSection={<IndexerManager />}
      adminNotice="Adding a custom self-hosted OPDS indexer (Calibre-Web, Kavita, COPS, etc.) needs an admin: ask them to add it in Admin > Integrations > Books."
    >
      <div>
        <h2 className="text-sm font-semibold">Built-in Sources</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Turn any of these off if you don't want them showing up in the Book Store, Audiobook Store, or search.</p>
        <div className="mt-3 space-y-2">
          {toggles === null ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : (
            BUILTINS.map((item) => (
              <ToggleRow key={item.key} item={item} enabled={toggles[item.key]} onChange={(v) => void flip(item.key, v)} />
            ))
          )}
        </div>
      </div>
    </AppSettingsPage>
  )
}
