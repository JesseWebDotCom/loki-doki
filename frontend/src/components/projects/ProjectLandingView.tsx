import React from 'react';
import { MessageSquare, MessageSquarePlus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getIconComponent, swatchVar } from '@/lib/projectPalette';
import type { ProjectRecord } from '@/lib/api';

interface ChatSummary {
  id: number;
  title: string;
  created_at?: string;
  project_id?: number | null;
}

interface ProjectLandingViewProps {
  project: ProjectRecord;
  chats: ChatSummary[];
  onNewChat: () => void;
  onEditProject: () => void;
  onSelectChat: (id: string) => void;
}

const ProjectLandingView: React.FC<ProjectLandingViewProps> = ({
  project,
  chats,
  onNewChat,
  onEditProject,
  onSelectChat,
}) => {
  const Icon = getIconComponent(project.icon);
  const color = swatchVar(project.icon_color);

  return (
    <div className="flex flex-1 flex-col items-center justify-start overflow-y-auto px-6 pb-12 pt-16 md:pt-24 text-center">
      <div className="w-full max-w-2xl animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* Hero icon */}
        <div className="mb-8 flex justify-center">
          <div className="relative">
            <div
              className="absolute inset-0 rounded-full opacity-30 blur-3xl"
              style={{ backgroundColor: color }}
            />
            <div
              className="relative flex h-20 w-20 items-center justify-center rounded-3xl border border-border/20 bg-card/60 shadow-m4"
              style={{ color }}
            >
              <Icon className="h-10 w-10" />
            </div>
          </div>
        </div>

        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          {project.name}
        </h1>
        {project.description && (
          <p className="mx-auto mt-4 max-w-xl whitespace-pre-wrap text-lg text-muted-foreground">
            {project.description}
          </p>
        )}
        <p className="mt-6 text-sm text-muted-foreground/70">
          Select a chat to continue or start a new one in this workspace.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Button
            onClick={onNewChat}
            className="h-12 gap-3 rounded-2xl px-6 text-base font-bold shadow-m2 hover:scale-105 active:scale-95 transition-all"
          >
            <MessageSquarePlus className="h-5 w-5" />
            New chat in {project.name}
          </Button>
          <Button
            variant="outline"
            onClick={onEditProject}
            className="h-12 gap-3 rounded-2xl px-6 text-base font-bold"
          >
            <Settings className="h-5 w-5" />
            Project Settings
          </Button>
        </div>

        {/* Chats grid */}
        <div className="mt-16 w-full border-t border-border/10 pt-10">
          <div className="mb-6 text-left text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Chats ({chats.length})
          </div>

          {chats.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              No chats in this project yet.
            </div>
          ) : (
            <div className="grid gap-3 text-left sm:grid-cols-2">
              {chats.map((chat) => (
                <button
                  key={chat.id}
                  onClick={() => onSelectChat(String(chat.id))}
                  className="group flex items-center gap-4 rounded-2xl border border-border/20 bg-card/40 p-4 transition-all hover:border-primary/30 hover:bg-card/70 active:scale-[0.98]"
                >
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-card text-muted-foreground transition-colors group-hover:text-primary"
                    style={{ color }}
                  >
                    <MessageSquare className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-bold text-foreground">
                      {chat.title || 'Untitled chat'}
                    </div>
                    {chat.created_at && (
                      <div className="truncate text-xs text-muted-foreground">
                        {new Date(chat.created_at).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProjectLandingView;
