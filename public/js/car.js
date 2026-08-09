// Arcade drift model. The car auto-accelerates; the player only steers and
// brakes. Velocity direction (`travel`) chases the nose direction (`heading`)
// at a grip-limited rate, which is what produces the slide in fast corners
// and on grass.
//
// Two things turn that slide into a game. Braking sharpens the steering and
// loosens the rear, so brake-and-turn provokes a drift on purpose; holding
// that drift charges a boost you get back when you straighten up. And running
// in another car's slipstream raises your top speed, so the pack pulls itself
// along even though the cars are ghosts and never touch.

export const CAR = { LEN: 34, WID: 18 };

const ON_TRACK = { maxSpeed: 340, accel: 270, grip: 10 };
const ON_GRASS = { maxSpeed: 150, accel: 200, grip: 4.5 };
const BRAKE_DECEL = 520;
const DRIFT_DECEL = 100; // braking *into a turn* is a handbrake, not an anchor
const DRIFT_STEER = 0.25; // steering past this turns the brake into a handbrake
const OVERSPEED_DECEL = 320; // bleeding off speed after leaving the asphalt

const BRAKE_STEER = 1.35; // how much harder the car turns under braking
const BRAKE_SLIDE = 0.45; // grip multiplier under braking — this is the drift
const MAX_SLIP = 0.62; // ~35°: past this the car catches itself instead of spinning

const DRIFT_SLIP = 0.22; // radians of slide before the tyres start charging
const DRIFT_MIN_SPEED = 130;
const CHARGE_PER_S = 0.8; // the harder the slide, the faster this fills
const CHARGE_DECAY = 2.5;
const RELEASE_GRACE_MS = 130; // ride out the wobble in a long drift
const DUMP_GRACE_MS = 260; // clipping the grass is survivable; running wide is not

// Charge thresholds and what each tier pays out.
const TIER_AT = [0.28, 0.62, 1];
const BOOST_MS = [0, 500, 900, 1400];
const BOOST_KICK = [0, 45, 75, 110];
export const TIER_COLOR = ['#ffffff', '#7fdbff', '#ffab40', '#e07bff'];

const BOOST_TOP = 0.26; // +26% top speed while the turbo is lit
const DRAFT_TOP = 0.17; // +17% top speed tucked in behind someone

export function driftTier(charge) {
  if (charge >= TIER_AT[2]) return 3;
  if (charge >= TIER_AT[1]) return 2;
  if (charge >= TIER_AT[0]) return 1;
  return 0;
}

export function createCar(x, y, heading) {
  return {
    x, y, heading,
    travel: heading,
    speed: 0,
    slip: 0,
    charge: 0,
    drifting: false,
    offSlipMs: 0,
    offTrackMs: 0,
    boostMs: 0,
    released: 0, // tier released this frame, for sound/particles/haptics
    dumped: false, // drift thrown away by running wide
    draft: 0,
  };
}

export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// input: { steer: -1..1, brake: bool }
// env:   { onTrack: bool, draft: 0..1 }
export function stepCar(car, input, env, dt) {
  const surf = env.onTrack ? ON_TRACK : ON_GRASS;
  const draft = env.draft || 0;
  car.draft = draft;
  car.released = 0;
  car.dumped = false;

  if (car.boostMs > 0) car.boostMs = Math.max(0, car.boostMs - dt * 1000);
  const boosting = car.boostMs > 0;

  const maxSpeed = surf.maxSpeed * (1 + DRAFT_TOP * draft + (boosting ? BOOST_TOP : 0));
  const accel = surf.accel * (1 + 0.4 * draft + (boosting ? 1.2 : 0));

  // Braking in a straight line is a real anchor; braking while turning breaks
  // the rear loose instead, so a drift carries its speed through the corner.
  const handbrake = input.brake && Math.abs(input.steer) > DRIFT_STEER;
  if (input.brake) {
    car.speed = Math.max(0, car.speed - (handbrake ? DRIFT_DECEL : BRAKE_DECEL) * dt);
  } else if (car.speed < maxSpeed) {
    car.speed = Math.min(maxSpeed, car.speed + accel * dt);
  } else {
    car.speed = Math.max(maxSpeed, car.speed - OVERSPEED_DECEL * dt);
  }

  // No pivoting in place, and much heavier steering at top speed — this is
  // what stops every corner being flat out, and so what gives the brake (and
  // the drift) something to do.
  const speedFactor = Math.min(1, car.speed / 120);
  const highSpeedFactor = 1 - 0.5 * Math.min(1, car.speed / ON_TRACK.maxSpeed);
  const steerGain = input.brake ? BRAKE_STEER : 1;
  car.heading += input.steer * 3.1 * speedFactor * highSpeedFactor * steerGain * dt;

  const grip = surf.grip * (input.brake ? BRAKE_SLIDE : 1);
  car.travel += angleDelta(car.heading, car.travel) * Math.min(1, grip * dt);

  // Hold the drift to a driftable angle. Without this the tail keeps coming
  // round until the car is travelling sideways and the slide is a spin — the
  // cap is what makes a held drift something you can steer through a corner.
  const slip = angleDelta(car.heading, car.travel);
  car.slip = Math.abs(slip) > MAX_SLIP ? Math.sign(slip) * MAX_SLIP : slip;
  if (car.slip !== slip) car.heading = car.travel + car.slip;

  car.x += Math.cos(car.travel) * car.speed * dt;
  car.y += Math.sin(car.travel) * car.speed * dt;
  stepDrift(car, env, maxSpeed, dt);
}

function stepDrift(car, env, maxSpeed, dt) {
  car.offTrackMs = env.onTrack ? 0 : car.offTrackMs + dt * 1000;

  // Run properly wide and the charge is gone — a drift only pays out if you
  // keep it on the asphalt. Brushing the grass for a moment is survivable,
  // which matters because a drift arc is tighter than the corner it's for.
  if (car.drifting && car.offTrackMs > DUMP_GRACE_MS) {
    car.drifting = false;
    car.dumped = car.charge >= TIER_AT[0];
    car.charge = 0;
    return;
  }

  const slip = Math.abs(car.slip);
  const sliding = env.onTrack && car.speed > DRIFT_MIN_SPEED && slip > DRIFT_SLIP;

  if (sliding) {
    // A proper sideways drift fills the meter far quicker than a mild slide,
    // so committing to the slide is what pays.
    car.charge = Math.min(1, car.charge + CHARGE_PER_S * Math.min(1.5, slip / 0.4) * dt);
    car.drifting = true;
    car.offSlipMs = 0;
    return;
  }

  if (!car.drifting) {
    car.charge = Math.max(0, car.charge - CHARGE_DECAY * dt);
    return;
  }
  if (!env.onTrack) return; // over the kerb mid-drift: freeze, don't cash in

  // Momentarily straight mid-drift — hold the charge briefly so a long slide
  // that wobbles through neutral doesn't cash itself in early.
  car.offSlipMs += dt * 1000;
  if (car.offSlipMs < RELEASE_GRACE_MS) return;

  car.drifting = false;
  const tier = driftTier(car.charge);
  if (tier > 0) {
    car.boostMs = Math.max(car.boostMs, BOOST_MS[tier]);
    car.speed = Math.min(maxSpeed * 1.3, car.speed + BOOST_KICK[tier]);
    car.released = tier;
  }
  car.charge = 0;
}
