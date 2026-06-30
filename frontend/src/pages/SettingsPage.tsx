import { useNavigate, useParams } from 'react-router-dom'
import { Bell, Home, Info, LayoutGrid, MonitorPlay, Palette, SlidersHorizontal, UserCircle, Wrench } from 'lucide-react'
import { PanelLayout, type PanelSection } from '@/components/shared/PanelLayout'
import { SettingsProfileTab } from '@/components/settings/SettingsProfileTab'
import { SettingsToolsTab } from '@/components/settings/SettingsToolsTab'
import { SettingsAppearanceTab } from '@/components/settings/SettingsAppearanceTab'
import { SettingsHomeTab } from '@/components/settings/SettingsHomeTab'
import { SettingsAboutTab } from '@/components/settings/SettingsAboutTab'
import { SettingsPrivacyTab } from '@/components/settings/SettingsPrivacyTab'
import { SettingsNotificationsTab } from '@/components/settings/SettingsNotificationsTab'
import { SettingsPlexTab } from '@/components/settings/SettingsPlexTab'
import { SettingsStreamDeckTab } from '@/components/settings/SettingsStreamDeckTab'
import { usePublishUIContext } from '@/context/UIContextProvider'

const SECTIONS: PanelSection[] = [
  { id: 'profile',       label: 'Profile',        icon: UserCircle },
  { id: 'home',          label: 'Home',            icon: Home       },
  { id: 'tools',         label: 'Tools',           icon: Wrench     },
  { id: 'plex',          label: 'Plex',            icon: MonitorPlay },
  { id: 'appearance',    label: 'Appearance',      icon: Palette    },
  { id: 'content',       label: 'Content',         icon: SlidersHorizontal },
  { id: 'notifications', label: 'Notifications',   icon: Bell       },
  { id: 'stream-deck',   label: 'Controller',      icon: LayoutGrid },
  { id: 'about',         label: 'About',           icon: Info       },
]

export function SettingsPage() {
  const { section = 'profile' } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const sectionLabel = SECTIONS.find((s) => s.id === section)?.label ?? section
  usePublishUIContext({ label: 'Settings', description: `User is in the Settings panel, "${sectionLabel}" tab.` })

  return (
    <PanelLayout
      sections={SECTIONS}
      activeSection={section}
      onSection={id => navigate(`/settings/${id}`, { replace: true })}
    >
      {section === 'profile'       && <SettingsProfileTab />}
      {section === 'home'          && <SettingsHomeTab />}
      {section === 'tools'         && <SettingsToolsTab />}
      {section === 'plex'          && <SettingsPlexTab />}
      {section === 'appearance'    && <SettingsAppearanceTab />}
      {section === 'content'       && <SettingsPrivacyTab />}
      {section === 'notifications' && <SettingsNotificationsTab />}
      {section === 'stream-deck'   && <SettingsStreamDeckTab />}
      {section === 'about'         && <SettingsAboutTab />}
    </PanelLayout>
  )
}
