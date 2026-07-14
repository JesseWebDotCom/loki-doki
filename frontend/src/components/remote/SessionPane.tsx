import { useRef, useState } from 'react'
import { FolderTree, Zap, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { XtermTerminal, type XtermHandle } from './XtermTerminal'
import { DisplayPane } from './DisplayPane'
import { SftpPanel } from './SftpPanel'
import { wsUrl, type RemoteHost, type RemoteSnippet } from './api'
import type { RemoteSession } from './RemoteSessionsProvider'

export function SessionPane({ session, host, snippets, fontSize }: {
  session: RemoteSession
  host?: RemoteHost
  snippets: RemoteSnippet[]
  fontSize: number
}) {
  if (session.kind === 'vnc' || session.kind === 'rdp') {
    if (!host) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Machine unavailable.</div>
    return <DisplayPane host={host} kind={session.kind} />
  }
  return <TerminalPane session={session} host={host} snippets={snippets} fontSize={fontSize} />
}

function TerminalPane({ session, host, snippets, fontSize }: { session: RemoteSession; host?: RemoteHost; snippets: RemoteSnippet[]; fontSize: number }) {
  const termRef = useRef<XtermHandle>(null)
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [sftpOpen, setSftpOpen] = useState(false)

  const url = session.kind === 'host-shell'
    ? wsUrl(`/terminal?token=${encodeURIComponent(session.hostShellToken ?? '')}`)
    : wsUrl(`/ssh?host=${encodeURIComponent(session.hostId ?? '')}`)

  const statusColor = status === 'open' ? 'text-success' : status === 'connecting' ? 'text-warning' : 'text-muted-foreground'
  const canSftp = session.kind === 'ssh' && !!host?.ssh

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b bg-background px-3 py-1.5">
        <Circle className={`size-2.5 fill-current ${statusColor}`} />
        <span className="text-xs text-muted-foreground">{status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
        <div className="ml-auto flex items-center gap-1">
          {snippets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm"><Zap className="mr-1.5 size-4" />Snippets</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                {snippets.map((s) => (
                  <DropdownMenuItem key={s.id} onClick={() => termRef.current?.send(s.command + '\n')}>
                    <span className="truncate">{s.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canSftp && (
            <Button variant={sftpOpen ? 'default' : 'ghost'} size="sm" onClick={() => setSftpOpen((v) => !v)}>
              <FolderTree className="mr-1.5 size-4" />Files
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-black">
          <XtermTerminal ref={termRef} wsUrl={url} fontSize={fontSize} onStatus={setStatus} />
        </div>
        {canSftp && sftpOpen && host && (
          <div className="w-80 shrink-0 border-l">
            <SftpPanel hostId={host.id} />
          </div>
        )}
      </div>
    </div>
  )
}
