import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderIcon, Plus } from 'lucide-react'
import { useChatContext } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { getIconChoice } from '@/components/shared/IconPicker'
import { ProjectEditor } from '@/components/chat/ProjectEditor'

/** Grid of every project — the "View all" target for Projects. */
export function ProjectsBrowsePage() {
  const navigate = useNavigate()
  const { projects, newConversation } = useChatContext()
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    newConversation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  usePublishUIContext({ label: 'Chat', description: 'User is browsing all of their projects in the Chat app.' })

  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    [projects],
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Projects</h1>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
          >
            <Plus className="size-3.5" />
            New project
          </button>
        </div>

        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
            <FolderIcon className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No projects yet. Create one to group related chats.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((p) => {
              const choice = getIconChoice(p.icon)
              const Icon = choice?.Icon ?? FolderIcon
              const color = resolveProjectColor(p.color)
              return (
                <button
                  key={p.id}
                  onClick={() => navigate(`/chat/project/${p.id}`)}
                  className="flex flex-col rounded-2xl border border-border/40 bg-card p-4 text-left transition-colors hover:border-border"
                >
                  <span
                    className="flex size-9 items-center justify-center rounded-xl"
                    style={{ backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`, color }}
                  >
                    <Icon className="size-4.5" />
                  </span>
                  <p className="mt-3 truncate text-sm font-medium">{p.name}</p>
                  {p.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <ProjectEditor
        open={creating}
        project={null}
        onOpenChange={setCreating}
        onCreated={(project) => navigate(`/chat/project/${project.id}`)}
      />
    </div>
  )
}
