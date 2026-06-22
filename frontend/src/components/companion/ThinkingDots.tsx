import type { CSSProperties } from "react";

interface Props {
  tiltDeg?: number;
}

export default function ThinkingDots({ tiltDeg = 0 }: Props) {
  const leansRight = tiltDeg > 1;
  const cornerStyle: CSSProperties = leansRight
    ? { top: "8%", right: "8%" }
    : { top: "8%", left: "8%" };

  return (
    <>
      <style>{`
        @keyframes ld-think-fade {
          0%   { opacity: 0; transform: translateY(2px) scale(0.92); }
          50%  { opacity: 1; transform: translateY(-4px) scale(1.05); }
          100% { opacity: 0; transform: translateY(2px) scale(0.92); }
        }
      `}</style>
      <div aria-hidden style={{ position: "absolute", pointerEvents: "none", zIndex: 5, ...cornerStyle }}>
        <span
          style={{
            display: "inline-block",
            fontSize: "32cqw",
            fontWeight: 900,
            lineHeight: 0.9,
            fontFamily: "system-ui, -apple-system, sans-serif",
            color: "#7dd3fc",
            textShadow: "0 0 16px rgba(56,189,248,0.6), 0 0 28px rgba(56,189,248,0.35)",
            transformOrigin: "center bottom",
            animation: "ld-think-fade 10s ease-in-out infinite",
            willChange: "transform, opacity",
          }}
        >
          ?
        </span>
      </div>
    </>
  );
}
