import { Link } from 'react-router-dom'
import { DownloadCloud } from 'lucide-react'
import { useStoreApps } from '@/lib/store/useStoreApps'
import { StoreAppCard } from '@/components/store/StoreAppCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function StoreInstalledPage() {
  const { apps, isLoading } = useStoreApps()
  const installed = apps.filter(a => a.enabled)

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6 pb-20">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Installed</h1>
        <p className="text-sm text-muted-foreground">{installed.length} apps and extensions ready to use.</p>
      </div>

      {isLoading ? (
        <CardGridSkeleton />
      ) : installed.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center">
          <DownloadCloud className="size-8 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/60">Nothing installed yet.</p>
          <Link to="/app-store/browse" className="text-sm font-medium text-brand hover:underline">Browse apps</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {installed.map(app => <StoreAppCard key={app.id} app={app} />)}
        </div>
      )}
    </div>
  )
}
