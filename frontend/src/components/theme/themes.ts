export type PaletteId = 
  | "material" | "ocean" | "amber" | "rose" | "midnight" | "nature" | "aurora" | "slate"
  | "crimson" | "violet" | "forest" | "amethyst" | "artdeco" | "blue" | "bold" | "bubblegum"
  | "caffeine" | "catppuccin" | "clay" | "corporate" | "cosmic" | "cyberpunk" | "doom"
  | "ghibli" | "graphite" | "green" | "marvel" | "mocha" | "minimal" | "mono" | "northern"
  | "quantum" | "retro" | "slack" | "soft" | "solar" | "spotify" | "starry" | "supabase"
  | "twitter" | "valorant" | "vercel" | "vscode" | "candyland" | "clean" | "darkmatter"
  | "luxury" | "yellow" | "orange" | "pastel" | "red" | "summer" | "sunset" | "tangerine";

export interface ThemePalette {
  id: PaletteId;
  label: string;
  swatch: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export const palettes: ThemePalette[] = [
  {
    id: "material", label: "Material Design", swatch: "oklch(0.51 0.21 286.50)",
    light: { 
      '--background': 'oklch(0.98 0.01 334.35)', 
      '--foreground': 'oklch(0.22 0 0)', 
      '--card': 'oklch(0.96 0.01 335.69)',
      '--muted': 'oklch(0.96 0.01 335.69)',
      '--primary': 'oklch(0.51 0.21 286.50)', 
      '--primary-foreground': 'oklch(1.00 0 0)', 
      '--secondary': 'oklch(0.49 0.04 300.23)', 
      '--border': 'oklch(0.83 0.02 308.26)',
      '--sidebar': 'oklch(0.99 0 0)',
      '--sidebar-foreground': 'oklch(0.15 0 0)',
      '--sidebar-border': 'oklch(0.90 0 0)'
    },
    dark: { 
      '--background': 'oklch(0.15 0.01 317.69)', 
      '--foreground': 'oklch(0.95 0.01 321.50)', 
      '--card': 'oklch(0.22 0.02 322.13)',
      '--muted': 'oklch(0.22 0.01 319.50)',
      '--primary': 'oklch(0.60 0.22 279.81)', 
      '--primary-foreground': 'oklch(0.98 0.01 321.51)', 
      '--secondary': 'oklch(0.45 0.03 294.79)', 
      '--border': 'oklch(0.40 0.04 309.35)',
      '--sidebar': 'oklch(0.20 0.01 317.74)',
      '--sidebar-foreground': 'oklch(0.95 0.01 321.50)',
      '--sidebar-border': 'oklch(0.35 0.01 319.53 / 30%)'
    }
  },
  {
    id: "ocean", label: "Ocean Breeze", swatch: "oklch(0.65 0.20 160)",
    light: { 
      '--background': 'oklch(0.98 0.01 200)', '--foreground': 'oklch(0.2 0.05 210)', '--card': 'oklch(0.96 0.01 200)', '--muted': 'oklch(0.96 0.01 200)', '--primary': 'oklch(0.65 0.20 160)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.85 0.05 200)',
      '--sidebar': 'oklch(0.99 0.01 200)', '--sidebar-foreground': 'oklch(0.2 0.05 210)', '--sidebar-border': 'oklch(0.92 0.05 200)'
    },
    dark: { 
      '--background': 'oklch(0.15 0.02 210)', '--foreground': 'oklch(0.95 0.02 210)', '--card': 'oklch(0.18 0.02 215)', '--muted': 'oklch(0.18 0.02 215)', '--primary': 'oklch(0.70 0.15 160)', '--primary-foreground': 'oklch(0.15 0.02 160)', '--border': 'oklch(0.3 0.05 210)',
      '--sidebar': 'oklch(0.12 0.02 210)', '--sidebar-foreground': 'oklch(0.9 0.02 210)', '--sidebar-border': 'oklch(0.2 0.05 210)'
    }
  },
  {
    id: "amber", label: "Amber Minimal", swatch: "oklch(0.75 0.15 75)",
    light: { 
      '--background': 'oklch(0.99 0.01 80)', '--foreground': 'oklch(0.2 0.05 70)', '--card': 'oklch(1 0 80)', '--muted': 'oklch(1 0 80)', '--primary': 'oklch(0.75 0.15 75)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.9 0.05 80)',
      '--sidebar': 'oklch(1 0 80)', '--sidebar-foreground': 'oklch(0.2 0.05 70)', '--sidebar-border': 'oklch(0.95 0.05 80)'
    },
    dark: { 
      '--background': 'oklch(0.12 0.02 70)', '--foreground': 'oklch(0.95 0.02 75)', '--card': 'oklch(0.15 0.02 75)', '--muted': 'oklch(0.15 0.02 75)', '--primary': 'oklch(0.8 0.15 75)', '--primary-foreground': 'oklch(0.1 0.05 75)', '--border': 'oklch(0.25 0.05 70)',
      '--sidebar': 'oklch(0.1 0.02 70)', '--sidebar-foreground': 'oklch(0.9 0.02 75)', '--sidebar-border': 'oklch(0.18 0.02 70)'
    }
  },
  {
    id: "vscode", label: "VS Code", swatch: "oklch(0.5 0.15 250)",
    light: { '--background': 'oklch(0.98 0.01 250)', '--foreground': 'oklch(0.2 0.05 250)', '--card': 'oklch(1 0 250)', '--primary': 'oklch(0.5 0.15 250)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.88 0.05 250)', '--sidebar': 'oklch(0.99 0.01 250)', '--sidebar-foreground': 'oklch(0.2 0.05 250)', '--sidebar-border': 'oklch(0.92 0.05 250)' },
    dark: { '--background': 'oklch(0.14 0.02 250)', '--foreground': 'oklch(0.92 0.02 250)', '--card': 'oklch(0.12 0.02 250)', '--primary': 'oklch(0.55 0.15 250)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.22 0.04 250)', '--sidebar': 'oklch(0.12 0.02 250)', '--sidebar-foreground': 'oklch(0.9 0.02 250)', '--sidebar-border': 'oklch(0.18 0.02 250)' }
  },
  {
    id: "cyberpunk", label: "Cyberpunk", swatch: "oklch(0.6 0.3 15)",
    light: { '--background': 'oklch(0.98 0.01 15)', '--foreground': 'oklch(0.15 0.05 15)', '--card': 'oklch(0.95 0.01 15)', '--primary': 'oklch(0.6 0.3 15)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.85 0.05 15)', '--sidebar': 'oklch(0.99 0.01 15)', '--sidebar-foreground': 'oklch(0.15 0.05 15)', '--sidebar-border': 'oklch(0.95 0.05 15)' },
    dark: { '--background': 'oklch(0.12 0.02 15)', '--foreground': 'oklch(0.95 0.25 15)', '--card': 'oklch(0.1 0.02 15)', '--primary': 'oklch(0.7 0.3 350)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.2 0.05 15)', '--sidebar': 'oklch(0.08 0.02 15)', '--sidebar-foreground': 'oklch(0.9 0.2 15)', '--sidebar-border': 'oklch(0.15 0.05 15)' }
  },
  {
    id: "spotify", label: "Spotify", swatch: "oklch(0.6 0.2 145)",
    light: { '--background': 'oklch(0.98 0.01 145)', '--foreground': 'oklch(0.15 0.05 145)', '--card': 'oklch(1 0 145)', '--primary': 'oklch(0.6 0.2 145)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.85 0.05 145)', '--sidebar': 'oklch(1 0 145)', '--sidebar-foreground': 'oklch(0.15 0.05 145)', '--sidebar-border': 'oklch(0.95 0 145)' },
    dark: { '--background': 'oklch(0.12 0.02 145)', '--foreground': 'oklch(0.95 0.1 145)', '--card': 'oklch(0.1 0.02 145)', '--primary': 'oklch(0.6 0.25 145)', '--primary-foreground': 'oklch(0.1 0.05 145)', '--border': 'oklch(0.2 0.05 145)', '--sidebar': 'oklch(0.08 0.02 145)', '--sidebar-foreground': 'oklch(0.9 0.1 145)', '--sidebar-border': 'oklch(0.15 0.02 145)' }
  },
  {
    id: "ghibli", label: "Studio Ghibli", swatch: "oklch(0.7 0.15 200)",
    light: { '--background': 'oklch(0.98 0.05 200)', '--foreground': 'oklch(0.3 0.1 210)', '--primary': 'oklch(0.7 0.15 200)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.9 0.05 200)', '--sidebar': 'oklch(0.99 0.05 200)', '--sidebar-foreground': 'oklch(0.3 0.1 210)', '--sidebar-border': 'oklch(0.95 0.05 200)' },
    dark: { '--background': 'oklch(0.15 0.05 210)', '--foreground': 'oklch(0.95 0.1 200)', '--primary': 'oklch(0.75 0.15 200)', '--primary-foreground': 'oklch(0.15 0.05 210)', '--border': 'oklch(0.25 0.1 210)', '--sidebar': 'oklch(0.12 0.05 210)', '--sidebar-foreground': 'oklch(0.9 0.1 200)', '--sidebar-border': 'oklch(0.2 0.1 210)' }
  },
  {
    id: "valorant", label: "Valorant", swatch: "oklch(0.55 0.25 25)",
    light: { '--background': 'oklch(0.98 0.01 25)', '--foreground': 'oklch(0.15 0.1 25)', '--primary': 'oklch(0.55 0.25 25)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.85 0.1 25)', '--sidebar': 'oklch(0.99 0.01 25)', '--sidebar-foreground': 'oklch(0.15 0.1 25)', '--sidebar-border': 'oklch(0.92 0.1 25)' },
    dark: { '--background': 'oklch(0.12 0.05 25)', '--foreground': 'oklch(0.95 0.1 25)', '--primary': 'oklch(0.6 0.3 25)', '--primary-foreground': 'oklch(1 0 0)', '--border': 'oklch(0.25 0.1 25)', '--sidebar': 'oklch(0.08 0.05 25)', '--sidebar-foreground': 'oklch(0.9 0.1 25)', '--sidebar-border': 'oklch(0.18 0.05 25)' }
  },
  {
    id: "clean", label: "Clean Slate", swatch: "oklch(0.95 0.01 240)",
    light: { '--background': 'oklch(1 0 0)', '--foreground': 'oklch(0.1 0 0)', '--card': 'oklch(0.98 0 0)', '--primary': 'oklch(0.95 0.01 240)', '--primary-foreground': 'oklch(0.1 0 0)', '--border': 'oklch(0.9 0 0)', '--sidebar': 'oklch(1 0 0)', '--sidebar-foreground': 'oklch(0.1 0 0)', '--sidebar-border': 'oklch(0.95 0 0)' },
    dark: { '--background': 'oklch(0.05 0 0)', '--foreground': 'oklch(0.95 0 0)', '--card': 'oklch(0.08 0 0)', '--primary': 'oklch(0.1 0 0)', '--primary-foreground': 'oklch(0.95 0 0)', '--border': 'oklch(0.15 0 0)', '--sidebar': 'oklch(0.03 0 0)', '--sidebar-foreground': 'oklch(0.9 0 0)', '--sidebar-border': 'oklch(0.1 0 0)' }
  }
];
