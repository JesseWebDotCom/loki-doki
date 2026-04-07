import React from 'react';
import { MoreVertical, Trash2, Edit3 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { getIconComponent, swatchVar } from '@/lib/projectPalette';
import type { ProjectRecord } from '@/lib/api';

interface ProjectListItemProps {
  project: ProjectRecord;
  isActive: boolean;
  onSelect: (id: number) => void;
  onEdit: (project: ProjectRecord) => void;
  onDelete: (id: number) => void;
}

const ProjectListItem: React.FC<ProjectListItemProps> = ({
  project,
  isActive,
  onSelect,
  onEdit,
  onDelete,
}) => {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
            <div
              onClick={() => onSelect(project.id)}
              className={cn(
                "group flex items-center justify-between px-3 py-2 rounded-lg text-xs cursor-pointer transition-all border",
                isActive
                  ? "bg-primary/10 text-primary border-primary/20 shadow-sm"
                  : "text-muted-foreground hover:bg-card/50 border-transparent"
              )}
            >
              <div className="flex items-center gap-2 overflow-hidden flex-1">
                {(() => {
                  const Icon = getIconComponent(project.icon);
                  return (
                    <div
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md"
                      style={{
                        color: swatchVar(project.icon_color),
                        backgroundColor: `color-mix(in oklch, ${swatchVar(project.icon_color)} 14%, transparent)`,
                      }}
                    >
                      <Icon size={12} />
                    </div>
                  );
                })()}
                <span className="truncate font-bold">{project.name}</span>
              </div>
              <MoreVertical size={12} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
            </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onEdit(project)}>
          <Edit3 className="mr-2 h-3.5 w-3.5" />
          <span>Edit Project</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(project.id)}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          <span>Delete Project</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default ProjectListItem;
