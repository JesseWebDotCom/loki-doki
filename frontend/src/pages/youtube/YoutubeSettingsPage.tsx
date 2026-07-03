import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SettingsYoutubeTab } from '@/components/settings/SettingsYoutubeTab'

// Standard per-app Settings home for YouTube. Currently user-scoped only (SponsorBlock /
// DeArrow prefs); admin/app config still lives in central Admin → Apps. If YouTube gains
// admin-specific settings later, add an <AdminSection> here.
export function YoutubeSettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <PageContainer width="narrow" className="pb-8">
        <PageHeader title="YouTube settings" className="pt-6 pb-5" />
        <SettingsYoutubeTab />
      </PageContainer>
    </div>
  )
}
