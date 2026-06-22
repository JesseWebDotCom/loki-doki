const SPARKS = [
  { top: "12%", left: "18%", delay: "0s", dur: "1.6s" },
  { top: "8%", left: "62%", delay: "0.7s", dur: "1.9s" },
  { top: "22%", left: "82%", delay: "1.2s", dur: "1.4s" },
  { top: "54%", left: "8%", delay: "0.4s", dur: "2.1s" },
  { top: "38%", left: "88%", delay: "1.6s", dur: "1.7s" },
  { top: "30%", left: "48%", delay: "0.2s", dur: "2.3s" },
];

export default function BotttsSparks() {
  return (
    <>
      <style>{`
        @keyframes ld-spark {
          0%, 100% { opacity: 0; transform: scale(0.4); }
          40% { opacity: 1; transform: scale(1); }
          60% { opacity: 1; transform: scale(1.1); }
        }
      `}</style>
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }}>
        {SPARKS.map((spark, index) => (
          <span
            key={index}
            style={{ position: "absolute", top: spark.top, left: spark.left, width: 10, height: 10, borderRadius: "50%", background: "radial-gradient(circle, #FFE26A 0%, #FFB020 50%, rgba(255,176,32,0) 75%)", filter: "blur(0.3px) drop-shadow(0 0 6px #FFC44A)", animation: `ld-spark ${spark.dur} ease-in-out ${spark.delay} infinite` }}
          />
        ))}
      </div>
    </>
  );
}
