// The circuit: a closed centerline sampled from a Catmull-Rom spline through
// hand-placed control points, plus the geometry helpers the game needs
// (closest-point projection for lap progress + off-track detection).

const CONTROL = [
  [260, 1180], [700, 1290], [1250, 1300], [1750, 1220], [2010, 1000],
  [2030, 640], [1830, 430], [1500, 400], [1290, 560], [1040, 620],
  [830, 470], [520, 400], [280, 560], [200, 870],
];
const SAMPLES_PER_SEG = 12;

export const TRACK_WIDTH = 96;
export const HALF_WIDTH = TRACK_WIDTH / 2;

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

function buildTrack() {
  const n = CONTROL.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = CONTROL[(i - 1 + n) % n];
    const p1 = CONTROL[i];
    const p2 = CONTROL[(i + 1) % n];
    const p3 = CONTROL[(i + 2) % n];
    for (let j = 0; j < SAMPLES_PER_SEG; j++) {
      pts.push(catmullRom(p0, p1, p2, p3, j / SAMPLES_PER_SEG));
    }
  }
  // Cumulative arc length; cum[i] is the distance at pts[i], cum[m] wraps.
  const m = pts.length;
  const cum = [0];
  for (let i = 1; i <= m; i++) {
    const a = pts[i - 1];
    const b = pts[i % m];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cum[m];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { pts, cum, length, bounds: { minX, minY, maxX, maxY } };
}

export const TRACK = buildTrack();

// Closest point on the centerline. Returns arc position `s` in [0, length)
// and perpendicular distance `d` (d > HALF_WIDTH means off the asphalt).
export function project(x, y) {
  const { pts, cum, length } = TRACK;
  const m = pts.length;
  let bestD2 = Infinity, bestS = 0;
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby || 1e-9;
    let t = ((x - a[0]) * abx + (y - a[1]) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + abx * t, py = a[1] + aby * t;
    const dx = x - px, dy = y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = (cum[i] + (cum[i + 1] - cum[i]) * t) % length;
    }
  }
  return { s: bestS, d: Math.sqrt(bestD2) };
}

// Point + tangent angle at arc position s.
export function pointAt(s) {
  const { pts, cum, length } = TRACK;
  const m = pts.length;
  s = ((s % length) + length) % length;
  let lo = 0, hi = m;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const a = pts[lo];
  const b = pts[(lo + 1) % m];
  const segLen = cum[lo + 1] - cum[lo] || 1e-9;
  const t = (s - cum[lo]) / segLen;
  return {
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    ang: Math.atan2(b[1] - a[1], b[0] - a[0]),
  };
}

// Signed shortest wrap-around delta between two arc positions.
export function progressDelta(s, lastS) {
  const L = TRACK.length;
  let d = s - lastS;
  if (d > L / 2) d -= L;
  if (d < -L / 2) d += L;
  return d;
}

// Starting grid: two staggered columns behind the start line (s = 0).
export function startSlots(count) {
  const slots = [];
  for (let i = 0; i < count; i++) {
    const s = TRACK.length - 55 - Math.floor(i / 2) * 52;
    const p = pointAt(s);
    const side = i % 2 === 0 ? -1 : 1;
    const nx = -Math.sin(p.ang), ny = Math.cos(p.ang);
    slots.push({
      x: p.x + nx * side * 24,
      y: p.y + ny * side * 24,
      heading: p.ang,
    });
  }
  return slots;
}
