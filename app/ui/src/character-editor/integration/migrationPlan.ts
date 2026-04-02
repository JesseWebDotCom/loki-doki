import {
  CHARACTER_PACKAGE_VERSION,
  EDITOR_REPLACEMENT_AREAS,
  RUNTIME_REPLACEMENT_AREAS,
  type RepositoryMigrationStatus,
} from '@/character-editor/integration/contracts';

export interface MigrationWorkstream {
  id: string;
  title: string;
  targetRepo: 'loki-doki' | 'loki-doki-characters' | 'both';
  summary: string;
  areas: string[];
}

export interface DecommissionGate {
  id: string;
  description: string;
}

export const ABSORPTION_WORKSTREAMS: MigrationWorkstream[] = [
  {
    id: 'runtime-replacement',
    title: 'Replace the existing LokiDoki character runtime',
    targetRepo: 'loki-doki',
    summary:
      'Port the renderer, state machine, voice streaming, reflexes, and kiosk behaviors into the existing LokiDoki character surfaces.',
    areas: RUNTIME_REPLACEMENT_AREAS,
  },
  {
    id: 'editor-embedding',
    title: 'Embed the editor/creator inside LokiDoki settings',
    targetRepo: 'loki-doki',
    summary:
      'Move the God-Mode editor into the permanent Settings > Characters experience without introducing a separate product identity.',
    areas: EDITOR_REPLACEMENT_AREAS,
  },
  {
    id: 'repository-migration',
    title: 'Migrate the character package format',
    targetRepo: 'both',
    summary:
      'Upgrade legacy character packages to the rigged manifest format required by the new runtime and block invalid packages.',
    areas: ['manifest_schema', 'rig_validation', 'legacy_audit', 'publish_pipeline'],
  },
  {
    id: 'publish-flow',
    title: 'Export from LokiDoki to loki-doki-characters',
    targetRepo: 'both',
    summary:
      'Create validated package export and pull-request publishing from LokiDoki into the shared repository.',
    areas: ['package_export', 'octokit_pr_creation', 'validation_feedback'],
  },
];

export const LAB_DECOMMISSION_GATES: DecommissionGate[] = [
  {
    id: 'runtime-parity',
    description: 'LokiDoki uses the migrated runtime in production-facing character surfaces.',
  },
  {
    id: 'editor-parity',
    description: 'Character editing, validation, and publishing are available inside LokiDoki settings.',
  },
  {
    id: 'repo-migration-complete',
    description: 'Legacy character packages are either migrated, blocked, or rebuilt against the new schema.',
  },
  {
    id: 'lab-not-required',
    description: 'No user or admin workflow depends on the standalone lab repo any longer.',
  },
];

export const PACKAGE_MIGRATION_POLICY: Record<RepositoryMigrationStatus, string> = {
  valid: 'Package satisfies the current schema and rig requirements.',
  migrated: 'Package was upgraded from the legacy format and now satisfies current requirements.',
  legacy_blocked: 'Package is legacy and cannot be installed into the new runtime until upgraded.',
  needs_manual_rebuild: 'Package cannot be safely upgraded automatically and must be rebuilt in the editor.',
};

export const MIGRATION_BASELINE = {
  packageVersion: CHARACTER_PACKAGE_VERSION,
  permanentHome: 'loki-doki',
  distributionRepo: 'loki-doki-characters',
  labRepo: 'loki-doki-animator',
} as const;
