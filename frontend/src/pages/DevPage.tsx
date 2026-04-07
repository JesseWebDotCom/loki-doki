import React from 'react';
import Sidebar from '../components/sidebar/Sidebar';
import { Wrench, ScrollText } from 'lucide-react';
import LogViewer from '../components/dev/LogViewer';

const DevPage: React.FC = () => {
  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />

      <main className="flex-1 flex flex-col relative bg-background shadow-inner overflow-y-auto">
        <header className="p-10 border-b border-border/10">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-m2">
              <Wrench size={28} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Dev Tools</h1>
              <p className="text-muted-foreground text-sm font-medium">Internal tooling, diagnostics, and developer utilities.</p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-12">
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <ScrollText className="text-primary w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Backend Logs</h2>
                <span className="text-[10px] font-bold text-muted-foreground bg-card/60 px-2 py-0.5 rounded-md border border-border/30 ml-2">
                  LIVE • polls every 1.5s
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                In-memory ring buffer of the last 2000 backend log records (admin-only).
              </p>
              <LogViewer height="h-[60vh]" />
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Wrench className="text-primary w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Tools</h2>
              </div>
              <div className="rounded-xl border border-border/30 bg-card/50 p-6 shadow-m1">
                <p className="text-sm text-muted-foreground">
                  More developer tools coming soon.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default DevPage;
