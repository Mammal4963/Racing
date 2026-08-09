// The circuits: closed centerlines sampled from Catmull-Rom splines through
// hand-placed control points, plus the geometry helpers the game needs
// (closest-point projection for lap progress + off-track detection).
//
// Each layout carries its own width and palette, so the tracks feel different
// to drive and read differently at a glance. `TRACK` is the one currently
// loaded — a live binding, so importers see the swap.

const LAYOUTS = [
  {
    name: 'Harbour Loop',
    blurb: 'flowing · forgiving',
    width: 96,
    theme: {
      ground: '#2b5231', groundAlt: ['#26492c', '#315c38'], void: '#1c3521',
      road: '#3a3d46', edge: '#dcdce2', mid: 'rgba(220,220,226,0.28)',
    },
    control: [
      [260, 1180], [700, 1290], [1250, 1300], [1750, 1220], [2010, 1000],
      [2030, 640], [1830, 430], [1500, 400], [1290, 560], [1040, 620],
      [830, 470], [520, 400], [280, 560], [200, 870],
    ],
  },
  {
    name: 'Sunset Ridge',
    blurb: 'wide open · very fast',
    width: 112,
    theme: {
      ground: '#6b4a33', groundAlt: ['#5d3f2b', '#785539'], void: '#4a3225',
      road: '#4a4048', edge: '#f0e0cc', mid: 'rgba(240,224,204,0.26)',
    },
    control: [
      [620, 1255], [1150, 1315], [1700, 1250], [2000, 1010], [2010, 700],
      [1750, 520], [1350, 500], [980, 545], [660, 620], [450, 780],
      [400, 980], [520, 1130],
    ],
  },
  {
    name: 'Chicane Bay',
    blurb: 'technical · brake late',
    width: 92,
    theme: {
      ground: '#2e4a58', groundAlt: ['#28414d', '#365664'], void: '#1e333d',
      road: '#39434a', edge: '#d8e4ea', mid: 'rgba(216,228,234,0.28)',
    },
    control: [
      [380, 1150], [760, 1270], [1120, 1195], [1265, 1290], [1580, 1250],
      [1900, 1120], [1990, 900], [1830, 755], [1570, 815], [1420, 670],
      [1150, 615], [900, 690], [640, 545], [400, 640], [285, 890],
    ],
  },
  {
    name: 'Nightport',
    blurb: 'tight · punishing',
    width: 84,
    theme: {
      ground: '#1d2230', groundAlt: ['#191d29', '#232838'], void: '#141821',
      road: '#2c3038', edge: '#c8ccd8', mid: 'rgba(200,204,216,0.22)',
    },
    control: [
      [350, 1080], [620, 1230], [900, 1120], [1080, 1250], [1380, 1230],
      [1600, 1060], [1560, 840], [1780, 700], [1900, 480], [1650, 380],
      [1350, 470], [1080, 420], [820, 500], [560, 460], [330, 620], [260, 860],
    ],
  },
];

const SAMPLES_PER_SEG = 12;

export const TRACK_COUNT = LAYOUTS.length;
export const trackInfo = (i) => {
  const l = LAYOUTS[((i % TRACK_COUNT) + TRACK_COUNT) % TRACK_COUNT];
  return { name: l.name, blurb: l.blurb };
};

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

function buildTrack(index) {
  const layout = LAYOUTS[((index % TRACK_COUNT) + TRACK_COUNT) % TRACK_COUNT];
  const CONTROL = layout.control;
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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return {
    index: ((index % TRACK_COUNT) + TRACK_COUNT) % TRACK_COUNT,
    name: layout.name,
    blurb: layout.blurb,
    theme: layout.theme,
    width: layout.width,
    half: layout.width / 2,
    pts,
    cum,
    length: cum[m],
    bounds: { minX, minY, maxX, maxY },
  };
}

export let TRACK = buildTrack(0);

export function setTrack(index) {
  TRACK = buildTrack(index);
  return TRACK;
}

const PROJECT_WINDOW = 420; // arc units searched either side of a hint

const wrapS = (s) => ((s % TRACK.length) + TRACK.length) % TRACK.length;

// Index of the centerline segment containing arc position s (s pre-wrapped).
function segIndexAt(s) {
  const { pts, cum } = TRACK;
  let lo = 0, hi = pts.length;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  return lo;
}

// Closest point over `count` segments starting at `first` (wraps).
function scan(x, y, first, count) {
  const { pts, cum, length } = TRACK;
  const m = pts.length;
  let bestD2 = Infinity, bestS = 0;
  for (let k = 0; k < count; k++) {
    const i = (first + k) % m;
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

// Closest point on the centerline. Returns arc position `s` in [0, length)
// and perpendicular distance `d` (d > TRACK.half means off the asphalt).
//
// Pass `hintS` — the caller's previous `s` — to search only the stretch of
// track around it. That is both cheaper than sweeping the whole circuit every
// frame and more correct: a car can never snap onto a different part of the
// lap that happens to run close by, which would hand it a chunk of free
// progress. If the car turns out to be nowhere near that stretch the search
// widens to the full track.
export function project(x, y, hintS) {
  const { pts, cum } = TRACK;
  const m = pts.length;
  if (hintS == null) return scan(x, y, 0, m);
  const first = segIndexAt(wrapS(hintS - PROJECT_WINDOW));
  let count = 0, arc = 0;
  while (arc < PROJECT_WINDOW * 2 && count < m) {
    const i = (first + count) % m;
    arc += cum[i + 1] - cum[i];
    count++;
  }
  const near = scan(x, y, first, count);
  return near.d > PROJECT_WINDOW ? scan(x, y, 0, m) : near;
}

// Point + tangent angle at arc position s.
export function pointAt(s) {
  const { pts, cum } = TRACK;
  const m = pts.length;
  s = wrapS(s);
  const lo = segIndexAt(s);
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
