import { useState } from 'react'
import { cn } from '@/lib/cn'
import { AdminTroubleshootingTab } from '@/components/admin/AdminTroubleshootingTab'
import { LogViewer } from '@/components/devtools/LogViewer'

export type AdvancedView = 'diagnostics' | 'logs'
type LogSource = 'app' | 'comfy'

export function AdminAdvancedTab({ view = 'diagnostics' }: { view?: AdvancedView } = {}) {
  const tab = view
  const [logSource, setLogSource] = useState<LogSource>('app')

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-black tracking-tight">{tab === 'logs' ? 'Logs' : 'Diagnostics'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {tab === 'logs' ? 'Live application and ComfyUI logs.' : 'System health and queue diagnostics for troubleshooting.'}
        </p>
      </div>

      {/* Diagnostics */}
      {tab === 'diagnostics' && <AdminTroubleshootingTab />}

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
                  'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  logSource === src
                    ? 'border-violet-500/40 bg-violet-500/8 text-violet-300'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/40',
                )}
              >
                {src === 'app' ? 'App Logs' : 'ComfyUI Logs'}
              </button>
            ))}
          </div>

          <div className="h-[560px] rounded-xl border border-border overflow-hidden">
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
