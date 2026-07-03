import { Link } from 'react-router-dom'
import { DownloadCloud, ShoppingBag } from 'lucide-react'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useStoreApps } from '@/lib/store/useStoreApps'
import { StoreAppCard } from '@/components/store/StoreAppCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'
import { STORE_GRADIENT } from '@/components/store/StoreRail'

export function StoreInstalledPage() {
  const { apps, isLoading } = useStoreApps()
  const installed = apps.filter(a => a.enabled)

  return (
    <PageContainer className="pb-20">
      <PageHeader
        title="Installed"
        eyebrow="App Store"
        icon={ShoppingBag}
        gradient={STORE_GRADIENT}
        subtitle={`${installed.length} apps and extensions ready to use.`}
      />

      {isLoading ? (
        <CardGridSkeleton />
      ) : installed.length === 0 ? (
        <div className={cn(cardVariants({ variant: 'dashed' }), 'flex flex-col items-center gap-2 py-24 text-center')}>
          <DownloadCloud className="size-8 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/60">Nothing installed yet.</p>
          <Link to="/app-store/browse" className="text-sm font-medium text-brand hover:underline">Browse apps</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {installed.map(app => <StoreAppCard key={app.id} app={app} />)}
        </div>
      )}
    </PageContainer>
  )
}
