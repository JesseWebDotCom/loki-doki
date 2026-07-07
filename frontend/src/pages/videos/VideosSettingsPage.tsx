import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SkipForward, Sparkles, Wand2, FileText, Rss, Bot, Play, CircleUserRound, Globe, ShieldCheck } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { getAppByPath } from '@/lib/appCategories'
import {
  SettingsYoutubeChannels, SettingsYoutubeAutoSkip, SettingsYoutubeVideoQuality,
  SettingsYoutubeTitlesThumbnails, SettingsYoutubeDescriptions,
} from '@/components/settings/SettingsYoutubeTab'
import { SettingsYoutubeAccount } from '@/components/settings/SettingsYoutubeAccount'
import { SettingsVideoSources } from '@/components/settings/SettingsVideoSources'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { ToolConfigFields } from '@/components/shared/ToolConfigFields'
import { AdminYoutubeLimitsSection } from '@/components/admin/AdminYoutubeLimitsSection'

// Settings home for the Videos hub: the YouTube sections carry over from the retired
// standalone app (channels, account sync, auto-skip, quality, titles, descriptions), plus
// per-source connections (Reddit client id, Vimeo token, TikTok cookies note) and the
// companion ability toggle. Section admin controls surface inline for admins.
const SECTIONS: AppSettingsSection[] = [
  { id: 'channels',     label: 'Channels',            icon: Rss,         content: <SettingsYoutubeChannels /> },
  { id: 'account',      label: 'Account',             icon: CircleUserRound, content: <SettingsYoutubeAccount /> },
  { id: 'auto-skip',    label: 'Auto-skip',           icon: SkipForward, content: <SettingsYoutubeAutoSkip /> },
  { id: 'quality',      label: 'Video quality',       icon: Sparkles,    content: <SettingsYoutubeVideoQuality /> },
  { id: 'titles',       label: 'Titles & thumbnails', icon: Wand2,       content: <SettingsYoutubeTitlesThumbnails /> },
  { id: 'descriptions', label: 'Descriptions',        icon: FileText,    content: <SettingsYoutubeDescriptions /> },
  { id: 'sources',      label: 'Sources',             icon: Globe,       content: <SettingsVideoSources /> },
  { id: 'companion',    label: 'Companion',           icon: Bot,         content: <CompanionAbilitiesCard appId="youtube" /> },
  {
    id: 'admin', label: 'Admin', icon: ShieldCheck, adminOnly: true,
    content: (
      <div className="space-y-6">
        <ToolConfigFields toolId="youtube" />
        <AdminYoutubeLimitsSection />
      </div>
    ),
  },
]

export function VideosSettingsPage() {
  const { section = 'channels' } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const go = useCallback((id: string) => navigate(`/videos/settings/${id}`, { replace: true }), [navigate])

  return (
    <AppSettingsShell
      appId="youtube"
      icon={Play}
      gradient={getAppByPath('/videos')?.gradient}
      sections={SECTIONS}
      activeSection={section}
      onNavigate={go}
    />
  )
}
