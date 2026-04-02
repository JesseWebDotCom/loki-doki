import type { CharacterEvent } from '@/character-editor/machines/CharacterMachine';

export const CHARACTER_PACKAGE_VERSION = '2.0.0';

export type RuntimeReplacementArea =
  | 'stage_renderer'
  | 'state_machine'
  | 'voice_streaming'
  | 'audio_reflexes'
  | 'fullscreen_kiosk';

export type EditorReplacementArea =
  | 'settings_editor'
  | 'character_browser'
  | 'rig_validation'
  | 'voice_model_selection'
  | 'publish_flow';

export type RepositoryMigrationStatus =
  | 'valid'
  | 'migrated'
  | 'legacy_blocked'
  | 'needs_manual_rebuild';

export interface CharacterRuntimeBridge {
  onUserTyping(): void;
  onUserIdle(): void;
  onMessageSent(): void;
  onSpeechStart(): void;
  onSpeechEnd(): void;
  onTranscriptionStart(): void;
  onWakeWordDetected(): void;
  onLoudSoundDetected(): void;
  onResetIdle(): void;
}

export interface CharacterEditorCapabilities {
  canBrowseCharacters: boolean;
  canCreateCharacter: boolean;
  canEditCharacter: boolean;
  canInstallCharacter: boolean;
  canPublishCharacter: boolean;
  canUploadCustomSvg: boolean;
}

export interface CharacterPackageManifest {
  primary_name: string;
  domain: string;
  identity_key: string;
  behavior_style: string;
  svg_file: string;
  voice_model?: string;
  wakeword_model?: string;
  face_center: {
    x: number;
    y: number;
  };
}

export const LOKI_DOKI_EVENT_TO_CHARACTER_EVENT: Record<string, CharacterEvent['type']> = {
  user_typing: 'USER_TYPING',
  user_idle: 'USER_IDLE',
  message_sent: 'LLM_PROCESSING',
  speech_start: 'SPEAK_START',
  speech_end: 'SPEAK_END',
  transcription_start: 'USER_TYPING',
  wake_word_detected: 'WAKE_WORD_DETECTED',
  loud_sound_detected: 'STARTLE',
  reset_idle: 'RESET_IDLE',
};

export const RUNTIME_REPLACEMENT_AREAS: RuntimeReplacementArea[] = [
  'stage_renderer',
  'state_machine',
  'voice_streaming',
  'audio_reflexes',
  'fullscreen_kiosk',
];

export const EDITOR_REPLACEMENT_AREAS: EditorReplacementArea[] = [
  'settings_editor',
  'character_browser',
  'rig_validation',
  'voice_model_selection',
  'publish_flow',
];
