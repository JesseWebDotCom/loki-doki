import React, { useState, useEffect } from 'react';
import Sidebar from '../components/sidebar/Sidebar';
import ThemeCustomizer from '../components/theme/ThemeCustomizer';
import ThemeShowcase from '../components/theme/ThemeShowcase';
import { Settings, Volume2, Cpu, Save, Check, Mic, Info } from 'lucide-react';
import { getPlatformInfo, getSettings, saveSettings } from '../lib/api';
import type { PlatformInfo, SettingsData } from '../lib/api';

const SettingsPage: React.FC = () => {
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [settings, setSettings] = useState<SettingsData>({
    admin_prompt: '',
    user_prompt: '',
    piper_voice: 'en_US-lessac-medium',
    stt_model: 'base',
    read_aloud: true,
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [platformRes, settingsRes] = await Promise.all([
        getPlatformInfo(),
        getSettings(),
      ]);
      setPlatform(platformRes);
      setSettings(settingsRes);
    } catch {
      // API not available yet
    }
  };

  const handleSave = async () => {
    try {
      await saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Handle error
    }
  };

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
              <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
              <p className="text-muted-foreground text-sm font-medium">Manage your LokiDoki core parameters and aesthetic.</p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-12">

            {/* Platform & Model Info */}
            {platform && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                  <Cpu className="text-primary w-5 h-5" />
                  <h2 className="text-xl font-bold tracking-tight">Platform & Models</h2>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-4 rounded-xl bg-card/50 border border-border/30">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Platform</div>
                    <div className="text-sm font-bold font-mono">{platform.platform}</div>
                  </div>
                  <div className="p-4 rounded-xl bg-card/50 border border-border/30">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Fast Model</div>
                    <div className="text-sm font-bold font-mono text-green-400">{platform.fast_model}</div>
                  </div>
                  <div className="p-4 rounded-xl bg-card/50 border border-border/30">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Thinking Model</div>
                    <div className="text-sm font-bold font-mono text-primary">{platform.thinking_model}</div>
                  </div>
                </div>
              </div>
            )}

            {/* User Customization Prompt */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Settings className="text-primary w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Bot Personality</h2>
                <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20 ml-2">
                  TIER 2
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Custom prompt for general bot behavior. Admin rules take precedence over these.
              </p>
              <textarea
                value={settings.user_prompt}
                onChange={(e) => setSettings(prev => ({ ...prev, user_prompt: e.target.value }))}
                placeholder="Example: Speak simply and use analogies. Be encouraging and patient."
                rows={3}
                className="w-full bg-card/50 border border-border/50 rounded-xl p-4 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all text-sm font-medium resize-none"
              />
            </div>

            {/* Audio Settings */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border/10 pb-4">
                <Volume2 className="text-primary w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Audio Intelligence</h2>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    <Volume2 size={12} /> Piper Voice
                  </label>
                  <select
                    value={settings.piper_voice}
                    onChange={(e) => setSettings(prev => ({ ...prev, piper_voice: e.target.value }))}
                    className="w-full bg-card/50 border border-border/50 rounded-xl p-3 text-sm font-medium focus:outline-none focus:border-primary/50"
                  >
                    <option value="en_US-lessac-medium">en_US-lessac-medium (Default)</option>
                    <option value="en_US-amy-medium">en_US-amy-medium</option>
                    <option value="en_US-ryan-medium">en_US-ryan-medium</option>
                    <option value="en_GB-alba-medium">en_GB-alba-medium</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                    <Mic size={12} /> STT Model
                  </label>
                  <select
                    value={settings.stt_model}
                    onChange={(e) => setSettings(prev => ({ ...prev, stt_model: e.target.value }))}
                    className="w-full bg-card/50 border border-border/50 rounded-xl p-3 text-sm font-medium focus:outline-none focus:border-primary/50"
                  >
                    <option value="tiny">tiny (fastest)</option>
                    <option value="base">base (balanced)</option>
                    <option value="small">small (accurate)</option>
                  </select>
                </div>
              </div>
              <label className="flex items-center gap-3 p-4 rounded-xl bg-card/50 border border-border/30 cursor-pointer hover:border-border/60 transition-all">
                <input
                  type="checkbox"
                  checked={settings.read_aloud}
                  onChange={(e) => setSettings(prev => ({ ...prev, read_aloud: e.target.checked }))}
                  className="w-4 h-4 rounded border-border accent-primary"
                />
                <div>
                  <div className="text-sm font-bold">Read Aloud</div>
                  <div className="text-xs text-muted-foreground">Automatically speak every response using Piper TTS</div>
                </div>
              </label>
            </div>

            {/* Theme Selection */}
            <div className="space-y-6 text-center">
              <h2 className="text-2xl font-bold tracking-tight mb-8">System Preview</h2>
              <div className="relative group/preview mx-auto max-w-5xl rounded-lg overflow-hidden border border-border/20 bg-onyx-2/5 shadow-m4">
                <ThemeShowcase />
                <ThemeCustomizer />
              </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-4">
              <button
                onClick={handleSave}
                className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition-all shadow-m2 ${
                  saved
                    ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                    : 'bg-primary text-white hover:bg-primary/90 active:scale-95'
                }`}
              >
                {saved ? <Check size={16} /> : <Save size={16} />}
                {saved ? 'Saved' : 'Save Settings'}
              </button>
            </div>

            <footer className="pt-10 border-t border-border/10 flex items-center gap-4 text-muted-foreground">
              <Info size={18} />
              <div className="text-xs font-medium">
                LokiDoki Core v0.2.0 • {platform ? `${platform.platform} • ${platform.fast_model}` : 'Detecting platform...'}
              </div>
            </footer>
          </div>
        </section>
      </main>
    </div>
  );
};

export default SettingsPage;
