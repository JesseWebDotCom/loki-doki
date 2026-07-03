// About & Licenses tab, satisfies CC-BY, CC-BY-SA, ODbL, and amCharts CC-BY 4.0
// attribution obligations with the minimum required surface area.

import { Card } from '@/components/ui/card'

const LICENSES: Array<{
  name: string
  note: string
  url: string
  license: string
}> = [
  // ── Maps ─────────────────────────────────────────────────────────────────────
  {
    name: 'OpenStreetMap',
    note: 'Map data powering all offline maps',
    url: 'https://www.openstreetmap.org/copyright',
    license: 'ODbL 1.0, © OpenStreetMap contributors',
  },
  {
    name: 'Geofabrik',
    note: 'Regional OSM data extracts',
    url: 'https://www.geofabrik.de/',
    license: 'ODbL 1.0 (derived from OpenStreetMap)',
  },
  {
    name: 'Natural Earth',
    note: 'Country and state boundary data',
    url: 'https://www.naturalearthdata.com/',
    license: 'Public Domain',
  },
  // ── Offline library ───────────────────────────────────────────────────────────
  {
    name: 'Wikipedia',
    note: 'Offline encyclopedia',
    url: 'https://en.wikipedia.org/',
    license: 'CC-BY-SA 4.0, Wikimedia Foundation',
  },
  {
    name: 'Wiktionary',
    note: 'Offline dictionary and thesaurus',
    url: 'https://en.wiktionary.org/',
    license: 'CC-BY-SA 4.0, Wikimedia Foundation',
  },
  {
    name: 'Wikivoyage',
    note: 'Offline travel guide',
    url: 'https://en.wikivoyage.org/',
    license: 'CC-BY-SA 4.0, Wikimedia Foundation',
  },
  {
    name: 'Wikiquote',
    note: 'Offline quotations',
    url: 'https://en.wikiquote.org/',
    license: 'CC-BY-SA 4.0, Wikimedia Foundation',
  },
  {
    name: 'Wikinews',
    note: 'Offline news archive',
    url: 'https://en.wikinews.org/',
    license: 'CC-BY-SA 4.0, Wikimedia Foundation',
  },
  {
    name: 'Wikiversity',
    note: 'Offline learning resources',
    url: 'https://en.wikiversity.org/',
    license: 'CC-BY-SA 4.0, Wikimedia Foundation',
  },
  {
    name: 'Stack Exchange / Stack Overflow',
    note: 'Offline Q&A (all Stack Exchange sites)',
    url: 'https://stackexchange.com/',
    license: 'CC-BY-SA 4.0',
  },
  {
    name: 'iFixit',
    note: 'Offline repair guides',
    url: 'https://www.ifixit.com/',
    license: 'CC-BY-SA 3.0',
  },
  {
    name: 'Khan Academy',
    note: 'Offline educational videos',
    url: 'https://www.khanacademy.org/',
    license: 'CC-BY-NC-SA 4.0',
  },
  {
    name: 'Arch Linux Wiki, Alpine Linux Wiki',
    note: 'Offline Linux documentation',
    url: 'https://wiki.archlinux.org/',
    license: 'CC-BY-SA 3.0',
  },
  {
    name: 'MDN Web Docs',
    note: 'Offline JavaScript/CSS/HTML reference',
    url: 'https://developer.mozilla.org/',
    license: 'CC-BY-SA 2.5',
  },
  // ── Character avatars ─────────────────────────────────────────────────────────
  {
    name: 'DiceBear Avataaars',
    note: 'Character avatar illustrations',
    url: 'https://avataaars.com/',
    license: 'Free for personal and commercial use, Pablo Stanley',
  },
  {
    name: 'DiceBear Bottts',
    note: 'Robot avatar illustrations',
    url: 'https://bottts.com/',
    license: 'Free for personal and commercial use, Pablo Stanley',
  },
  {
    name: 'DiceBear Toon Head',
    note: 'Toon character avatar illustrations',
    url: 'https://www.johanmelin.com/',
    license: 'CC-BY 4.0, © Johan Melin',
  },
  // ── UI assets ─────────────────────────────────────────────────────────────────
  {
    name: 'amCharts Weather Icons',
    note: 'Animated and static weather condition icons',
    url: 'https://www.amcharts.com/free-animated-svg-weather-icons/',
    license: 'CC-BY 4.0, © amCharts',
  },
  // ── AI models & runtimes ─────────────────────────────────────────────────────
  {
    name: 'Ollama',
    note: 'Local LLM runtime',
    url: 'https://ollama.com/',
    license: 'MIT',
  },
  {
    name: 'Meta Llama 3.x',
    note: 'Language model',
    url: 'https://llama.meta.com/',
    license: 'Meta Llama 3 Community License',
  },
  {
    name: 'Google Gemma 3 / 4',
    note: 'Language model',
    url: 'https://ai.google.dev/gemma/',
    license: 'Gemma Terms of Use',
  },
  {
    name: 'IBM Granite 4',
    note: 'Routing model',
    url: 'https://github.com/ibm-granite/',
    license: 'Apache 2.0',
  },
  {
    name: 'ComfyUI',
    note: 'Image generation backend',
    url: 'https://github.com/comfyanonymous/ComfyUI',
    license: 'GPL 3.0',
  },
  {
    name: 'Kokoro TTS / Whisper STT / OpenWakeWord',
    note: 'Voice subsystem models',
    url: 'https://github.com/dscripka/openWakeWord',
    license: 'MIT / Apache 2.0',
  },
  {
    name: 'MapLibre GL JS',
    note: 'Map rendering',
    url: 'https://maplibre.org/',
    license: 'BSD 3-Clause',
  },
]

export function SettingsAboutTab() {
  return (
    <div className="space-y-6 pb-10">
      <div>
        <h2 className="text-title">About loki-doki</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A private, self-hosted AI companion. All processing runs locally on your device.
        </p>
      </div>

      <div>
        <h3 className="mb-3 text-section">Open-source & content licenses</h3>
        <p className="mb-4 text-caption text-muted-foreground">
          loki-doki is built on open-source software and open-licensed content. The following
          credits are required by their respective licenses.
        </p>
        <Card variant="surface" className="divide-y divide-border/50">
          {LICENSES.map((item) => (
            <div key={item.name} className="flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium underline-offset-2 hover:underline"
                >
                  {item.name}
                </a>
                <p className="text-caption text-muted-foreground">{item.note}</p>
              </div>
              <span className="shrink-0 text-right text-caption text-muted-foreground/70 sm:ml-4">
                {item.license}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}
