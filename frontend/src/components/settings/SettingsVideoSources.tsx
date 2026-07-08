import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check, Compass, Search, UserPlus, MessageSquare, Download, Radio, TriangleAlert, Info,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { AppTabBar } from '@/components/shared/AppTabBar'
import { useAuth } from '@/context/AuthContext'
import { SettingsYoutubeAccount } from '@/components/settings/SettingsYoutubeAccount'
import { SOURCE_META } from '@/lib/videos/sources'
import { toast } from '@/lib/toast'
import {
  addFollow, getRedditConfig, getVideoSources, getVimeoConfig, putEnabledSources, putRedditConfig, putVimeoConfig,
  type SourceInfo, type VideoSource,
} from '@/lib/videos/api'

// Tabs for the Connect section, one per source. 'link' (Other sites) has no discovery
// surface or follow concept, but still gets a tab so its "nothing to set up" note lives
// somewhere discoverable instead of floating loose at the bottom of the old flat list.
const TABS: VideoSource[] = ['youtube', 'reddit', 'tiktok', 'vimeo', 'link']

const CAPABILITY_CHIPS: Array<{
  key: string
  label: string
  icon: typeof Compass
  active: (c: SourceInfo['capabilities']) => boolean
}> = [
  { key: 'browse', label: 'Browse', icon: Compass, active: (c) => c.browse },
  { key: 'search', label: 'Search', icon: Search, active: (c) => c.search },
  { key: 'follow', label: 'Follow', icon: UserPlus, active: (c) => c.creators },
  { key: 'comments', label: 'Comments', icon: MessageSquare, active: (c) => c.comments },
  { key: 'downloads', label: 'Downloads', icon: Download, active: (c) => c.downloadKinds.length > 0 },
  { key: 'live', label: 'Live', icon: Radio, active: (c) => c.live },
]

// Which capabilities the backend's status note is actually about, per source (both Reddit's
// and Vimeo's notes call out browsing/search specifically). Drives the amber "needs setup"
// chip state below instead of showing those chips as fully active while a note is pending.
const SETUP_GATED_CAPABILITIES: Partial<Record<VideoSource, string[]>> = {
  reddit: ['browse', 'search'],
  vimeo: ['browse', 'search'],
}

/** Graphical "what can this source do, right now" summary: a labeled, bordered card of
 *  capability chips plus a readiness badge, both driven by the same GET /api/videos/sources
 *  payload every other part of the hub already reads. Shown at the top of every source tab
 *  so the connect controls below always have context.
 *
 *  Readiness is driven by whether the backend has a `note` at all, not the raw `configured`
 *  boolean: Vimeo always reports configured:true (it works keyless) but still surfaces a note
 *  when its optional token is missing, and that's exactly the "something's worth setting up"
 *  signal a user cares about, so it renders the same amber "Setup needed" as Reddit's actually
 *  blocking missing-key case. */
function SourceCapabilityBar({ info }: { info?: SourceInfo }) {
  if (!info) return null
  const { note } = info.status
  const ready = !note
  const gated = SETUP_GATED_CAPABILITIES[info.source] ?? []
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">What this source can do</p>
        <Badge variant={ready ? 'success' : 'warning'} className="gap-1">
          {ready ? <Check className="size-3" /> : <TriangleAlert className="size-3" />}
          {ready ? 'Ready' : 'Setup needed'}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CAPABILITY_CHIPS.map(({ key, label, icon: Icon, active }) => {
          const on = active(info.capabilities)
          const needsSetup = on && !ready && gated.includes(key)
          const variant = !on ? 'outline' : needsSetup ? 'warning' : 'info'
          return (
            <Badge key={key} variant={variant} className={`gap-1 ${on ? '' : 'text-muted-foreground'}`}>
              {needsSetup ? <TriangleAlert className="size-3" /> : <Icon className="size-3" />}
              {label}
            </Badge>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Filled = supported here right now, amber = works but needs setup below, outlined = not
        available on this source.
      </p>
      {note && (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {note}
        </p>
      )}
    </Card>
  )
}

function TokenForm({ value, placeholder, saved, onSave, saving, masked }: {
  value: string
  placeholder: string
  saved: boolean
  onSave: (v: string) => void
  saving: boolean
  masked?: boolean
}) {
  const [input, setInput] = useState(value)
  useEffect(() => { setInput(value) }, [value])
  return (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onSave(input.trim()) }}>
      <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={placeholder}
        autoComplete="off" type={masked ? 'password' : 'text'} />
      <Button type="submit" variant={saved ? 'secondary' : 'default'} disabled={saving}>
        {saving ? <Spinner size="sm" /> : saved ? 'Update' : 'Connect'}
      </Button>
    </form>
  )
}

/** Follow a creator/subreddit/channel by handle or a pasted profile URL. This is the
 *  keyless "sync via profile" affordance for sources with no account sign-in: there's no
 *  reliable way to import a whole following list from a public profile (TikTok hides it,
 *  subscribed subreddits are private, Vimeo's requires login), but following one profile
 *  at a time works today via provider.getCreator(), so that's what's offered here. */
function FollowByHandle({ source }: { source: VideoSource }) {
  const [value, setValue] = useState('')
  const mutation = useMutation({
    mutationFn: (v: string) => addFollow(source, v),
    onSuccess: () => { toast.success('Following'); setValue('') },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not follow'),
  })
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">Follow a profile</p>
      <p className="text-sm text-muted-foreground">
        Paste a profile URL or handle to start following it, your own profile included.
      </p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) mutation.mutate(value.trim()) }}>
        <Input value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={source === 'reddit' ? 'subreddit or r/subreddit' : '@handle or profile URL'}
          autoComplete="off" />
        <Button type="submit" disabled={mutation.isPending || !value.trim()}>
          {mutation.isPending ? <Spinner size="sm" /> : 'Follow'}
        </Button>
      </form>
    </div>
  )
}

