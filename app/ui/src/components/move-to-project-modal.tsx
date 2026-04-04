import { Folder, X, icons } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ProjectSummary } from "@/components/app-sidebar"

type MoveToProjectModalProps = {
  chatId: string | null
  projects: ProjectSummary[]
  onClose: () => void
  onMove: (chatId: string, projectId: string | null) => void
}

export function MoveToProjectModal({ chatId, projects, onClose, onMove }: MoveToProjectModalProps) {
  if (!chatId) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-[var(--foreground)]">Move to Project</h2>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 text-[var(--muted-foreground)]">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
          Select a project to organize this chat.
        </p>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-2">
          <button
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-[var(--input)] text-[var(--foreground)] border border-transparent hover:border-[var(--line)]"
            onClick={() => onMove(chatId, null)}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--panel)]">
              <Folder className="h-5 w-5 text-[var(--muted-foreground)]" />
            </div>
            <div>
              <div className="text-sm font-medium">None (Remove from project)</div>
            </div>
          </button>
          
          {projects.map((project) => {
            const IconComponent = (icons as any)[project.icon || "Folder"] || Folder
            return (
              <button
                key={project.id}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-[var(--input)] text-[var(--foreground)] border border-transparent hover:border-[var(--line)]"
                onClick={() => onMove(chatId, project.id)}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--panel)]">
                  <IconComponent className="h-5 w-5" style={{ color: project.icon_color || "currentColor" }} />
                </div>
                <div>
                  <div className="text-sm font-medium">{project.name}</div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}