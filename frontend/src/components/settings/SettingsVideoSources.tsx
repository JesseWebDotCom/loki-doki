import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cookie, Eye, Globe, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/context/AuthContext'
import { SettingsYoutubeAccount } from '@/components/settings/SettingsYoutubeAccount'
import { toast } from '@/lib/toast'
import {
  getRedditConfig, getVideoSources, getVimeoConfig, putEnabledSources, putRedditConfig, putVimeoConfig,
  type VideoSource,
} from '@/lib/videos/api'

const ALL_SOURCES: VideoSource[] = ['youtube', 'reddit', 'tiktok', 'vimeo']

/** Which sources show up on discovery surfaces (rail, home feed, browse pages).
 *  Admin-only control; everyone can see the current state. Already-followed/saved
 *  items and direct playback from a hidden source keep working: this just hides
 *  where you'd discover more of it. */
function DisplayedSourcesCard({ sources, isAdmin }: { sources: Array<{ source: VideoSource; label: string; enabled: boolean }>; isAdmin: boolean }) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (next: VideoSource[]) => putEnabledSources(next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['videos-sources'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })
  const enabledSet = new Set(sources.filter((s) => s.enabled).map((s) => s.source))

  function toggle(source: VideoSource, checked: boolean) {
    const next = checked ? [...enabledSet, source] : [...enabledSet].filter((s) => s !== source)
    mutation.mutate(next)
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <Eye className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Displayed sources</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Which sources show up in the sidebar, the mixed home feed, and browse pages.
            {!isAdmin && ' Only an admin can change this.'}
          </p>
          <div className="mt-3 space-y-2.5">
            {ALL_SOURCES.map((source) => {
              const info = sources.find((s) => s.source === source)
              return (
                <label key={source} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-foreground">{info?.label ?? source}</span>
                  <Switch checked={info?.enabled ?? true} disabled={!isAdmin || mutation.isPending}
                    onCheckedChange={(checked) => toggle(source, checked)} />
                </label>
              )
            })}
          </div>
        </div>
      </div>
    </Card>
  )
}

function SourceCard({ title, icon: Icon, blurb, children }: {
  title: string
  icon: typeof KeyRound
  blurb: string
  children?: React.ReactNode
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
          {children}
        </div>
      </div>
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
    <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); onSave(input.trim()) }}>
      <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={placeholder}
        autoComplete="off" type={masked ? 'password' : 'text'} />
      <Button type="submit" variant={saved ? 'secondary' : 'default'} disabled={saving}>
        {saving ? <Spinner size="sm" /> : saved ? 'Update' : 'Connect'}
      </Button>
    </form>
  )
}

/** Per-source connections for the Videos hub. Admin-only inputs (config is global);
 *  everyone can see connection state. Sign-in-and-sync for more sources follows the
 *  YouTube account pattern as providers gain auth support. */
export function SettingsVideoSources() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const status = (s: string) => sourcesData?.sources.find((x) => x.source === s)?.status

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

      {/* YouTube: full account sign-in (Google device flow); its own richer card. */}
      <SettingsYoutubeAccount />

      <SourceCard
        title={`Reddit ${status('reddit')?.configured ? '· Connected' : ''}`}
        icon={KeyRound}
        blurb="Browsing needs a free registered app client id (reddit.com/prefs/apps, type: installed app). Follows, saves, and watch progress stay on this server either way."
      >
        {isAdmin && (
          <TokenForm value={redditCfg?.clientId ?? ''} placeholder="Reddit app client id"
            saved={!!redditCfg?.configured} saving={redditMutation.isPending}
            onSave={(v) => redditMutation.mutate(v)} />
        )}
      </SourceCard>

      <SourceCard
        title={`Vimeo ${status('vimeo')?.configured ? '· Connected' : ''}`}
        icon={KeyRound}
        blurb="Staff Picks and search need a free API token (developer.vimeo.com/apps, public scope). Pasted vimeo.com links play without it."
      >
        {isAdmin && (
          <TokenForm value={vimeoCfg?.token ?? ''} placeholder="Vimeo API token" masked
            saved={!!vimeoCfg?.configured} saving={vimeoMutation.isPending}
            onSave={(v) => vimeoMutation.mutate(v)} />
        )}
      </SourceCard>

      <SourceCard
        title="TikTok"
        icon={Cookie}
        blurb="Works out of the box for creator feeds and pasted links. If extraction gets flaky, uploading a cookies.txt in Admin makes it more reliable; the same cookies are shared by every source that uses yt-dlp."
      />

      <SourceCard
        title="Other sites"
        icon={Globe}
        blurb="Nothing to set up. Paste a link from any of yt-dlp's ~1800 supported sites (Instagram, X, Twitch clips, and more) into the Videos search bar and it plays right in the hub."
      />

      <DisplayedSourcesCard
        isAdmin={isAdmin}
        sources={(sourcesData?.sources ?? []).map((s) => ({ source: s.source, label: s.label, enabled: s.enabled }))}
      />
    </div>
  )
}
