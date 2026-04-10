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
  const style = {
    ...vars,
    '--radius': '1.25rem',
  } as React.CSSProperties;

  return (
    <div
      style={style}
      className="rounded-[2rem] bg-background text-foreground border border-border/10 p-6 shadow-m3 transition-all duration-500 overflow-hidden"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-xl font-bold tracking-tight">{title}</h3>
          <p className="text-sm font-medium text-muted-foreground">
            Preview of your colors and surfaces
          </p>
        </div>
        <span className="rounded-full border border-border/30 bg-card px-3 py-1 text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground">
          {isDark ? "Dark" : "Light"}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(220px,0.8fr)]">
        <div className="space-y-5">
          <div className="grid grid-cols-5 gap-3">
            <div className="aspect-square rounded-2xl bg-primary shadow-m1" />
            <div className="aspect-square rounded-2xl bg-secondary shadow-m1 opacity-80" />
            <div className="aspect-square rounded-2xl bg-accent shadow-m1" />
            <div className="aspect-square rounded-2xl bg-muted border border-border/10 shadow-sm" />
            <div className="aspect-square rounded-2xl bg-destructive shadow-m1" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button className="px-5 py-2.5 rounded-full bg-primary text-primary-foreground font-bold text-sm shadow-m2">
              Primary
            </button>
            <button className="px-5 py-2.5 rounded-full bg-secondary text-secondary-foreground font-bold text-sm shadow-m1">
              Secondary
            </button>
            <button className="px-5 py-2.5 rounded-full border border-border text-foreground font-bold text-sm">
              Outline
            </button>
          </div>

          <div className="rounded-[1.5rem] bg-card p-5 border border-border/5 space-y-2 shadow-m2">
            <h4 className="text-lg font-bold tracking-tight">Conversation Card</h4>
            <p className="text-sm font-medium text-muted-foreground leading-relaxed">
              Messages, controls, and panels use these surface colors.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground ml-1">
              Input Field
            </label>
            <div className="w-full px-5 py-3 rounded-2xl bg-background border border-border/20 text-sm italic text-muted-foreground flex items-center">
              Enter text...
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="px-4 py-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-black uppercase tracking-widest shadow-sm">
              Badge
            </span>
            <span className="px-4 py-1.5 rounded-full bg-secondary text-secondary-foreground text-[10px] font-black uppercase tracking-widest shadow-sm">
              Secondary
            </span>
            <span className="px-4 py-1.5 rounded-full border border-border text-foreground text-[10px] font-black uppercase tracking-widest">
              Outline
            </span>
          </div>

          <div className="space-y-3">
            <h5 className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground ml-1">
              Chart Colors
            </h5>
            <div className="grid grid-cols-5 h-10 gap-2">
              <div className="rounded-xl bg-primary/80" />
              <div className="rounded-xl bg-secondary/80" />
              <div className="rounded-xl bg-accent/80" />
              <div className="rounded-xl bg-primary/40" />
              <div className="rounded-xl bg-secondary/40" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const ThemeShowcase: React.FC = () => {
    const { palette } = useTheme();
    const currentPalette = palettes.find(p => p.id === palette) || palettes[0];

    return (
        <div className="w-full animate-in fade-in duration-1000 p-6 pb-28 space-y-6">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
                <ThemePreview title="Light Mode" isDark={false} paletteData={currentPalette} />
                <ThemePreview title="Dark Mode" isDark={true} paletteData={currentPalette} />
            </div>
        </div>
    );
};

export default ThemeShowcase;
