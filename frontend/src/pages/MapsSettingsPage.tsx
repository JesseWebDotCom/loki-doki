import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Bot, Globe2, Map as MapIcon } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { MapsRegionSection } from '@/components/admin/MapsRegionSection'
import { MapSettingsPanel } from '@/pages/maps/panels/MapSettingsPanel'
import { useMapPrefs } from '@/pages/maps/use-map-prefs'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { getAppByPath } from '@/lib/appCategories'

/** The Maps app's own settings page: map display prefs for everyone, offline
 *  region installation for admins. Reached from the Maps header gear and the
 *  in-map settings dock panel. */
export function MapsSettingsPage() {
  const { prefs, setPref, resetPrefs } = useMapPrefs()
  const { section = 'display' } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const go = useCallback((id: string) => navigate(`/maps/settings/${id}`, { replace: true }), [navigate])

  usePublishUIContext({ label: 'Maps Settings', description: 'User is on the Maps settings page.' })

  const app = getAppByPath('/maps')

  const sections: AppSettingsSection[] = [
    {
      id: 'display',
      label: 'Map display',
      icon: MapIcon,
      content: (
        <div className="max-w-2xl">
          <MapSettingsPanel prefs={prefs} onChangePref={setPref} onReset={resetPrefs} variant="page" />
        </div>
      ),
    },
    {
      id: 'regions',
      label: 'Offline regions',
      icon: Globe2,
      adminOnly: true,
      content: (
        <div className="max-w-2xl">
          <MapsRegionSection />
        </div>
      ),
    },
    { id: 'companion', label: 'Companion', icon: Bot, content: <CompanionAbilitiesCard appId="maps" /> },
  ]

  return (
    <AppSettingsShell
      appId="maps"
      icon={app?.icon}
      gradient={app?.gradient}
      sections={sections}
      activeSection={section}
      onNavigate={go}
    />
  )
}
