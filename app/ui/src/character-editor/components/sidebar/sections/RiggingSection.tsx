import React from 'react';
import { Palette, Scissors, RotateCcw, Shirt, Eye, Glasses, Move, Hash, Box, Maximize, Type, RefreshCw, Layers } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import { Input } from "@/character-editor/components/ui/input";
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

  const colorLabel = (value: string) => (value === 'seed' || value === 'transparent' ? value.charAt(0).toUpperCase() + value.slice(1) : `#${value.toUpperCase()}`);
  const ColorItem = ({ value }: { value: string }) => (
    <div className="flex items-center gap-2">
      <span
        className="h-4 w-4 rounded-full border border-[color:var(--app-border)] shadow-inner"
        style={{ backgroundColor: (value === 'seed' || value === 'transparent') ? 'transparent' : `#${value}` }}
      />
      <span>{colorLabel(value)}</span>
    </div>
  );

  const hairColors = ['2c1b18', '4a312c', '724130', 'a55728', 'b58143', 'd6b370', '1a1a1a', 'e8e1e1', '7fdff2'];
  const skinTones = ['ffdbac', 'f1c27d', 'e0ac69', '8d5524', '614335', 'ae5d4c'];
  const clothColors = ['3c4e5e', '2a2b2e', 'ff5c5c', '5cff5c', '5c5cff', 'ffffff', 'e0ac69', '64748b'];
  const accessoryColors = ['262e33', '65c9ff', '5199e4', '25557c', 'e6e6e6', '929598', '3c4f5c', 'b1e2ff', 'a7ffc4', 'ffdeb5', 'ffafb9', 'ffffb1', 'ff488e', 'ff5c5c', 'ffffff'];
  
  const backgroundColors = ['transparent', 'b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'f1f5f9', '1e293b'];
  const backgroundTypes = ['solid', 'gradientLinear', 'gradientRadial'];

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
      
      <div className="space-y-6 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-4 shadow-[var(--app-shadow-soft)]">
        
        {/* GLOBAL TRANSFORMS */}
        <div className="space-y-4">
          <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]">
            <Maximize className="w-2.5 h-2.5 text-[var(--app-icon-primary)]" /> Transforms & Geometry
          </label>
          <div className="grid grid-cols-2 gap-4">
             <div className="space-y-1.5">
                <div className="flex justify-between px-0.5">
                   <span className="text-[10px] text-[var(--app-text-muted)]">Scale (Size)</span>
                   <span className="text-[10px] font-mono text-[var(--app-accent)]">{options.scale}%</span>
                </div>
                <Input type="range" min="10" max="200" value={options.scale} onChange={(e) => updateOption('scale', parseInt(e.target.value))} className="h-1 bg-[var(--app-bg-panel-strong)]" />
             </div>
             <div className="space-y-1.5">
                <div className="flex justify-between px-0.5">
                   <span className="text-[10px] text-[var(--app-text-muted)]">Rotate</span>
                   <span className="text-[10px] font-mono text-[var(--app-accent)]">{options.rotate}°</span>
                </div>
                <Input type="range" min="0" max="360" value={options.rotate} onChange={(e) => updateOption('rotate', parseInt(e.target.value))} className="h-1 bg-[var(--app-bg-panel-strong)]" />
             </div>
             <div className="space-y-1.5">
                <div className="flex justify-between px-0.5">
                   <span className="text-[10px] text-[var(--app-text-muted)]">Translate X</span>
                   <span className="text-[10px] font-mono text-[var(--app-accent)]">{options.translateX}%</span>
                </div>
                <Input type="range" min="-100" max="100" value={options.translateX} onChange={(e) => updateOption('translateX', parseInt(e.target.value))} className="h-1 bg-[var(--app-bg-panel-strong)]" />
             </div>
             <div className="space-y-1.5">
                <div className="flex justify-between px-0.5">
                   <span className="text-[10px] text-[var(--app-text-muted)]">Translate Y</span>
                   <span className="text-[10px] font-mono text-[var(--app-accent)]">{options.translateY}%</span>
                </div>
                <Input type="range" min="-100" max="100" value={options.translateY} onChange={(e) => updateOption('translateY', parseInt(e.target.value))} className="h-1 bg-[var(--app-bg-panel-strong)]" />
             </div>
             <div className="space-y-1.5">
                <div className="flex justify-between px-0.5">
                   <span className="text-[10px] text-[var(--app-text-muted)]">Radius</span>
                   <span className="text-[10px] font-mono text-[var(--app-accent)]">{options.radius}%</span>
                </div>
                <Input type="range" min="0" max="50" value={options.radius} onChange={(e) => updateOption('radius', parseInt(e.target.value))} className="h-1 bg-[var(--app-bg-panel-strong)]" />
             </div>
             <div className="flex items-center gap-4 pt-2">
                <div className="flex items-center gap-2">
                   <input 
                      type="checkbox" 
                      id="opt-flip"
                      checked={options.flip} 
                      onChange={(e) => updateOption('flip', e.target.checked)}
                      className="accent-[var(--app-accent)]"
                   />
                   <label htmlFor="opt-flip" className="text-[10px] text-[var(--app-text-muted)]">Flip</label>
                </div>
                <div className="flex items-center gap-2">
                   <input 
                      type="checkbox" 
                      id="opt-random-ids"
                      checked={options.randomizeIds} 
                      onChange={(e) => updateOption('randomizeIds', e.target.checked)}
                      className="accent-[var(--app-accent)]"
                   />
                   <label htmlFor="opt-random-ids" className="text-[10px] text-[var(--app-text-muted)]">Random IDs</label>
                </div>
             </div>
          </div>
        </div>

        {/* BACKGROUND */}
        <div className="space-y-4 border-t border-[color:var(--app-border)] pt-4">
          <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]">
            <Layers className="w-2.5 h-2.5 text-[var(--app-icon-indigo)]" /> Background
          </label>
          <div className="grid grid-cols-1 gap-3">
             <div className="flex gap-2">
                <div className="flex-1">
                   <Select value={options.backgroundColor?.[0]} onValueChange={(v) => updateOption('backgroundColor', [v])}>
                      <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                         <SelectValue placeholder="Color" />
                      </SelectTrigger>
                      <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                         {backgroundColors.map(c => <SelectItem key={c} value={c}><ColorItem value={c} /></SelectItem>)}
                      </SelectContent>
                   </Select>
                </div>
                <div className="flex-1">
                   <Select value={options.backgroundType?.[0]} onValueChange={(v) => updateOption('backgroundType', [v])}>
                      <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                         <SelectValue placeholder="Type" />
                      </SelectTrigger>
                      <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                         {backgroundTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                   </Select>
                </div>
             </div>
             <div className="space-y-1.5">
                <div className="flex justify-between px-0.5">
                   <span className="text-[10px] text-[var(--app-text-muted)]">BG Rotation</span>
                   <span className="text-[10px] font-mono text-[var(--app-accent)]">{options.backgroundRotation}°</span>
                </div>
                <Input type="range" min="0" max="360" value={options.backgroundRotation} onChange={(e) => updateOption('backgroundRotation', parseInt(e.target.value))} className="h-1 bg-[var(--app-bg-panel-strong)]" />
             </div>
          </div>
        </div>

        {/* ANATOMY & STYLE */}
        <div className="space-y-4 border-t border-[color:var(--app-border)] pt-4">
           <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]">
              <Scissors className="w-2.5 h-2.5 text-[var(--app-icon-primary)]" /> Anatomy & Traits
           </label>

           {/* HAIR */}
           <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                 <Select value={options.top?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('top', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Hair: Seed" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed">seed</SelectItem>
                       {['none', 'bob', 'curly', 'curvy', 'dreads', 'frida', 'frizzle', 'shaggy', 'shortCurly', 'shortFlat', 'shortRound', 'shortWaved', 'sides', 'theCaesar', 'turban', 'winterHat01', 'bigHair', 'hat'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
                 <Select value={options.hairColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('hairColor', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Hair Color" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                       {hairColors.map(t => <SelectItem key={t} value={t}><ColorItem value={t} /></SelectItem>)}
                    </SelectContent>
                 </Select>
              </div>
              <div className="space-y-1.5">
                 <div className="flex justify-between px-0.5">
                    <span className="text-[9px] uppercase font-bold text-[var(--app-text-muted)]">Hair Probability</span>
                    <span className="text-[9px] font-mono text-[var(--app-accent)]">{options.topProbability}%</span>
                 </div>
                 <Input type="range" min="0" max="100" value={options.topProbability} onChange={(e) => updateOption('topProbability', parseInt(e.target.value))} className="h-0.5 bg-[var(--app-bg-panel-strong)]" />
              </div>
           </div>

           {/* BEARD */}
           <div className="space-y-3 pt-2 border-t border-[color:var(--app-border)]">
              <div className="grid grid-cols-1 gap-2">
                 <Select value={options.facialHair?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('facialHair', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Beard: Seed" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed">seed</SelectItem>
                       {['none', 'beardMedium', 'beardLight', 'beardMajestic', 'moustaches01', 'moustaches02'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
              </div>
              <div className="space-y-1.5">
                 <div className="flex justify-between px-0.5">
                    <span className="text-[9px] uppercase font-bold text-[var(--app-text-muted)]">Beard Probability</span>
                    <span className="text-[9px] font-mono text-[var(--app-accent)]">{options.facialHairProbability}%</span>
                 </div>
                 <Input type="range" min="0" max="100" value={options.facialHairProbability} onChange={(e) => updateOption('facialHairProbability', parseInt(e.target.value))} className="h-0.5 bg-[var(--app-bg-panel-strong)]" />
              </div>
           </div>

           {/* REAR HAIR */}
           <div className="space-y-3 pt-2 border-t border-[color:var(--app-border)]">
              <div className="grid grid-cols-1 gap-2">
                 <Select value={options.hair?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('hair', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Rear Hair: Seed" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed">seed</SelectItem>
                       {['none', 'long', 'short', 'bob', 'curvy'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
              </div>
              <div className="space-y-1.5">
                 <div className="flex justify-between px-0.5">
                    <span className="text-[9px] uppercase font-bold text-[var(--app-text-muted)]">Rear Hair Prob</span>
                    <span className="text-[9px] font-mono text-[var(--app-accent)]">{options.hairProbability}%</span>
                 </div>
                 <Input type="range" min="0" max="100" value={options.hairProbability} onChange={(e) => updateOption('hairProbability', parseInt(e.target.value))} className="h-0.5 bg-[var(--app-bg-panel-strong)]" />
              </div>
           </div>

           {/* CLOTHING */}
           <div className="space-y-2.5 pt-2 border-t border-[color:var(--app-border)]">
              <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]"><Shirt className="w-2.5 h-2.5 text-[var(--app-icon-indigo)]" /> Apparel & Skin</label>
              <div className="grid grid-cols-2 gap-2">
                 <Select value={options.clothing?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('clothing', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Outfit" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed">seed</SelectItem>
                       {['graphicShirt', 'blazerAndShirt', 'blazerAndSweater', 'collarAndSweater', 'hoodie', 'overall', 'shirtCrewNeck', 'shirtScoopNeck', 'shirtVNeck'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
                 <Select value={options.clothesColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('clothesColor', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Color" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                       {clothColors.map(t => <SelectItem key={t} value={t}><ColorItem value={t} /></SelectItem>)}
                    </SelectContent>
                 </Select>
                 <Select value={options.skinColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('skinColor', v)}>
                    <SelectTrigger className="h-10 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px]">
                       <SelectValue placeholder="Skin" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       <SelectItem value="seed"><ColorItem value="seed" /></SelectItem>
                       {skinTones.map(c => <SelectItem key={c} value={c}><ColorItem value={c} /></SelectItem>)}
                    </SelectContent>
                 </Select>
              </div>
           </div>

           {/* EXPRESSION */}
           <div className="space-y-2.5 pt-2 border-t border-[color:var(--app-border)]">
              <label className="ce-micro flex items-center gap-1.5 px-1 text-[var(--app-text-muted)]"><Eye className="w-2.5 h-2.5 text-[var(--app-icon-pink)]" /> Expression</label>
              <div className="grid grid-cols-3 gap-2">
                 <Select value={options.eyes?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('eyes', v)}>
                    <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[9px]">
                       <SelectValue placeholder="Eyes" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       {['default', 'closed', 'happy', 'surprised', 'wink', 'eyeRoll'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
                 <Select value={options.eyebrows?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('eyebrows', v)}>
                    <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[9px]">
                       <SelectValue placeholder="Brows" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       {['default', 'angry', 'angryNatural', 'flatNatural', 'raisedExcited', 'sadConcerned', 'upDown', 'upDownNatural'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
                 <Select value={options.mouth?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('mouth', v)}>
                    <SelectTrigger className="h-9 rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[9px]">
                       <SelectValue placeholder="Mouth" />
                    </SelectTrigger>
                    <SelectContent className="border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] text-[var(--app-text)]">
                       {['default', 'smile', 'serious', 'screamOpen', 'disbelief', 'tongue'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                 </Select>
              </div>
           </div>
        </div>
      </div>
    </section>
  );
};
