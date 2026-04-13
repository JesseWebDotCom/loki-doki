export type PaletteId = 
  | "material" | "amber-minimal" | "amethyst-haze" | "art-deco" | "blue" | "bold-tech" | "bubblegum" 
  | "caffeine" | "candyland" | "catppuccin" | "claude" | "claymorphism" | "clean-slate" 
  | "corporate" | "cosmic-night" | "cyberpunk" | "darkmatter" | "doom-64" | "elegant-luxury" 
  | "ghibli-studio" | "graphite" | "green" | "kodama-grove" | "marshmallow" | "marvel" 
  | "midnight-bloom" | "mocha-mousse" | "modern-minimal" | "mono" | "nature" 
  | "neo-brutalism" | "northern-lights" | "notebook" | "ocean-breeze" | "orange" 
  | "pastel-dreams" | "perpetuity" | "quantum-rose" | "red" | "retro-arcade" | "rose" 
  | "slack" | "soft-pop" | "solar-dusk" | "spotify" | "starry-night" | "summer" 
  | "sunset-horizon" | "supabase" | "t3-chat" | "tangerine" | "twitter" | "valorant" 
  | "vercel" | "vintage-paper" | "violet" | "violet-bloom" | "vs-code" | "yellow";

export interface ThemePalette {
  id: PaletteId;
  label: string;
  swatch: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export const palettes: ThemePalette[] = [
  {
    id: "material", label: "Material Design", swatch: "oklch(0.55 0.20 290)",
    light: { 
      '--background': 'oklch(0.98 0.01 334.35)', '--foreground': 'oklch(0.22 0 0)', '--card': 'oklch(0.96 0.01 335.69)', '--primary': 'oklch(0.55 0.20 290)', '--primary-foreground': 'oklch(1.00 0 0)', '--secondary': 'oklch(0.49 0.04 300.23)', '--border': 'oklch(0.83 0.02 308.26)', '--sidebar': 'oklch(0.99 0 0)', '--sidebar-foreground': 'oklch(0.15 0 0)', '--sidebar-border': 'oklch(0.90 0 0)'
    },
    dark: { 
      '--background': 'oklch(0.15 0.01 317.69)', '--foreground': 'oklch(0.95 0.01 321.50)', '--card': 'oklch(0.22 0.02 322.13)', '--primary': 'oklch(0.60 0.22 279.81)', '--primary-foreground': 'oklch(0.98 0.01 321.51)', '--secondary': 'oklch(0.45 0.03 294.79)', '--border': 'oklch(0.40 0.04 309.35)', '--sidebar': 'oklch(0.20 0.01 317.74)', '--sidebar-foreground': 'oklch(0.95 0.01 321.50)', '--sidebar-border': 'oklch(0.35 0.01 319.53 / 30%)'
    }
  },
  {
    id: "northern-lights", label: "Northern Lights", swatch: "oklch(0.6487 0.1538 150.3071)",
    light: {
      '--background': 'oklch(0.9824 0.0013 286.3757)', '--foreground': 'oklch(0.3211 0 0)', '--card': 'oklch(1.0000 0 0)', '--primary': 'oklch(0.6487 0.1538 150.3071)', '--primary-foreground': 'oklch(1.0000 0 0)', '--secondary': 'oklch(0.6746 0.1414 261.3380)', '--border': 'oklch(0.8699 0 0)'
    },
    dark: {
      '--background': 'oklch(0.2303 0.0125 264.2926)', '--foreground': 'oklch(0.9219 0 0)', '--card': 'oklch(0.3210 0.0078 223.6661)', '--primary': 'oklch(0.6487 0.1538 150.3071)', '--primary-foreground': 'oklch(1.0000 0 0)', '--secondary': 'oklch(0.5880 0.0993 245.7394)', '--border': 'oklch(0.3867 0 0)'
    }
  },
  {
    id: "amber-minimal", label: "Amber Minimal", swatch: "oklch(0.80 0.15 75)",
    light: {
      "--background": "oklch(0.99 0.01 80)", "--foreground": "oklch(0.20 0.05 70)", "--primary": "oklch(0.75 0.15 75)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.05 80)"
    },
    dark: {
      "--background": "oklch(0.12 0.02 70)", "--foreground": "oklch(0.95 0.02 75)", "--primary": "oklch(0.80 0.15 75)", "--primary-foreground": "oklch(0.10 0.05 75)", "--border": "oklch(0.25 0.05 70)"
    }
  },
  {
    id: "amethyst-haze", label: "Amethyst Haze", swatch: "oklch(0.60 0.15 295)",
    light: {
      "--background": "oklch(0.98 0.02 300)", "--foreground": "oklch(0.25 0.08 295)", "--primary": "oklch(0.60 0.15 295)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.05 300)"
    },
    dark: {
      "--background": "oklch(0.15 0.04 300)", "--foreground": "oklch(0.95 0.05 295)", "--primary": "oklch(0.65 0.15 295)", "--primary-foreground": "oklch(0.15 0.04 300)", "--border": "oklch(0.30 0.08 300)"
    }
  },
  {
    id: "art-deco", label: "Art Deco", swatch: "oklch(0.65 0.15 85)",
    light: {
      "--background": "oklch(0.99 0.02 90)", "--foreground": "oklch(0.20 0.05 85)", "--primary": "oklch(0.65 0.15 85)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.05 90)"
    },
    dark: {
      "--background": "oklch(0.15 0.03 85)", "--foreground": "oklch(0.98 0.03 90)", "--primary": "oklch(0.70 0.12 85)", "--primary-foreground": "oklch(0.15 0.03 85)", "--border": "oklch(0.30 0.05 85)"
    }
  },
  {
    id: "blue", label: "Blue", swatch: "oklch(0.63 0.17 250)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0.14 0.005 285.82)", "--primary": "oklch(0.63 0.17 250)", "--primary-foreground": "oklch(0.97 0.016 232.39)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.14 0.005 285.82)", "--foreground": "oklch(0.98 0 0)", "--primary": "oklch(0.63 0.17 250)", "--primary-foreground": "oklch(0.97 0.016 232.39)", "--border": "oklch(1.00 0 0 / 10%)"
    }
  },
  {
    id: "bold-tech", label: "Bold Tech", swatch: "oklch(0.10 0.01 250)",
    light: {
      "--background": "oklch(0.98 0.01 255)", "--foreground": "oklch(0.10 0.04 250)", "--primary": "oklch(0.10 0.01 250)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.85 0.02 255)"
    },
    dark: {
      "--background": "oklch(0.08 0.01 250)", "--foreground": "oklch(0.95 0.01 250)", "--primary": "oklch(0.98 0.01 255)", "--primary-foreground": "oklch(0.08 0.01 250)", "--border": "oklch(0.20 0.02 250)"
    }
  },
  {
    id: "bubblegum", label: "Bubblegum", swatch: "oklch(0.75 0.15 350)",
    light: {
      "--background": "oklch(0.99 0.05 350)", "--foreground": "oklch(0.35 0.15 350)", "--primary": "oklch(0.75 0.15 350)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.92 0.10 350)"
    },
    dark: {
      "--background": "oklch(0.20 0.08 350)", "--foreground": "oklch(0.95 0.10 350)", "--primary": "oklch(0.80 0.12 350)", "--primary-foreground": "oklch(0.20 0.08 350)", "--border": "oklch(0.35 0.10 350)"
    }
  },
  {
    id: "caffeine", label: "Caffeine", swatch: "oklch(0.45 0.06 60)",
    light: {
      "--background": "oklch(0.98 0.02 70)", "--foreground": "oklch(0.25 0.05 60)", "--primary": "oklch(0.45 0.06 60)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.88 0.04 70)"
    },
    dark: {
      "--background": "oklch(0.15 0.03 60)", "--foreground": "oklch(0.92 0.04 70)", "--primary": "oklch(0.55 0.06 60)", "--primary-foreground": "oklch(0.15 0.03 60)", "--border": "oklch(0.28 0.05 60)"
    }
  },
  {
    id: "candyland", label: "Candyland", swatch: "oklch(0.78 0.15 315)",
    light: {
      "--background": "oklch(0.99 0.05 320)", "--foreground": "oklch(0.35 0.12 315)", "--primary": "oklch(0.78 0.15 315)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.08 320)"
    },
    dark: {
      "--background": "oklch(0.18 0.05 315)", "--foreground": "oklch(0.95 0.08 315)", "--primary": "oklch(0.85 0.12 315)", "--primary-foreground": "oklch(0.18 0.05 315)", "--border": "oklch(0.32 0.08 315)"
    }
  },
  {
    id: "catppuccin", label: "Catppuccin Mocha", swatch: "oklch(0.80 0.10 270)",
    light: {
      "--background": "oklch(0.98 0.01 270)", "--foreground": "oklch(0.30 0.05 270)", "--primary": "oklch(0.75 0.10 270)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.92 0.02 270)"
    },
    dark: {
      "--background": "oklch(0.18 0.02 270)", "--foreground": "oklch(0.92 0.05 270)", "--primary": "oklch(0.85 0.10 270)", "--primary-foreground": "oklch(0.18 0.02 270)", "--border": "oklch(0.30 0.05 270)"
    }
  },
  {
    id: "claude", label: "Claude", swatch: "oklch(0.48 0.05 45)",
    light: {
      "--background": "oklch(0.98 0.01 45)", "--foreground": "oklch(0.20 0.04 45)", "--primary": "oklch(0.48 0.05 45)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.02 45)"
    },
    dark: {
      "--background": "oklch(0.15 0.02 45)", "--foreground": "oklch(0.95 0.02 45)", "--primary": "oklch(0.55 0.05 45)", "--primary-foreground": "oklch(0.15 0.02 45)", "--border": "oklch(0.28 0.04 45)"
    }
  },
  {
    id: "claymorphism", label: "Claymorphism", swatch: "oklch(0.90 0.05 240)",
    light: {
      "--background": "oklch(0.97 0.02 240)", "--foreground": "oklch(0.20 0.05 240)", "--primary": "oklch(0.90 0.05 240)", "--primary-foreground": "oklch(0.10 0.05 240)", "--border": "oklch(0.95 0 0)"
    },
    dark: {
      "--background": "oklch(0.12 0.05 240)", "--foreground": "oklch(0.95 0.05 240)", "--primary": "oklch(0.15 0.05 240)", "--primary-foreground": "oklch(0.95 0.05 240)", "--border": "oklch(0.20 0.05 240)"
    }
  },
  {
    id: "clean-slate", label: "Clean Slate", swatch: "oklch(0.95 0.01 240)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0.10 0 0)", "--primary": "oklch(0.95 0.01 240)", "--primary-foreground": "oklch(0.10 0 0)", "--border": "oklch(0.90 0 0)"
    },
    dark: {
      "--background": "oklch(0.05 0 0)", "--foreground": "oklch(0.95 0 0)", "--primary": "oklch(0.10 0 0)", "--primary-foreground": "oklch(0.95 0 0)", "--border": "oklch(0.15 0 0)"
    }
  },
  {
    id: "corporate", label: "Corporate", swatch: "oklch(0.45 0.15 245)",
    light: {
      "--background": "oklch(0.98 0.01 245)", "--foreground": "oklch(0.15 0.05 245)", "--primary": "oklch(0.45 0.15 245)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.88 0.02 245)"
    },
    dark: {
      "--background": "oklch(0.12 0.02 245)", "--foreground": "oklch(0.95 0.02 245)", "--primary": "oklch(0.55 0.12 245)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.25 0.04 245)"
    }
  },
  {
    id: "cosmic-night", label: "Cosmic Night", swatch: "oklch(0.25 0.05 285)",
    light: {
      "--background": "oklch(0.98 0.01 285)", "--foreground": "oklch(0.15 0.05 285)", "--primary": "oklch(0.25 0.05 285)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.85 0.02 285)"
    },
    dark: {
      "--background": "oklch(0.08 0.02 285)", "--foreground": "oklch(0.92 0.05 285)", "--primary": "oklch(0.98 0.02 285)", "--primary-foreground": "oklch(0.08 0.02 285)", "--border": "oklch(0.18 0.04 285)"
    }
  },
  {
    id: "cyberpunk", label: "Cyberpunk", swatch: "oklch(0.60 0.30 15)",
    light: {
      "--background": "oklch(0.98 0.01 15)", "--foreground": "oklch(0.15 0.05 15)", "--primary": "oklch(0.60 0.30 15)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.85 0.05 15)"
    },
    dark: {
      "--background": "oklch(0.12 0.02 15)", "--foreground": "oklch(0.95 0.25 15)", "--primary": "oklch(0.70 0.30 350)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.20 0.05 15)"
    }
  },
  {
    id: "darkmatter", label: "Darkmatter", swatch: "oklch(0.10 0 0)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0 0 0)", "--primary": "oklch(0.10 0 0)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0 0)"
    },
    dark: {
      "--background": "oklch(0 0 0)", "--foreground": "oklch(1.00 0 0)", "--primary": "oklch(1.00 0 0)", "--primary-foreground": "oklch(0 0 0)", "--border": "oklch(0.15 0 0)"
    }
  },
  {
    id: "doom-64", label: "Doom 64", swatch: "oklch(0.40 0.20 25)",
    light: {
      "--background": "oklch(0.90 0.05 25)", "--foreground": "oklch(0.15 0.10 25)", "--primary": "oklch(0.40 0.20 25)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.80 0.10 25)"
    },
    dark: {
      "--background": "oklch(0.08 0.05 25)", "--foreground": "oklch(0.85 0.20 25)", "--primary": "oklch(0.50 0.25 25)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.15 0.10 25)"
    }
  },
  {
    id: "elegant-luxury", label: "Elegant Luxury", swatch: "oklch(0.35 0.05 85)",
    light: {
      "--background": "oklch(0.97 0.01 85)", "--foreground": "oklch(0.25 0.04 85)", "--primary": "oklch(0.35 0.05 85)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.92 0.02 85)"
    },
    dark: {
      "--background": "oklch(0.10 0.02 85)", "--foreground": "oklch(0.92 0.04 85)", "--primary": "oklch(0.85 0.08 85)", "--primary-foreground": "oklch(0.10 0.02 85)", "--border": "oklch(0.20 0.04 85)"
    }
  },
  {
    id: "ghibli-studio", label: "Studio Ghibli", swatch: "oklch(0.70 0.15 200)",
    light: {
      "--background": "oklch(0.98 0.05 200)", "--foreground": "oklch(0.30 0.10 210)", "--primary": "oklch(0.70 0.15 200)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.05 200)"
    },
    dark: {
      "--background": "oklch(0.15 0.05 210)", "--foreground": "oklch(0.95 0.10 200)", "--primary": "oklch(0.75 0.15 200)", "--primary-foreground": "oklch(0.15 0.05 210)", "--border": "oklch(0.25 0.10 210)"
    }
  },
  {
    id: "graphite", label: "Graphite", swatch: "oklch(0.35 0.01 270)",
    light: {
      "--background": "oklch(0.98 0 0)", "--foreground": "oklch(0.15 0.01 270)", "--primary": "oklch(0.35 0.01 270)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0 0)"
    },
    dark: {
      "--background": "oklch(0.12 0.01 270)", "--foreground": "oklch(0.95 0 0)", "--primary": "oklch(0.45 0.01 270)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.25 0.01 270)"
    }
  },
  {
    id: "green", label: "Green", swatch: "oklch(0.68 0.19 145)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0.14 0.005 285.82)", "--primary": "oklch(0.68 0.19 145)", "--primary-foreground": "oklch(0.98 0.01 161.73)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.14 0.005 285.82)", "--foreground": "oklch(0.98 0 0)", "--primary": "oklch(0.68 0.19 145)", "--primary-foreground": "oklch(0.98 0.01 161.73)", "--border": "oklch(1.00 0 0 / 10%)"
    }
  },
  {
    id: "kodama-grove", label: "Kodama Grove", swatch: "oklch(0.60 0.12 150)",
    light: {
      "--background": "oklch(0.98 0.02 150)", "--foreground": "oklch(0.20 0.05 150)", "--primary": "oklch(0.60 0.12 150)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.05 150)"
    },
    dark: {
      "--background": "oklch(0.12 0.04 150)", "--foreground": "oklch(0.92 0.05 150)", "--primary": "oklch(0.70 0.10 150)", "--primary-foreground": "oklch(0.12 0.04 150)", "--border": "oklch(0.25 0.05 150)"
    }
  },
  {
    id: "marshmallow", label: "Marshmallow", swatch: "oklch(0.95 0.02 330)",
    light: {
      "--background": "oklch(0.99 0.01 330)", "--foreground": "oklch(0.40 0.05 330)", "--primary": "oklch(0.95 0.02 330)", "--primary-foreground": "oklch(0.40 0.05 330)", "--border": "oklch(0.95 0.01 330)"
    },
    dark: {
      "--background": "oklch(0.25 0.02 330)", "--foreground": "oklch(0.98 0.02 330)", "--primary": "oklch(0.30 0.02 330)", "--primary-foreground": "oklch(0.98 0.02 330)", "--border": "oklch(0.35 0.02 330)"
    }
  },
  {
    id: "marvel", label: "Marvel", swatch: "oklch(0.55 0.25 25)",
    light: {
      "--background": "oklch(0.98 0.01 25)", "--foreground": "oklch(0.15 0.10 25)", "--primary": "oklch(0.55 0.25 25)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.85 0.10 25)"
    },
    dark: {
      "--background": "oklch(0.12 0.05 25)", "--foreground": "oklch(0.95 0.10 25)", "--primary": "oklch(0.60 0.30 25)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.25 0.10 25)"
    }
  },
  {
    id: "midnight-bloom", label: "Midnight Bloom", swatch: "oklch(0.20 0.05 280)",
    light: {
      "--background": "oklch(0.98 0.01 280)", "--foreground": "oklch(0.15 0.05 280)", "--primary": "oklch(0.20 0.05 280)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.02 280)"
    },
    dark: {
      "--background": "oklch(0.08 0.02 280)", "--foreground": "oklch(0.95 0.05 280)", "--primary": "oklch(0.98 0.02 280)", "--primary-foreground": "oklch(0.08 0.02 280)", "--border": "oklch(0.20 0.04 280)"
    }
  },
  {
    id: "mocha-mousse", label: "Mocha Mousse", swatch: "oklch(0.40 0.05 50)",
    light: {
      "--background": "oklch(0.98 0.01 50)", "--foreground": "oklch(0.25 0.04 50)", "--primary": "oklch(0.40 0.05 50)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.02 50)"
    },
    dark: {
      "--background": "oklch(0.15 0.02 50)", "--foreground": "oklch(0.92 0.04 50)", "--primary": "oklch(0.50 0.05 50)", "--primary-foreground": "oklch(0.15 0.02 50)", "--border": "oklch(0.25 0.04 50)"
    }
  },
  {
    id: "modern-minimal", label: "Modern Minimal", swatch: "oklch(0.15 0 0)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0.15 0 0)", "--primary": "oklch(0.15 0 0)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.92 0 0)"
    },
    dark: {
      "--background": "oklch(0.10 0 0)", "--foreground": "oklch(0.95 0 0)", "--primary": "oklch(0.95 0 0)", "--primary-foreground": "oklch(0.10 0 0)", "--border": "oklch(0.20 0 0)"
    }
  },
  {
    id: "mono", label: "Mono", swatch: "oklch(0 0 0)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0 0 0)", "--primary": "oklch(0 0 0)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0 0)"
    },
    dark: {
      "--background": "oklch(0 0 0)", "--foreground": "oklch(1.00 0 0)", "--primary": "oklch(1.00 0 0)", "--primary-foreground": "oklch(0 0 0)", "--border": "oklch(0.15 0 0)"
    }
  },
  {
    id: "nature", label: "Nature", swatch: "oklch(0.62 0.15 140)",
    light: {
      "--background": "oklch(0.98 0.02 140)", "--foreground": "oklch(0.20 0.05 140)", "--primary": "oklch(0.62 0.15 140)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.90 0.05 140)"
    },
    dark: {
      "--background": "oklch(0.12 0.04 140)", "--foreground": "oklch(0.92 0.05 140)", "--primary": "oklch(0.70 0.12 140)", "--primary-foreground": "oklch(0.12 0.04 140)", "--border": "oklch(0.25 0.05 140)"
    }
  },
  {
    id: "neo-brutalism", label: "Neo Brutalism", swatch: "oklch(0.65 0.24 26.97)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0 0 0)", "--primary": "oklch(0.65 0.24 26.97)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0 0 0)"
    },
    dark: {
      "--background": "oklch(0 0 0)", "--foreground": "oklch(1.00 0 0)", "--primary": "oklch(0.70 0.19 23.19)", "--primary-foreground": "oklch(0 0 0)", "--border": "oklch(1.00 0 0)"
    }
  },
  {
    id: "northern-lights", label: "Northern Lights", swatch: "oklch(0.6487 0.1538 150.3071)",
    light: {
      "--background": "oklch(0.9824 0.0013 286.3757)", "--foreground": "oklch(0.3211 0 0)", "--primary": "oklch(0.6487 0.1538 150.3071)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.8699 0 0)"
    },
    dark: {
      "--background": "oklch(0.2303 0.0125 264.2926)", "--foreground": "oklch(0.9219 0 0)", "--primary": "oklch(0.6487 0.1538 150.3071)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.3867 0 0)"
    }
  },
  {
    id: "notebook", label: "Notebook", swatch: "oklch(0.4891 0 0)",
    light: {
      "--background": "oklch(0.9821 0 0)", "--foreground": "oklch(0.3485 0 0)", "--primary": "oklch(0.4891 0 0)", "--primary-foreground": "oklch(0.9551 0 0)", "--border": "oklch(0.5538 0.0025 17.2320)"
    },
    dark: {
      "--background": "oklch(0.2891 0 0)", "--foreground": "oklch(0.8945 0 0)", "--primary": "oklch(0.7572 0 0)", "--primary-foreground": "oklch(0.2891 0 0)", "--border": "oklch(0.4276 0 0)"
    }
  },
  {
    id: "ocean-breeze", label: "Ocean Breeze", swatch: "oklch(0.7227 0.1920 149.5793)",
    light: {
      "--background": "oklch(0.9751 0.0127 244.2507)", "--foreground": "oklch(0.3729 0.0306 259.7328)", "--primary": "oklch(0.7227 0.1920 149.5793)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.9276 0.0058 264.5313)"
    },
    dark: {
      "--background": "oklch(0.2077 0.0398 265.7549)", "--foreground": "oklch(0.8717 0.0093 258.3382)", "--primary": "oklch(0.7729 0.1535 163.2231)", "--primary-foreground": "oklch(0.2077 0.0398 265.7549)", "--border": "oklch(0.4461 0.0263 256.8018)"
    }
  },
  {
    id: "orange", label: "Orange", swatch: "oklch(0.705 0.213 47.604)",
    light: {
      "--background": "oklch(1 0 0)", "--foreground": "oklch(0.141 0.005 285.823)", "--primary": "oklch(0.705 0.213 47.604)", "--primary-foreground": "oklch(0.98 0.016 73.684)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.141 0.005 285.823)", "--foreground": "oklch(0.985 0 0)", "--primary": "oklch(0.646 0.222 41.116)", "--primary-foreground": "oklch(0.98 0.016 73.684)", "--border": "oklch(1 0 0 / 10%)"
    }
  },
  {
    id: "pastel-dreams", label: "Pastel Dreams", swatch: "oklch(0.71 0.16 293.54)",
    light: {
      "--background": "oklch(0.97 0.01 314.78)", "--foreground": "oklch(0.37 0.03 259.73)", "--primary": "oklch(0.71 0.16 293.54)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.91 0.05 306.09)"
    },
    dark: {
      "--background": "oklch(0.22 0.01 56.04)", "--foreground": "oklch(0.93 0.03 272.79)", "--primary": "oklch(0.79 0.12 295.75)", "--primary-foreground": "oklch(0.22 0.01 56.04)", "--border": "oklch(0.34 0.04 308.85)"
    }
  },
  {
    id: "perpetuity", label: "Perpetuity", swatch: "oklch(0.5624 0.0947 203.2755)",
    light: {
      "--background": "oklch(0.9491 0.0085 197.0126)", "--foreground": "oklch(0.3772 0.0619 212.6640)", "--primary": "oklch(0.5624 0.0947 203.2755)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.8931 0.0205 204.4136)"
    },
    dark: {
      "--background": "oklch(0.2068 0.0247 224.4533)", "--foreground": "oklch(0.8520 0.1269 195.0354)", "--primary": "oklch(0.8520 0.1269 195.0354)", "--primary-foreground": "oklch(0.2068 0.0247 224.4533)", "--border": "oklch(0.3775 0.0564 216.5010)"
    }
  },
  {
    id: "quantum-rose", label: "Quantum Rose", swatch: "oklch(0.6002 0.2414 0.1348)",
    light: {
      "--background": "oklch(0.9692 0.0192 343.9344)", "--foreground": "oklch(0.4426 0.1653 352.3762)", "--primary": "oklch(0.6002 0.2414 0.1348)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.8881 0.0747 344.3866)"
    },
    dark: {
      "--background": "oklch(0.1808 0.0535 313.7159)", "--foreground": "oklch(0.8624 0.1307 326.6356)", "--primary": "oklch(0.7543 0.2319 332.0212)", "--primary-foreground": "oklch(0.1608 0.0493 327.5673)", "--border": "oklch(0.3280 0.1202 313.5393)"
    }
  },
  {
    id: "red", label: "Red", swatch: "oklch(0.637 0.237 25.331)",
    light: {
      "--background": "oklch(1 0 0)", "--foreground": "oklch(0.141 0.005 285.823)", "--primary": "oklch(0.637 0.237 25.331)", "--primary-foreground": "oklch(0.971 0.013 17.38)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.141 0.005 285.823)", "--foreground": "oklch(0.985 0 0)", "--primary": "oklch(0.637 0.237 25.331)", "--primary-foreground": "oklch(0.971 0.013 17.38)", "--border": "oklch(1 0 0 / 10%)"
    }
  },
  {
    id: "retro-arcade", label: "Retro Arcade", swatch: "oklch(0.5924 0.2025 355.8943)",
    light: {
      "--background": "oklch(0.9735 0.0261 90.0953)", "--foreground": "oklch(0.3092 0.0518 219.6516)", "--primary": "oklch(0.5924 0.2025 355.8943)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.6537 0.0197 205.2618)"
    },
    dark: {
      "--background": "oklch(0.2673 0.0486 219.8169)", "--foreground": "oklch(0.6979 0.0159 196.7940)", "--primary": "oklch(0.5924 0.2025 355.8943)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.5230 0.0283 219.1365)"
    }
  },
  {
    id: "rose", label: "Rose", swatch: "oklch(0.645 0.246 16.439)",
    light: {
      "--background": "oklch(1 0 0)", "--foreground": "oklch(0.141 0.005 285.823)", "--primary": "oklch(0.645 0.246 16.439)", "--primary-foreground": "oklch(0.969 0.015 12.422)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.141 0.005 285.823)", "--foreground": "oklch(0.985 0 0)", "--primary": "oklch(0.645 0.246 16.439)", "--primary-foreground": "oklch(0.969 0.015 12.422)", "--border": "oklch(1 0 0 / 10%)"
    }
  },
  {
    id: "slack", label: "Slack", swatch: "oklch(0.37 0.14 323.23)",
    light: {
      "--background": "oklch(1.00 0 0)", "--foreground": "oklch(0.23 0.00 325.86)", "--primary": "oklch(0.37 0.14 323.23)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.91 0 0)"
    },
    dark: {
      "--background": "oklch(0.23 0.01 255.60)", "--foreground": "oklch(0.93 0 0)", "--primary": "oklch(0.58 0.14 327.21)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.30 0.01 268.37)"
    }
  },
  {
    id: "soft-pop", label: "Soft Pop", swatch: "oklch(0.5106 0.2301 276.9656)",
    light: {
      "--background": "oklch(0.9789 0.0082 121.6272)", "--foreground": "oklch(0 0 0)", "--primary": "oklch(0.5106 0.2301 276.9656)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0 0 0)"
    },
    dark: {
      "--background": "oklch(0 0 0)", "--foreground": "oklch(1.0000 0 0)", "--primary": "oklch(0.6801 0.1583 276.9349)", "--primary-foreground": "oklch(0 0 0)", "--border": "oklch(0.4459 0 0)"
    }
  },
  {
    id: "solar-dusk", label: "Solar Dusk", swatch: "oklch(0.5553 0.1455 48.9975)",
    light: {
      "--background": "oklch(0.9885 0.0057 84.5659)", "--foreground": "oklch(0.3660 0.0251 49.6085)", "--primary": "oklch(0.5553 0.1455 48.9975)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.8866 0.0404 89.6994)"
    },
    dark: {
      "--background": "oklch(0.2161 0.0061 56.0434)", "--foreground": "oklch(0.9699 0.0013 106.4238)", "--primary": "oklch(0.7049 0.1867 47.6044)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.3741 0.0087 67.5582)"
    }
  },
  {
    id: "spotify", label: "Spotify", swatch: "oklch(0.67 0.17 153.85)",
    light: {
      "--background": "oklch(0.99 0 0)", "--foreground": "oklch(0.35 0.02 165.48)", "--primary": "oklch(0.67 0.17 153.85)", "--primary-foreground": "oklch(0.99 0.02 169.99)", "--border": "oklch(0.94 0.01 238.46)"
    },
    dark: {
      "--background": "oklch(0.15 0.02 269.18)", "--foreground": "oklch(0.95 0.01 238.46)", "--primary": "oklch(0.67 0.17 153.85)", "--primary-foreground": "oklch(0.15 0.02 269.18)", "--border": "oklch(0.95 0.01 238.46 / 15%)"
    }
  },
  {
    id: "starry-night", label: "Starry Night", swatch: "oklch(0.4815 0.1178 263.3758)",
    light: {
      "--background": "oklch(0.9755 0.0045 258.3245)", "--foreground": "oklch(0.2558 0.0433 268.0662)", "--primary": "oklch(0.4815 0.1178 263.3758)", "--primary-foreground": "oklch(0.9856 0.0278 98.0540)", "--border": "oklch(0.7791 0.0156 251.1926)"
    },
    dark: {
      "--background": "oklch(0.2204 0.0198 275.8439)", "--foreground": "oklch(0.9366 0.0129 266.6974)", "--primary": "oklch(0.4815 0.1178 263.3758)", "--primary-foreground": "oklch(0.9097 0.1440 95.1120)", "--border": "oklch(0.3072 0.0287 281.7681)"
    }
  },
  {
    id: "summer", label: "Summer", swatch: "oklch(0.70 0.17 28.12)",
    light: {
      "--background": "oklch(0.98 0.01 78.24)", "--foreground": "oklch(0.38 0.02 64.34)", "--primary": "oklch(0.70 0.17 28.12)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.87 0.08 65.91)"
    },
    dark: {
      "--background": "oklch(0.26 0.02 60.79)", "--foreground": "oklch(0.87 0.08 65.91)", "--primary": "oklch(0.70 0.17 28.12)", "--primary-foreground": "oklch(1.00 0 0)", "--border": "oklch(0.45 0.05 59.00)"
    }
  },
  {
    id: "sunset-horizon", label: "Sunset Horizon", swatch: "oklch(0.7357 0.1641 34.7091)",
    light: {
      "--background": "oklch(0.9856 0.0084 56.3169)", "--foreground": "oklch(0.3353 0.0132 2.7676)", "--primary": "oklch(0.7357 0.1641 34.7091)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.9296 0.0370 38.6868)"
    },
    dark: {
      "--background": "oklch(0.2569 0.0169 352.4042)", "--foreground": "oklch(0.9397 0.0119 51.3156)", "--primary": "oklch(0.7357 0.1641 34.7091)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.3637 0.0203 342.2664)"
    }
  },
  {
    id: "supabase", label: "Supabase", swatch: "oklch(0.8348 0.1302 160.9080)",
    light: {
      "--background": "oklch(0.9911 0 0)", "--foreground": "oklch(0.2046 0 0)", "--primary": "oklch(0.8348 0.1302 160.9080)", "--primary-foreground": "oklch(0.2626 0.0147 166.4589)", "--border": "oklch(0.9037 0 0)"
    },
    dark: {
      "--background": "oklch(0.1822 0 0)", "--foreground": "oklch(0.9288 0.0126 255.5078)", "--primary": "oklch(0.4365 0.1044 156.7556)", "--primary-foreground": "oklch(0.9213 0.0135 167.1556)", "--border": "oklch(0.2809 0 0)"
    }
  },
  {
    id: "t3-chat", label: "T3 Chat", swatch: "oklch(0.5316 0.1409 355.1999)",
    light: {
      "--background": "oklch(0.9754 0.0084 325.6414)", "--foreground": "oklch(0.3257 0.1161 325.0372)", "--primary": "oklch(0.5316 0.1409 355.1999)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.8568 0.0829 328.9110)"
    },
    dark: {
      "--background": "oklch(0.2409 0.0201 307.5346)", "--foreground": "oklch(0.8398 0.0387 309.5391)", "--primary": "oklch(0.4607 0.1853 4.0994)", "--primary-foreground": "oklch(0.8560 0.0618 346.3684)", "--border": "oklch(0.3286 0.0154 343.4461)"
    }
  },
  {
    id: "tangerine", label: "Tangerine", swatch: "oklch(0.6397 0.1720 36.4421)",
    light: {
      "--background": "oklch(0.9383 0.0042 236.4993)", "--foreground": "oklch(0.3211 0 0)", "--primary": "oklch(0.6397 0.1720 36.4421)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.9022 0.0052 247.8822)"
    },
    dark: {
      "--background": "oklch(0.2598 0.0306 262.6666)", "--foreground": "oklch(0.9219 0 0)", "--primary": "oklch(0.6397 0.1720 36.4421)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.3843 0.0301 269.7337)"
    }
  },
  {
    id: "twitter", label: "Twitter", swatch: "oklch(0.6723 0.1606 244.9955)",
    light: {
      "--background": "oklch(1.0000 0 0)", "--foreground": "oklch(0.1884 0.0128 248.5103)", "--primary": "oklch(0.6723 0.1606 244.9955)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.9317 0.0118 231.6594)"
    },
    dark: {
      "--background": "oklch(0 0 0)", "--foreground": "oklch(0.9328 0.0025 228.7857)", "--primary": "oklch(0.6692 0.1607 245.0110)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.2674 0.0047 248.0045)"
    }
  },
  {
    id: "valorant", label: "Valorant", swatch: "oklch(0.67 0.22 21.34)",
    light: {
      "--background": "oklch(0.97 0.02 12.78)", "--foreground": "oklch(0.24 0.07 17.81)", "--primary": "oklch(0.67 0.22 21.34)", "--primary-foreground": "oklch(0.99 0.00 359.99)", "--border": "oklch(0.91 0.05 11.40)"
    },
    dark: {
      "--background": "oklch(0.16 0.03 17.48)", "--foreground": "oklch(0.99 0.00 359.99)", "--primary": "oklch(0.67 0.22 21.34)", "--primary-foreground": "oklch(0.99 0.00 359.99)", "--border": "oklch(0.31 0.09 19.80)"
    }
  },
  {
    id: "vercel", label: "Vercel", swatch: "oklch(0 0 0)",
    light: {
      "--background": "oklch(0.9900 0 0)", "--foreground": "oklch(0 0 0)", "--primary": "oklch(0 0 0)", "--primary-foreground": "oklch(1 0 0)", "--border": "oklch(0.9200 0 0)"
    },
    dark: {
      "--background": "oklch(0 0 0)", "--foreground": "oklch(1 0 0)", "--primary": "oklch(1 0 0)", "--primary-foreground": "oklch(0 0 0)", "--border": "oklch(0.2600 0 0)"
    }
  },
  {
    id: "vintage-paper", label: "Vintage Paper", swatch: "oklch(0.6180 0.0778 65.5444)",
    light: {
      "--background": "oklch(0.9582 0.0152 90.2357)", "--foreground": "oklch(0.3760 0.0225 64.3434)", "--primary": "oklch(0.6180 0.0778 65.5444)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.8606 0.0321 84.5881)"
    },
    dark: {
      "--background": "oklch(0.2747 0.0139 57.6523)", "--foreground": "oklch(0.9239 0.0190 83.0636)", "--primary": "oklch(0.7264 0.0581 66.6967)", "--primary-foreground": "oklch(0.2747 0.0139 57.6523)", "--border": "oklch(0.3795 0.0181 57.1280)"
    }
  },
  {
    id: "violet", label: "Violet", swatch: "oklch(0.606 0.25 292.717)",
    light: {
      "--background": "oklch(1 0 0)", "--foreground": "oklch(0.141 0.005 285.823)", "--primary": "oklch(0.606 0.25 292.717)", "--primary-foreground": "oklch(0.969 0.016 293.756)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.141 0.005 285.823)", "--foreground": "oklch(0.985 0 0)", "--primary": "oklch(0.541 0.281 293.009)", "--primary-foreground": "oklch(0.969 0.016 293.756)", "--border": "oklch(1 0 0 / 10%)"
    }
  },
  {
    id: "violet-bloom", label: "Violet Bloom", swatch: "oklch(0.5393 0.2713 286.7462)",
    light: {
      "--background": "oklch(0.9940 0 0)", "--foreground": "oklch(0 0 0)", "--primary": "oklch(0.5393 0.2713 286.7462)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.9300 0.0094 286.2156)"
    },
    dark: {
      "--background": "oklch(0.2223 0.0060 271.1393)", "--foreground": "oklch(0.9551 0 0)", "--primary": "oklch(0.6132 0.2294 291.7437)", "--primary-foreground": "oklch(1.0000 0 0)", "--border": "oklch(0.3289 0.0092 268.3843)"
    }
  },
  {
    id: "vs-code", label: "VS Code", swatch: "oklch(0.71 0.15 239.07)",
    light: {
      "--background": "oklch(0.97 0.02 225.66)", "--foreground": "oklch(0.15 0.02 269.18)", "--primary": "oklch(0.71 0.15 239.07)", "--primary-foreground": "oklch(0.94 0.03 232.39)", "--border": "oklch(0.82 0.02 240.77)"
    },
    dark: {
      "--background": "oklch(0.18 0.02 271.27)", "--foreground": "oklch(0.90 0.01 238.47)", "--primary": "oklch(0.71 0.15 239.07)", "--primary-foreground": "oklch(0.94 0.03 232.39)", "--border": "oklch(0.90 0.01 238.47 / 15%)"
    }
  },
  {
    id: "yellow", label: "Yellow", swatch: "oklch(0.795 0.184 86.047)",
    light: {
      "--background": "oklch(1 0 0)", "--foreground": "oklch(0.141 0.005 285.823)", "--primary": "oklch(0.795 0.184 86.047)", "--primary-foreground": "oklch(0.421 0.095 57.708)", "--border": "oklch(0.92 0.004 286.32)"
    },
    dark: {
      "--background": "oklch(0.141 0.005 285.823)", "--foreground": "oklch(0.985 0 0)", "--primary": "oklch(0.795 0.184 86.047)", "--primary-foreground": "oklch(0.421 0.095 57.708)", "--border": "oklch(1 0 0 / 10%)"
    }
  }
];
