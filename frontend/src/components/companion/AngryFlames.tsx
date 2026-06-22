interface Props {
  tiltDeg?: number;
}

const TONGUES = [
  { left: "8%", width: "26%", delay: "0s", dur: "1.6s", height: "55%" },
  { left: "30%", width: "30%", delay: "0.3s", dur: "1.4s", height: "70%" },
  { left: "55%", width: "26%", delay: "0.6s", dur: "1.8s", height: "60%" },
  { left: "72%", width: "22%", delay: "0.9s", dur: "1.5s", height: "50%" },
];

const EMBERS = [
  { left: "20%", delay: "0s", dur: "3.2s" },
  { left: "48%", delay: "1.0s", dur: "3.8s" },
  { left: "75%", delay: "2.0s", dur: "3.4s" },
];

export default function AngryFlames(_: Props) {
  return (
    <>
      <style>{`
        @keyframes ld-flame-flicker {
          0%   { transform: translateY(0)    scaleY(0.85) scaleX(1);    opacity: 0.85; }
          25%  { transform: translateY(-4%)  scaleY(1.15) scaleX(0.92); opacity: 1;    }
          50%  { transform: translateY(-2%)  scaleY(0.95) scaleX(1.05); opacity: 0.95; }
          75%  { transform: translateY(-6%)  scaleY(1.25) scaleX(0.88); opacity: 1;    }
          100% { transform: translateY(0)    scaleY(0.85) scaleX(1);    opacity: 0.85; }
        }
        @keyframes ld-flame-aura { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.9; } }
        @keyframes ld-ember-rise {
          0%   { transform: translateY(0)    scale(1);   opacity: 0;   }
          15%  { opacity: 1; }
          100% { transform: translateY(-140%) scale(0.4); opacity: 0;  }
        }
      `}</style>
      <div
        aria-hidden
        style={{ position: "absolute", inset: "-10% -12% -4% -12%", pointerEvents: "none", zIndex: 0, background: "radial-gradient(ellipse 70% 65% at 50% 60%, rgba(254,215,170,0.95) 0%, rgba(249,115,22,0.8) 35%, rgba(239,68,68,0.55) 60%, rgba(239,68,68,0) 82%)", filter: "blur(6px)", mixBlendMode: "screen", animation: "ld-flame-aura 3s ease-in-out infinite" }}
      />
      <div aria-hidden style={{ position: "absolute", inset: "20% -10% -10% -10%", pointerEvents: "none", zIndex: 0 }}>
        {TONGUES.map((t, index) => (
          <span
            key={index}
            style={{ position: "absolute", bottom: 0, left: t.left, width: t.width, height: t.height, borderRadius: "50% 50% 45% 45% / 80% 80% 30% 30%", background: "radial-gradient(ellipse 60% 80% at 50% 100%, rgba(254,240,138,0.95) 0%, rgba(251,146,60,0.9) 35%, rgba(239,68,68,0.85) 65%, rgba(239,68,68,0) 95%)", filter: "blur(0.5px)", transformOrigin: "50% 100%", mixBlendMode: "screen", animation: `ld-flame-flicker ${t.dur} ease-in-out ${t.delay} infinite`, willChange: "transform, opacity" }}
          />
        ))}
      </div>
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        {EMBERS.map((e, index) => (
          <span
            key={index}
            style={{ position: "absolute", bottom: "20%", left: e.left, width: 6, height: 6, borderRadius: "50%", background: "radial-gradient(circle, rgba(254,240,138,1) 0%, rgba(251,146,60,0.9) 60%, rgba(239,68,68,0) 100%)", boxShadow: "0 0 6px rgba(251,146,60,0.9)", animation: `ld-ember-rise ${e.dur} ease-out ${e.delay} infinite`, willChange: "transform, opacity" }}
          />
        ))}
      </div>
    </>
  );
}
