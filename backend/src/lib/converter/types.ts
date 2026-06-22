// Shared types for the file-conversion service.

export type MediaFamily = 'image' | 'audio' | 'video'

/** A conversion engine wraps one CLI tool (vips, ffmpeg) for a set of formats. */
export interface Engine {
  name: string
  /** Resolve + report whether this engine can run on this host right now. */
  available(): Promise<boolean>
  /** Can this engine convert inExt → outExt? Both are lowercase, no dot. */
  supports(inExt: string, outExt: string): boolean
  /** Perform the conversion. Throws on failure (message = tail of stderr). */
  run(args: EngineRunArgs): Promise<void>
}

export interface EngineRunArgs {
  inPath: string
  outPath: string
  outExt: string
  family: MediaFamily
  /** 1–100 quality hint for lossy outputs (jpg/webp/avif/mp3…). Engine may ignore. */
  quality?: number
  signal?: AbortSignal
}

/** Input to the service API. */
export interface ConvertInput {
  userId: string
  firstName: string
  /** Absolute path to the already-saved source file. */
  srcPath: string
  /** Original filename (for the DB row + output naming). */
  srcName: string
  /** Target format, lowercase, no dot (e.g. 'jpg'). */
  targetFormat: string
  quality?: number
  /** Delete srcPath once the job finishes — set when srcPath is a throwaway upload. */
  cleanupSrc?: boolean
}

/** Per-family capability lists, with vips-awareness folded in. */
export interface Capabilities {
  vipsAvailable: boolean
  families: Record<MediaFamily, { inputs: string[]; outputs: string[] }>
}
