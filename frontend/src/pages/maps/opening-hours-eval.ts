// Pure-TS port of the Python opening_hours_eval.py evaluator.
// Phase maps-discovery chunk-12.
// No external dependencies — avoids the opening_hours.js package requirement.
// Supports: 24/7, Mo-Fr HH:MM-HH:MM, comma days, multi-rule semicolon, midnight crossing.

const DAY: Record<string, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
const RULE_RE = /^([A-Za-z,\-]+)\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/;

function parseDays(spec: string): number[] | null {
  const result: number[] = [];
  for (const part of spec.trim().split(",")) {
    const p = part.trim();
    if (p.includes("-")) {
      const [a, b] = p.split("-");
      const si = DAY[a.trim().toLowerCase()], ei = DAY[b.trim().toLowerCase()];
      if (si == null || ei == null) return null;
      if (ei >= si) for (let i = si; i <= ei; i++) result.push(i);
      else { for (let i = si; i < 7; i++) result.push(i); for (let i = 0; i <= ei; i++) result.push(i); }
    } else {
      const idx = DAY[p.toLowerCase()];
      if (idx == null) return null;
      result.push(idx);
    }
  }
  return result;
}

function parseMinutes(t: string): number | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, mn] = m;
  const total = Number(h) * 60 + Number(mn);
  return total <= 1440 ? total : null;
}

function fmtTime(minutes: number): string {
  const h = (minutes % 1440) / 60 | 0, mn = minutes % 60;
  const suffix = h < 12 ? "AM" : "PM", h12 = h % 12 || 12;
  return mn ? `${h12}:${mn.toString().padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

export type OpenStatus = { isOpen: boolean | null; closesAt: string | null; opensAt: string | null };

export function evaluateOpeningHours(raw: string | null | undefined, now: Date): OpenStatus {
  if (!raw) return { isOpen: null, closesAt: null, opensAt: null };
  const s = raw.trim();
  if (s === "24/7" || s.toLowerCase() === "open") return { isOpen: true, closesAt: null, opensAt: null };
  const weekday = (now.getDay() + 6) % 7; // JS: 0=Sun → convert to Mo=0
  const nowM = now.getHours() * 60 + now.getMinutes();
  for (const rule of s.split(";")) {
    const r = rule.trim();
    if (!r || /^(PH|SH|holiday|off)\b/i.test(r)) continue;
    const m = RULE_RE.exec(r);
    if (!m) return { isOpen: null, closesAt: null, opensAt: null };
    const days = parseDays(m[1]);
    const startM = parseMinutes(m[2]), endM = parseMinutes(m[3]);
    if (!days || startM == null || endM == null) return { isOpen: null, closesAt: null, opensAt: null };
    if (!days.includes(weekday)) continue;
    const crosses = endM < startM;
    if (crosses ? (nowM >= startM || nowM < endM) : (startM <= nowM && nowM < endM))
      return { isOpen: true, closesAt: fmtTime(endM), opensAt: null };
    if (!crosses && nowM < startM) return { isOpen: false, closesAt: null, opensAt: fmtTime(startM) };
    return { isOpen: false, closesAt: null, opensAt: null };
  }
  return { isOpen: false, closesAt: null, opensAt: null };
}
