import { Outlet } from 'react-router-dom'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { CompanionStoreRail } from '@/components/companions/store/CompanionStoreRail'
import { CompanionStoreTopBar } from '@/components/companions/store/CompanionStoreTopBar'

/** Persistent shell for every /companions view: own rail + top bar + outlet. */
export function CompanionStoreLayout() {
  const { favorites } = useCompanionStore()
  usePublishUIContext({ label: 'Companions', description: 'User is browsing the Companion store.' })

  return (
    <div className="flex min-h-full bg-background">
      <CompanionStoreRail favoritesCount={favorites.length} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CompanionStoreTopBar />
        <div className="flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
