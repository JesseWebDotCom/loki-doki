import { useRef, useState } from 'react'
import { FolderTree, Zap, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { XtermTerminal, type XtermHandle } from './XtermTerminal'
import { DisplayPane, type DisplayTarget } from './DisplayPane'
import { SftpPanel } from './SftpPanel'
import { wsUrl, type RemoteHost, type RemoteSnippet } from './api'
import type { RemoteSession } from './RemoteSessionsProvider'

export function SessionPane({ session, host, snippets, fontSize, active = true }: {
  session: RemoteSession
  host?: RemoteHost
  snippets: RemoteSnippet[]
  fontSize: number
  active?: boolean
}) {
  if (session.kind === 'vnc' || session.kind === 'rdp') {
    // "This server" (loopback) desktop: connect via the single-use token, not a host row.
    if (session.selfToken) {
      const target: DisplayTarget = { mode: 'self', token: session.selfToken, vncPassword: session.selfVncPassword, rdp: session.selfRdp }
      return <DisplayPane target={target} kind={session.kind} />
    }
    if (!host) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Machine unavailable.</div>
    return <DisplayPane target={{ mode: 'host', host }} kind={session.kind} />
  }
  return <TerminalPane session={session} host={host} snippets={snippets} fontSize={fontSize} active={active} />
}

function TerminalPane({ session, host, snippets, fontSize, active }: { session: RemoteSession; host?: RemoteHost; snippets: RemoteSnippet[]; fontSize: number; active: boolean }) {
  const termRef = useRef<XtermHandle>(null)
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [sftpOpen, setSftpOpen] = useState(false)

  // Claude Code attaches to the shared per-user coding terminal (tmux + Claude Code CLI),
  // reusing the Coding app's WS on its own /api/coding base rather than the remote one.
  const codingWsUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/coding/terminal`
  const url = session.kind === 'host-shell'
    ? wsUrl(`/terminal?token=${encodeURIComponent(session.hostShellToken ?? '')}`)
    : session.kind === 'claude-code'
      ? codingWsUrl()
      : wsUrl(`/ssh?host=${encodeURIComponent(session.hostId ?? '')}`)

  const statusColor = status === 'open' ? 'text-success' : status === 'connecting' ? 'text-warning' : 'text-muted-foreground'
  const canSftp = session.kind === 'ssh' && !!host?.ssh
  // Snippets are shell one-liners; they make no sense piped into the Claude Code CLI.
  const showSnippets = session.kind !== 'claude-code' && snippets.length > 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b bg-background px-3 py-1.5">
        <Circle className={`size-2.5 fill-current ${statusColor}`} />
        <span className="text-xs text-muted-foreground">{status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'}</span>
        <div className="ml-auto flex items-center gap-1">
          {showSnippets && (
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
          <XtermTerminal ref={termRef} wsUrl={url} fontSize={fontSize} active={active} onStatus={setStatus} />
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
