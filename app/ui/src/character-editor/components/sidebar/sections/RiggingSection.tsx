import React from 'react';
import { Palette, Scissors, RotateCcw, Shirt, Eye } from 'lucide-react';
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

  const hairColors = ['2c1b18', '4a312c', '724130', 'a55728', 'b58143', 'd6b370', '1a1a1a', 'e8e1e1', '7fdff2'];
  const skinTones = ['ffdbac', 'f1c27d', 'e0ac69', '8d5524', '614335', 'ae5d4c'];
  const clothColors = ['3c4e5e', '2a2b2e', 'ff5c5c', '5cff5c', '5c5cff', 'ffffff', 'e0ac69', '64748b'];

  return (
    <section id="rigging" className="space-y-4 pt-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[9px] font-black text-sky-500 uppercase tracking-[0.2em] flex items-center gap-2">
          <Palette className="w-2.5 h-2.5" /> Full Rigging Suite
        </h3>
        <Button variant="ghost" size="sm" onClick={() => resetToSeed(options.seed)} className="h-6 px-2 text-[9px]">
          <RotateCcw className="w-2.5 h-2.5 mr-1" /> Default
        </Button>
      </div>
      
      <div className="bg-slate-950/40 p-4 rounded-2xl border border-white/5 shadow-inner space-y-5">
        {/* HAIR */}
        <div className="space-y-2.5">
          <label className="text-[8px] font-black text-slate-500 uppercase px-1 flex items-center gap-1.5"><Scissors className="w-2.5 h-2.5 text-sky-500" /> Style & Hair</label>
          <div className="flex gap-2">
            <div className="flex-1">
              <Select value={options.top?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('top', v)}>
                <SelectTrigger className="bg-slate-900 border-none h-10 text-[10px] rounded-xl text-sky-300">
                  <SelectValue placeholder="Hair: Seed" />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-white/10 text-slate-200 uppercase text-[9px] font-bold">
                  {['none', 'bob', 'curly', 'curvy', 'dreads', 'frida', 'frizzle', 'shaggy', 'shortCurly', 'shortFlat', 'shortRound', 'shortWaved', 'sides', 'theCaesar', 'turban', 'winterHat01', 'bigHair', 'hat'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="w-[52px] shrink-0">
               {/* Color picker would go here */}
            </div>
          </div>
        </div>
        
        {/* CLOTHING */}
        <div className="space-y-2.5 border-t border-white/5 pt-4">
          <label className="text-[8px] font-black text-slate-500 uppercase px-1 flex items-center gap-1.5"><Shirt className="w-2.5 h-2.5 text-indigo-400" /> Apparel & Skin</label>
          <div className="grid grid-cols-2 gap-2">
            <Select value={options.clothing?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('clothing', v)}>
              <SelectTrigger className="bg-slate-900 border-none h-10 text-[10px] rounded-xl text-sky-300">
                <SelectValue placeholder="Outfit" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-white/10 text-slate-200 text-[9px] font-bold uppercase">
                {['graphicShirt', 'blazerAndShirt', 'blazerAndSweater', 'hoodie', 'overall', 'shirtCrewNeck', 'shirtScoopNeck', 'shirtVNeck'].sort().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.skinColor?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('skinColor', v)}>
              <SelectTrigger className="bg-slate-900 border-none h-10 rounded-xl">
                <SelectValue placeholder="Skin" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-white/10 p-2 grid grid-cols-3 gap-2">
                 {skinTones.map(c => <SelectItem key={c} value={c} className="!p-0 h-8 w-8 rounded-full flex justify-center !text-[0px]"><div className="w-6 h-6 rounded-full border border-white/10" style={{ backgroundColor: `#${c}` }} /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* EYES/MOUTH */}
        <div className="space-y-2.5 border-t border-white/5 pt-4">
          <label className="text-[8px] font-black text-slate-500 uppercase px-1 flex items-center gap-1.5"><Eye className="w-2.5 h-2.5 text-pink-500" /> Expression</label>
          <div className="grid grid-cols-3 gap-2">
            <Select value={options.eyes?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('eyes', v)}>
              <SelectTrigger className="bg-slate-900 border-none h-9 text-[9px] rounded-xl text-sky-400 font-bold">
                <SelectValue placeholder="Eyes" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-white/10 text-slate-200">
                {['default', 'closed', 'happy', 'surprised', 'wink', 'eyeRoll'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={options.mouth?.[0] || 'seed'} onValueChange={(v) => handleTraitChange('mouth', v)}>
              <SelectTrigger className="bg-slate-900 border-none h-9 text-[9px] rounded-xl text-sky-400 font-bold">
                <SelectValue placeholder="Mouth" />
              </SelectTrigger>
              <SelectContent className="bg-slate-900 border-white/10 text-slate-200">
                {['default', 'smile', 'serious', 'screamOpen', 'disbelief', 'tongue'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </section>
  );
};
