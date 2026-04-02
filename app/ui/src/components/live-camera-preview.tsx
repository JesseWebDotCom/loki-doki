import { useEffect, useRef, useState } from "react"
import { Camera, CameraOff, LoaderCircle, ScanSearch } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

type Detection = {
  label: string
  confidence: number
  bbox: {
    x: number
    y: number
    width: number
    height: number
  }
}

type FaceDetection = {
  confidence: number
  bbox: {
    x: number
    y: number
    width: number
    height: number
  }
  landmarks: { x: number; y: number }[]
  identity?: string
  match_score?: number
}

type DetectionPayload = {
  detections: Detection[]
  count: number
  meta: {
    execution: {
      backend: string
      model: string
      acceleration: string
    }
  }
}

export function LiveCameraPreview({ token }: { token?: string }) {
  const [enabled, setEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)
  const [error, setError] = useState("")
  const [detectionError, setDetectionError] = useState("")
  const [detections, setDetections] = useState<Detection[]>([])
  const [detectorSummary, setDetectorSummary] = useState("")
  const [faceDetections, setFaceDetections] = useState<FaceDetection[]>([])
  const [faceSummary, setFaceSummary] = useState("")
  const [faceError, setFaceError] = useState("")
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!enabled) {
      stopStream(streamRef.current)
      streamRef.current = null
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      setIsLoading(false)
      setIsDetecting(false)
      setDetections([])
      setDetectorSummary("")
      setDetectionError("")
      setFaceDetections([])
      setFaceSummary("")
      setFaceError("")
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError("")
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
        setIsLoading(false)
      })
      .catch((requestError: unknown) => {
        if (cancelled) {
          return
        }
        setIsLoading(false)
        setEnabled(false)
        setError(requestError instanceof Error ? requestError.message : "Camera preview is unavailable.")
      })
    return () => {
      cancelled = true
      stopStream(streamRef.current)
      streamRef.current = null
    }
  }, [enabled])

  return (
    <Card className="border-zinc-800 bg-zinc-900/75 text-zinc-100 shadow-sm">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">Live Camera Preview</div>
            <div className="mt-1 text-sm text-zinc-400">
              Browser-native camera preview for quick framing checks in the web UI.
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              className="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-800"
              disabled={!enabled || isLoading || isDetecting || !token}
              onClick={() => void detectCurrentFrame(videoRef.current, token || "", setIsDetecting, setDetections, setDetectorSummary, setDetectionError)}
              type="button"
              variant="ghost"
            >
              {isDetecting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
              Detect
            </Button>
            <Button
              className="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-800"
              disabled={!enabled || isLoading || isDetecting || !token}
              onClick={() => void detectCurrentFaces(videoRef.current, token || "", setIsDetecting, setFaceDetections, setFaceSummary, setFaceError)}
              type="button"
              variant="ghost"
            >
              {isDetecting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
              Faces
            </Button>
            <Button
              className="rounded-full border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 hover:bg-zinc-800"
              onClick={() => setEnabled((current) => !current)}
              type="button"
              variant="ghost"
            >
              {enabled ? <CameraOff className="mr-2 h-4 w-4" /> : <Camera className="mr-2 h-4 w-4" />}
              {enabled ? "Stop" : "Start"}
            </Button>
          </div>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-black/60">
          {enabled ? (
            <video ref={videoRef} autoPlay className="aspect-video w-full object-cover" muted playsInline />
          ) : (
            <div className="grid aspect-video place-items-center text-sm text-zinc-500">Camera preview is off.</div>
          )}
          {enabled ? (
            <div className="pointer-events-none absolute inset-0">
              {detections.map((detection, index) => (
                <div
                  key={`${detection.label}-${index}`}
                  className="absolute rounded-lg border-2 border-emerald-400/90 bg-emerald-500/10"
                  style={{
                    left: `${detection.bbox.x * 100}%`,
                    top: `${detection.bbox.y * 100}%`,
                    width: `${detection.bbox.width * 100}%`,
                    height: `${detection.bbox.height * 100}%`,
                  }}
                >
                  <div className="absolute left-0 top-0 -translate-y-full rounded-md bg-emerald-400 px-2 py-1 text-[10px] font-semibold text-black">
                    {detection.label} {Math.round(detection.confidence * 100)}%
                  </div>
                </div>
              ))}
              {faceDetections.map((face, index) => (
                <div
                  key={`face-${index}`}
                  className="absolute rounded-lg border-2 border-sky-400/90 bg-sky-500/10"
                  style={{
                    left: `${face.bbox.x * 100}%`,
                    top: `${face.bbox.y * 100}%`,
                    width: `${face.bbox.width * 100}%`,
                    height: `${face.bbox.height * 100}%`,
                  }}
                >
                  <div className="absolute left-0 top-0 -translate-y-full rounded-md bg-sky-400 px-2 py-1 text-[10px] font-semibold text-black">
                    {face.identity ? `${face.identity} ` : "face "}
                    {Math.round(face.confidence * 100)}%
                    {typeof face.match_score === "number" ? ` • ${face.match_score.toFixed(2)}` : ""}
                  </div>
                  {face.landmarks.map((point, pointIndex) => (
                    <div
                      key={`face-${index}-point-${pointIndex}`}
                      className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-300"
                      style={{
                        left: `${((point.x - face.bbox.x) / Math.max(face.bbox.width, 0.0001)) * 100}%`,
                        top: `${((point.y - face.bbox.y) / Math.max(face.bbox.height, 0.0001)) * 100}%`,
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Waiting for camera permission...
          </div>
        ) : null}
        {!token ? <div className="text-sm text-zinc-500">Sign in to run object detection from the camera preview.</div> : null}
        {detectorSummary ? <div className="text-sm text-zinc-400">{detectorSummary}</div> : null}
        {faceSummary ? <div className="text-sm text-zinc-400">{faceSummary}</div> : null}
        {enabled && faceDetections.length > 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300">
            {faceDetections.map((face, index) => (
              <div key={`face-summary-${index}`}>
                {face.identity || "Unknown face"} • detector {Math.round(face.confidence * 100)}%
                {typeof face.match_score === "number" ? ` • match ${face.match_score.toFixed(2)}` : ""}
              </div>
            ))}
          </div>
        ) : null}
        {enabled && detections.length > 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300">
            {detections.map((detection, index) => (
              <div key={`${detection.label}-summary-${index}`}>
                {detection.label} • {Math.round(detection.confidence * 100)}%
              </div>
            ))}
          </div>
        ) : null}
        {detectionError ? <div className="text-sm text-amber-300">{detectionError}</div> : null}
        {faceError ? <div className="text-sm text-amber-300">{faceError}</div> : null}
        {error ? <div className="text-sm text-rose-300">{error}</div> : null}
      </CardContent>
    </Card>
  )
}

async function detectCurrentFaces(
  video: HTMLVideoElement | null,
  token: string,
  setIsDetecting: (value: boolean) => void,
  setDetections: (detections: FaceDetection[]) => void,
  setSummary: (summary: string) => void,
  setError: (error: string) => void
): Promise<void> {
  if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
    setError("Start the camera first so LokiDoki has a frame to analyze.")
    return
  }
  setIsDetecting(true)
  setError("")
  try {
    const imageDataUrl = captureFrame(video)
    const response = await fetch("/api/detect/faces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
        body: JSON.stringify({
        image_data_url: imageDataUrl,
        confidence_threshold: 0.65,
      }),
    })
    const payload = (await response.json().catch(() => ({}))) as Partial<DetectionPayload> & {
      detections?: FaceDetection[]
      detail?: string
    }
    if (!response.ok) {
      throw new Error(payload.detail || "Face detection failed.")
    }
    const nextDetections = Array.isArray(payload.detections) ? payload.detections : []
    setDetections(nextDetections)
    const execution = payload.meta?.execution
    const detectorLabel = execution ? `${execution.backend} / ${execution.model}` : "detector ready"
    const recognized = nextDetections.filter((detection) => Boolean(detection.identity))
    setSummary(
      nextDetections.length > 0
        ? recognized.length > 0
          ? `${recognized.map((detection) => detection.identity).join(", ")} recognized via ${detectorLabel}.`
          : `${nextDetections.length} face${nextDetections.length === 1 ? "" : "s"} found via ${detectorLabel}.`
        : `No faces found above threshold via ${detectorLabel}.`
    )
  } catch (requestError) {
    setDetections([])
    setSummary("")
    setError(requestError instanceof Error ? requestError.message : "Face detection failed.")
  } finally {
    setIsDetecting(false)
  }
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}

async function detectCurrentFrame(
  video: HTMLVideoElement | null,
  token: string,
  setIsDetecting: (value: boolean) => void,
  setDetections: (detections: Detection[]) => void,
  setDetectorSummary: (summary: string) => void,
  setDetectionError: (error: string) => void
): Promise<void> {
  if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
    setDetectionError("Start the camera first so LokiDoki has a frame to analyze.")
    return
  }
  setIsDetecting(true)
  setDetectionError("")
  try {
    const imageDataUrl = captureFrame(video)
    const response = await fetch("/api/detect/objects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        image_data_url: imageDataUrl,
        confidence_threshold: 0.2,
      }),
    })
    const payload = (await response.json().catch(() => ({}))) as Partial<DetectionPayload> & { detail?: string }
    if (!response.ok) {
      throw new Error(payload.detail || "Object detection failed.")
    }
    const nextDetections = Array.isArray(payload.detections) ? payload.detections : []
    setDetections(nextDetections)
    const execution = payload.meta?.execution
    const detectorLabel = execution ? `${execution.backend} / ${execution.model}` : "detector ready"
    setDetectorSummary(
      nextDetections.length > 0
        ? `${nextDetections.length} object${nextDetections.length === 1 ? "" : "s"} found via ${detectorLabel}.`
        : `No objects found above threshold via ${detectorLabel}.`
    )
  } catch (requestError) {
    setDetections([])
    setDetectorSummary("")
    setDetectionError(requestError instanceof Error ? requestError.message : "Object detection failed.")
  } finally {
    setIsDetecting(false)
  }
}

function captureFrame(video: HTMLVideoElement): string {
  const canvas = document.createElement("canvas")
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("Camera frame capture is unavailable in this browser.")
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/png")
}
