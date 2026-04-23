export const STATUS_LABELS = {
  augmentation: "Looking up context",
  decomposition: "Understanding your ask",
  routing: "Picking the right skills",
  execute: "Checking sources",
  media_augment: "Looking for visuals",
  synthesis: "Preparing response",
  finishing: "Finishing up",
} as const;

export function humanStatusLabel(
  phase: keyof typeof STATUS_LABELS | string,
): string {
  return STATUS_LABELS[phase as keyof typeof STATUS_LABELS] ?? "Working locally";
}
