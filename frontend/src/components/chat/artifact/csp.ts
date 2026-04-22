export const ARTIFACT_MAX_BYTES = 256 * 1024;

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export function artifactSizeBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function isArtifactContentWithinLimit(content: string): boolean {
  return artifactSizeBytes(content) <= ARTIFACT_MAX_BYTES;
}

