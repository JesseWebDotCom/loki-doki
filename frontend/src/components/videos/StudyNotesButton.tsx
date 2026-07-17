import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GraduationCap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { makeStudyNotes, type VideoSource } from '@/lib/videos/api'

// Homework mode: turn this video into study material (timestamped key points + flashcards)
// saved as a real Note. "Watch later" is converging with "knowledge base", and a hub with
// local transcripts and a local model can do it without a child's schoolwork leaving the
// house. Lives in the watch page's action rail.
export function StudyNotesButton({ source, videoId, className }: {
  source: VideoSource | 'youtube'
  videoId: string
  className?: string
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  async function go() {
    if (busy) return
    setBusy(true)
    toast.info('Reading the video and writing your notes…')
    try {
      const { noteId } = await makeStudyNotes(source, videoId)
      toast.success('Notes saved', {
        description: 'Key points and flashcards, with timestamps back into the video.',
        duration: 10_000,
        action: { label: 'Open', onClick: () => navigate(`/notes/${noteId}`) },
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not make notes for this one')
    } finally {
      setBusy(false)
    }
  }

  return (
    // design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop
    <Button size="icon" onClick={() => void go()} disabled={busy}
      title="Make study notes: key points and flashcards, saved to your notes"
      aria-label="Make study notes"
      className={cn('size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15', className)}>
      {busy ? <Spinner className="size-4" /> : <GraduationCap className="size-4" />}
    </Button>
  )
}
