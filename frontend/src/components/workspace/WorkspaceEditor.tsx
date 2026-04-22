import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WorkspaceInput, WorkspaceRecord } from '@/lib/api';

interface WorkspaceEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId?: string;
  onSelect: (workspaceId: string) => void;
  onSave: (workspaceId: string, input: WorkspaceInput) => Promise<void>;
  onCreate: (input: WorkspaceInput) => Promise<void>;
  onDelete: (workspaceId: string) => Promise<void>;
}

type EditorState = WorkspaceInput;

const MODE_OPTIONS: WorkspaceRecord['default_mode'][] = [
  'direct',
  'standard',
  'rich',
  'deep',
  'search',
  'artifact',
];

const WorkspaceEditor: React.FC<WorkspaceEditorProps> = ({
  open,
  onOpenChange,
  workspaces,
  activeWorkspaceId,
  onSelect,
  onSave,
  onCreate,
  onDelete,
}) => {
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  );
  const [form, setForm] = useState<EditorState>({
    name: '',
    persona_id: 'default',
    default_mode: 'standard',
    attached_corpora: [],
    tone_hint: '',
    memory_scope: 'workspace',
  });
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    if (!activeWorkspace) return;
    setForm({
      name: activeWorkspace.name,
      persona_id: activeWorkspace.persona_id,
      default_mode: activeWorkspace.default_mode,
      attached_corpora: activeWorkspace.attached_corpora,
      tone_hint: activeWorkspace.tone_hint || '',
      memory_scope: activeWorkspace.memory_scope,
    });
  }, [activeWorkspace]);

  const corporaString = form.attached_corpora.join(', ');

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Manage Workspaces</DialogTitle>
            <DialogDescription>
              Workspaces bundle a persona id, response-mode default, attached corpora, and memory scope.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 py-2 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Workspaces
              </div>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => onSelect(workspace.id)}
                  className={[
                    'w-full rounded-2xl border px-3 py-3 text-left transition-colors',
                    workspace.id === activeWorkspaceId
                      ? 'border-primary/30 bg-primary/10'
                      : 'border-border/50 bg-card/40 hover:border-primary/20 hover:bg-card',
                  ].join(' ')}
                >
                  <div className="truncate text-sm font-semibold">{workspace.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {workspace.default_mode} · {workspace.memory_scope}
                  </div>
                </button>
              ))}
            </div>

            <div className="space-y-5 rounded-[1.75rem] border border-border/50 bg-card/50 p-5 shadow-m2">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">Workspace name</Label>
                  <Input
                    id="workspace-name"
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="workspace-persona">Persona id</Label>
                  <Input
                    id="workspace-persona"
                    value={form.persona_id}
                    onChange={(event) => setForm((prev) => ({ ...prev, persona_id: event.target.value }))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="workspace-tone">Tone hint</Label>
                <Input
                  id="workspace-tone"
                  value={form.tone_hint || ''}
                  onChange={(event) => setForm((prev) => ({ ...prev, tone_hint: event.target.value }))}
                  placeholder="calm, source-first, road-trip copilot"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="workspace-corpora">Attached corpora</Label>
                <Input
                  id="workspace-corpora"
                  value={corporaString}
                  onChange={(event) => {
                    const attached_corpora = event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean);
                    setForm((prev) => ({ ...prev, attached_corpora }));
                  }}
                  placeholder="maps-east-coast, vanlife-guide, service-manuals"
                />
              </div>

              <div className="space-y-3">
                <div>
                  <Label>Default mode</Label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {MODE_OPTIONS.map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        variant={form.default_mode === mode ? 'default' : 'outline'}
                        className="rounded-full"
                        onClick={() => setForm((prev) => ({ ...prev, default_mode: mode }))}
                      >
                        {mode}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Memory scope</Label>
                  <div className="mt-2 flex gap-2">
                    {(['workspace', 'global'] as const).map((scope) => (
                      <Button
                        key={scope}
                        type="button"
                        variant={form.memory_scope === scope ? 'default' : 'outline'}
                        className="rounded-full"
                        onClick={() => setForm((prev) => ({ ...prev, memory_scope: scope }))}
                      >
                        {scope}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => void onCreate(form)}>
                <Plus className="mr-2 h-4 w-4" />
                Save As New
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!activeWorkspace || activeWorkspace.id === 'default'}
                onClick={() => setConfirmDeleteOpen(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!activeWorkspace) return;
                  void onSave(activeWorkspace.id, form);
                }}
              >
                Save Changes
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete workspace?"
        description={`"${activeWorkspace?.name || 'This workspace'}" will be removed and its sessions will fall back to Default.`}
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={() => {
          if (!activeWorkspace) return;
          setConfirmDeleteOpen(false);
          void onDelete(activeWorkspace.id);
        }}
      />
    </>
  );
};

export default WorkspaceEditor;
