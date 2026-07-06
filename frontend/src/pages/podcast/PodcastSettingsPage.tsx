import { Mic, Rss } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { AdminPodcastsTab } from '@/components/admin/AdminPodcastsTab'
import { getAppByPath } from '@/lib/appCategories'

// Standard per-app Settings home for Podcasts (replaces the old /podcasts/admin
// AdminGate page). All content is admin-scoped today: show & subscription
// management; the shell shows non-admins a locked notice.
const SECTIONS: AppSettingsSection[] = [
  { id: 'shows', label: 'Manage shows', icon: Rss, adminOnly: true, content: <AdminPodcastsTab /> },
]

export function PodcastSettingsPage() {
  return (
    <AppSettingsShell
      appId="podcasts"
      icon={Mic}
      gradient={getAppByPath('/podcasts')?.gradient}
      sections={SECTIONS}
    />
  )
}
