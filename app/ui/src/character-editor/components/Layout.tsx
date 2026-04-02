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
        <aside className="w-64 border-r border-slate-800 bg-slate-950 flex flex-col hidden md:flex shrink-0">
          <div className="p-4 border-b border-slate-800 h-14 flex items-center shrink-0">
            <div className="font-bold text-lg tracking-tight">Main Menu</div>
          </div>
          <ScrollArea className="flex-1 p-4 opacity-50 space-y-4">
            <div className="h-8 bg-slate-800 rounded w-full animate-pulse mb-3" />
            <div className="h-8 bg-slate-800 rounded w-4/5 animate-pulse mb-3" />
            <div className="h-8 bg-slate-800 rounded w-6/7 animate-pulse mb-3" />
            <div className="h-8 bg-slate-800 rounded w-full animate-pulse mb-3" />
          </ScrollArea>
        </aside>
      ) : null}

      <div className="flex flex-col flex-1 min-w-0 h-full relative">
        {showHeader ? (
          <header className="h-14 border-b border-slate-800 flex items-center px-6 shrink-0 bg-slate-950/40 backdrop-blur-md sticky top-0 z-50">
            <div className="flex-1 flex items-center justify-between">
              {headerControls}
            </div>
          </header>
        ) : null}

        <div className="flex flex-1 overflow-hidden">
          <main className={`flex flex-1 min-w-0 bg-slate-900 relative overflow-hidden ${sidebar ? 'border-r border-slate-800' : ''}`}>
            <div className="flex flex-1 overflow-hidden relative">
              <ScrollArea className="flex-1 p-6">
                <div className="space-y-6">
                  {children}
                </div>
              </ScrollArea>
              
              <Separator orientation="vertical" className="bg-slate-800 h-full w-px" />
              
              <div className="w-[420px] shrink-0 bg-slate-950/20 relative shadow-[inset_0_0_50px_rgba(0,0,0,0.5)]">
                {puppetStage}
              </div>
            </div>
          </main>

          {sidebar ? (
            <aside className="w-[420px] bg-slate-900 flex flex-col h-full shrink-0 shadow-2xl relative z-10">
              {sidebar}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default Layout;
