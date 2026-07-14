import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, File as FileIcon, ArrowUp, Download, Upload, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { sftpList, sftpDownloadUrl, sftpUpload, type SftpEntry } from './api'

const joinPath = (base: string, name: string) => (base.endsWith('/') ? base + name : `${base}/${name}`)
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

export function SftpPanel({ hostId }: { hostId: string }) {
  const [cwd, setCwd] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const r = await sftpList(hostId, path)
      setCwd(r.path)
      setEntries(r.entries)
    } catch (e) { toast.error(`SFTP: ${e instanceof Error ? e.message : e}`) }
    setLoading(false)
  }, [hostId])

  useEffect(() => { void load('.') }, [load])

  const enter = (e: SftpEntry) => {
    if (e.dir) void load(joinPath(cwd, e.name))
    else window.open(sftpDownloadUrl(hostId, joinPath(cwd, e.name)), '_blank')
  }

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      try { await sftpUpload(hostId, joinPath(cwd, f.name), f); toast.success(`Uploaded ${f.name}`) }
      catch (e) { toast.error(`Upload failed: ${e instanceof Error ? e.message : e}`) }
    }
    void load(cwd)
  }

  return (
    <div
      className="flex h-full flex-col bg-background"
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files) }}
    >
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" title="Up" onClick={() => void load(joinPath(cwd, '..'))}><ArrowUp className="size-4" /></Button>
        <Button variant="ghost" size="icon-sm" title="Refresh" onClick={() => void load(cwd)}><RefreshCw className="size-4" /></Button>
        <span className="ml-1 truncate font-mono text-xs text-muted-foreground" title={cwd}>{cwd}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="Upload" onClick={() => fileInputRef.current?.click()}><Upload className="size-4" /></Button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = '' }} />
      </div>
      <div className={`relative min-h-0 flex-1 overflow-y-auto ${dragging ? 'ring-2 ring-inset ring-primary' : ''}`}>
        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : entries.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">Empty folder. Drop files to upload.</div>
        ) : (
          entries.map((e) => (
            <button key={e.name} onDoubleClick={() => enter(e)} onClick={() => enter(e)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60">
              {e.dir ? <Folder className="size-4 shrink-0 text-primary" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {!e.dir && <span className="text-xs text-muted-foreground">{fmtSize(e.size)}</span>}
              {!e.dir && <Download className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />}
            </button>
          ))
        )}
        {dragging && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/10 text-sm font-medium">Drop to upload</div>}
      </div>
    </div>
  )
}
