// Admin > Integrations > Books: configure an optional self-hosted OPDS indexer
// (Calibre-Web, Kavita, COPS, etc.) as a Discover-tab source beyond the built-in
// Gutenberg/Archive.org search. Config is stored via the generic tool-config API
// (toolId: 'bookIndexer'), the same mechanism as Home Assistant/Plex.

import { useCallback, useEffect, useState } from 'react'
import { BookAudio, Check, Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'

const opts: RequestInit = { credentials: 'include' }

async function saveToolConfig(key: string, value: unknown) {
  await fetch('/api/tools/config/global', {
    ...opts, method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolId: 'bookIndexer', key, value }),
  })
}

export function AdminBooksTab() {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordSet, setPasswordSet] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const load = useCallback(async () => {
    const allConfigs = await fetch('/api/tools/config/global', opts).then((r) => r.json()).catch(() => ({}))
    const cfg = (allConfigs as Record<string, Record<string, unknown>>)['bookIndexer'] ?? {}
    if (typeof cfg['base_url'] === 'string') setBaseUrl(cfg['base_url'])
    if (typeof cfg['username'] === 'string') setUsername(cfg['username'])
    setPasswordSet(!!cfg['password'])
    setEnabled(cfg['enabled'] === true)
  }, [])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async () => {
    setSaving(true)
    setTestResult(null)
    try {
      await saveToolConfig('base_url', baseUrl.trim())
      await saveToolConfig('username', username.trim())
      if (password.trim()) { await saveToolConfig('password', password.trim()); setPassword(''); setPasswordSet(true) }
      await saveToolConfig('enabled', enabled)
      toast.success('Saved')
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }, [baseUrl, username, password, enabled])

  const test = useCallback(async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/admin/books/indexer/test', { ...opts, method: 'POST' })
      const d = await res.json() as { ok: boolean; error?: string; resultCount?: number }
      setTestResult(d.ok
        ? { ok: true, message: `Connected: a test search returned ${d.resultCount} result(s)` }
        : { ok: false, message: d.error ?? 'Connection failed' })
    } catch (err) {
      setTestResult({ ok: false, message: String(err) })
    } finally {
      setTesting(false)
    }
  }, []);

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-control bg-muted p-2"><BookAudio className="size-5 text-muted-foreground" /></div>
        <div>
          <h2 className="text-title">Books: Self-Hosted Indexer</h2>
          <p className="text-sm text-muted-foreground">
            Optional. Point the Discover tab at your own OPDS catalog (Calibre-Web, Kavita, COPS, etc.) as a third search
            source alongside Project Gutenberg and Internet Archive. Only entries with a direct EPUB download link are shown.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connection</CardTitle>
          <CardDescription>The search feed URL. Use <code>{'{searchTerms}'}</code> where your server expects the query, or a plain base URL (a <code>?q=</code> parameter is appended).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="opds-url">OPDS search URL</Label>
            <Input id="opds-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://books.home.lan/opds/search?query={searchTerms}" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="opds-user">Username (optional)</Label>
              <Input id="opds-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="opds-pass">Password {passwordSet && <span className="text-muted-foreground">(set)</span>}</Label>
              <Input id="opds-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={passwordSet ? '••••••••' : ''} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-brand" />
            Enable this source in Discover
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1.5" /> : <Save className="mr-1.5 size-4" />}
              Save
            </Button>
            <Button variant="outline" onClick={() => void test()} disabled={testing || !baseUrl.trim()}>
              {testing ? <Spinner size="sm" className="mr-1.5" /> : null}
              Test connection
            </Button>
          </div>

          {testResult && (
            <p className={`flex items-center gap-1.5 text-sm ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
              {testResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
              {testResult.message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
