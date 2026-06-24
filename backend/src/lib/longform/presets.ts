// Long-form "studio" presets — each tailors the planner's outline and section count.
// Ported from v2's StudioPreset set.

export interface StudioPreset {
  id: string
  label: string
  plannerPrompt: string
  defaultSectionCount: number
}

export const PRESETS: StudioPreset[] = [
  {
    id: 'briefing',
    label: 'Briefing',
    plannerPrompt: 'Plan a concise executive briefing. Sections should move from summary to key details to implications.',
    defaultSectionCount: 4,
  },
  {
    id: 'study_guide',
    label: 'Study Guide',
    plannerPrompt: 'Plan a study guide. Break the material into teachable topics, each building on the last, ending with a recap.',
    defaultSectionCount: 6,
  },
  {
    id: 'faq',
    label: 'FAQ',
    plannerPrompt: 'Plan an FAQ. Each section is a likely question; the body answers it directly from the sources.',
    defaultSectionCount: 6,
  },
  {
    id: 'timeline',
    label: 'Timeline',
    plannerPrompt: 'Plan a chronological timeline. Each section is a time period or milestone in order.',
    defaultSectionCount: 5,
  },
  {
    id: 'slide_outline',
    label: 'Slide Outline',
    plannerPrompt: 'Plan a slide deck outline. Each section is one slide: a punchy title and 3–5 bullet points.',
    defaultSectionCount: 6,
  },
]

export function findPreset(id: string | null | undefined): StudioPreset | null {
  return PRESETS.find((p) => p.id === id) ?? null
}
