export type PendingImage = {
  name: string
  dataUrl: string
}

export type PendingVideo = {
  name: string
  posterDataUrl: string
  frameDataUrls: string[]
}

export type PendingDocument = {
  name: string
  text: string
}

const MAX_IMAGE_DIMENSION = 1024
const MAX_IMAGE_DATA_URL_LENGTH = 1_800_000
const NORMALIZED_IMAGE_TYPE = "image/jpeg"
const NORMALIZED_IMAGE_QUALITY = 0.82
const MAX_VIDEO_FRAMES = 4
const MAX_DOCUMENT_CHARACTERS = 120_000
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "log",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "rst",
  "ini",
  "toml",
  "py",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "sql",
])

export function prepareImageUpload(file: File): Promise<PendingImage> {
  return readFileAsDataUrl(file).then(async (original) => {
    const normalized = await normalizeImageDataUrl(original)
    validatePreparedImage(normalized)
    return { name: normalizedName(file.name), dataUrl: normalized }
  })
}

export async function prepareVideoUpload(file: File): Promise<PendingVideo> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const video = await loadVideoElement(objectUrl)
    const timestamps = buildSampleTimestamps(video.duration)
    const frames = await captureFrames(video, timestamps)
    return {
      name: normalizedName(file.name),
      posterDataUrl: frames[0],
      frameDataUrls: frames,
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function prepareDocumentUpload(file: File): Promise<PendingDocument> {
  validateDocumentFile(file)
  const text = (await file.text()).trim()
  if (!text) {
    throw new Error("Document upload is empty.")
  }
  if (text.length > MAX_DOCUMENT_CHARACTERS) {
    throw new Error("Document upload is too large. Try a smaller text-based file.")
  }
  return {
    name: file.name.trim() || "document.txt",
    text,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
        return
      }
      reject(new Error("Image upload could not be read."))
    }
    reader.onerror = () => reject(new Error("Image upload could not be read."))
    reader.readAsDataURL(file)
  })
}

function validateDocumentFile(file: File): void {
  const extension = file.name.split(".").pop()?.toLowerCase() || ""
  if (SUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) {
    return
  }
  throw new Error("Document analysis currently supports text-based files like .txt, .md, .csv, .json, and source files.")
}

function normalizeImageDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const { width, height } = scaleDimensions(image.width, image.height, MAX_IMAGE_DIMENSION)
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext("2d")
      if (!context) {
        reject(new Error("Canvas context is unavailable."))
        return
      }
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, width, height)
      context.drawImage(image, 0, 0, width, height)
      resolve(canvas.toDataURL(NORMALIZED_IMAGE_TYPE, NORMALIZED_IMAGE_QUALITY))
    }
    image.onerror = () => reject(new Error("Image upload could not be prepared for analysis."))
    image.src = dataUrl
  })
}

function validatePreparedImage(dataUrl: string): void {
  if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
    return
  }
  throw new Error("Image upload is too large after compression. Try a smaller image.")
}

function scaleDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height }
  }
  const scale = maxDimension / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function normalizedName(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) {
    return `${name}.jpg`
  }
  return `${name.slice(0, dot)}.jpg`
}

function loadVideoElement(objectUrl: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video")
    video.preload = "metadata"
    video.muted = true
    video.playsInline = true
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error("Video upload could not be prepared for analysis."))
    video.src = objectUrl
  })
}

function buildSampleTimestamps(duration: number): number[] {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1
  return Array.from({ length: MAX_VIDEO_FRAMES }, (_, index) => {
    const ratio = (index + 1) / (MAX_VIDEO_FRAMES + 1)
    return Math.min(safeDuration, safeDuration * ratio)
  })
}

async function captureFrames(video: HTMLVideoElement, timestamps: number[]): Promise<string[]> {
  const size = scaleDimensions(video.videoWidth || 1280, video.videoHeight || 720, MAX_IMAGE_DIMENSION)
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("Canvas context is unavailable.")
  }
  const frames: string[] = []
  for (const timestamp of timestamps) {
    await seekVideo(video, timestamp)
    context.fillStyle = "#000000"
    context.fillRect(0, 0, size.width, size.height)
    context.drawImage(video, 0, 0, size.width, size.height)
    const frame = canvas.toDataURL(NORMALIZED_IMAGE_TYPE, NORMALIZED_IMAGE_QUALITY)
    validatePreparedImage(frame)
    frames.push(frame)
  }
  return frames
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error("Video upload could not be sampled."))
    }
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked)
      video.removeEventListener("error", onError)
    }
    video.addEventListener("seeked", onSeeked)
    video.addEventListener("error", onError)
    video.currentTime = Math.max(0, time)
  })
}
