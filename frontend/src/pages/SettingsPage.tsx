import { useNavigate, useParams } from 'react-router-dom'
import { Bell, Home, Info, Palette, Shield, UserCircle, Wrench } from 'lucide-react'
import { PanelLayout, type PanelSection } from '@/components/shared/PanelLayout'
import { SettingsProfileTab } from '@/components/settings/SettingsProfileTab'
import { SettingsToolsTab } from '@/components/settings/SettingsToolsTab'
import { SettingsAppearanceTab } from '@/components/settings/SettingsAppearanceTab'
import { SettingsHomeTab } from '@/components/settings/SettingsHomeTab'
import { SettingsAboutTab } from '@/components/settings/SettingsAboutTab'
import { SettingsPrivacyTab } from '@/components/settings/SettingsPrivacyTab'
import { usePublishUIContext } from '@/context/UIContextProvider'

const SECTIONS: PanelSection[] = [
  { id: 'profile',       label: 'Profile',        icon: UserCircle },
  { id: 'home',          label: 'Home',            icon: Home       },
  { id: 'tools',         label: 'Tools',           icon: Wrench     },
  { id: 'appearance',    label: 'Appearance',      icon: Palette    },
  { id: 'privacy',       label: 'Privacy',         icon: Shield     },
  { id: 'notifications', label: 'Notifications',   icon: Bell       },
  { id: 'about',         label: 'About',           icon: Info       },
]

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  )
}

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
      {section === 'appearance'    && <SettingsAppearanceTab />}
      {section === 'privacy'       && <SettingsPrivacyTab />}
      {section === 'notifications' && <Placeholder label="Notifications — coming soon" />}
      {section === 'about'         && <SettingsAboutTab />}
    </PanelLayout>
  )
}
