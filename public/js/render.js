// Canvas renderer. The track (grass, asphalt, markings) never changes, so it
// is drawn once into an offscreen canvas and blitted with the camera
// transform each frame; only cars and labels are drawn per frame.

import { TRACK, TRACK_WIDTH, pointAt } from './track.js';
import { CAR } from './car.js';

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

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.marks = [];
    this.skidAt = new Map(); // car id -> last emit time
    this.skidPrev = new Map(); // `id:side` -> last wheel position
    const b = TRACK.bounds;
    this.world = {
      x: b.minX - WORLD_MARGIN,
      y: b.minY - WORLD_MARGIN,
      w: b.maxX - b.minX + WORLD_MARGIN * 2,
      h: b.maxY - b.minY + WORLD_MARGIN * 2,
    };
    this.static = this.buildStaticLayer();
    this.resize();
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
    const c = document.createElement('canvas');
    c.width = Math.ceil(this.world.w);
    c.height = Math.ceil(this.world.h);
    const g = c.getContext('2d');
    g.translate(-this.world.x, -this.world.y);

    // Grass with a little texture so motion is visible off-track.
    g.fillStyle = '#2b5231';
    g.fillRect(this.world.x, this.world.y, this.world.w, this.world.h);
    for (let i = 0; i < 900; i++) {
      const x = this.world.x + Math.random() * this.world.w;
      const y = this.world.y + Math.random() * this.world.h;
      g.fillStyle = Math.random() < 0.5 ? '#26492c' : '#315c38';
      g.fillRect(x, y, 5 + Math.random() * 9, 5 + Math.random() * 9);
    }

    const path = new Path2D();
    TRACK.pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();

    g.lineJoin = 'round';
    g.lineCap = 'round';
    // Edge lines, then asphalt on top.
    g.strokeStyle = '#dcdce2';
    g.lineWidth = TRACK_WIDTH + 12;
    g.stroke(path);
    g.strokeStyle = '#3a3d46';
    g.lineWidth = TRACK_WIDTH;
    g.stroke(path);
    // Dashed centerline.
    g.strokeStyle = 'rgba(220,220,226,0.28)';
    g.setLineDash([16, 30]);
    g.lineWidth = 3;
    g.stroke(path);
    g.setLineDash([]);

    // Checkered start/finish band across the track at s = 0.
    const p0 = pointAt(0);
    const nx = -Math.sin(p0.ang), ny = Math.cos(p0.ang);
    const tx = Math.cos(p0.ang), ty = Math.sin(p0.ang);
    const sq = 8, cols = 2, rows = Math.floor(TRACK_WIDTH / sq);
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

  // cars: [{x, y, heading, color, name, braking, isMe}]
  draw(camX, camY, cars, now) {
    const { ctx, dpr, zoom } = this;
    const vw = this.cssW, vh = this.cssH;

    // Clamp the camera so we never show past the world edge.
    const halfW = vw / 2 / zoom, halfH = vh / 2 / zoom;
    camX = Math.max(this.world.x + halfW, Math.min(this.world.x + this.world.w - halfW, camX));
    camY = Math.max(this.world.y + halfH, Math.min(this.world.y + this.world.h - halfH, camY));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1c3521';
    ctx.fillRect(0, 0, vw, vh);

    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.static, this.world.x, this.world.y);
    this.drawSkids(ctx, now);

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
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);
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
