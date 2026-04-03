import React from 'react';
import { Palette, Scissors, RotateCcw, Shirt, Eye, Glasses } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/character-editor/components/ui/select";

interface RiggingSectionProps {
  options: any;
  updateOption: (key: any, value: any) => void;
  resetToSeed: (seed: string) => void;
}

export const RiggingSection: React.FC<RiggingSectionProps> = ({ options, updateOption, resetToSeed }) => {
  const handleTraitChange = (key: string, value: string | null) => {
    if (!value) return;
    updateOption(key, [value]);
  };

  const colorLabel = (value: string) => (value === 'seed' ? 'Seed' : `#${value.toUpperCase()}`);
  const ColorItem = ({ value }: { value: string }) => (
    <div className="flex items-center gap-2">
      <span
        className="h-4 w-4 rounded-full border border-[color:var(--app-border)] shadow-inner"
        style={{ backgroundColor: value === 'seed' ? 'transparent' : `#${value}` }}
      />
      <span>{colorLabel(value)}</span>
    </div>
  );

  const hairColors = ['2c1b18', '4a312c', '724130', 'a55728', 'b58143', 'd6b370', '1a1a1a', 'e8e1e1', '7fdff2'];
  const skinTones = ['ffdbac', 'f1c27d', 'e0ac69', '8d5524', '614335', 'ae5d4c'];
  const clothColors = ['3c4e5e', '2a2b2e', 'ff5c5c', '5cff5c', '5c5cff', 'ffffff', 'e0ac69', '64748b'];
  const accessoryColors = ['262e33', '65c9ff', '5199e4', '25557c', 'e6e6e6', '929598', '3c4f5c', 'b1e2ff', 'a7ffc4', 'ffdeb5', 'ffafb9', 'ffffb1', 'ff488e', 'ff5c5c', 'ffffff'];
  const isAvataaars = options.style === 'avataaars';

  return (
    <section id="rigging" className="space-y-4 pt-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="ce-title flex items-center gap-2 text-[var(--app-icon-primary)]">
          <Palette className="w-2.5 h-2.5" /> Full Rigging Suite
        </h3>
        <Button variant="ghost" size="sm" onClick={() => resetToSeed(options.seed)} className="h-6 px-2 text-[9px]">
          <RotateCcw className="w-2.5 h-2.5 mr-1" /> Default
        </Button>
      </div>
      
      <div className="space-y-5 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-4 shadow-[var(--app-shadow-soft)]">
        {!isAvataaars ? (
          <div className="rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-3 text-xs text-[var(--app-text-muted)]">
            Detailed apparel and accessory controls are available for the Avataaars type.
          </div>
        ) : null}
        {/* HAIR */}
        <div className="space-y-2.5">
          <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]"><Scissors className="w-2.5 h-2.5 text-[var(--app-icon-primary)]" /> Style & Hair</label>
          <div className="flex gap-2">
            <div className="flex-1">
              <Select value={options.top?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('top', v)}>
                <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] text-[var(--app-icon-primary)]">
                  <SelectValue placeholder="Hair: Seed" />
                </SelectTrigger>
                <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                  {['none', 'bob', 'curly', 'curvy', 'dreads', 'frida', 'frizzle', 'shaggy', 'shortCurly', 'shortFlat', 'shortRound', 'shortWaved', 'sides', 'theCaesar', 'turban', 'winterHat01', 'bigHair', 'hat'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[160px] shrink-0">
              <Select value={options.hairColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('hairColor', v)}>
                <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] text-[var(--app-icon-primary)]">
                  <SelectValue placeholder="Hair Color" />
                </SelectTrigger>
                <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                  <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                  {hairColors.map(t => <SelectItem key={t} value={t}><ColorItem value={t} /></SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        
        {/* CLOTHING */}
        <div className="space-y-2.5 border-t border-[color:var(--app-border)] pt-4">
          <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]"><Shirt className="w-2.5 h-2.5 text-[var(--app-icon-indigo)]" /> Apparel & Skin</label>
          <div className="grid grid-cols-2 gap-2">
            <Select value={options.clothing?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('clothing', v)}>
              <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] text-[var(--app-icon-primary)]">
                <SelectValue placeholder="Outfit" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                <SelectItem value="seed">seed</SelectItem>
                {['graphicShirt', 'blazerAndShirt', 'blazerAndSweater', 'collarAndSweater', 'hoodie', 'overall', 'shirtCrewNeck', 'shirtScoopNeck', 'shirtVNeck'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.clothesColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('clothesColor', v)}>
              <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)]">
                <SelectValue placeholder="Shirt Color" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                {clothColors.map(t => <SelectItem key={t} value={t}><ColorItem value={t} /></SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.clothingGraphic?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('clothingGraphic', v)}>
              <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] text-[var(--app-icon-primary)]">
                <SelectValue placeholder="Graphic" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                <SelectItem value="seed">seed</SelectItem>
                {['bat', 'bear', 'cumbia', 'deer', 'diamond', 'hola', 'pizza', 'resist', 'skull', 'skullOutline'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.skinColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('skinColor', v)}>
              <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)]">
                <SelectValue placeholder="Skin" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                 <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                 {skinTones.map(c => <SelectItem key={c} value={c}><ColorItem value={c} /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2.5 border-t border-[color:var(--app-border)] pt-4">
          <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]"><Glasses className="w-2.5 h-2.5 text-[var(--app-icon-primary)]" /> Accessories</label>
          <div className="grid grid-cols-2 gap-2">
            <Select value={options.accessories?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('accessories', v)}>
              <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] text-[var(--app-icon-primary)]">
                <SelectValue placeholder="Accessory" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                <SelectItem value="seed">seed</SelectItem>
                {['kurt', 'prescription01', 'prescription02', 'round', 'sunglasses', 'wayfarers', 'eyepatch'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.accessoriesColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('accessoriesColor', v)}>
              <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)]">
                <SelectValue placeholder="Accessory Color" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                {accessoryColors.map(t => <SelectItem key={t} value={t}><ColorItem value={t} /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* EYES/MOUTH */}
        <div className="space-y-2.5 border-t border-[color:var(--app-border)] pt-4">
          <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]"><Eye className="w-2.5 h-2.5 text-[var(--app-icon-pink)]" /> Expression</label>
          <div className="grid grid-cols-3 gap-2">
            <Select value={options.eyes?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('eyes', v)}>
              <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[9px] font-bold text-[var(--app-icon-primary)]">
                <SelectValue placeholder="Eyes" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                {['default', 'closed', 'happy', 'surprised', 'wink', 'eyeRoll'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.mouth?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('mouth', v)}>
              <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[9px] font-bold text-[var(--app-icon-primary)]">
                <SelectValue placeholder="Mouth" />
              </SelectTrigger>
              <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                {['default', 'smile', 'serious', 'screamOpen', 'disbelief', 'tongue'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </section>
  );
};
