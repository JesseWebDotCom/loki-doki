import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Wifi, Cpu, ShieldCheck, Globe, HardDrive } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { useStoreApps, type StoreApp } from '@/lib/store/useStoreApps'
import { AppIcon } from '@/components/store/AppIcon'
import { PrimaryAction, SecondaryActions } from '@/components/store/StoreActions'
import { StoreAppCard } from '@/components/store/StoreAppCard'
import { ServiceConsentCard } from '@/components/shared/ServiceConsentCard'

type Tab = 'overview' | 'sources' | 'related'

export function StoreAppDetailPage() {
  const { appId = '' } = useParams()
  const { apps, getApp, isLoading } = useStoreApps()
  const app = getApp(appId)
  const [tab, setTab] = useState<Tab>('overview')

  if (isLoading) {
    return <div className="px-5 py-20 text-center text-sm text-muted-foreground/60">Loading…</div>
  }
  if (!app) {
    return (
      <div className="px-5 py-20 text-center text-sm text-muted-foreground">
        App not found. <Link to="/app-store" className="text-brand hover:underline">Back to store</Link>
      </div>
    )
  }

  const related = apps.filter(a => a.categoryKey === app.categoryKey && a.id !== app.id).slice(0, 4)
  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'sources', label: 'Data Sources' },
    { id: 'related', label: 'Related' },
  ]

  return (
    <PageContainer className="py-6 pb-20">
      <Link to="/app-store" className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Go back
      </Link>

      {/* Hero: calm bg-card panel; the app tile keeps its identity gradient. */}
      <div className="relative mb-6 overflow-hidden rounded-sheet border border-border bg-card">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(640px circle at 0% 0%, color-mix(in oklch, ${app.accent} 22%, transparent), transparent 62%)` }}
        />
        <div className="relative flex flex-col gap-5 p-6 sm:flex-row sm:items-start sm:p-8">
          <AppIcon app={app} className="size-24" iconClassName="size-12" rounded="rounded-sheet" />

          <div className="min-w-0 flex-1">
            {/* design-ok(raw-h1-in-pages): bespoke detail hero (tile + tags + actions) that PageHeader can't host; title uses the sanctioned text-display style */}
            <h1 className="text-display">{app.name}</h1>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              {app.category}
              {app.builtIn && (
                <span className="inline-flex items-center gap-1 text-success">
                  <ShieldCheck className="size-3.5" /> Built-in
                </span>
              )}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Tag>{app.offline ? 'Extension' : 'App'}</Tag>
              <Tag>{app.online ? 'Connects online' : 'Runs locally'}</Tag>
              <Tag>{app.category}</Tag>
            </div>

            <p className="mt-4 max-w-2xl text-sm text-muted-foreground leading-relaxed">{app.description}</p>

            <div className="mt-5 flex items-center gap-2">
              <PrimaryAction app={app} size="md" />
              <SecondaryActions app={app} className="size-9 border border-border" />
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Main column with tabs */}
        <div className="min-w-0 flex-1">
          <div className="mb-5 flex gap-6 border-b border-border/40">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  '-mb-px border-b-2 pb-2.5 text-sm font-semibold transition-colors',
                  tab === t.id ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <OverviewTab app={app} />}
          {tab === 'sources' && <SourcesTab app={app} />}
          {tab === 'related' && (
            related.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {related.map(a => <StoreAppCard key={a.id} app={a} />)}
              </div>
            ) : (
              <p className="py-8 text-sm text-muted-foreground/60">No related apps.</p>
            )
          )}
        </div>

        {/* Details panel */}
        <DetailsPanel app={app} />
      </div>
    </PageContainer>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted/70 px-3 py-1 text-xs font-medium text-muted-foreground">{children}</span>
  )
}

function OverviewTab({ app }: { app: StoreApp }) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-base font-semibold">About this app</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{app.description}</p>
      </section>
      {app.examples.length > 0 && (
        <section>
          <h3 className="mb-2 text-base font-semibold">Try saying</h3>
          <ul className="space-y-1.5">
            {app.examples.map((ex, i) => (
              <li key={i} className="rounded-control bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
                “{ex}”
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function SourcesTab({ app }: { app: StoreApp }) {
  if (app.dataSources.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-card bg-secondary/50 p-4">
        <HardDrive className="mt-0.5 size-5 shrink-0 text-success" />
        <div>
          <p className="text-sm font-medium">Fully local</p>
          <p className="text-xs text-muted-foreground leading-snug">
            This app runs entirely on your local hardware. No external connections are made.
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Globe className="size-4" /> Connects to {app.dataSources.length} external {app.dataSources.length === 1 ? 'service' : 'services'}.
      </p>
      <ServiceConsentCard name={app.name} dataSources={app.dataSources} />
    </div>
  )
}

function DetailsPanel({ app }: { app: StoreApp }) {
  const rows: [string, React.ReactNode][] = [
    ['Category', app.category],
    ['Type', app.offline ? 'Extension' : 'App'],
    ['Connectivity', (
      <span className="inline-flex items-center gap-1.5">
        {app.online ? <Wifi className="size-3.5 text-info" /> : <Cpu className="size-3.5 text-muted-foreground" />}
        {app.online ? 'Online' : 'Local'}
      </span>
    )],
    ['Source', app.builtIn ? 'Built-in' : 'Installable'],
    ['Status', app.enabled ? 'Installed' : 'Not installed'],
    ['Data sources', String(app.dataSources.length)],
  ]
  return (
    <aside className="w-full shrink-0 rounded-card border border-border bg-card p-5 lg:w-72">
      <h3 className="mb-3 text-base font-semibold">Details</h3>
      <dl className="divide-y divide-border/50">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}
