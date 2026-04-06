import React from 'react';
import { useTheme } from './ThemeProvider';
import { palettes } from './themes';

interface ThemePreviewProps {
  title: string;
  isDark: boolean;
  paletteData: any;
}

function ThemePreview({ title, isDark, paletteData }: ThemePreviewProps) {
  const vars = isDark ? paletteData.dark : paletteData.light;
  
  // Create a scoped style object for the preview card
  const style = {
    ...vars,
    '--radius': '1.5rem', // Match high-radius aesthetic
  } as React.CSSProperties;

  return (
    <div 
      style={style}
      className="flex-1 rounded-[2.5rem] bg-background text-foreground border border-border/10 p-10 space-y-10 shadow-m3 transition-all duration-500 overflow-hidden"
    >
      <div className="text-center space-y-1">
        <h3 className="text-2xl font-bold tracking-tight">{title}</h3>
        <p className="text-sm font-medium text-muted-foreground">Preview of theme colors</p>
      </div>

      {/* Swatches */}
      <div className="grid grid-cols-5 gap-4">
        <div className="aspect-square rounded-3xl bg-primary shadow-m1" />
        <div className="aspect-square rounded-3xl bg-secondary shadow-m1 opacity-80" />
        <div className="aspect-square rounded-3xl bg-accent shadow-m1" />
        <div className="aspect-square rounded-3xl bg-muted border border-border/10 shadow-sm" />
        <div className="aspect-square rounded-3xl bg-destructive shadow-m1" />
      </div>

      {/* Buttons */}
      <div className="flex flex-wrap items-center gap-4">
        <button className="px-8 py-3 rounded-full bg-primary text-primary-foreground font-bold text-sm shadow-m2">Primary</button>
        <button className="px-8 py-3 rounded-full bg-secondary text-secondary-foreground font-bold text-sm shadow-m1">Secondary</button>
        <button className="px-8 py-3 rounded-full border border-border text-foreground font-bold text-sm">Outline</button>
        <button className="px-8 py-3 rounded-full bg-destructive text-primary-foreground font-bold text-sm shadow-m1">Destructive</button>
      </div>

      {/* Surface Layer / Card */}
      <div className="rounded-[2rem] bg-card p-8 border border-border/5 space-y-2 shadow-m2 transition-all hover:scale-[1.01]">
        <h4 className="text-xl font-bold tracking-tight">Card Title</h4>
        <p className="text-sm font-medium text-muted-foreground leading-relaxed">
          Card description with muted text styling.
        </p>
      </div>

      {/* Input Field Form Factor */}
      <div className="space-y-3">
        <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground ml-1">Input Field</label>
        <div className="w-full px-6 py-4 rounded-2xl bg-background border border-border/20 text-sm italic text-muted-foreground flex items-center">
          Enter text...
        </div>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-3">
         <span className="px-5 py-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-black uppercase tracking-widest shadow-sm">Badge</span>
         <span className="px-5 py-1.5 rounded-full bg-secondary text-secondary-foreground text-[10px] font-black uppercase tracking-widest shadow-sm">Secondary</span>
         <span className="px-5 py-1.5 rounded-full border border-border text-foreground text-[10px] font-black uppercase tracking-widest">Outline</span>
      </div>

      {/* Chart Colors */}
      <div className="space-y-4">
        <h5 className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground ml-1">Chart Colors</h5>
        <div className="grid grid-cols-5 h-12 gap-2">
            <div className="rounded-xl bg-primary/80" />
            <div className="rounded-xl bg-secondary/80" />
            <div className="rounded-xl bg-accent/80" />
            <div className="rounded-xl bg-primary/40" />
            <div className="rounded-xl bg-secondary/40" />
        </div>
      </div>
    </div>
  );
}

const ThemeShowcase: React.FC = () => {
    const { palette } = useTheme();
    const currentPalette = palettes.find(p => p.id === palette) || palettes[0];

    return (
        <div className="w-full animate-in fade-in duration-1000 p-8 space-y-12">
            <div className="flex items-center gap-6 mb-4 opacity-40">
                <span className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
                <div className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.5em] whitespace-nowrap">
                    Live Authoritative Preview
                </div>
                <span className="h-[1px] flex-1 bg-gradient-to-r from-border via-border to-transparent" />
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-stretch">
                <ThemePreview title="Light Mode" isDark={false} paletteData={currentPalette} />
                <ThemePreview title="Dark Mode" isDark={true} paletteData={currentPalette} />
            </div>
        </div>
    );
};

export default ThemeShowcase;
