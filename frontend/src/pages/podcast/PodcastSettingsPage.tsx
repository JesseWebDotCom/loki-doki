import { Mic, Rss, SlidersHorizontal, FolderInput } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { AdminPodcastsTab } from '@/components/admin/AdminPodcastsTab'
import { PodcastPlaybackSection } from '@/components/podcast/PodcastPlaybackSection'
import { PodcastOpmlSection } from '@/components/podcast/PodcastOpmlSection'
import { getAppByPath } from '@/lib/appCategories'

// Standard per-app Settings home for Podcasts. Playback (voice boost / trim silence)
// and Subscriptions (OPML import/export) are per-user; show & subscription management
// stays admin-scoped (the shell shows non-admins a locked notice there).
const SECTIONS: AppSettingsSection[] = [
  { id: 'playback', label: 'Playback', icon: SlidersHorizontal, content: <PodcastPlaybackSection /> },
  { id: 'subscriptions', label: 'Subscriptions', icon: FolderInput, content: <PodcastOpmlSection /> },
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
