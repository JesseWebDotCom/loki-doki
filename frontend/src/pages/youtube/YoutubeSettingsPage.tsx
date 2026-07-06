import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SkipForward, Sparkles, Wand2, FileText, Rss, Bot, Play } from 'lucide-react'
import { AppSettingsShell, type AppSettingsSection } from '@/components/shared/AppSettingsShell'
import { getAppByPath } from '@/lib/appCategories'
import {
  SettingsYoutubeChannels, SettingsYoutubeAutoSkip, SettingsYoutubeVideoQuality,
  SettingsYoutubeTitlesThumbnails, SettingsYoutubeDescriptions,
} from '@/components/settings/SettingsYoutubeTab'
import { CompanionAbilitiesCard } from '@/components/shared/CompanionAbilitiesCard'

// Standard per-app Settings home for YouTube: channel management (subscriptions, auto-save,
// save quality, pause automation) plus the user-scoped viewing prefs (SponsorBlock / DeArrow /
// Smart Description). The Channels section surfaces the one admin control (default keep-N)
// inline when the viewer is an admin; broader app config still lives in central Admin → Apps.
const SECTIONS: AppSettingsSection[] = [
  { id: 'channels',     label: 'Channels',            icon: Rss,         content: <SettingsYoutubeChannels /> },
  { id: 'auto-skip',    label: 'Auto-skip',           icon: SkipForward, content: <SettingsYoutubeAutoSkip /> },
  { id: 'quality',      label: 'Video quality',       icon: Sparkles,    content: <SettingsYoutubeVideoQuality /> },
  { id: 'titles',       label: 'Titles & thumbnails', icon: Wand2,       content: <SettingsYoutubeTitlesThumbnails /> },
  { id: 'descriptions', label: 'Descriptions',        icon: FileText,    content: <SettingsYoutubeDescriptions /> },
  { id: 'companion',    label: 'Companion',           icon: Bot,         content: <CompanionAbilitiesCard appId="youtube" /> },
]

export function YoutubeSettingsPage() {
  const { section = 'channels' } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const go = useCallback((id: string) => navigate(`/youtube/settings/${id}`, { replace: true }), [navigate])

  return (
    <AppSettingsShell
      appId="youtube"
      icon={Play}
      gradient={getAppByPath('/youtube')?.gradient}
      sections={SECTIONS}
      activeSection={section}
      onNavigate={go}
    />
  )
}
