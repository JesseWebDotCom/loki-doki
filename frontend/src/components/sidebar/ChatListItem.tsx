import React, { useState } from 'react';
import { MessageSquare, MoreVertical, Trash2, Edit3, FolderInput } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

interface ChatListItemProps {
  id: string;
  title?: string;
  isActive: boolean;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, newTitle: string) => void;
  onMove?: (id: string, projectId: number | null) => void;
  projects: any[];
}

const NOOP = () => {};

const ChatListItem: React.FC<ChatListItemProps> = ({
  id,
  title,
  isActive,
  onSelect = NOOP,
  onDelete = NOOP,
  onRename = NOOP,
  onMove = NOOP,
  projects,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(title || id);

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onRename(id, editTitle);
    setIsEditing(false);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          onClick={() => !isEditing && onSelect(id)}
          className={cn(
            "group flex items-center justify-between px-3 py-2 rounded-lg text-xs cursor-pointer transition-all border",
            isActive
              ? "bg-primary/10 text-primary border-primary/20 shadow-sm"
              : "text-muted-foreground hover:bg-card/50 border-transparent"
          )}
        >
          <div className="flex items-center gap-2 overflow-hidden flex-1">
            <MessageSquare size={14} className={isActive ? "text-primary" : "text-muted-foreground/50"} />
            {isEditing ? (
              <form onSubmit={handleRenameSubmit} className="flex-1">
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => setIsEditing(false)}
                  className="bg-transparent border-none outline-none w-full text-xs text-foreground"
                />
              </form>
            ) : (
              <span className="truncate font-medium">{title || id}</span>
            )}
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity ml-2">
            <MoreVertical size={12} className="text-muted-foreground" />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => setIsEditing(true)}>
          <Edit3 className="mr-2 h-3.5 w-3.5" />
          <span>Rename</span>
        </ContextMenuItem>
        <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(id)}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          <span>Delete</span>
        </ContextMenuItem>
        {projects.length > 0 && (
          <>
            <div className="px-2 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-t mt-1">
              Move to Project
            </div>
            {projects.map((p) => (
              <ContextMenuItem key={p.id} onClick={() => onMove(id, p.id)}>
                <FolderInput className="mr-2 h-3.5 w-3.5" />
                <span>{p.name}</span>
              </ContextMenuItem>
            ))}
            <ContextMenuItem onClick={() => onMove(id, 0)}>
                <FolderInput className="mr-2 h-3.5 w-3.5" />
                <span>No Project</span>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default ChatListItem;
