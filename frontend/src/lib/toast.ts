/**
 * Lightweight toast notifications.
 *
 * v3 does not yet ship a global toast surface, so this renders ephemeral
 * floating pills directly into the DOM. The API mirrors the common
 * `toast.success/error/info` shape so feature code stays portable; swap
 * the implementation for a shared component later without touching callers.
 */
type ToastKind = "success" | "error" | "info";

const COLORS: Record<ToastKind, string> = {
  success: "#059669",
  error: "#dc2626",
  info: "#2563eb",
};

function show(message: string, kind: ToastKind): void {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:32px",
    "transform:translateX(-50%) translateY(8px)",
    "z-index:9999",
    "padding:10px 16px",
    "border-radius:10px",
    "color:#fff",
    "font-size:13px",
    "font-weight:600",
    "box-shadow:0 6px 24px rgba(0,0,0,0.25)",
    "opacity:0",
    "transition:opacity .18s ease, transform .18s ease",
    `background:${COLORS[kind]}`,
  ].join(";");
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

export const toast = {
  success: (message: string) => show(message, "success"),
  error: (message: string) => show(message, "error"),
  info: (message: string) => show(message, "info"),
};
