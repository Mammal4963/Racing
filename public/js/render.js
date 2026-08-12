// Canvas renderer. The track (ground, asphalt, markings) never changes while
// a race is running, so it is drawn once into an offscreen canvas and blitted
// with the camera transform each frame; only cars, effects and labels are
// drawn per frame.

import { TRACK, pointAt } from './track.js';
import { CAR, TIER_COLOR } from './car.js';

export const PALETTE = [
  '#ff5252', '#40c4ff', '#ffd740', '#69f0ae',
  '#ff6ec7', '#ffab40', '#b388ff', '#64ffda',
];

const WORLD_MARGIN = 260;

// Skid marks: a capped ring of short segments that fade out. They are drawn
// live rather than baked into a second world-sized canvas — one 19MB layer is
// enough for a phone — and batched into a handful of paths by opacity so the
// whole trail costs a few strokes per frame instead of one per mark.
const SKID_LIFE_MS = 4200;
const SKID_MAX = 800;
const SKID_STEP_MS = 30; // how often one car lays down a new pair of marks
const SKID_BUCKETS = 4;

const PARTICLE_MAX = 400;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.marks = [];
    this.skidAt = new Map(); // car id -> last emit time
    this.skidPrev = new Map(); // `id:side` -> last wheel position
    this.parts = [];
    this.shake = 0;
    this.lastNow = 0;
    this.useTrack();
    this.resize();
  }

  // Rebuild everything that is baked per circuit. Called on every track swap.
  useTrack() {
    const b = TRACK.bounds;
    this.world = {
      x: b.minX - WORLD_MARGIN,
      y: b.minY - WORLD_MARGIN,
      w: b.maxX - b.minX + WORLD_MARGIN * 2,
      h: b.maxY - b.minY + WORLD_MARGIN * 2,
    };
    this.static = this.buildStaticLayer();
    this.clearSkids();
    this.parts.length = 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    this.zoom = Math.max(0.38, Math.min(1.1, Math.min(this.cssW, this.cssH) / 720));
  }

  buildStaticLayer() {
    const theme = TRACK.theme;
    const c = document.createElement('canvas');
    c.width = Math.ceil(this.world.w);
    c.height = Math.ceil(this.world.h);
    const g = c.getContext('2d');
    g.translate(-this.world.x, -this.world.y);

    // Ground with a little texture so motion is visible off-track.
    g.fillStyle = theme.ground;
    g.fillRect(this.world.x, this.world.y, this.world.w, this.world.h);
    for (let i = 0; i < 900; i++) {
      const x = this.world.x + Math.random() * this.world.w;
      const y = this.world.y + Math.random() * this.world.h;
      g.fillStyle = theme.groundAlt[Math.random() < 0.5 ? 0 : 1];
      g.fillRect(x, y, 5 + Math.random() * 9, 5 + Math.random() * 9);
    }

    const path = new Path2D();
    TRACK.pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();

    g.lineJoin = 'round';
    g.lineCap = 'round';
    // Edge lines, then asphalt on top.
    g.strokeStyle = theme.edge;
    g.lineWidth = TRACK.width + 12;
    g.stroke(path);
    g.strokeStyle = theme.road;
    g.lineWidth = TRACK.width;
    g.stroke(path);
    // Dashed centerline.
    g.strokeStyle = theme.mid;
    g.setLineDash([16, 30]);
    g.lineWidth = 3;
    g.stroke(path);
    g.setLineDash([]);

    // Checkered start/finish band across the track at s = 0.
    const p0 = pointAt(0);
    const nx = -Math.sin(p0.ang), ny = Math.cos(p0.ang);
    const tx = Math.cos(p0.ang), ty = Math.sin(p0.ang);
    const sq = 8, cols = 2, rows = Math.floor(TRACK.width / sq);
    for (let cI = 0; cI < cols; cI++) {
      for (let r = 0; r < rows; r++) {
        g.fillStyle = (cI + r) % 2 === 0 ? '#f2f2f5' : '#17181d';
        const cx = p0.x + tx * (cI - cols / 2) * sq + nx * (r - rows / 2) * sq;
        const cy = p0.y + ty * (cI - cols / 2) * sq + ny * (r - rows / 2) * sq;
        g.save();
        g.translate(cx, cy);
        g.rotate(p0.ang);
        g.fillRect(0, 0, sq, sq);
        g.restore();
      }
    }
    return c;
  }

  // ------------------------------------------------------------- skid marks

  clearSkids() {
    this.marks.length = 0;
    this.skidAt.clear();
    this.skidPrev.clear();
  }

  // Lay rubber under one car's rear wheels. `strength` is 0..1.
  skid(id, x, y, heading, now, strength) {
    if (now - (this.skidAt.get(id) || 0) < SKID_STEP_MS) return;
    this.skidAt.set(id, now);
    const cos = Math.cos(heading), sin = Math.sin(heading);
    const bx = x - cos * CAR.LEN * 0.3, by = y - sin * CAR.LEN * 0.3;
    const ox = -sin * (CAR.WID / 2 - 1), oy = cos * (CAR.WID / 2 - 1);
    for (const side of [-1, 1]) {
      const px = bx + ox * side, py = by + oy * side;
      const key = `${id}:${side}`;
      const prev = this.skidPrev.get(key);
      this.skidPrev.set(key, { x: px, y: py, t: now });
      if (!prev || now - prev.t > 140) continue; // trail broken — start fresh
      const d2 = (px - prev.x) ** 2 + (py - prev.y) ** 2;
      if (d2 < 1 || d2 > 8100) continue; // stationary, or a teleport/respawn
      this.marks.push({
        x1: prev.x, y1: prev.y, x2: px, y2: py, born: now, s: strength,
      });
    }
    while (this.marks.length > SKID_MAX) this.marks.shift();
  }

  drawSkids(ctx, now) {
    const marks = this.marks;
    while (marks.length && now - marks[0].born > SKID_LIFE_MS) marks.shift();
    if (!marks.length) return;
    const paths = Array.from({ length: SKID_BUCKETS }, () => new Path2D());
    for (const m of marks) {
      const life = 1 - (now - m.born) / SKID_LIFE_MS;
      const b = Math.max(0, Math.min(SKID_BUCKETS - 1, (life * m.s * SKID_BUCKETS) | 0));
      paths[b].moveTo(m.x1, m.y1);
      paths[b].lineTo(m.x2, m.y2);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    for (let b = 0; b < SKID_BUCKETS; b++) {
      ctx.strokeStyle = `rgba(22,20,24,${0.06 + b * 0.055})`;
      ctx.stroke(paths[b]);
    }
  }

  // -------------------------------------------------------------- particles

  spawn(x, y, vx, vy, life, size, color, grow = 0) {
    if (this.parts.length >= PARTICLE_MAX) this.parts.shift();
    this.parts.push({ x, y, vx, vy, life, max: life, size, color, grow });
  }

  // Dirt kicked up by a car running off the asphalt.
  dirt(x, y, heading, speed) {
    const back = heading + Math.PI;
    const spread = (Math.random() - 0.5) * 1.4;
    const v = 30 + speed * 0.25;
    this.spawn(
      x + (Math.random() - 0.5) * 12,
      y + (Math.random() - 0.5) * 12,
      Math.cos(back + spread) * v,
      Math.sin(back + spread) * v,
      0.5 + Math.random() * 0.3,
      3 + Math.random() * 4,
      TRACK.theme.groundAlt[Math.random() < 0.5 ? 0 : 1],
      14
    );
  }

  // Exhaust flame while the turbo is lit.
  flame(x, y, heading, tier) {
    const back = heading + Math.PI;
    const spread = (Math.random() - 0.5) * 0.5;
    const v = 60 + Math.random() * 90;
    this.spawn(
      x + Math.cos(back) * CAR.LEN * 0.5,
      y + Math.sin(back) * CAR.LEN * 0.5,
      Math.cos(back + spread) * v,
      Math.sin(back + spread) * v,
      0.28 + Math.random() * 0.18,
      4 + Math.random() * 5,
      Math.random() < 0.45 ? '#fff3c4' : TIER_COLOR[tier] || '#ffab40',
      -6
    );
  }

  // Sparks off the tyres as a drift charges up.
  spark(x, y, heading, tier) {
    const back = heading + Math.PI;
    const spread = (Math.random() - 0.5) * 1.8;
    const v = 70 + Math.random() * 120;
    this.spawn(
      x, y,
      Math.cos(back + spread) * v,
      Math.sin(back + spread) * v,
      0.18 + Math.random() * 0.16,
      2 + Math.random() * 2.5,
      TIER_COLOR[tier],
      -4
    );
  }

  burst(x, y, tier) {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * 170;
      this.spawn(x, y, Math.cos(a) * v, Math.sin(a) * v,
        0.3 + Math.random() * 0.25, 3 + Math.random() * 4, TIER_COLOR[tier], -5);
    }
  }

  stepParticles(dt) {
    const parts = this.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) {
        parts.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2.6 * dt;
      p.vy *= 1 - 2.6 * dt;
      p.size = Math.max(0.5, p.size + p.grow * dt);
    }
  }

  drawParticles(ctx) {
    for (const p of this.parts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  kick(amount) {
    this.shake = Math.min(26, this.shake + amount);
  }

  // ------------------------------------------------------------------ frame

  // cars: [{x, y, heading, color, name, braking, isMe, boosting, charge,
  //         tier, draft}]
  draw(camX, camY, cars, now, opts = {}) {
    const dt = this.lastNow ? Math.min(0.05, (now - this.lastNow) / 1000) : 0.016;
    this.lastNow = now;
    this.stepParticles(dt);

    const { ctx, dpr } = this;
    const vw = this.cssW, vh = this.cssH;
    const speedRatio = opts.speedRatio || 0;
    // Pull the camera back as the car winds up — the road arrives faster and
    // you can see more of what is coming.
    const zoom = this.zoom * (1 - 0.13 * speedRatio);

    // Clamp the camera so we never show past the world edge.
    const halfW = vw / 2 / zoom, halfH = vh / 2 / zoom;
    const wx = this.world.x, wy = this.world.y;
    camX = Math.max(wx + halfW, Math.min(wx + this.world.w - halfW, camX));
    camY = Math.max(wy + halfH, Math.min(wy + this.world.h - halfH, camY));

    if (this.shake > 0.2) {
      camX += (Math.random() - 0.5) * this.shake;
      camY += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.max(0, 1 - 7 * dt);
    } else {
      this.shake = 0;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = TRACK.theme.void;
    ctx.fillRect(0, 0, vw, vh);

    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.static, this.world.x, this.world.y);
    this.drawSkids(ctx, now);
    this.drawParticles(ctx);

    for (const car of cars) this.drawCar(ctx, car);

    // Name labels on top of everything, at a fixed on-screen size.
    const fs = 13 / zoom;
    ctx.textAlign = 'center';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    for (const car of cars) {
      if (car.isMe || !car.name) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const w = ctx.measureText(car.name).width + fs * 0.8;
      ctx.fillRect(car.x - w / 2, car.y - 30 - fs * 1.15, w, fs * 1.45);
      ctx.fillStyle = '#fff';
      ctx.fillText(car.name, car.x, car.y - 30);
    }
    ctx.restore();
  }

  drawCar(ctx, car) {
    const { LEN, WID } = CAR;
    // Slipstream: streaks pulled off the car you are tucked in behind.
    if (car.draft > 0.15) {
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(car.heading);
      ctx.strokeStyle = `rgba(200,235,255,${0.12 + car.draft * 0.3})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = -1; i <= 1; i += 2) {
        const oy = i * (WID / 2 + 3);
        ctx.moveTo(-LEN * 0.4, oy);
        ctx.lineTo(-LEN * 0.4 - 22 - car.draft * 26, oy);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);

    // Charge glow builds under the car as a drift is held.
    if (car.charge > 0.05) {
      const tier = car.tier || 0;
      ctx.fillStyle = TIER_COLOR[tier] || '#ffffff';
      ctx.globalAlpha = 0.14 + car.charge * 0.3;
      ctx.beginPath();
      ctx.ellipse(0, 0, LEN * 0.85, WID * 0.95, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.roundRect(-LEN / 2 + 2, -WID / 2 + 3, LEN, WID, 5);
    ctx.fill();
    // Body
    ctx.fillStyle = car.color;
    ctx.beginPath();
    ctx.roundRect(-LEN / 2, -WID / 2, LEN, WID, 5);
    ctx.fill();
    // Windshield
    ctx.fillStyle = 'rgba(15,18,26,0.75)';
    ctx.beginPath();
    ctx.roundRect(LEN * 0.05, -WID / 2 + 3, LEN * 0.3, WID - 6, 2);
    ctx.fill();
    // Nose stripe for the local car so it's easy to spot.
    if (car.isMe) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(LEN / 2 - 6, -WID / 2 + 2, 3, WID - 4);
    }
    if (car.braking) {
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(-LEN / 2 - 2, -WID / 2 + 2, 3, 5);
      ctx.fillRect(-LEN / 2 - 2, WID / 2 - 7, 3, 5);
    }
    ctx.restore();
  }
}
