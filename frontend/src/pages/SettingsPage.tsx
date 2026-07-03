import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Bell, Brain, Cpu, Home, Info, Menu, MonitorPlay, Palette, SlidersHorizontal, UserCircle, Wrench } from 'lucide-react'
import type { PanelSection } from '@/components/shared/PanelLayout'
import { SettingsSidebar } from '@/components/settings/SettingsSidebar'
import { Button } from '@/components/ui/button'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { SettingsProfileTab } from '@/components/settings/SettingsProfileTab'
import { SettingsToolsTab } from '@/components/settings/SettingsToolsTab'
import { SettingsAppearanceTab } from '@/components/settings/SettingsAppearanceTab'
import { SettingsHomeTab } from '@/components/settings/SettingsHomeTab'
import { SettingsAboutTab } from '@/components/settings/SettingsAboutTab'
import { SettingsPrivacyTab } from '@/components/settings/SettingsPrivacyTab'
import { SettingsNotificationsTab } from '@/components/settings/SettingsNotificationsTab'
import { SettingsPlexTab } from '@/components/settings/SettingsPlexTab'
import { SettingsDevicesTab } from '@/components/settings/SettingsDevicesTab'
import { SettingsMemoryTab } from '@/components/settings/SettingsMemoryTab'
import { usePublishUIContext } from '@/context/UIContextProvider'

const SECTIONS: PanelSection[] = [
  { id: 'profile',       label: 'Profile',        icon: UserCircle },
  { id: 'home',          label: 'Home',            icon: Home       },
  { id: 'tools',         label: 'Tools',           icon: Wrench     },
  { id: 'plex',          label: 'Plex',            icon: MonitorPlay },
  { id: 'appearance',    label: 'Appearance',      icon: Palette    },
  { id: 'content',       label: 'Content',         icon: SlidersHorizontal },
  { id: 'memory',        label: 'Memory',          icon: Brain      },
  { id: 'notifications', label: 'Notifications',   icon: Bell       },
  { id: 'devices',       label: 'Devices',         icon: Cpu        },
  { id: 'about',         label: 'About',           icon: Info       },
]

export function SettingsPage() {
  const { section = 'profile' } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const sectionLabel = SECTIONS.find((s) => s.id === section)?.label ?? section
  usePublishUIContext({ label: 'Settings', description: `User is in the Settings panel, "${sectionLabel}" tab.` })

  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('settings.sidebarCollapsed') === '1')
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => { const next = !c; localStorage.setItem('settings.sidebarCollapsed', next ? '1' : '0'); return next })
  }, [])

  const go = useCallback((id: string) => {
    navigate(`/settings/${id}`, { replace: true })
    setMobileNavOpen(false)
  }, [navigate])

  // Publish the active section into the ONE global breadcrumb (Home > Settings >
  // Appearance) instead of a second local header bar; the mobile-nav trigger rides
  // along as a slot on the same bar.
  useAppHeader({
    query: '', setQuery: () => {}, searchable: false,
    leftSlot: (
      <Button variant="ghost" size="icon-sm" onClick={() => setMobileNavOpen(true)} className="md:hidden" aria-label="Open navigation">
        <Menu className="size-5" />
      </Button>
    ),
    extraCrumbs: [{ label: sectionLabel }],
  })

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Desktop sidebar (collapsible icon rail) */}
      <SettingsSidebar
        className="hidden md:flex"
        sections={SECTIONS} activeSection={section} onNavigate={go}
        collapsed={collapsed} onToggleCollapse={toggleCollapsed}
      />

      {/* Mobile nav drawer */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Settings navigation</SheetTitle>
          <SettingsSidebar className="h-full w-full border-r-0" sections={SECTIONS} activeSection={section} onNavigate={go} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          {section === 'profile'       && <SettingsProfileTab />}
          {section === 'home'          && <SettingsHomeTab />}
          {section === 'tools'         && <SettingsToolsTab />}
          {section === 'plex'          && <SettingsPlexTab />}
          {section === 'appearance'    && <SettingsAppearanceTab />}
          {section === 'content'       && <SettingsPrivacyTab />}
          {section === 'memory'        && <SettingsMemoryTab />}
          {section === 'notifications' && <SettingsNotificationsTab />}
          {section === 'devices'       && <SettingsDevicesTab />}
          {section === 'about'         && <SettingsAboutTab />}
        </div>
      </div>
    </div>
  )
}
