import React, { useState } from 'react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { MessageSquare, MoreVertical, Trash2, Edit3, FolderInput } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onRename(id, editTitle);
    setIsEditing(false);
  };

  // Stop React-synthetic-event propagation so menu clicks don't also
  // trigger the row's onClick (which would call onSelect and navigate
  // away from the rename input). Radix portals don't bubble in the DOM
  // but React synthetic events still bubble through the component tree.
  const handleRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditTitle(title || id);
    // Defer state flip past Radix's "restore focus to trigger" step on
    // menu close. Without this, the trigger button receives focus AFTER
    // the input mounts, which immediately blurs and cancels the rename.
    requestAnimationFrame(() => setIsEditing(true));
  };
  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };
  const handleMove = (e: React.MouseEvent, projectId: number) => {
    e.stopPropagation();
    onMove(id, projectId);
  };

  const renderItems = (Item: React.ElementType) => (
    <>
      <Item onClick={handleRename}>
        <Edit3 className="mr-2 h-3.5 w-3.5" />
        <span>Rename</span>
      </Item>
      <Item className="text-destructive focus:text-destructive" onClick={handleDelete}>
        <Trash2 className="mr-2 h-3.5 w-3.5" />
        <span>Delete</span>
      </Item>
      {projects.length > 0 && (
        <>
          <div className="px-2 py-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-widest border-t mt-1">
            Move to Project
          </div>
          {projects.map((p) => (
            <Item key={p.id} onClick={(e: React.MouseEvent) => handleMove(e, p.id)}>
              <FolderInput className="mr-2 h-3.5 w-3.5" />
              <span>{p.name}</span>
            </Item>
          ))}
          <Item onClick={(e: React.MouseEvent) => handleMove(e, 0)}>
            <FolderInput className="mr-2 h-3.5 w-3.5" />
            <span>No Project</span>
          </Item>
        </>
      )}
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          onClick={() => !isEditing && onSelect(id)}
          className={cn(
            "group flex items-center justify-between pl-2 pr-1 py-2 rounded-lg text-sm cursor-pointer transition-all border",
            isActive
              ? "bg-primary/10 text-primary border-primary/20 shadow-sm"
              : "text-muted-foreground hover:bg-card/50 border-transparent"
          )}
        >
          <div className="flex items-center gap-2 overflow-hidden flex-1">
            <MessageSquare size={16} className={isActive ? "text-primary" : "text-muted-foreground/50"} />
            {isEditing ? (
              <form onSubmit={handleRenameSubmit} className="flex-1" onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  ref={(el) => {
                    if (el && !el.dataset.selected) {
                      el.select();
                      el.dataset.selected = 'true';
                    }
                  }}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  onBlur={() => {
                    // Commit on blur (clicking elsewhere) so the user
                    // doesn't lose their edit silently.
                    if (editTitle.trim() && editTitle !== title) {
                      onRename(id, editTitle.trim());
                    }
                    setIsEditing(false);
                  }}
                  className="bg-transparent border-none outline-none w-full text-xs text-foreground"
                />
              </form>
            ) : (
              <span className="truncate font-medium text-sm">{title || id}</span>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity p-1 rounded hover:bg-card/80 text-muted-foreground hover:text-primary"
                aria-label="Chat actions"
              >
                <MoreVertical size={14} className="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e) => e.stopPropagation()}
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {renderItems(DropdownMenuItem)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {renderItems(ContextMenuItem)}
      </ContextMenuContent>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete chat?"
        description={`"${title || id}" will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          onDelete(id);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </ContextMenu>
  );
};

export default ChatListItem;
