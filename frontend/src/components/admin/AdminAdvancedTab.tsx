import { useState } from 'react'
import { cn } from '@/lib/cn'
import { AdminTroubleshootingTab } from '@/components/admin/AdminTroubleshootingTab'
import { LogViewer } from '@/components/devtools/LogViewer'
import { TraceInspector } from '@/components/devtools/TraceInspector'

export type AdvancedView = 'diagnostics' | 'logs' | 'traces'
type LogSource = 'app' | 'comfy'

export function AdminAdvancedTab({ view = 'diagnostics' }: { view?: AdvancedView } = {}) {
  const tab = view
  const [logSource, setLogSource] = useState<LogSource>('app')

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div>
        <h2 className="text-title">{tab === 'logs' ? 'Logs' : tab === 'traces' ? 'Chat Traces' : 'Diagnostics'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {tab === 'logs' ? 'Live application and ComfyUI logs.'
            : tab === 'traces' ? 'Per-turn chat traces: the assembled prompt, route decision, tool trail, tokens, and latency behind recent replies.'
            : 'System health and queue diagnostics for troubleshooting.'}
        </p>
      </div>

      {/* Diagnostics */}
      {tab === 'diagnostics' && <AdminTroubleshootingTab />}

      {/* Chat traces */}
      {tab === 'traces' && <TraceInspector />}

      {/* Logs */}
      {tab === 'logs' && (
        <div className="space-y-3">
          {/* Log source picker */}
          <div className="flex gap-2">
            {(['app', 'comfy'] as LogSource[]).map(src => (
              <button
                key={src}
                type="button"
                onClick={() => setLogSource(src)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  logSource === src
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/40',
                )}
              >
                {src === 'app' ? 'App Logs' : 'ComfyUI Logs'}
              </button>
            ))}
          </div>

          <div className="h-[560px] rounded-card border border-border overflow-hidden">
            <LogViewer
              streamUrl={logSource === 'app' ? '/api/logs/stream' : '/api/logs/comfy/stream'}
              mode={logSource === 'app' ? 'json' : 'text'}
            />
          </div>
        </div>
      )}
    </div>
  )
}
