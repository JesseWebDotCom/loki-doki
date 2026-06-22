import { SettingsYoutubeTab } from '@/components/settings/SettingsYoutubeTab'

// Standard per-app Settings home for YouTube. Currently user-scoped only (SponsorBlock /
// DeArrow prefs); admin/app config still lives in central Admin → Apps. If YouTube gains
// admin-specific settings later, add an <AdminSection> here.
export function YoutubeSettingsPage() {
  return (
    <div className="mx-auto h-full max-w-3xl space-y-8 overflow-y-auto p-6">
      <h1 className="text-2xl font-bold">YouTube settings</h1>
      <SettingsYoutubeTab />
    </div>
  )
}
