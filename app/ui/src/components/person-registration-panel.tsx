import { type MutableRefObject, useEffect, useRef, useState } from "react"
import { Camera, CameraOff, LoaderCircle, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { RegisteredPeopleCard } from "@/components/registered-people-card"
import {
  capturePrompt,
  captureTargetCount,
  type CapturedSample,
  captureFrame,
  currentCaptureStage,
  type FaceOverlay,
  loadPeople,
  poseStage,
  type QualityPayload,
  type RegisteredPerson,
  type RegistrationMode,
  shouldCapture,
  stopLoop,
  stopStream,
} from "@/components/person-registration-utils"
import { Select } from "@/components/ui/select"

type PersonRegistrationPanelProps = {
  token: string
  onClose: () => void
  initialName?: string
  embedded?: boolean
  showRegisteredList?: boolean
}

export function PersonRegistrationPanel({
  token,
  onClose,
  initialName = "",
  embedded = false,
  showRegisteredList = true,
}: PersonRegistrationPanelProps) {
  const [name, setName] = useState(initialName)
  const [mode, setMode] = useState<RegistrationMode>("close_up")
  const [enabled, setEnabled] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState("")
  const [guidance, setGuidance] = useState("Enter a name, choose a mode, and start the camera.")
  const [overlayFace, setOverlayFace] = useState<FaceOverlay | null>(null)
  const [quality, setQuality] = useState<QualityPayload | null>(null)
  const [captures, setCaptures] = useState<CapturedSample[]>([])
  const [people, setPeople] = useState<RegisteredPerson[]>([])
  const [successMessage, setSuccessMessage] = useState("")
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const capturesRef = useRef<CapturedSample[]>([])
  const speakingAtRef = useRef(0)
  const lastGuidanceRef = useRef("")
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    void loadPeople(token, setPeople)
  }, [token])

  useEffect(() => {
    setName(initialName)
  }, [initialName])

  useEffect(() => {
    capturesRef.current = captures
  }, [captures])

  useEffect(() => {
    setCaptures([])
    setOverlayFace(null)
    setQuality(null)
    setError("")
    if (!successMessage) {
      setGuidance("Enter a name, choose a mode, and start the camera.")
    }
  }, [mode, successMessage])

  useEffect(() => {
    if (!enabled) {
      stopLoop(timerRef)
      stopStream(streamRef.current)
      streamRef.current = null
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      return
    }
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stopStream(stream)
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
        scheduleNextFrame()
      })
      .catch((cameraError: unknown) => {
        setError(cameraError instanceof Error ? cameraError.message : "Camera access failed.")
        setEnabled(false)
      })
    return () => {
      cancelled = true
      stopLoop(timerRef)
      stopStream(streamRef.current)
      streamRef.current = null
    }
  }, [enabled, mode, name, token])

  useEffect(() => {
    if (!guidance || guidance === lastGuidanceRef.current) {
      return
    }
    const now = Date.now()
    if (!shouldSpeakGuidance(guidance) || now - speakingAtRef.current < 2500) {
      return
    }
    speakingAtRef.current = now
    lastGuidanceRef.current = guidance
    void speakGuidance(guidance, token, audioRef)
  }, [guidance, token])

  function scheduleNextFrame() {
    stopLoop(timerRef)
    timerRef.current = window.setTimeout(() => {
      void analyzeFrame()
    }, 350)
  }

  async function analyzeFrame() {
    if (!enabled || isAnalyzing || isSaving || !token || !videoRef.current) {
      return
    }
    if (!name.trim()) {
      setGuidance("Add a name before capture starts.")
      scheduleNextFrame()
      return
    }
    if (videoRef.current.videoWidth <= 0 || videoRef.current.videoHeight <= 0) {
      scheduleNextFrame()
      return
    }
    setIsAnalyzing(true)
    try {
      const dataUrl = captureFrame(videoRef.current)
      const response = await fetch("/api/people/faces/frame", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ image_data_url: dataUrl, mode }),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        accepted?: boolean
        guidance?: string
        face?: FaceOverlay | null
        quality?: QualityPayload | null
        detail?: string
      }
      if (!response.ok) {
        throw new Error(payload.detail || "Face registration analysis failed.")
      }
      setOverlayFace(payload.face || null)
      setQuality(payload.quality || null)
      const current = capturesRef.current
      const currentStage = currentCaptureStage(mode, current)
      const expectedPrompt = capturePrompt(mode, currentStage)
      if (!payload.face || !payload.quality) {
        setGuidance(payload.guidance || "Step into view so I can see one face.")
        return
      }
      if (!payload.accepted) {
        setGuidance(payload.guidance || expectedPrompt)
        return
      }
      if (poseStage(payload.quality) !== currentStage) {
        setGuidance(expectedPrompt)
        return
      }
      if (payload.accepted && payload.face && payload.quality) {
        const now = Date.now()
        setCaptures((current) => {
          if (!shouldCapture(current, payload.face!, payload.quality!, mode, now)) {
            setGuidance(capturePrompt(mode, currentCaptureStage(mode, current)))
            return current
          }
          const next = [
            ...current,
            {
              dataUrl,
              face: payload.face!,
              quality: payload.quality!,
              capturedAt: now,
              stage: currentCaptureStage(mode, current),
            },
          ]
          if (next.length >= captureTargetCount(mode)) {
            void finalizeRegistration(next)
          } else {
            setGuidance(capturePrompt(mode, currentCaptureStage(mode, next)))
          }
          return next
        })
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Face registration analysis failed.")
    } finally {
      setIsAnalyzing(false)
      if (enabled && !isSaving) {
        scheduleNextFrame()
      }
    }
  }

  async function finalizeRegistration(samples: CapturedSample[]) {
    if (isSaving || !name.trim()) {
      return
    }
    setIsSaving(true)
    setError("")
    setSuccessMessage("")
    setGuidance(`Got it, learning ${name.trim()}'s face...`)
    try {
      const response = await fetch("/api/people/faces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: name.trim(),
          mode,
          frames: samples.map((sample) => sample.dataUrl),
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as { detail?: string }
      if (!response.ok) {
        throw new Error(payload.detail || "Registration failed.")
      }
      const person = (payload as { person?: RegisteredPerson }).person
      const nextMode = person?.modes?.includes("close_up") && !person?.modes?.includes("far") ? "far" : "close_up"
      const incomplete = person && !person.is_complete
      if (incomplete) {
        setSuccessMessage(`${mode === "close_up" ? "Close-up" : "Far"} mode saved for ${person.name}. ${nextMode === "far" ? "Far mode" : "Close-up mode"} is next.`)
        setGuidance(`${mode === "close_up" ? "Close-up" : "Far"} mode saved for ${person.name}. ${capturePrompt(nextMode, currentCaptureStage(nextMode, []))}`)
        setMode(nextMode)
        setName(person.name)
      } else {
        setSuccessMessage(`Done, I'll recognize ${name.trim()} from now on.`)
        setGuidance(`Done, I'll recognize ${name.trim()} from now on.`)
        setName(name.trim())
      }
      setCaptures([])
      setOverlayFace(null)
      setQuality(null)
      setEnabled(false)
      await loadPeople(token, setPeople)
    } catch (saveError) {
      setSuccessMessage("")
      setError(saveError instanceof Error ? saveError.message : "Registration failed.")
    } finally {
      setIsSaving(false)
    }
  }

  async function removePerson(personName: string) {
    const response = await fetch(`/api/people/faces/${encodeURIComponent(personName)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    const payload = (await response.json().catch(() => ({}))) as { detail?: string }
    if (!response.ok) {
      setError(payload.detail || "Remove failed.")
      return
    }
    await loadPeople(token, setPeople)
  }

  const targetCount = captureTargetCount(mode)
  const progressLabel = `Captured ${captures.length} of ${targetCount} good frames`
  const currentPerson = people.find((person) => person.name.toLowerCase() === name.trim().toLowerCase()) || null
  const currentStage = currentCaptureStage(mode, captures)
  const personalizedTitle = embedded ? "Your Recognition" : "Register a Person"
  const personalizedSubtitle = embedded
    ? "Set up your own facial recognition so LokiDoki can recognize you later."
    : "Capture close-up and far samples so LokiDoki can recognize someone later."

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm uppercase tracking-[0.18em] text-[var(--muted-foreground)]">{embedded ? "Personal Setup" : "Recognition"}</div>
            <h1 className="mt-2 text-3xl font-semibold text-[var(--foreground)]">{personalizedTitle}</h1>
          </div>
          {!embedded ? (
            <Button className="h-9 rounded-full border border-[var(--line)] bg-[var(--panel)] px-3 text-[var(--foreground)] hover:bg-[var(--input)]" onClick={onClose} type="button" variant="ghost">
              <X className="mr-2 h-4 w-4" />
              Close
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-sm leading-7 text-[var(--muted-foreground)]">{personalizedSubtitle}</p>
        {!embedded ? (
          <p className="mt-2 text-sm leading-7 text-[var(--muted-foreground)]">
            Recognition testing is available in Camera Test via the <span className="text-[var(--foreground)]">Faces</span> button, and this page now treats close-up and far as separate enrollment phases.
          </p>
        ) : null}
      </div>
      <div className={`grid gap-6 ${showRegisteredList ? "xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.85fr)]" : ""}`}>
        <Card className="border-[var(--line)] bg-[var(--card)] text-[var(--foreground)]">
          <CardContent className="space-y-4 p-4">
            <div className={`grid gap-3 ${embedded ? "md:grid-cols-[minmax(0,1fr)_auto]" : "md:grid-cols-[1.2fr_0.8fr_auto]"}`}>
              {!embedded ? (
                <Input className="border-[var(--line)] bg-[var(--input)]" onChange={(event) => setName(event.target.value)} placeholder="Person name" value={name} />
              ) : (
                <div className="rounded-[24px] border border-[var(--line)] bg-[var(--input)] px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Recognition Name</div>
                  <div className="mt-1 text-sm text-[var(--foreground)]">{name || "Your account name"}</div>
                </div>
              )}
              <Select onChange={(event) => setMode(event.target.value as RegistrationMode)} value={mode}>
                <option value="close_up">Close-up mode</option>
                <option value="far">Far mode</option>
              </Select>
              <Button
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent)] font-semibold text-[var(--accent-foreground)] hover:bg-[var(--accent-strong)]"
                onClick={() => setEnabled((current) => !current)}
                type="button"
              >
                {enabled ? <CameraOff className="mr-2 h-4 w-4" /> : <Camera className="mr-2 h-4 w-4" />}
                {enabled ? "Stop" : "Start"}
              </Button>
            </div>
            {name.trim() ? (
              <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                <span className={`rounded-full border px-3 py-1 ${currentPerson?.modes.includes("close_up") ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-[var(--line)] bg-[var(--input)] text-[var(--muted-foreground)]"}`}>close-up {currentPerson?.modes.includes("close_up") ? "done" : "pending"}</span>
                <span className={`rounded-full border px-3 py-1 ${currentPerson?.modes.includes("far") ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-[var(--line)] bg-[var(--input)] text-[var(--muted-foreground)]"}`}>far {currentPerson?.modes.includes("far") ? "done" : "pending"}</span>
                <span className={`rounded-full border px-3 py-1 ${currentPerson?.is_complete ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>{currentPerson?.is_complete ? "ready" : "finish setup"}</span>
              </div>
            ) : null}
            <div className="relative overflow-hidden rounded-[28px] border border-[var(--line)] bg-[var(--panel)]">
              {enabled ? (
                <video ref={videoRef} autoPlay className="aspect-video w-full object-cover" muted playsInline />
              ) : (
                <div className="grid aspect-video place-items-center text-sm text-[var(--muted-foreground)]">Camera preview is off.</div>
              )}
              {overlayFace ? (
                <div
                  className="pointer-events-none absolute rounded-lg border-2 border-sky-400/90 bg-sky-500/10"
                  style={{
                    left: `${overlayFace.bbox.x * 100}%`,
                    top: `${overlayFace.bbox.y * 100}%`,
                    width: `${overlayFace.bbox.width * 100}%`,
                    height: `${overlayFace.bbox.height * 100}%`,
                  }}
                >
                  <div className="absolute left-0 top-0 -translate-y-full rounded-md bg-sky-400 px-2 py-1 text-[10px] font-semibold text-black">
                    {overlayFace.identity ? `${overlayFace.identity} ` : "face "}
                    {Math.round(overlayFace.confidence * 100)}%
                  </div>
                </div>
              ) : null}
            </div>
            <div className="rounded-[24px] border border-[var(--line)] bg-[var(--input)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-medium text-[var(--foreground)]">{progressLabel}</div>
                {(isAnalyzing || isSaving) ? <LoaderCircle className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" /> : null}
              </div>
              <div className="mt-3 text-xs uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Current step: {currentStage.replace("_", " ")}</div>
              <div className="mt-3 text-sm text-[var(--foreground)]">{guidance}</div>
              {quality ? (
                <div className="mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                  <span>{quality.width_px}x{quality.height_px}px</span>
                  <span>sharpness {quality.sharpness.toFixed(0)}</span>
                  <span>yaw {quality.yaw.toFixed(0)}</span>
                  <span>pitch {quality.pitch.toFixed(0)}</span>
                </div>
              ) : null}
            </div>
            {successMessage ? <div className="text-sm text-emerald-300">{successMessage}</div> : null}
            {error ? <div className="text-sm text-rose-300">{error}</div> : null}
          </CardContent>
        </Card>
        {showRegisteredList ? <RegisteredPeopleCard people={people} onRemove={(personName) => void removePerson(personName)} /> : null}
      </div>
    </div>
  )
}

const SPOKEN_GUIDANCE = new Set([
  "Step into view so I can see one face.",
  "Look straight ahead.",
  "Turn left slowly.",
  "Turn right slowly.",
  "Tilt up a little.",
  "Tilt down a little.",
  "Move a little closer.",
  "Hold still for a second.",
  "Perfect, hold that.",
  "Drift a little left and keep your face visible.",
  "Drift a little right and keep your face visible.",
  "Lift your chin a little while you stay in frame.",
  "Lower your chin a little while you stay in frame.",
  "Face forward and move naturally in view.",
])

function shouldSpeakGuidance(guidance: string): boolean {
  return SPOKEN_GUIDANCE.has(guidance.trim())
}

async function speakGuidance(
  guidance: string,
  token: string,
  audioRef: MutableRefObject<HTMLAudioElement | null>
): Promise<void> {
  if (!guidance.trim()) {
    return
  }
  try {
    const response = await fetch("/api/voices/speak", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: guidance }),
    })
    if (response.ok) {
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      if (audioRef.current) {
        audioRef.current.pause()
      }
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (audioRef.current === audio) {
          audioRef.current = null
        }
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
      }
      await audio.play()
      return
    }
  } catch {
    // Fall back to browser speech when local voice playback is unavailable.
  }
  if (!("speechSynthesis" in window)) {
    return
  }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(guidance)
  utterance.rate = 1.05
  utterance.pitch = 1
  window.speechSynthesis.speak(utterance)
}
