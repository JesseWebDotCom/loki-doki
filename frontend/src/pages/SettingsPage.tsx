import React from 'react';
import Sidebar from '../components/sidebar/Sidebar';
import ThemeShowcase from '../components/theme/ThemeShowcase';
import { Settings, Bell, Shield, Info } from 'lucide-react';

const SettingsPage: React.FC = () => {
  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />

      <main className="flex-1 flex flex-col relative bg-background shadow-inner overflow-y-auto">
        <header className="p-10 border-b border-border/10">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary shadow-m2">
              <Settings size={28} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">System Configuration</h1>
              <p className="text-muted-foreground text-sm font-medium">Manage your LokiDoki core parameters and aesthetic.</p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-12">
            
            {/* Theme Selection */}
            <div className="space-y-6 text-center">
              <h1 className="text-2xl font-bold tracking-tight mb-8">System Preview</h1>
              <ThemeShowcase />
            </div>

            {/* Placeholder Sections */}
            <div className="space-y-6 opacity-40">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Shield className="text-gray-500 w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Security & Privacy</h2>
              </div>
              <p className="text-sm italic">Local-first data orchestration is always active. Advanced parameters coming soon.</p>
            </div>

            <div className="space-y-6 opacity-40">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Bell className="text-gray-500 w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Core Notifications</h2>
              </div>
              <p className="text-sm italic">Configure system alerts and agentic status updates.</p>
            </div>

            <footer className="pt-10 border-t border-border/10 flex items-center gap-4 text-muted-foreground">
              <Info size={18} />
              <div className="text-xs font-medium">LokiDoki Core v0.1.0-alpha • Powered by Gemma 2B</div>
            </footer>
          </div>
        </section>
      </main>
    </div>
  );
};

export default SettingsPage;
