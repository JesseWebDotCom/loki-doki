import React from 'react';
import { Save, UploadCloud, Volume2, VolumeX } from 'lucide-react';
import { useCharacter } from '../context/CharacterContext';
import { buildCharacterEditorBundle } from '../integration/exportBundle';
import { Button } from "@/character-editor/components/ui/button";

const HeaderControls: React.FC = () => {
  const { options, saveManifest } = useCharacter();
  const [saveState, setSaveState] = React.useState<'idle' | 'working'>('idle');
  const [isMuted, setIsMuted] = React.useState(false);
  const embedded = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('embedded') === '1';

  const sendEditorAction = (action: 'save' | 'publish') => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!embedded && action === 'save') {
      void saveManifest();
      setSaveState('working');
      window.setTimeout(() => setSaveState('idle'), 900);
      return;
    }
    setSaveState('working');
    window.parent.postMessage(
      {
        source: 'loki-doki-character-editor',
        type: 'character-editor-action',
        action,
        bundle: buildCharacterEditorBundle(options),
      },
      window.location.origin
    );
    window.setTimeout(() => setSaveState('idle'), 900);
  };

  return (
    <div className="flex w-full select-none items-center gap-4 px-2">
      <div className="flex-1" />

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setIsMuted((current) => !current)}
          className={`h-9 w-9 rounded-xl border ${
            isMuted
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
          }`}
        >
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
        <Button
          onClick={() => sendEditorAction('save')}
          disabled={saveState === 'working'}
          className="h-9 rounded-xl border border-[color:var(--app-border-strong)] bg-[color:var(--app-accent-soft)] px-3 text-[11px] font-black uppercase text-[var(--app-text)] hover:bg-[color:var(--app-accent-soft)]/80"
          type="button"
        >
          <Save className="mr-2 h-4 w-4" />
          {embedded ? 'Save' : 'Save Local'}
        </Button>
        {embedded ? (
          <Button
            onClick={() => sendEditorAction('publish')}
            disabled={saveState === 'working'}
            className="h-9 rounded-xl border border-emerald-500/30 bg-emerald-500/12 px-3 text-[11px] font-black uppercase text-emerald-200 hover:bg-emerald-500/20"
            type="button"
          >
            <UploadCloud className="mr-2 h-4 w-4" />
            Upload Repo
          </Button>
        ) : null}
      </div>
    </div>
  );
};

export default HeaderControls;