/** Admin-only "show on discovery surfaces" toggle for one source, colocated in its own
 *  tab instead of a separate global grid. */
function DiscoveryToggle({ info, isAdmin, sources }: {
  info?: SourceInfo
  isAdmin: boolean
  sources: SourceInfo[]
}) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (next: VideoSource[]) => putEnabledSources(next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['videos-sources'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })
  if (!info) return null
  const enabledSet = new Set(sources.filter((s) => s.enabled).map((s) => s.source))
  function toggle(checked: boolean) {
    if (!info) return
    const next = checked ? [...enabledSet, info.source] : [...enabledSet].filter((s) => s !== info.source)
    mutation.mutate(next)
  }
  return (
    <label className="flex items-center justify-between gap-3 rounded-card border border-border/50 bg-muted/20 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Show on discovery surfaces</p>
        <p className="text-sm text-muted-foreground">Sidebar rail, mixed home feed, and browse pages.</p>
      </div>
      <Switch checked={info.enabled} disabled={!isAdmin || mutation.isPending} onCheckedChange={toggle} />
    </label>
  )
}

/** Per-source connections for the Videos hub, one tab per source. Each tab opens with a
 *  capability summary (what this source can do + whether it's connected) so linking a
 *  source is never a guessing game, then that source's specific controls. */
export function SettingsVideoSources() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()
  const [tab, setTab] = useState<VideoSource>('youtube')

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const sources = sourcesData?.sources ?? []
  const info = sources.find((s) => s.source === tab)

  const { data: redditCfg } = useQuery({ queryKey: ['videos-config-reddit'], queryFn: getRedditConfig, enabled: isAdmin })
  const { data: vimeoCfg } = useQuery({ queryKey: ['videos-config-vimeo'], queryFn: getVimeoConfig, enabled: isAdmin })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['videos-sources'] })
    void qc.invalidateQueries({ queryKey: ['videos-config-reddit'] })
    void qc.invalidateQueries({ queryKey: ['videos-config-vimeo'] })
  }
  const redditMutation = useMutation({
    mutationFn: (v: string) => putRedditConfig(v),
    onSuccess: () => { toast.success('Reddit updated'); invalidate() },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })
  const vimeoMutation = useMutation({
    mutationFn: (v: string) => putVimeoConfig(v),
    onSuccess: () => { toast.success('Vimeo updated'); invalidate() },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect your video sources in one place. Each platform links up differently: some sign in,
        some take a free key, and some need nothing at all.
      </p>

      <AppTabBar
        tabs={TABS.map((s) => ({ id: s, label: SOURCE_META[s].label, icon: SOURCE_META[s].icon }))}
        value={tab}
        onChange={setTab}
      />

      {tab === 'youtube' && (
        <div className="space-y-4">
          <SourceCapabilityBar info={info} />
          <SettingsYoutubeAccount />
        </div>
      )}

      {tab === 'reddit' && (
        <div className="space-y-4">
          <SourceCapabilityBar info={info} />
          <Card className="space-y-4 p-5">
            <p className="text-sm text-muted-foreground">
              Browsing needs a free registered app client id (reddit.com/prefs/apps, type:
              installed app). Follows, saves, and watch progress stay on this server either way.
            </p>
            {isAdmin && (
              <TokenForm value={redditCfg?.clientId ?? ''} placeholder="Reddit app client id"
                saved={!!redditCfg?.configured} saving={redditMutation.isPending}
                onSave={(v) => redditMutation.mutate(v)} />
            )}
            <FollowByHandle source="reddit" />
            <DiscoveryToggle info={info} isAdmin={isAdmin} sources={sources} />
          </Card>
        </div>
      )}

      {tab === 'tiktok' && (
        <div className="space-y-4">
          <SourceCapabilityBar info={info} />
          <Card className="space-y-4 p-5">
            <p className="text-sm text-muted-foreground">
              Works out of the box for creator feeds and pasted links, no sign-in or key needed.
              If extraction gets flaky, uploading a cookies.txt in Admin makes it more reliable;
              the same cookies are shared by every source that uses yt-dlp.
            </p>
            <FollowByHandle source="tiktok" />
            <DiscoveryToggle info={info} isAdmin={isAdmin} sources={sources} />
          </Card>
        </div>
      )}

      {tab === 'vimeo' && (
        <div className="space-y-4">
          <SourceCapabilityBar info={info} />
          <Card className="space-y-4 p-5">
            <p className="text-sm text-muted-foreground">
              Staff Picks and search need a free API token (developer.vimeo.com/apps, public
              scope). Pasted vimeo.com links and profile follows work without it.
            </p>
            {isAdmin && (
              <TokenForm value={vimeoCfg?.token ?? ''} placeholder="Vimeo API token" masked
                saved={!!vimeoCfg?.configured} saving={vimeoMutation.isPending}
                onSave={(v) => vimeoMutation.mutate(v)} />
            )}
            <FollowByHandle source="vimeo" />
            <DiscoveryToggle info={info} isAdmin={isAdmin} sources={sources} />
          </Card>
        </div>
      )}

      {tab === 'link' && (
        <div className="space-y-4">
          <SourceCapabilityBar info={info} />
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">
              Nothing to set up. Paste a link from any of yt-dlp's ~1800 supported sites
              (Instagram, X, Twitch clips, and more) into the Videos search bar and it plays right
              in the hub.
            </p>
          </Card>
        </div>
      )}
    </div>
  )
}
