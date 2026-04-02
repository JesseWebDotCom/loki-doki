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
        return <UserCircle2 className="w-4 h-4 text-sky-400" />;
      case 'micah':
        return <UserCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'notionists':
        return <UserCircle2 className="w-4 h-4 text-amber-400" />;
      case 'adventurerNeutral':
        return <UserCircle2 className="w-4 h-4 text-rose-400" />;
      default:
        return <Sparkles className="w-4 h-4 text-amber-400" />;
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
    <div className="flex items-center gap-4 px-2 w-full select-none">
      <div className="flex items-center gap-3 text-slate-100">
        <Select value={selectedCharId} onValueChange={(val) => val && updateOption('style', val)}>
          <SelectTrigger className="w-[240px] bg-slate-900 border-slate-700 hover:border-sky-500/50 transition-colors focus:ring-sky-500/10 data-[state=open]:border-sky-500/50">
            <div className="flex items-center gap-3 overflow-hidden">
               {renderCharacterIcon(selectedChar.id)}
               <SelectValue placeholder="Select character" />
            </div>
          </SelectTrigger>
          <SelectContent className="bg-slate-900 border-slate-700 text-slate-200">
            {FEATURED_CHARACTERS.map((char) => (
              <SelectItem 
                key={char.id} 
                value={char.id} 
                className="focus:bg-slate-800 transition-colors cursor-pointer py-2.5"
              >
                <div className="flex items-center gap-3">
                  {renderCharacterIcon(char.id)}
                  <div className="flex flex-col items-start leading-tight">
                    <span className="font-semibold text-sm">{char.primary_name}</span>
                    <span className="text-[10px] text-slate-500 uppercase font-bold tracking-tighter">{char.domain}</span>
                  </div>
                </div>
              </SelectItem>
            ))}
            {!FEATURED_CHARACTERS.find(c => c.id === selectedCharId) && (
              <SelectItem 
                key={selectedCharId} 
                value={selectedCharId} 
                className="focus:bg-slate-800 transition-colors cursor-pointer py-2.5"
              >
                <div className="flex items-center gap-3">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <div className="flex flex-col items-start leading-tight">
                    <span className="font-semibold text-sm">Other Style</span>
                    <span className="text-[10px] text-slate-500 uppercase font-bold tracking-tighter">{selectedCharId}</span>
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
            className={`transition-all ${isVisible ? 'bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:text-sky-300' : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'}`}
          >
            {isVisible ? <Eye className="w-4.5 h-4.5" /> : <EyeOff className="w-4.5 h-4.5" />}
          </Button>

          <Button
            variant="outline"
            size="icon"
            onClick={toggleMute}
            className={`transition-all ${!isMuted ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20 hover:text-rose-300'}`}
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
