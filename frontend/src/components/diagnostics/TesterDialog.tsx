import { useEffect, useState } from 'react'
import { AudioWaveform, MessageSquareText } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { WakewordTester } from '@/components/admin/voiceControls'
import { SpeechTester } from '@/components/diagnostics/SpeechTester'
import { useActiveCompanion } from '@/hooks/useActiveCompanion'
import { useAuth } from '@/context/AuthContext'

type TesterTab = 'wakeword' | 'speech'

const TABS: { id: TesterTab; label: string; icon: typeof AudioWaveform }[] = [
  { id: 'wakeword', label: 'Wake word', icon: AudioWaveform },
  { id: 'speech', label: 'Speech', icon: MessageSquareText },
]

// Profile-menu diagnostics dialog: quick self-serve checks that the voice
// pipeline actually works on THIS device (mic, wake word detector, STT, TTS),
// without digging through the admin panel. Each tab reuses the production
// pipeline components so results match live behavior.
export function TesterDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useAuth()
  const { companion } = useActiveCompanion()
  const [tab, setTab] = useState<TesterTab>('wakeword')

  // What the live hands-free loop would actually use: if the companion's trained
  // model id isn't in the browser registry, hands-free silently falls back to
  // loose phrase matching. Surfacing that here turns a silent downgrade into a
  // visible diagnosis.
  const [detectorIds, setDetectorIds] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!open) return
    fetch('/api/voice/wakewords', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { detectors?: { id: string }[] } | null) => {
        if (d?.detectors) setDetectorIds(new Set(d.detectors.map((x) => x.id)))
      })
      .catch(() => {})
  }, [open])

  const modelId = companion?.wakeWordModelId ?? null
  const modelAvailable = modelId && detectorIds ? detectorIds.has(modelId) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tester</DialogTitle>
          <DialogDescription>Check that voice features work on this device.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-control bg-secondary/60 p-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-control px-2 py-1.5 text-xs transition-colors',
                tab === id ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        {tab === 'wakeword' && (
          <div className="space-y-2">
            {companion && (
              <p className="text-[11px] text-muted-foreground">
                {modelId
                  ? modelAvailable === false
                    ? `${companion.name}'s trained wake word model isn't available in this browser, so hands-free is falling back to loose phrase matching. Ask your admin to check the wake word install.`
                    : `${companion.name} listens for "${companion.wakeWordPhrase ?? companion.name}" with a trained detector.`
                  : companion.wakeWordPhrase
                    ? `${companion.name} has no trained detector; hands-free matches the phrase "${companion.wakeWordPhrase}" from transcripts.`
                    : `${companion.name} has no wake word configured.`}
              </p>
            )}
            <WakewordTester initialModelId={modelId ?? undefined} allowSave={user?.role === 'admin'} />
          </div>
        )}

        {tab === 'speech' && <SpeechTester />}
      </DialogContent>
    </Dialog>
  )
}
