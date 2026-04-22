import React from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';

import Avatar from '@/components/character/Avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { WorkspaceRecord } from '@/lib/api';

interface WorkspacePickerProps {
  workspaces: WorkspaceRecord[];
  activeWorkspaceId?: string;
  disabled?: boolean;
  onSelect: (workspaceId: string) => void;
  onManage: () => void;
}

const WorkspacePicker: React.FC<WorkspacePickerProps> = ({
  workspaces,
  activeWorkspaceId,
  disabled = false,
  onSelect,
  onManage,
}) => {
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-10 rounded-2xl border-border/50 bg-card/60 px-3 shadow-m1"
        >
          <span className="mr-2 flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-border/40 bg-background">
            <Avatar
              style="bottts"
              seed={activeWorkspace?.persona_id || 'default'}
              size={28}
            />
          </span>
          <span className="max-w-[11rem] truncate text-sm font-medium">
            {activeWorkspace?.name || 'Default'}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Workspace Lens</DropdownMenuLabel>
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onSelect={() => onSelect(workspace.id)}
            className="flex items-center gap-3 py-2"
          >
            <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border/40 bg-background">
              <Avatar style="bottts" seed={workspace.persona_id || workspace.id} size={32} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{workspace.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {workspace.default_mode} · {workspace.memory_scope} memory
              </span>
            </span>
            {workspace.id === activeWorkspaceId ? (
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                Active
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage} className="gap-2">
          <Settings2 className="h-4 w-4" />
          Manage Workspaces
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default WorkspacePicker;
