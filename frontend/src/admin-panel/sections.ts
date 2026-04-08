/**
 * Section registry for the unified Admin Panel.
 *
 * Settings, Admin, and Dev Tools are no longer separate pages — they
 * are nav groups inside one panel. Each entry below appears as one
 * link in the left rail and renders one self-contained pane.
 */
import {
  Cpu, Sparkles, Volume2, Puzzle, Palette,
  Users, Shield, Brain, AlertTriangle,
  ScrollText, Wrench,
} from 'lucide-react';

export type SectionId =
  | 'general' | 'characters' | 'audio' | 'skills' | 'appearance'
  | 'users' | 'character-catalog' | 'controls' | 'memory' | 'danger'
  | 'logs' | 'tools';

export interface SectionDef {
  id: SectionId;
  label: string;
  group: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
  adminOnly?: boolean;
  /** Section requires the 15-min admin password challenge before rendering. */
  requiresChallenge?: boolean;
}

export const SECTIONS: SectionDef[] = [
  // ── Personalization ────────────────────────────────────────────
  { id: 'general',     group: 'Personalization', label: 'Platform & Models', icon: Cpu,
    title: 'Platform & Models', description: 'Detected runtime and the models powering your assistant.' },
  { id: 'characters',  group: 'Personalization', label: 'Characters',        icon: Sparkles,
    title: 'Characters', description: 'Pick the personality your assistant wears in chat.' },
  { id: 'audio',       group: 'Personalization', label: 'Audio',             icon: Volume2,
    title: 'Audio Intelligence', description: 'Voice synthesis and speech-to-text settings.' },
  { id: 'skills',      group: 'Personalization', label: 'Skills',            icon: Puzzle,
    title: 'Skills', description: 'Enable, disable, and configure each skill in the catalog.' },
  { id: 'appearance',  group: 'Personalization', label: 'Appearance',        icon: Palette,
    title: 'Appearance', description: 'Theme palette and surface styling.' },

  // ── Permissions ────────────────────────────────────────────────
  { id: 'users',             group: 'Permissions', label: 'Users',             icon: Users,
    title: 'Users & Requests', description: 'Manage user accounts, roles, and access.',
    adminOnly: true, requiresChallenge: true },
  { id: 'character-catalog', group: 'Permissions', label: 'Character Catalog', icon: Sparkles,
    title: 'Character Catalog', description: 'Two-tier character library and per-user access.',
    adminOnly: true, requiresChallenge: true },
  { id: 'controls',          group: 'Permissions', label: 'Admin Controls',    icon: Shield,
    title: 'Admin Controls', description: 'Tier-1 prompt that overrides every other rule.',
    adminOnly: true, requiresChallenge: true },
  { id: 'memory',            group: 'Permissions', label: 'Memory Inspector',  icon: Brain,
    title: 'Memory Inspector', description: 'Audit and edit per-user people and facts.',
    adminOnly: true, requiresChallenge: true },

  // ── Danger ─────────────────────────────────────────────────────
  { id: 'danger', group: 'Danger', label: 'Reset Memory', icon: AlertTriangle,
    title: 'Danger Zone', description: 'Destructive operations that cannot be undone.',
    adminOnly: true, requiresChallenge: true },

  // ── Developer ──────────────────────────────────────────────────
  { id: 'logs',  group: 'Developer', label: 'Backend Logs', icon: ScrollText,
    title: 'Backend Logs', description: 'Live tail of the FastAPI log ring buffer.',
    adminOnly: true, requiresChallenge: true },
  { id: 'tools', group: 'Developer', label: 'Tools',        icon: Wrench,
    title: 'Developer Tools', description: 'Internal tooling and diagnostics.',
    adminOnly: true, requiresChallenge: true },
];

export const SECTION_GROUPS = ['Personalization', 'Permissions', 'Danger', 'Developer'] as const;

export const findSection = (id: string | undefined): SectionDef => {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
};
