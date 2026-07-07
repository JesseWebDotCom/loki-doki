import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SkipForward, Sparkles, Wand2, FileText, Rss, Bot, Play, Plug, ShieldCheck } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { getAppByPath } from '@/lib/appCategories'
import {
  SettingsYoutubeChannels, SettingsYoutubeAutoSkip, SettingsYoutubeVideoQuality,
  SettingsYoutubeTitlesThumbnails, SettingsYoutubeDescriptions,
} from '@/components/settings/SettingsYoutubeTab'
import { SettingsVideoSources } from '@/components/settings/SettingsVideoSources'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'
import { ToolConfigFields } from '@/components/shared/ToolConfigFields'
import { AdminYoutubeLimitsSection } from '@/components/admin/AdminYoutubeLimitsSection'

// Settings home for the Videos hub. ONE "Connect" section holds every source's connection
// (YouTube account sign-in, Reddit/Vimeo keys, TikTok note) so linking a source is never
// scattered. The remaining sections are YouTube-specific and grouped under a "YouTube"
// heading so it's clear what applies where; the companion toggle + admin controls sit under
// "General".
const SECTIONS: AppSettingsSection[] = [
  { id: 'connect',      label: 'Connect',             icon: Plug,        content: <SettingsVideoSources /> },
  { id: 'channels',     label: 'Channels',            icon: Rss,         group: 'YouTube', content: <SettingsYoutubeChannels /> },
  { id: 'auto-skip',    label: 'Auto-skip',           icon: SkipForward, group: 'YouTube', content: <SettingsYoutubeAutoSkip /> },
  { id: 'quality',      label: 'Video quality',       icon: Sparkles,    group: 'YouTube', content: <SettingsYoutubeVideoQuality /> },
  { id: 'titles',       label: 'Titles & thumbnails', icon: Wand2,       group: 'YouTube', content: <SettingsYoutubeTitlesThumbnails /> },
  { id: 'descriptions', label: 'Descriptions',        icon: FileText,    group: 'YouTube', content: <SettingsYoutubeDescriptions /> },
  { id: 'companion',    label: 'Companion',           icon: Bot,         group: 'General', content: <CompanionAbilitiesCard appId="youtube" /> },
  {
    id: 'admin', label: 'Admin', icon: ShieldCheck, adminOnly: true, group: 'General',
    content: (
      <div className="space-y-6">
        <ToolConfigFields toolId="youtube" />
        <AdminYoutubeLimitsSection />
      </div>
    ),
  },
]

export function VideosSettingsPage() {
  const { section: raw = 'connect' } = useParams<{ section?: string }>()
  // Old deep links (/settings/account for the YouTube sign-in, /settings/sources for the
  // per-source keys) both now live under Connect.
  const section = raw === 'account' || raw === 'sources' ? 'connect' : raw
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
