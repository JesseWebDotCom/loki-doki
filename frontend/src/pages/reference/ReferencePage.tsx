import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookMarked, BookOpen, HeartPulse, Plus, type LucideIcon } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { ArchiveIcon } from '@/components/shared/ArchiveIcon'
import { AddOfflinePacksDialog } from '@/components/shared/AddOfflinePacksDialog'
import { Spinner } from '@/components/ui/spinner'
import { useInstalledArchives, type InstalledArchive } from '@/hooks/useInstalledArchives'
import { categoryVisual, compareCategories } from '@/lib/archiveCategories'
import { getAppByPath } from '@/lib/appCategories'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAuth } from '@/context/AuthContext'

const REFERENCE_GRADIENT = getAppByPath('/reference')?.gradient

// Featured lookups: the Dictionary and Medical tools live inside Reference now,
// alongside the offline reference libraries, instead of as separate grid apps.
// design-ok(hex-in-tsx): lookup tile gradients carried over from the retired Dictionary/Medical app tiles
const LOOKUPS: { to: string; label: string; description: string; icon: LucideIcon; gradient: string }[] = [
  { to: '/reference/dictionary', label: 'Dictionary', description: 'Definitions, phonetics & pronunciation', icon: BookOpen, gradient: 'linear-gradient(135deg,#1e3a5f,#1d4ed8)' },
  { to: '/reference/medical', label: 'Medical', description: 'Look up conditions & medications', icon: HeartPulse, gradient: 'linear-gradient(135deg,#164e63,#0891b2)' },
]

function LookupCard({ to, label, description, icon: Icon, gradient }: (typeof LOOKUPS)[number]) {
  return (
    <Link
      to={to}
      className="group relative overflow-hidden rounded-card border border-border/40 bg-card/60 p-4 transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-control shadow-lg transition-transform group-hover:scale-110" style={{ background: gradient }}>
        <Icon className="size-6 text-white" />
      </div>
      <p className="text-[15px] font-bold leading-tight tracking-tight">{label}</p>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{description}</p>
    </Link>
  )
}

function ArchiveCard({ a }: { a: InstalledArchive }) {
  const visual = categoryVisual(a.category)
  return (
    <Link
      to={`/read/${a.sourceId}`}
      className="group relative overflow-hidden rounded-card border border-border/40 bg-card/60 p-4 transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-control shadow-lg transition-transform group-hover:scale-110" style={{ background: visual.gradient }}>
        <ArchiveIcon zimIconUrl={a.zimIconUrl} category={a.category} className="size-6" />
      </div>
      <p className="text-[15px] font-bold leading-tight tracking-tight">{a.label}</p>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{a.description ?? 'Reference library'}</p>
    </Link>
  )
}

export function ReferencePage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [addOpen, setAddOpen] = useState(false)
  const { data: archives = [], isLoading } = useInstalledArchives()

  usePublishUIContext({
    label: 'Reference',
    description: 'User is browsing Reference - Wikipedia, dictionary, medical and other offline references.',
  })

  // Reference = everything that isn't a book collection.
  const referenceArchives = useMemo(() => archives.filter((a) => a.bookCategory == null), [archives])
  const byCategory = useMemo(() => {
    const m = new Map<string, InstalledArchive[]>()
    for (const a of referenceArchives) {
      if (!m.has(a.category)) m.set(a.category, [])
      m.get(a.category)!.push(a)
    }
    return [...m.keys()].sort(compareCategories).map((cat) => [cat, m.get(cat)!] as const)
  }, [referenceArchives])

  return (
    <div className="h-full overflow-y-auto">
      <PageContainer className="space-y-8 py-6 pb-24">
        <PageHeader
          title="Reference"
          subtitle="Look things up - dictionary, medical, Wikipedia and more, online or off."
          icon={BookMarked}
          gradient={REFERENCE_GRADIENT}
          actions={isAdmin ? (
            <button
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent/50"
            >
              <Plus className="size-4" /> Add references
            </button>
          ) : undefined}
        />

        {/* Lookups */}
        <section>
          <SectionHeader title="Look up" className="mb-4" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {LOOKUPS.map((l) => <LookupCard key={l.to} {...l} />)}
          </div>
        </section>

        {/* Offline reference libraries */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>
        ) : referenceArchives.length > 0 ? (
          byCategory.map(([category, items]) => (
            <section key={category}>
              <SectionHeader title={category} count={items.length} className="mb-4" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((a) => <ArchiveCard key={a.id} a={a} />)}
              </div>
            </section>
          ))
        ) : (
          <EmptyAppState
            icon={BookMarked}
            title="No offline references yet"
            tagline="Add Wikipedia, medical guides, repair manuals and more to browse without a connection."
            gradient={REFERENCE_GRADIENT}
            actions={isAdmin ? (
              <button onClick={() => setAddOpen(true)} className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90">
                Add references
              </button>
            ) : undefined}
            features={[]}
          />
        )}
      </PageContainer>

      {isAdmin && <AddOfflinePacksDialog open={addOpen} onOpenChange={setAddOpen} mode="reference" />}
    </div>
  )
}
