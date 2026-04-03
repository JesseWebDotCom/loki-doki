import React from 'react';
import { Separator } from "@/character-editor/components/ui/separator";
import { ScrollArea } from "@/character-editor/components/ui/scroll-area";

interface LayoutProps {
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  puppetStage: React.ReactNode;
  headerControls: React.ReactNode;
  showReservedNav?: boolean;
  showHeader?: boolean;
}

/**
 * Layout representing the ChatGPT-style 3+ column spatial architecture.
 * Refactored to use shadcn/ui components (Separator, ScrollArea).
 */
const Layout: React.FC<LayoutProps> = ({
  children,
  sidebar,
  puppetStage,
  headerControls,
  showReservedNav = true,
  showHeader = true,
}) => {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--app-bg)] text-[var(--app-text)] font-sans">
      {showReservedNav ? (
        <aside className="hidden w-64 shrink-0 flex-col border-r border-[color:var(--app-border)] bg-[var(--app-bg-panel)] md:flex">
          <div className="flex h-14 shrink-0 items-center border-b border-[color:var(--app-border)] p-4">
            <div className="text-lg font-bold tracking-tight">Main Menu</div>
          </div>
          <ScrollArea className="flex-1 p-4 opacity-50 space-y-4">
            <div className="mb-3 h-8 w-full animate-pulse rounded bg-[var(--app-bg-panel-strong)]" />
            <div className="mb-3 h-8 w-4/5 animate-pulse rounded bg-[var(--app-bg-panel-strong)]" />
            <div className="mb-3 h-8 w-6/7 animate-pulse rounded bg-[var(--app-bg-panel-strong)]" />
            <div className="mb-3 h-8 w-full animate-pulse rounded bg-[var(--app-bg-panel-strong)]" />
          </ScrollArea>
        </aside>
      ) : null}

      <div className="flex flex-col flex-1 min-w-0 h-full relative">
        {showHeader ? (
          <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center border-b border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)]/80 px-6 backdrop-blur-md">
            <div className="flex-1 flex items-center justify-between">
              {headerControls}
            </div>
          </header>
        ) : null}

        <div className="flex flex-1 overflow-hidden">
          <main className={`relative flex min-w-0 flex-1 overflow-hidden bg-[var(--app-bg-elevated)] ${sidebar ? 'border-r border-[color:var(--app-border)]' : ''}`}>
            <div className="flex flex-1 overflow-hidden relative">
              <ScrollArea className="flex-1 p-6">
                <div className="space-y-6">
                  {children}
                </div>
              </ScrollArea>
              
              <Separator orientation="vertical" className="h-full w-px bg-[color:var(--app-border)]" />
              
              <div className="relative w-[420px] shrink-0 bg-[var(--app-stage-bg)] shadow-[inset_0_0_50px_rgba(0,0,0,0.35)]">
                {puppetStage}
              </div>
            </div>
          </main>

          {sidebar ? (
            <aside className="relative z-10 flex h-full w-[420px] shrink-0 flex-col bg-[var(--app-bg-elevated)] shadow-2xl">
              {sidebar}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default Layout;
