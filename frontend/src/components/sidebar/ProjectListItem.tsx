import React from 'react';
import { Folder, MoreVertical, Trash2, Edit3 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ProjectListItemProps {
  project: {
    id: number;
    name: string;
    description: string;
    prompt: string;
  };
  isActive: boolean;
  onSelect: (id: number) => void;
  onEdit: (project: any) => void;
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
        <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
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
                <Folder size={14} className={isActive ? "text-primary" : "text-muted-foreground/50"} />
                <span className="truncate font-bold">{project.name}</span>
              </div>
              <MoreVertical size={12} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
            </div>
          </TooltipTrigger>
          {project.description && (
            <TooltipContent side="right" className="max-w-[200px]">
              <p className="font-bold mb-1">{project.name}</p>
              <p className="text-xs">{project.description}</p>
            </TooltipContent>
          )}
        </Tooltip>
        </TooltipProvider>
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
