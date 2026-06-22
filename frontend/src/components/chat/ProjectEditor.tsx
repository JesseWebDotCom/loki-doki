import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ColorPicker } from '@/components/shared/ColorPicker'
import { IconPicker } from '@/components/shared/IconPicker'
import { useChatContext } from '@/context/ChatContext'
import type { Project, ProjectInput } from '@/context/ChatContext'

const MAX_CHARS = 2000

interface ProjectEditorProps {
  open: boolean
  project?: Project | null
  onOpenChange: (open: boolean) => void
  onCreated?: (project: Project) => void
}

interface EditState {
  name: string
  icon: string | null
  color: string | null
  description: string
  instructions: string
}

const BLANK: EditState = { name: '', icon: null, color: null, description: '', instructions: '' }

function toState(p: Project | null | undefined): EditState {
  if (!p) return BLANK
  return {
    name: p.name,
    icon: p.icon,
    color: p.color,
    description: p.description ?? '',
    instructions: p.instructions ?? '',
  }
}

export function ProjectEditor({ open, project, onOpenChange, onCreated }: ProjectEditorProps) {
  const isEdit = Boolean(project)
  const { createProject, updateProject } = useChatContext()
  const [state, setState] = useState<EditState>(() => toState(project))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) {
      setState(toState(project))
      setError(null)
    }
  }, [open, project])

  function set<K extends keyof EditState>(key: K, val: EditState[K]) {
    setState((prev) => ({ ...prev, [key]: val }))
  }

  async function handleSave() {
    setError(null)
    const name = state.name.trim()
    if (!name) { setError('Project name is required.'); return }
    if (state.description.length > MAX_CHARS) {
      setError(`Description must be ${MAX_CHARS} characters or fewer.`); return
    }
    if (state.instructions.length > MAX_CHARS) {
      setError(`Instructions must be ${MAX_CHARS} characters or fewer.`); return
    }

    const body: ProjectInput = {
      name,
      icon: state.icon,
      color: state.color,
      description: state.description.trim() || null,
      instructions: state.instructions.trim() || null,
    }

    setPending(true)
    try {
      if (project) {
        await updateProject(project.id, body)
        onOpenChange(false)
      } else {
        const created = await createProject(body)
        if (!created) { setError("Couldn't save project. Try again."); return }
        onOpenChange(false)
        onCreated?.(created)
      }
    } catch {
      setError("Couldn't save project. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onOpenChange(false) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>
            Description is shown to users. Instructions are sent to the model as a system message.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="proj-name" className="text-sm font-medium">Name</label>
            <Input
              id="proj-name"
              placeholder="Project name"
              value={state.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Icon</span>
              <IconPicker value={state.icon} onChange={(v) => set('icon', v)} />
            </div>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">Color</span>
              <ColorPicker value={state.color} onChange={(v) => set('color', v)} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="proj-desc" className="text-sm font-medium">Description</label>
            <Textarea
              id="proj-desc"
              rows={3}
              placeholder="What is this project about?"
              value={state.description}
              onChange={(e) => set('description', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {state.description.length}/{MAX_CHARS}
            </p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="proj-instr" className="text-sm font-medium">Instructions</label>
            <Textarea
              id="proj-instr"
              rows={4}
              placeholder="Custom system instructions for this project…"
              value={state.instructions}
              onChange={(e) => set('instructions', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Prepended as a system message for every reply in this project.{' '}
              {state.instructions.length}/{MAX_CHARS}
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={pending}>
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
