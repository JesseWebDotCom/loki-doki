import { useEffect } from 'react'
import { Code2, FileText, Globe, Sparkles, Plus } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  useArtifactState, refreshArtifacts, openArtifact, clearUnseen,
  type ArtifactSummary,
} from '@/lib/canvas/artifactStore'

const TYPE_META = {
  code: { icon: Code2, label: 'Code' },
  document: { icon: FileText, label: 'Document' },
  html: { icon: Globe, label: 'Web page' },
} as const

function timeAgo(ts: string | number): string {
  const then = typeof ts === 'number' ? ts : Date.parse(ts)
  const s = Math.floor((Date.now() - then) / 1000)
  if (isNaN(then)) return ''
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function ArtifactCard({ a }: { a: ArtifactSummary }) {
  const meta = TYPE_META[a.type] ?? TYPE_META.document
  const Icon = meta.icon
  return (
    <Card
      variant="surface"
      className="cursor-pointer overflow-hidden transition-colors hover:border-primary/40"
      onClick={() => void openArtifact(a.id)}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-card bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{a.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {meta.label}{a.language ? ` · ${a.language}` : ''} · {timeAgo(a.updatedAt)}
          </p>
        </div>
      </div>
      {a.currentContent && (
        <p className="line-clamp-2 border-t border-border bg-background/40 px-4 py-2 text-xs text-muted-foreground">
          {a.currentContent.slice(0, 160)}
        </p>
      )}
    </Card>
  )
}

export function CanvasPage() {
  useAppHeader({ query: '', setQuery: () => {}, searchable: false, settingsHref: '/apps/canvas/settings' })
  const { recent } = useArtifactState()

  useEffect(() => { void refreshArtifacts(); clearUnseen() }, [])

  async function newDoc() {
    const r = await fetch('/api/artifacts', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'document', title: 'Untitled', content: '' }),
    })
    if (r.ok) { const { artifact } = await r.json(); void refreshArtifacts(); void openArtifact(artifact.id) }
  }

  return (
    <PageContainer>
      <PageHeader
        subtitle="Documents, code, and pages your companion writes - open, edit, and export them here."
        actions={<Button onClick={newDoc}><Plus className="size-4" /> New document</Button>}
      />
      {recent.length === 0 ? (
        <EmptyAppState
          icon={Sparkles}
          title="Your canvas is empty"
          tagline="Ask your companion to write something - a letter, a checklist, a code snippet, a web page - and it appears here, ready to edit."
          features={[
            { icon: FileText, title: 'Documents', desc: 'Letters, essays, plans, notes' },
            { icon: Code2, title: 'Code', desc: 'Snippets and single files' },
            { icon: Globe, title: 'Web pages', desc: 'Small self-contained HTML' },
          ]}
          actions={<Button onClick={newDoc}><Plus className="size-4" /> New document</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 pb-12 sm:grid-cols-2 lg:grid-cols-3">
          {recent.map((a) => <ArtifactCard key={a.id} a={a} />)}
        </div>
      )}
    </PageContainer>
  )
}
