import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cookie, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import {
  getRedditConfig, getVideoSources, getVimeoConfig, putRedditConfig, putVimeoConfig,
} from '@/lib/videos/api'

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
    </div>
  )
}
