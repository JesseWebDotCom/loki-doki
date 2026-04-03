import React from 'react';
import { Eye, EyeOff, Volume2, VolumeX, UserCircle2, Sparkles } from 'lucide-react';
import { useCharacter } from '../context/CharacterContext';
import { FEATURED_CHARACTERS } from '../constants/characters';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/character-editor/components/ui/select";
import { Button } from "@/character-editor/components/ui/button";

const HeaderControls: React.FC<{ onVisibilityToggle?: (visible: boolean) => void; onMuteToggle?: (muted: boolean) => void }> = ({ onVisibilityToggle, onMuteToggle }) => {
  const { options, updateOption } = useCharacter();
  const [isVisible, setIsVisible] = React.useState(true);
  const [isMuted, setIsMuted] = React.useState(false);

  const selectedCharId = options.style;
  const selectedChar = FEATURED_CHARACTERS.find(c => c.id === selectedCharId) || {
    id: selectedCharId,
    primary_name: 'Custom',
    domain: 'DiceBear',
  };

  const renderCharacterIcon = (styleId: string) => {
    switch (styleId) {
      case 'avataaars':
        return <UserCircle2 className="w-4 h-4 text-[var(--app-icon-primary)]" />;
      case 'micah':
        return <UserCircle2 className="w-4 h-4 text-[var(--app-icon-success)]" />;
      case 'notionists':
        return <UserCircle2 className="w-4 h-4 text-[var(--app-icon-warm)]" />;
      case 'adventurerNeutral':
        return <UserCircle2 className="w-4 h-4 text-[var(--app-icon-danger)]" />;
      default:
        return <Sparkles className="w-4 h-4 text-[var(--app-icon-warm)]" />;
    }
  };

  const toggleVisibility = () => {
    const newVal = !isVisible;
    setIsVisible(newVal);
    onVisibilityToggle?.(newVal);
  };

  const toggleMute = () => {
    const newVal = !isMuted;
    setIsMuted(newVal);
    onMuteToggle?.(newVal);
  };

  return (
    <div className="flex w-full select-none items-center gap-4 px-2">
      <div className="flex items-center gap-3 text-[var(--app-text)]">
        <Select value={selectedCharId} onValueChange={(val) => val && updateOption('style', val)}>
          <SelectTrigger className="w-[240px] border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)] transition-colors hover:border-[color:var(--app-border-strong)] focus:ring-[color:var(--app-accent-soft)] data-[state=open]:border-[color:var(--app-border-strong)]">
            <div className="flex items-center gap-3 overflow-hidden">
               {renderCharacterIcon(selectedChar.id)}
               <SelectValue placeholder="Select character" />
            </div>
          </SelectTrigger>
          <SelectContent className="border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text)]">
            {FEATURED_CHARACTERS.map((char) => (
              <SelectItem 
                key={char.id} 
                value={char.id} 
                className="cursor-pointer py-2.5 transition-colors focus:bg-[var(--app-bg-panel-strong)]"
              >
                <div className="flex items-center gap-3">
                  {renderCharacterIcon(char.id)}
                  <div className="flex flex-col items-start leading-tight">
                    <span className="ce-body font-semibold">{char.primary_name}</span>
                    <span className="ce-micro text-[var(--app-text-muted)]">{char.domain}</span>
                  </div>
                </div>
              </SelectItem>
            ))}
            {!FEATURED_CHARACTERS.find(c => c.id === selectedCharId) && (
              <SelectItem 
                key={selectedCharId} 
                value={selectedCharId} 
                className="cursor-pointer py-2.5 transition-colors focus:bg-[var(--app-bg-panel-strong)]"
              >
                <div className="flex items-center gap-3">
                  <Sparkles className="w-4 h-4 text-[var(--app-icon-warm)]" />
                  <div className="flex flex-col items-start leading-tight">
                    <span className="ce-body font-semibold">Other Style</span>
                    <span className="ce-micro text-[var(--app-text-muted)]">{selectedCharId}</span>
                  </div>
                </div>
              </SelectItem>
            )}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={toggleVisibility}
            className={`transition-all ${isVisible ? 'border-[color:var(--app-border-strong)] bg-[color:var(--app-accent-soft)] text-[var(--app-accent)] hover:bg-[color:var(--app-accent-soft)]/80' : 'border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]'}`}
          >
            {isVisible ? <Eye className="w-4.5 h-4.5" /> : <EyeOff className="w-4.5 h-4.5" />}
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={toggleMute}
            className={`transition-all ${!isMuted ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 hover:text-rose-300'}`}
          >
            {!isMuted ? <Volume2 className="w-4.5 h-4.5" /> : <VolumeX className="w-4.5 h-4.5" />}
          </Button>
        </div>
      </div>

      <div className="flex-1" />
    </div>
  );
};

export default HeaderControls;
