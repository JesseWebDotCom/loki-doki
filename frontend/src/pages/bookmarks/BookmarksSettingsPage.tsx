import { AdminSection } from '@/components/shared/AdminGate'
import { SettingsSaveToLokiTab } from '@/components/settings/SettingsSaveToLokiTab'
import { AdminBookmarksTab } from '@/components/admin/AdminBookmarksTab'

// Standard per-app Settings home for Bookmarks: a user section (everyone) + an admin-only
// section (global links). Reached from the rail "Settings" entry by all users; the admin
// block simply doesn't render for non-admins.
export function BookmarksSettingsPage() {
  return (
    <div className="mx-auto h-full max-w-3xl space-y-8 overflow-y-auto p-6">
      <h1 className="text-2xl font-bold">Bookmarks settings</h1>

      {/* User section — capturing pages into Bookmarks */}
      <SettingsSaveToLokiTab />

      {/* Admin section — links shared with every user */}
      <AdminSection title="Global links" description="shared with everyone">
        <AdminBookmarksTab />
      </AdminSection>
    </div>
  )
}
