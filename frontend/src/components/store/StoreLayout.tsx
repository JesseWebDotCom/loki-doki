import { Outlet } from 'react-router-dom'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { StoreActionsProvider } from '@/components/store/StoreActions'
import { StoreRail } from '@/components/store/StoreRail'
import { StoreTopBar } from '@/components/store/StoreTopBar'
import { useStoreApps } from '@/lib/store/useStoreApps'

/** Persistent shell for every /app-store view: own rail + top bar + outlet. */
export function StoreLayout() {
  const { installedCount } = useStoreApps()
  usePublishUIContext({ label: 'App Store', description: 'User is browsing the App Store.' })

  return (
    <StoreActionsProvider>
      <div className="flex min-h-full bg-background">
        <StoreRail installedCount={installedCount} />
        <div className="flex min-w-0 flex-1 flex-col">
          <StoreTopBar />
          <div className="flex-1">
            <Outlet />
          </div>
        </div>
      </div>
    </StoreActionsProvider>
  )
}
