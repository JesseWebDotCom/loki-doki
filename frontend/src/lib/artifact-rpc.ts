export type ArtifactRpcMessage =
  | { kind: "save"; payload: string }
  | { kind: "export"; format: "html" | "svg" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isArtifactRpcMessage(value: unknown): value is ArtifactRpcMessage {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "save") {
    return typeof value.payload === "string";
  }
  if (value.kind === "export") {
    return value.format === "html" || value.format === "svg";
  }
  return false;
}

