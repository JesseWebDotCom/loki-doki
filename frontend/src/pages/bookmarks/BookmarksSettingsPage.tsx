import { AdminSection } from '@/components/shared/AdminGate'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SettingsSaveToLokiTab } from '@/components/settings/SettingsSaveToLokiTab'
import { AdminBookmarksTab } from '@/components/admin/AdminBookmarksTab'

// Standard per-app Settings home for Bookmarks: a user section (everyone) + an admin-only
// section (global links). Reached from the rail "Settings" entry by all users; the admin
// block simply doesn't render for non-admins.
export function BookmarksSettingsPage() {
  return (
    <PageContainer width="narrow" className="h-full space-y-8 overflow-y-auto py-6">
      <PageHeader title="Bookmarks settings" className="py-0" />

      {/* User section - capturing pages into Bookmarks */}
      <SettingsSaveToLokiTab />

      {/* Admin section - links shared with every user */}
      <AdminSection title="Global links" description="shared with everyone">
        <AdminBookmarksTab />
      </AdminSection>
    </PageContainer>
  )
}
