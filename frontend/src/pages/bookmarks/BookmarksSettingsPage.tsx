import { BookmarkPlus, BookOpen, Bot, Globe } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { getAppByPath } from '@/lib/appCategories'
import { SettingsSaveToMaiPaiTab } from '@/components/settings/SettingsSaveToMaiPaiTab'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { AdminBookmarksTab } from '@/components/admin/AdminBookmarksTab'

// Standard per-app Settings home for Bookmarks: user sections (capturing pages,
// companion abilities) + an admin-only "Global links" section. Reached from the
// rail "Settings" entry by all users; the shell shows non-admins a locked notice
// for the admin section.
const SECTIONS: AppSettingsSection[] = [
  { id: 'save',      label: 'Save to MaiPai', icon: BookmarkPlus, content: <SettingsSaveToMaiPaiTab /> },
  { id: 'companion', label: 'Companion',    icon: Bot,          content: <CompanionAbilitiesCard appId="bookmarks" /> },
  {
    id: 'links',
    label: 'Global links',
    icon: Globe,
    adminOnly: true,
    content: (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Links shared with everyone.</p>
        <AdminBookmarksTab />
      </div>
    ),
  },
]

export function BookmarksSettingsPage() {
  return (
    <AppSettingsShell
      appId="bookmarks"
      icon={BookOpen}
      gradient={getAppByPath('/bookmarks')?.gradient}
      sections={SECTIONS}
    />
  )
}
