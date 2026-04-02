import { type MutableRefObject } from "react"

export type RegistrationMode = "close_up" | "far"

export type FaceOverlay = {
  bbox: { x: number; y: number; width: number; height: number }
  confidence: number
  identity?: string
  match_score?: number
}

export type QualityPayload = {
  width_px: number
  height_px: number
  sharpness: number
  yaw: number
  pitch: number
}

export type CaptureStage = "straight" | "left" | "right" | "up" | "down"

export type RegisteredPerson = {
  name: string
  sample_count: number
  modes: RegistrationMode[]
  is_complete: boolean
}

export type CapturedSample = {
  dataUrl: string
  quality: QualityPayload
  face: FaceOverlay
  capturedAt: number
  stage: CaptureStage
}

export async function loadPeople(token: string, setPeople: (people: RegisteredPerson[]) => void) {
  const response = await fetch("/api/people/faces", { headers: { Authorization: `Bearer ${token}` } })
  const payload = (await response.json().catch(() => ({}))) as { people?: RegisteredPerson[] }
  setPeople(
    Array.isArray(payload.people)
      ? payload.people.map((person) => ({
          name: person.name,
          sample_count: Number(person.sample_count || 0),
          modes: Array.isArray(person.modes) ? person.modes.filter((mode): mode is RegistrationMode => mode === "close_up" || mode === "far") : [],
          is_complete: Boolean(person.is_complete),
        }))
      : []
  )
}

const STAGE_PLANS: Record<RegistrationMode, CaptureStage[]> = {
  close_up: ["straight", "left", "right", "up", "down", "straight", "left", "right", "up", "down"],
  far: ["straight", "left", "right", "straight", "up", "down", "straight", "left", "right", "straight", "up", "down", "straight", "left", "right"],
}

export function captureTargetCount(mode: RegistrationMode): number {
  return STAGE_PLANS[mode].length
}

export function currentCaptureStage(mode: RegistrationMode, current: CapturedSample[]): CaptureStage {
  const stages = STAGE_PLANS[mode]
  return stages[Math.min(current.length, stages.length - 1)]
}

export function poseStage(quality: QualityPayload): CaptureStage {
  const yaw = quality.yaw
  const pitch = quality.pitch
  if (Math.abs(yaw) >= Math.abs(pitch) && Math.abs(yaw) >= 8) {
    return yaw < 0 ? "left" : "right"
  }
  if (Math.abs(pitch) >= 8) {
    return pitch < 0 ? "up" : "down"
  }
  return "straight"
}

export function capturePrompt(mode: RegistrationMode, stage: CaptureStage): string {
  if (mode === "far") {
    if (stage === "left") {
      return "Drift a little left and keep your face visible."
    }
    if (stage === "right") {
      return "Drift a little right and keep your face visible."
    }
    if (stage === "up") {
      return "Lift your chin a little while you stay in frame."
    }
    if (stage === "down") {
      return "Lower your chin a little while you stay in frame."
    }
    return "Face forward and move naturally in view."
  }
  if (stage === "left") {
    return "Turn left slowly."
  }
  if (stage === "right") {
    return "Turn right slowly."
  }
  if (stage === "up") {
    return "Tilt up a little."
  }
  if (stage === "down") {
    return "Tilt down a little."
  }
  return "Look straight ahead."
}

export function shouldCapture(current: CapturedSample[], face: FaceOverlay, quality: QualityPayload, mode: RegistrationMode, now: number): boolean {
  if (poseStage(quality) !== currentCaptureStage(mode, current)) {
    return false
  }
  const latest = current[current.length - 1]
  if (!latest) {
    return true
  }
  if (now - latest.capturedAt >= 700) {
    return true
  }
  const centerDelta = Math.abs(face.bbox.x - latest.face.bbox.x) + Math.abs(face.bbox.y - latest.face.bbox.y)
  return centerDelta > 0.025 || quality.sharpness > latest.quality.sharpness + 18
}

export function captureFrame(video: HTMLVideoElement): string {
  const canvas = document.createElement("canvas")
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("Canvas capture is unavailable in this browser.")
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/jpeg", 0.92)
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop())
}

export function stopLoop(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }
}
