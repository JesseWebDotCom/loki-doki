import { Mic, Rss, SlidersHorizontal, FolderInput, Smartphone } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { AdminPodcastsTab } from '@/components/admin/AdminPodcastsTab'
import { PodcastPlaybackSection } from '@/components/podcast/PodcastPlaybackSection'
import { PodcastOpmlSection } from '@/components/podcast/PodcastOpmlSection'
import { PodcastSyncSection } from '@/components/podcast/PodcastSyncSection'
import { getAppByPath } from '@/lib/appCategories'

// Standard per-app Settings home for Podcasts. Playback (voice boost / trim silence),
// Subscriptions (OPML import/export), and Sync & feeds (private RSS out + gPodder app
// password) are per-user; show & subscription management stays admin-scoped (the shell
// shows non-admins a locked notice there).
const SECTIONS: AppSettingsSection[] = [
  { id: 'playback', label: 'Playback', icon: SlidersHorizontal, content: <PodcastPlaybackSection /> },
  { id: 'subscriptions', label: 'Subscriptions', icon: FolderInput, content: <PodcastOpmlSection /> },
  { id: 'sync', label: 'Sync & feeds', icon: Smartphone, content: <PodcastSyncSection /> },
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
