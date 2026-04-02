export { default as AnimatedCharacter } from '@/character-editor/components/AnimatedCharacter';
export { default as CharacterRuntimeProviders } from '@/character-editor/integration/CharacterRuntimeProviders';
export { default as CharacterWorkspace } from '@/character-editor/integration/CharacterWorkspace';
export { default as CharacterEditorWorkbench } from '@/character-editor/integration/CharacterEditorWorkbench';
export { default as EditorSidebar } from '@/character-editor/components/EditorSidebar';
export { default as FullscreenKiosk } from '@/character-editor/components/FullscreenKiosk';
export { default as HeaderControls } from '@/character-editor/components/HeaderControls';
export { default as Layout } from '@/character-editor/components/Layout';
export { default as PuppetStage } from '@/character-editor/components/PuppetStage';

export { AudioProvider, useAudio } from '@/character-editor/context/AudioContext';
export { CharacterProvider, useCharacter } from '@/character-editor/context/CharacterContext';
export { VoiceProvider, useVoice } from '@/character-editor/context/VoiceContext';

export { characterMachine } from '@/character-editor/machines/CharacterMachine';
export type { CharacterEvent } from '@/character-editor/machines/CharacterMachine';

export {
  CHARACTER_PACKAGE_VERSION,
  EDITOR_REPLACEMENT_AREAS,
  LOKI_DOKI_EVENT_TO_CHARACTER_EVENT,
  RUNTIME_REPLACEMENT_AREAS,
} from '@/character-editor/integration/contracts';
export type {
  CharacterEditorCapabilities,
  CharacterPackageManifest,
  CharacterRuntimeBridge,
  EditorReplacementArea,
  RepositoryMigrationStatus,
  RuntimeReplacementArea,
} from '@/character-editor/integration/contracts';

export {
  ABSORPTION_WORKSTREAMS,
  LAB_DECOMMISSION_GATES,
  MIGRATION_BASELINE,
  PACKAGE_MIGRATION_POLICY,
} from '@/character-editor/integration/migrationPlan';
export { buildCharacterEditorBundle } from '@/character-editor/integration/exportBundle';
export { buildCharacterPackageManifest, deriveIdentityKey } from '@/character-editor/integration/packageManifest';
export { validateCharacterPackage } from '@/character-editor/integration/packageValidation';
export type { DecommissionGate, MigrationWorkstream } from '@/character-editor/integration/migrationPlan';
export type { ValidationCheck, ValidationLevel } from '@/character-editor/integration/packageValidation';
