import React, { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../../lib/api';
import type { SettingsData } from '../../lib/api';
import { toast } from 'sonner';

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];

const LogLevelSelector: React.FC = () => {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then(setSettings)
      .catch(() => toast.error('Failed to load logging settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleLevelChange = async (newLevel: string) => {
    if (!settings) return;
    
    const updated = { ...settings, log_level: newLevel };
    setSettings(updated);
    
    try {
      await saveSettings(updated);
      toast.success(`Log level updated to ${newLevel}`);
    } catch {
      toast.error('Failed to update log level');
      // Revert on failure
      const reverted = await getSettings();
      setSettings(reverted);
    }
  };

  if (loading) return <div className="text-[10px] text-muted-foreground">Loading settings…</div>;

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-1">
        Level:
      </span>
      <div className="flex bg-card/60 rounded-lg p-1 border border-border/30">
        {LOG_LEVELS.map((level) => {
          const active = settings?.log_level === level;
          return (
            <button
              key={level}
              type="button"
              onClick={() => handleLevelChange(level)}
              className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${
                active
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-card/80'
              }`}
            >
              {level}
            </button>
          )
        })}
      </div>
      {settings?.log_level === 'DEBUG' && (
        <span className="text-[9px] font-bold text-amber-400 animate-pulse bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20">
          TRACE ON
        </span>
      )}
    </div>
  );
};

export default LogLevelSelector;
