// Hands-free finite state machine. Ported verbatim from v2.
//
// Pure reducer over states + events. Owns transitions only — not the wake-word
// loop, mic stream, or STT WS. useHandsFree subscribes and drives those.

export type HandsFreeState =
  | "off"
  | "engaging"
  | "idle"
  | "wake-detected"
  | "capturing"
  | "replying"
  | "post-reply-listen"
  | "suspended"

export type HandsFreeEvent =
  | { type: "engage" }
  | { type: "disengage" }
  | { type: "models_loaded" }
  | { type: "models_failed" }
  | { type: "wake_detected" }
  | { type: "capture_open" }
  | { type: "stt_final" }
  | { type: "tts_end" }
  | { type: "vad_onset" }
  | { type: "post_reply_timeout" }
  | { type: "stop_listening" }
  | { type: "suspend" }
  | { type: "resume" }
  | { type: "stop_command" }
  | { type: "barge_in" }

export const INITIAL_STATE: HandsFreeState = "off"

export function transition(state: HandsFreeState, event: HandsFreeEvent): HandsFreeState {
  if (event.type === "disengage") return "off"

  switch (state) {
    case "off":
      return event.type === "engage" ? "engaging" : state
    case "engaging":
      if (event.type === "models_loaded") return "idle"
      if (event.type === "models_failed") return "off"
      return state
    case "idle":
      if (event.type === "wake_detected") return "wake-detected"
      if (event.type === "suspend") return "suspended"
      return state
    case "wake-detected":
      if (event.type === "capture_open") return "capturing"
      if (event.type === "stop_command") return "idle" // capture timed out with no command
      return state
    case "capturing":
      if (event.type === "stt_final") return "replying"
      if (event.type === "stop_command") return "idle"
      return state
    case "replying":
      if (event.type === "tts_end") return "post-reply-listen"
      if (event.type === "barge_in") return "capturing"
      if (event.type === "stop_command") return "idle"
      return state
    case "post-reply-listen":
      if (event.type === "vad_onset") return "capturing"
      if (event.type === "post_reply_timeout") return "idle"
      if (event.type === "stop_listening") return "idle"
      if (event.type === "stop_command") return "idle"
      return state
    case "suspended":
      return event.type === "resume" ? "idle" : state
    default:
      return state
  }
}

export function isEngaged(state: HandsFreeState): boolean {
  return state !== "off"
}

export function isCapturing(state: HandsFreeState): boolean {
  return state === "capturing" || state === "wake-detected"
}
