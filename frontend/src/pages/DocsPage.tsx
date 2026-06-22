import { useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, BookOpen, Code2, Search } from 'lucide-react'
import { AppBreadcrumb } from '@/components/shared/AppBreadcrumb'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usePublishUIContext } from '@/context/UIContextProvider'

interface DocsPageProps {
  entry: 'user' | 'dev'
}

export function DocsPage({ entry }: DocsPageProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const label   = entry === 'user' ? 'User Guide'  : 'Dev Docs'
  const Icon    = entry === 'user' ? BookOpen       : Code2
  const initUrl = entry === 'user' ? '/docs/user/welcome/' : '/docs/dev/architecture/'

  usePublishUIContext({
    label,
    description: entry === 'user'
      ? 'User is reading the Loki Doki user guide.'
      : 'User is reading the Loki Doki developer documentation.',
  })

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!searchQuery.trim()) return
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    // The [data-open-modal] button starts disabled until pagefind loads.
    // Directly show the dialog instead, then poll for the search input.
    const dialog = doc.querySelector<HTMLDialogElement>('site-search dialog')
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    const tryInject = (attempts = 0) => {
      const input = doc.querySelector<HTMLInputElement>('.pagefind-ui__search-input')
      if (input) {
        input.value = searchQuery.trim()
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
      } else if (attempts < 20) {
        setTimeout(() => tryInject(attempts + 1), 100)
      }
    }
    tryInject()
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <AppBreadcrumb
        crumbs={[
          { label: 'Knowledge', href: '/' },
          { label, icon: Icon },
        ]}
      >
        <Button
          variant="ghost" size="icon" className="size-8 shrink-0"
          onClick={() => iframeRef.current?.contentWindow?.history.back()}
          title="Back"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          variant="ghost" size="icon" className="size-8 shrink-0"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}
          title="Forward"
        >
          <ArrowRight className="size-4" />
        </Button>
        <form onSubmit={handleSearch} className="flex flex-1 gap-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${label}…`}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary" className="h-8 px-3">Go</Button>
        </form>
        <a href={initUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
          <Button variant="ghost" size="icon" className="size-8" asChild>
            <span><ExternalLink className="size-4" /></span>
          </Button>
        </a>
      </AppBreadcrumb>

      <div className="flex-1 overflow-hidden">
        <iframe
          ref={iframeRef}
          src={initUrl}
          className="h-full w-full border-0"
          title={label}
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        />
      </div>
    </div>
  )
}
