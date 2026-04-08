/**
 * BotttsSparks — decorative spark overlay for sick bottts.
 *
 * Six absolutely-positioned spark dots that fade in/out at jittered
 * positions and intervals around the head. CSS-only (no rAF), so it
 * costs basically nothing while running.
 *
 * Z-order: rendered BEHIND the avatar SVG (the avatar wrapper sits
 * above this layer in document order via positioning), so sparks
 * peek out from behind the silhouette.
 */
import React from "react";

const SPARKS = [
  { top: "12%", left: "18%", delay: "0s", dur: "1.6s" },
  { top: "8%",  left: "62%", delay: "0.7s", dur: "1.9s" },
  { top: "22%", left: "82%", delay: "1.2s", dur: "1.4s" },
  { top: "54%", left: "8%",  delay: "0.4s", dur: "2.1s" },
  { top: "38%", left: "88%", delay: "1.6s", dur: "1.7s" },
  { top: "30%", left: "48%", delay: "0.2s", dur: "2.3s" },
];

const BotttsSparks: React.FC = () => {
  return (
    <>
      <style>{`
        @keyframes ld-spark {
          0%, 100% { opacity: 0; transform: scale(0.4); }
          40%      { opacity: 1; transform: scale(1.0); }
          60%      { opacity: 1; transform: scale(1.1); }
        }
      `}</style>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
        }}
      >
        {SPARKS.map((s, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              top: s.top,
              left: s.left,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, #FFE26A 0%, #FFB020 50%, rgba(255,176,32,0) 75%)",
              filter: "blur(0.3px) drop-shadow(0 0 6px #FFC44A)",
              animation: `ld-spark ${s.dur} ease-in-out ${s.delay} infinite`,
            }}
          />
        ))}
      </div>
    </>
  );
};

export default BotttsSparks;
