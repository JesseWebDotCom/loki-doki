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
  | 'users' | 'character-catalog' | 'controls' | 'memory' | 'admin-skills' | 'feedback' | 'danger'
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
  /** Lets visually dense panes use the full content width. */
  fullWidth?: boolean;
}

export const SECTIONS: SectionDef[] = [
  // ── Personalization ────────────────────────────────────────────
  { id: 'characters',  group: 'Personalization', label: 'Characters',        icon: Sparkles,
    title: 'Characters', description: 'Pick the personality your assistant wears in chat.' },
  { id: 'audio',       group: 'Personalization', label: 'Audio',             icon: Volume2,
    title: 'Audio Intelligence', description: 'Voice synthesis and speech-to-text settings.' },
  { id: 'skills',      group: 'Personalization', label: 'Skills',            icon: Puzzle,
    title: 'Skills', description: 'Enable, disable, and configure each skill in the catalog.' },
  { id: 'appearance',  group: 'Personalization', label: 'Appearance',        icon: Palette,
    title: 'Appearance', description: 'Theme palette and surface styling.', fullWidth: true },

  // ── Permissions ────────────────────────────────────────────────
  { id: 'general',           group: 'Permissions', label: 'System Info',       icon: Cpu,
    title: 'System Info', description: 'Runtime platform, Ollama version, and loaded models.',
    adminOnly: true, requiresChallenge: true },
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
  { id: 'admin-skills',      group: 'Permissions', label: 'Skills',            icon: Puzzle,
    title: 'Skills', description: 'Configure global credentials and run test prompts against any skill.',
    adminOnly: true, requiresChallenge: true },
  { id: 'feedback',          group: 'Permissions', label: 'Feedback Review',   icon: ScrollText,
    title: 'Feedback Review', description: 'Audit user feedback and pipeline traces across all users.',
    adminOnly: true, requiresChallenge: true, fullWidth: true },

  // ── Danger ─────────────────────────────────────────────────────
  { id: 'danger', group: 'Danger', label: 'Danger Zone', icon: AlertTriangle,
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
