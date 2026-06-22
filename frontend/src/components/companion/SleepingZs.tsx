import type { CSSProperties } from "react";

interface Props {
  tiltDeg?: number;
  grayscale?: boolean;
}

const ZS = [
  { delay: "0s", dur: "3.4s", startPx: 30, hueShift: 0 },
  { delay: "1.2s", dur: "3.8s", startPx: 36, hueShift: 6 },
  { delay: "2.4s", dur: "3.1s", startPx: 42, hueShift: -4 },
];

export default function SleepingZs({ tiltDeg = 0, grayscale = false }: Props) {
  const leansLeft = tiltDeg < -1;
  const cornerStyle: CSSProperties = leansLeft
    ? { top: "-18%", left: "8%", width: "50%", height: "50%" }
    : { top: "-18%", right: "8%", width: "50%", height: "50%" };
  const originLeft = leansLeft ? "22%" : "auto";
  const originRight = leansLeft ? "auto" : "22%";
  const driftSign = leansLeft ? -1 : 1;
  const keyframeName = leansLeft ? "ld-zzz-float-l" : "ld-zzz-float-r";

  return (
    <>
      <style>{`
        @keyframes ${keyframeName} {
          0%   { opacity: 0; transform: translate(0, 0) rotate(${-8 * driftSign}deg) scale(0.5); }
          12%  { opacity: 1; }
          30%  { transform: translate(${10 * driftSign}px, -25%) rotate(${6 * driftSign}deg) scale(0.85); }
          55%  { transform: translate(${-4 * driftSign}px, -55%) rotate(${-10 * driftSign}deg) scale(1.3); }
          78%  { transform: translate(${14 * driftSign}px, -80%) rotate(${8 * driftSign}deg) scale(1.7); opacity: 0.75; }
          100% { transform: translate(${-2 * driftSign}px, -105%) rotate(${-4 * driftSign}deg) scale(2.0); opacity: 0; }
        }
      `}</style>
      <div
        aria-hidden
        style={{ position: "absolute", pointerEvents: "none", zIndex: 2, filter: grayscale ? "grayscale(1)" : undefined, transition: "filter 600ms ease", ...cornerStyle }}
      >
        {ZS.map((z, index) => (
          <span
            key={index}
            style={{
              position: "absolute",
              left: originLeft,
              right: originRight,
              bottom: 0,
              fontSize: z.startPx,
              fontWeight: 900,
              fontFamily: "system-ui, -apple-system, sans-serif",
              color: "#7dd3fc",
              textShadow: "0 0 10px rgba(56,189,248,0.55)",
              filter: `hue-rotate(${z.hueShift}deg)`,
              animation: `${keyframeName} ${z.dur} ease-in-out ${z.delay} infinite`,
              willChange: "transform, opacity",
            }}
          >
            z
          </span>
        ))}
      </div>
    </>
  );
}
