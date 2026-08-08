// Arcade drift model. The car auto-accelerates; the player only steers and
// brakes. Velocity direction (`travel`) chases the nose direction (`heading`)
// at a grip-limited rate, which is what produces the slide in fast corners
// and on grass.

export const CAR = { LEN: 34, WID: 18 };

const ON_TRACK = { maxSpeed: 340, accel: 270, grip: 10 };
const ON_GRASS = { maxSpeed: 150, accel: 200, grip: 4.5 };
const BRAKE_DECEL = 520;
const OVERSPEED_DECEL = 320; // bleeding off speed after leaving the asphalt

export function createCar(x, y, heading) {
  return { x, y, heading, travel: heading, speed: 0 };
}

export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// input: { steer: -1..1, brake: bool }
export function stepCar(car, input, onTrack, dt) {
  const surf = onTrack ? ON_TRACK : ON_GRASS;

  if (input.brake) {
    car.speed = Math.max(0, car.speed - BRAKE_DECEL * dt);
  } else if (car.speed < surf.maxSpeed) {
    car.speed = Math.min(surf.maxSpeed, car.speed + surf.accel * dt);
  } else {
    car.speed = Math.max(surf.maxSpeed, car.speed - OVERSPEED_DECEL * dt);
  }

  // No pivoting in place, and slightly heavier steering at top speed.
  const speedFactor = Math.min(1, car.speed / 120);
  const highSpeedFactor = 1 - 0.35 * Math.min(1, car.speed / ON_TRACK.maxSpeed);
  car.heading += input.steer * 3.1 * speedFactor * highSpeedFactor * dt;

  car.travel += angleDelta(car.heading, car.travel) * Math.min(1, surf.grip * dt);
  car.x += Math.cos(car.travel) * car.speed * dt;
  car.y += Math.sin(car.travel) * car.speed * dt;
}
