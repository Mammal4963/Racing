// Driving-model and circuit tests. No browser and no server needed — car.js
// and track.js are plain modules, so the handling can be checked directly.
//
// These lock in the numbers the game is actually tuned around: what a held
// drift pays, that a drift turns tighter than a flat corner, that the slide
// can't become a spin, and that no circuit has a spline cusp in it.

import { TRACK, TRACK_COUNT, setTrack, pointAt, project, progressDelta } from '../public/js/track.js';
import { createCar, stepCar, driftTier } from '../public/js/car.js';

const DT = 1 / 60;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) {
    console.log(`ok: ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// Hold a drift for `holdMs`, optionally spending `offMs` of it on the grass.
function heldDrift(holdMs, { offMs = 0, speed = 320, onTrack = true } = {}) {
  setTrack(0);
  const p = pointAt(0);
  const car = createCar(p.x, p.y, p.ang);
  car.speed = speed;
  car.travel = p.ang;
  let t = 0, tier = 0, boost = 0, dumped = false, peakCharge = 0, peakSlip = 0;
  while (t < holdMs / 1000 + 1) {
    const ms = t * 1000;
    const braking = ms < holdMs;
    const grounded = onTrack && !(ms > holdMs * 0.45 && ms < holdMs * 0.45 + offMs);
    stepCar(car, { steer: braking ? 1 : 0, brake: braking }, { onTrack: grounded, draft: 0 }, DT);
    peakCharge = Math.max(peakCharge, car.charge);
    peakSlip = Math.max(peakSlip, Math.abs(car.slip));
    if (car.released) { tier = car.released; boost = car.boostMs; }
    if (car.dumped) dumped = true;
    t += DT;
  }
  return { tier, boost: Math.round(boost), dumped, peakCharge, peakSlip, speed: car.speed };
}

// How far the car rotates in one second of full lock at 320.
function turnedIn1s(brake) {
  setTrack(0);
  const p = pointAt(0);
  const car = createCar(p.x, p.y, p.ang);
  car.speed = 320;
  car.travel = p.ang;
  const start = car.heading;
  for (let t = 0; t < 1; t += DT) {
    stepCar(car, { steer: 1, brake }, { onTrack: true, draft: 0 }, DT);
  }
  return { turned: Math.abs(car.heading - start), speed: car.speed };
}

// Terminal speed on a straight under a given amount of slipstream.
function topSpeed(draft) {
  setTrack(0);
  const p = pointAt(0);
  const car = createCar(p.x, p.y, p.ang);
  car.travel = p.ang;
  for (let t = 0; t < 6; t += DT) {
    stepCar(car, { steer: 0, brake: false }, { onTrack: true, draft }, DT);
  }
  return car.speed;
}

console.log('— drift boost —');
check('a short stab of brake pays nothing', heldDrift(300).tier === 0);
const t1 = heldDrift(500);
check('half a second of drift pays a boost', t1.tier >= 1 && t1.boost > 0, `tier ${t1.tier}, ${t1.boost}ms`);
const t2 = heldDrift(900);
check('a longer drift pays more', t2.tier > t1.tier && t2.boost > t1.boost, `tier ${t2.tier}, ${t2.boost}ms`);
const t3 = heldDrift(1300);
check('a full charge pays the top tier', t3.tier === 3, `tier ${t3.tier}, ${t3.boost}ms`);
check('boost leaves the car faster than it entered', t3.speed > heldDrift(1300).speed - 1 && t1.tier > 0);

console.log('\n— keeping it on the island —');
check('clipping the grass keeps the drift', heldDrift(1000, { offMs: 200 }).tier >= 1);
check('running properly wide throws it away', heldDrift(1000, { offMs: 500 }).tier === 0);
check('no charge is earned off track', heldDrift(1000, { onTrack: false }).peakCharge === 0);

console.log('\n— the slide is a drift, not a spin —');
const spin = heldDrift(2500);
check('slip angle stays driftable', spin.peakSlip <= 0.63, `peak ${spin.peakSlip.toFixed(2)} rad`);
const flat = turnedIn1s(false);
const slid = turnedIn1s(true);
check('drifting turns tighter than a flat corner',
  slid.turned > flat.turned * 1.3,
  `${slid.turned.toFixed(2)} vs ${flat.turned.toFixed(2)} rad/s`);
check('and costs speed to do it', slid.speed < flat.speed - 50, `${Math.round(slid.speed)} vs ${Math.round(flat.speed)}`);

console.log('\n— slipstream —');
const solo = topSpeed(0);
const towed = topSpeed(1);
check('a tow raises top speed', towed > solo * 1.1, `${Math.round(solo)} -> ${Math.round(towed)}`);
check('a partial tow gives a partial gain', topSpeed(0.5) > solo && topSpeed(0.5) < towed);

console.log('\n— circuits —');
// Flat-out cornering radius: at top speed the car turns at 3.1 * (1 - 0.5) rad/s.
const FLAT_OUT_RADIUS = 340 / (3.1 * 0.5);
for (let i = 0; i < TRACK_COUNT; i++) {
  setTrack(i);
  const { pts, cum, length, name } = TRACK;
  const m = pts.length;
  let minRadius = Infinity;
  for (let j = 0; j < m; j++) {
    const a = pts[(j - 3 + m) % m], b = pts[j], c = pts[(j + 3) % m];
    const A = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const B = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const C = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    if (area > 1e-6) minRadius = Math.min(minRadius, (A * B * C) / (4 * area));
  }
  // A cusp — the spline doubling back on itself — shows up as a tiny radius
  // and makes the road overlap, which wrecks lap progress.
  check(`${name}: no spline cusp`, minRadius > 45, `tightest radius ${minRadius.toFixed(0)}`);
  check(`${name}: sensible lap length`, length > 3000 && length < 8000, `${Math.round(length)} units`);
  check(`${name}: arc length is monotonic`, cum[m] === length && cum[0] === 0);

  // Hinted projection must agree with sweeping the whole circuit.
  let worst = 0;
  for (let s = 0; s < length; s += length / 40) {
    const p = pointAt(s);
    const off = { x: p.x - Math.sin(p.ang) * 20, y: p.y + Math.cos(p.ang) * 20 };
    const global = project(off.x, off.y);
    const hinted = project(off.x, off.y, s);
    worst = Math.max(worst, Math.abs(progressDelta(hinted.s, global.s)));
  }
  check(`${name}: hinted projection matches a full sweep`, worst < 1, `worst ${worst.toFixed(2)} units`);
}

setTrack(0);
console.log(failed ? `\n${failed} PHYSICS CHECK(S) FAILED` : '\nALL PHYSICS CHECKS PASSED');
process.exit(failed ? 1 : 0);
