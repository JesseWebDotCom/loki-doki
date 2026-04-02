import { createMachine, assign } from 'xstate';

interface CharacterContext {
  idleCount: number;
  lastEventTime: number;
  currentViseme: string;
}

export type CharacterEvent =
  | { type: 'SPEAK_START' }
  | { type: 'SPEAK_END' }
  | { type: 'PHONEME_RECEIVED'; viseme: string }
  | { type: 'STARTLE' }
  | { type: 'PET' }
  | { type: 'USER_TYPING' }
  | { type: 'USER_IDLE' }
  | { type: 'WAKE_WORD_DETECTED' }
  | { type: 'LLM_PROCESSING' }
  | { type: 'RESET_IDLE' }
  | { type: 'RECOVER_ACTIVE' }
  | { type: 'FORCE_DOZING' }
  | { type: 'FORCE_SLEEP' }
  | { type: 'FORCE_SICK' }
  | { type: 'FORCE_THINKING' }
  | { type: 'FORCE_BORED' };

/**
 * CharacterMachine — The Parallel Brain (Phase 2.3)
 * Decouples the Mouth (Lip-sync) from the Body (Postures/Reflexes).
 */
export const characterMachine = createMachine({
  id: 'characterBrain',
  type: 'parallel',
  types: {} as {
    context: CharacterContext;
    events: CharacterEvent;
  },
  context: {
    idleCount: 0,
    lastEventTime: Date.now(),
    currentViseme: 'neutral',
  },
  states: {
    mouth: {
      initial: 'silent',
      states: {
        silent: { on: { SPEAK_START: 'talking' } },
        talking: {
          on: { 
            SPEAK_END: 'silent',
            PHONEME_RECEIVED: {
                actions: assign({ currentViseme: ({ event }) => event.viseme })
            }
          }
        }
      }
    },
    body: {
      initial: 'active',
      on: {
        STARTLE: {
           target: '.startled',
           // Removed state.matches guard as it caused V5 evaluation errors during transition
        },
        PET: '.happy',
        USER_TYPING: '.thinking',
        WAKE_WORD_DETECTED: '.alert',
        LLM_PROCESSING: '.processing',
        RECOVER_ACTIVE: '.active',
        FORCE_DOZING: '.dozing',
        FORCE_SLEEP: '.sleep',
        FORCE_SICK: '.sick',
        FORCE_THINKING: '.thinking',
        FORCE_BORED: '.bored',
        RESET_IDLE: {
          actions: assign({ idleCount: 0, lastEventTime: () => Date.now() }),
          target: '.active'
        }
      },
      states: {
        active: {
          after: { 120000: 'dozing' }
        },
        happy: {
          after: { 3000: 'active' }
        },
        thinking: {
          on: { USER_IDLE: 'active', SPEAK_START: 'active' }
        },
        bored: {
          on: { RESET_IDLE: 'active', USER_TYPING: 'thinking' }
        },
        processing: { on: { SPEAK_START: 'active' } },
        alert: { after: { 5000: 'active' } },
        startled: {
          after: { 2000: 'active' }
        },
        dozing: {
          on: { RESET_IDLE: 'active' },
          after: { 780000: 'sleep' }
        },
        sleep: {
          on: { STARTLE: 'active', PET: 'active', WAKE_WORD_DETECTED: 'active', RESET_IDLE: 'active' }
        },
        sick: {
          on: { RESET_IDLE: 'active' }
        }
      }
    }
  }
});
