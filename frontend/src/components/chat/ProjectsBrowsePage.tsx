import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderIcon, Plus } from 'lucide-react'
import { useChatContext } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { resolveProjectColor } from '@/components/shared/ColorPicker'
import { getIconChoice } from '@/components/shared/IconPicker'
import { ProjectEditor } from '@/components/chat/ProjectEditor'

/** Grid of every project - the "View all" target for Projects. */
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
      <PageContainer className="py-6">
        <PageHeader
          title="Projects"
          className="pt-0 pb-5"
          actions={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New project
            </Button>
          }
        />

        {sorted.length === 0 ? (
          <Card variant="dashed" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <FolderIcon className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No projects yet. Create one to group related chats.</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((p) => {
              const choice = getIconChoice(p.icon)
              const Icon = choice?.Icon ?? FolderIcon
              const color = resolveProjectColor(p.color)
              return (
                <Card
                  key={p.id}
                  variant="interactive"
                  onClick={() => navigate(`/chat/project/${p.id}`)}
                  className="flex flex-col p-4 text-left"
                >
                  <span
                    className="flex size-9 items-center justify-center rounded-control"
                    style={{ backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`, color }}
                  >
                    <Icon className="size-4.5" />
                  </span>
                  <p className="mt-3 truncate text-sm font-medium">{p.name}</p>
                  {p.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </PageContainer>

      <ProjectEditor
        open={creating}
        project={null}
        onOpenChange={setCreating}
        onCreated={(project) => navigate(`/chat/project/${project.id}`)}
      />
    </div>
  )
}
