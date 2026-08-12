// Experimental WebGL2 renderer — a 3D view of exactly the same game state.
//
// Nothing here touches the simulation. The physics stays flat (x, y, heading),
// and this module only decides how to *look* at it: the circuit centreline is
// extruded into a road mesh, a height field is draped over the world, and the
// cars are placed on the resulting surface. Elevation and banking are derived
// procedurally from the existing 2D control points, so no track data changes.
//
// Raw WebGL rather than a library: the whole scene is a few thousand
// triangles, and the project has no build step to hang a dependency off.

import { TRACK, project, pointAt } from './track.js';
import { CAR, TIER_COLOR } from './car.js';
import { perspective, lookAt, multiply, carModel, identity } from './glmath.js';

// --------------------------------------------------------------- height field

// Hills are sine terms over the lap, at integer harmonics so the elevation
// joins up seamlessly where the lap wraps.
const HILLS = [
  { k: 2, amp: 62, phase: 0.0 },
  { k: 3, amp: 31, phase: 1.1 },
  { k: 5, amp: 17, phase: 2.3 },
];
const MAX_BANK = 0.23; // radians of lean in the tightest corners
const ROAD_LIFT = 1.5; // keeps the road off the terrain it sits on

let bankTable = null; // per centreline sample

export function roadHeight(s, scale) {
  if (!scale) return 0;
  const L = TRACK.length;
  let h = 0;
  for (const t of HILLS) h += t.amp * Math.sin((2 * Math.PI * t.k * s) / L + t.phase);
  return h * scale;
}

function buildBanking(scale) {
  const { pts } = TRACK;
  const m = pts.length;
  const raw = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const a = pts[(i - 2 + m) % m], b = pts[i], c = pts[(i + 2) % m];
    const t1x = b[0] - a[0], t1y = b[1] - a[1];
    const t2x = c[0] - b[0], t2y = c[1] - b[1];
    const l1 = Math.hypot(t1x, t1y) || 1;
    const l2 = Math.hypot(t2x, t2y) || 1;
    const turn = (t1x * t2y - t1y * t2x) / (l1 * l2); // signed sine of the turn
    const curvature = turn / ((l1 + l2) / 2);
    raw[i] = Math.max(-1, Math.min(1, curvature * 100)) * MAX_BANK * scale;
  }
  // Smooth so the lean eases in and out rather than snapping at the apex.
  let cur = raw;
  for (let pass = 0; pass < 6; pass++) {
    const next = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      next[i] = (cur[(i - 1 + m) % m] + 2 * cur[i] + cur[(i + 1) % m]) / 4;
    }
    cur = next;
  }
  return cur;
}

// Sample index + interpolant for an arc position.
function sampleAt(s) {
  const { cum, pts, length } = TRACK;
  const m = pts.length;
  s = ((s % length) + length) % length;
  let lo = 0, hi = m;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cum[lo + 1] - cum[lo] || 1e-9;
  return { i: lo, t: (s - cum[lo]) / span };
}

export function bankAt(s) {
  if (!bankTable) return 0;
  const { i, t } = sampleAt(s);
  const m = bankTable.length;
  return bankTable[i] * (1 - t) + bankTable[(i + 1) % m] * t;
}

// Height of the land at a point. Under the asphalt this matches the banked
// road surface exactly — otherwise the ground pokes up through the lowered
// inside edge of every cambered corner — and then it falls away into a verge
// and gentle hills of its own.
function groundFrom(x, z, proj, scale) {
  if (!scale) return 0;
  const p = pointAt(proj.s);
  const nx = -Math.sin(p.ang), ny = Math.cos(p.ang);
  const lateral = (x - p.x) * nx + (z - p.y) * ny;
  const onRoad = Math.max(-TRACK.half, Math.min(TRACK.half, lateral));
  const banked = roadHeight(proj.s, scale) + onRoad * Math.sin(bankAt(proj.s));
  const off = Math.max(0, proj.d - TRACK.half);
  const verge = -10 * Math.min(1, off / 55);
  const away = Math.min(1, off / 260);
  const rolling = 26 * Math.sin(x * 0.0031) * Math.cos(z * 0.0027)
    + 15 * Math.sin((x + z) * 0.0043);
  return banked + (verge + rolling * away) * scale;
}

// Surface height and lean under a car, wherever it happens to be.
export function surfaceUnder(x, z, scale) {
  const proj = project(x, z);
  const onRoad = proj.d <= TRACK.half;
  return {
    y: groundFrom(x, z, proj, scale) + (onRoad ? ROAD_LIFT : 0),
    bank: onRoad ? bankAt(proj.s) : 0,
    s: proj.s,
  };
}

// ------------------------------------------------------------------- meshes

function pushBox(v, idx, cx, cy, cz, sx, sy, sz, tint, useCarColor) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    { n: [1, 0, 0], c: [[hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [-1, 0, 0], c: [[-hx, -hy, hz], [-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz]] },
    { n: [0, 1, 0], c: [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, -1, 0], c: [[-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 0, 1], c: [[-hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [0, 0, -1], c: [[hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
  ];
  for (const f of faces) {
    const base = v.length / 10;
    for (const c of f.c) {
      v.push(cx + c[0], cy + c[1], cz + c[2], f.n[0], f.n[1], f.n[2],
        tint[0], tint[1], tint[2], useCarColor);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// A low-poly car: body, cabin, four wheels and a nose flash.
function buildCarMesh() {
  const v = [], idx = [];
  const dark = [0.07, 0.08, 0.11];
  const rubber = [0.05, 0.05, 0.06];
  pushBox(v, idx, 0, 5.5, 0, 34, 8, 18, [1, 1, 1], 1);
  pushBox(v, idx, -2.5, 11.2, 0, 15, 6.5, 14, dark, 0);
  for (const fx of [11, -11]) {
    for (const fz of [8.6, -8.6]) pushBox(v, idx, fx, 3.2, fz, 9, 6.4, 3.6, rubber, 0);
  }
  pushBox(v, idx, 15.6, 6.5, 0, 1.6, 5, 12, [0.95, 0.95, 0.98], 0);
  return { data: new Float32Array(v), index: new Uint16Array(idx) };
}

function buildRoadMesh(scale) {
  const { pts, cum, length, half } = TRACK;
  const m = pts.length;
  const v = [], idx = [];
  for (let i = 0; i <= m; i++) {
    const j = i % m;
    const p = pts[j];
    const prev = pts[(j - 1 + m) % m], next = pts[(j + 1) % m];
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    const s = i === m ? length : cum[j];
    const bank = bankTable[j];
    const sinB = Math.sin(bank), cosB = Math.cos(bank);
    const h = roadHeight(s, scale);
    for (const side of [-1, 1]) {
      const o = side * half;
      v.push(
        p[0] + nx * o, h + o * sinB + ROAD_LIFT, p[1] + ny * o,
        nx * sinB, cosB, ny * sinB,
        (side + 1) / 2, s
      );
    }
    if (i < m) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  return { data: new Float32Array(v), index: new Uint32Array(idx) };
}

function buildTerrainMesh(scale) {
  const b = TRACK.bounds;
  const MARGIN = 700;
  const x0 = b.minX - MARGIN, x1 = b.maxX + MARGIN;
  const z0 = b.minY - MARGIN, z1 = b.maxY + MARGIN;
  const NX = 104, NZ = 78;
  const heights = new Float32Array(NX * NZ);
  const xs = new Float32Array(NX), zs = new Float32Array(NZ);
  for (let ix = 0; ix < NX; ix++) xs[ix] = x0 + ((x1 - x0) * ix) / (NX - 1);
  for (let iz = 0; iz < NZ; iz++) zs[iz] = z0 + ((z1 - z0) * iz) / (NZ - 1);
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      const proj = project(xs[ix], zs[iz]);
      heights[iz * NX + ix] = groundFrom(xs[ix], zs[iz], proj, scale);
    }
  }
  const v = [], idx = [];
  const at = (ix, iz) => heights[Math.min(NZ - 1, Math.max(0, iz)) * NX + Math.min(NX - 1, Math.max(0, ix))];
  const dx = xs[1] - xs[0], dz = zs[1] - zs[0];
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      const nx = (at(ix - 1, iz) - at(ix + 1, iz)) / (2 * dx);
      const nz = (at(ix, iz - 1) - at(ix, iz + 1)) / (2 * dz);
      const len = Math.hypot(nx, 1, nz);
      v.push(xs[ix], heights[iz * NX + ix], zs[iz], nx / len, 1 / len, nz / len, ix, iz);
    }
  }
  for (let iz = 0; iz < NZ - 1; iz++) {
    for (let ix = 0; ix < NX - 1; ix++) {
      const a = iz * NX + ix, c = a + 1, d = a + NX, e = d + 1;
      idx.push(a, d, c, c, d, e);
    }
  }
  return { data: new Float32Array(v), index: new Uint32Array(idx) };
}

// ------------------------------------------------------------------ shaders

// Attribute locations are pinned with layout qualifiers — without them the
// linker is free to assign whatever it likes and the buffer bindings below
// would be feeding the wrong values into the wrong slots.
const VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
uniform mat4 uViewProj; uniform mat4 uModel;
out vec3 vNormal; out vec2 vUV; out vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV;
  gl_Position = uViewProj * w;
}`;

const CAR_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aTint;
layout(location = 3) in float aUseColor;
uniform mat4 uViewProj; uniform mat4 uModel;
out vec3 vNormal; out vec3 vWorld; out vec3 vTint; out float vUseColor;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vTint = aTint;
  vUseColor = aUseColor;
  gl_Position = uViewProj * w;
}`;

const FOG = `
vec3 applyFog(vec3 c, vec3 world) {
  float dist = length(world - uEye);
  float f = 1.0 - exp(-uFogDensity * dist);
  return mix(c, uFog, clamp(f, 0.0, 0.92));
}`;

const LIGHT = `
float lambert(vec3 n) {
  return max(dot(normalize(n), normalize(uLight)), 0.0);
}`;

const TERRAIN_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal; in vec2 vUV; in vec3 vWorld;
uniform vec3 uGround; uniform vec3 uGroundAlt; uniform vec3 uLight;
uniform vec3 uFog; uniform float uFogDensity; uniform vec3 uEye;
out vec4 frag;
${LIGHT}
${FOG}
float hash(vec2 cell) {
  return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  // Two octaves at low contrast: enough texture to read motion over the
  // ground without turning into a chequerboard.
  float r = hash(floor(vWorld.xz / 16.0)) * 0.55 + hash(floor(vWorld.xz / 51.0)) * 0.45;
  vec3 base = mix(uGround, uGroundAlt, smoothstep(0.34, 0.66, r));
  vec3 c = base * (0.42 + 0.62 * lambert(vNormal));
  frag = vec4(applyFog(c, vWorld), 1.0);
}`;

const ROAD_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal; in vec2 vUV; in vec3 vWorld;
uniform vec3 uRoad; uniform vec3 uEdge; uniform vec3 uLight;
uniform vec3 uFog; uniform float uFogDensity; uniform vec3 uEye;
out vec4 frag;
${LIGHT}
${FOG}
void main() {
  float u = vUV.x, v = vUV.y;
  float aa = fwidth(u) * 1.2 + 0.001;
  // Painted edge lines.
  float e = min(u, 1.0 - u);
  float edge = 1.0 - smoothstep(0.036 - aa, 0.036 + aa, e);
  // Dashed centre line.
  float mid = 1.0 - smoothstep(0.010 - aa, 0.010 + aa, abs(u - 0.5));
  float dash = step(fract(v / 74.0), 0.42);
  vec3 c = mix(uRoad, uEdge, max(edge, mid * dash * 0.75));
  // Start/finish chequer in the first few metres of the lap.
  float band = step(v, 20.0);
  float chk = mod(floor(u * 12.0) + floor(v / 10.0), 2.0);
  c = mix(c, mix(vec3(0.08), vec3(0.93), chk), band);
  c *= 0.42 + 0.62 * lambert(vNormal);
  frag = vec4(applyFog(c, vWorld), 1.0);
}`;

const CAR_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vWorld; in vec3 vTint; in float vUseColor;
uniform vec3 uColor; uniform vec3 uLight;
uniform vec3 uFog; uniform float uFogDensity; uniform vec3 uEye;
out vec4 frag;
${LIGHT}
${FOG}
void main() {
  vec3 base = mix(vTint, uColor, vUseColor);
  float l = lambert(vNormal);
  vec3 c = base * (0.34 + 0.7 * l);
  // A hint of specular so the bodywork reads as a surface, not a flat blob.
  c += vec3(1.0) * pow(l, 24.0) * 0.25;
  frag = vec4(applyFog(c, vWorld), 1.0);
}`;

// A soft blob under each car. Without it the cars read as hovering, most
// obviously from the steeper camera angles.
const SHADOW_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
uniform mat4 uViewProj; uniform mat4 uModel;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const SHADOW_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 frag;
void main() {
  // Full strength out past the bodywork, then a soft edge — the middle of the
  // blob is hidden under the car and does no work.
  float a = (1.0 - smoothstep(0.5, 1.0, length(vUV))) * 0.5;
  frag = vec4(0.0, 0.0, 0.0, a);
}`;

// Skid marks and particles share one unlit, blended, vertex-coloured pass.
const FX_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aColor;
layout(location = 2) in float aAlpha;
layout(location = 3) in vec2 aUV;
uniform mat4 uViewProj;
out vec3 vColor; out float vAlpha; out vec3 vWorld; out vec2 vUV;
void main() {
  vColor = aColor; vAlpha = aAlpha; vWorld = aPos; vUV = aUV;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FX_FRAG = `#version 300 es
precision highp float;
in vec3 vColor; in float vAlpha; in vec3 vWorld; in vec2 vUV;
uniform vec3 uFog; uniform float uFogDensity; uniform vec3 uEye;
out vec4 frag;
void main() {
  // Particles carry corner UVs and come out round; skid quads pass (0,0) on
  // every corner, so the falloff is a no-op and they stay square.
  float fall = 1.0 - smoothstep(0.55, 1.0, length(vUV));
  float dist = length(vWorld - uEye);
  float f = 1.0 - exp(-uFogDensity * dist);
  frag = vec4(mix(vColor, uFog, clamp(f, 0.0, 0.92)), vAlpha * fall);
}`;

const SKY_VERT = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 1.0, 1.0);
}`;

const SKY_FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform vec3 uTop; uniform vec3 uHorizon;
out vec4 frag;
void main() {
  float t = clamp(vNdc.y * 0.5 + 0.5, 0.0, 1.0);
  frag = vec4(mix(uHorizon, uTop, pow(t, 0.75)), 1.0);
}`;

// --------------------------------------------------------------- the renderer

// Four rigs. `lead` is tuned per rig so the followed car sits at the same
// spot on screen (~68% down) in all of them — otherwise you end up comparing
// framing rather than camera angle.
export const CAMERAS = {
  chase: { back: 150, up: 72, lead: 150, fov: 62, label: 'Chase' },
  raised: { back: 200, up: 175, lead: 90, fov: 54, label: 'Raised chase' },
  sweep: { back: 185, up: 290, lead: 70, fov: 48, label: 'Sweep' },
  high: { back: 160, up: 440, lead: 70, fov: 44, label: 'High angle' },
};

const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

const SKID_LIFE_MS = 4200;
const SKID_MAX = 700;
const SKID_STEP_MS = 30;
const SKID_WIDTH = 2.8;
const PARTICLE_MAX = 340;
const MAX_QUADS = SKID_MAX + PARTICLE_MAX;
const CAM_LERP = 8; // camera catch-up rate

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    gl.enable(gl.DEPTH_TEST);

    this.progTerrain = this.program(VERT, TERRAIN_FRAG);
    this.progRoad = this.program(VERT, ROAD_FRAG);
    this.progCar = this.program(CAR_VERT, CAR_FRAG);
    this.progSky = this.program(SKY_VERT, SKY_FRAG);
    this.progShadow = this.program(SHADOW_VERT, SHADOW_FRAG);
    this.progFx = this.program(FX_VERT, FX_FRAG);

    this.car = this.upload(buildCarMesh(), [3, 3, 3, 1], gl.UNSIGNED_SHORT);
    this.shadow = this.upload({
      data: new Float32Array([
        -31, 0, -19, -1, -1, 31, 0, -19, 1, -1,
        31, 0, 19, 1, 1, -31, 0, 19, -1, 1,
      ]),
      index: new Uint16Array([0, 1, 2, 0, 2, 3]),
    }, [3, 2], gl.UNSIGNED_SHORT);
    this.emptyVao = gl.createVertexArray();
    this.buildFxBuffers();

    this.marks = [];
    this.skidAt = new Map();
    this.skidPrev = new Map();
    this.parts = [];
    this.shake = 0;
    this.lastNow = 0;
    this.camName = 'sweep';
    this.heightScale = 1;
    this.cam = null; // smoothed {eye, target}
    this.labels = [];
    this.resize();
  }

  program(vsrc, fsrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) + '\n' + src);
      }
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  upload(mesh, sizes, indexType) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    const stride = sizes.reduce((a, b) => a + b, 0) * 4;
    let offset = 0;
    sizes.forEach((size, i) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, size, gl.FLOAT, false, stride, offset);
      offset += size * 4;
    });
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: mesh.index.length, type: indexType || gl.UNSIGNED_INT };
  }

  // One dynamic quad buffer, refilled each frame, for skids and particles.
  buildFxBuffers() {
    const gl = this.gl;
    this.fxData = new Float32Array(MAX_QUADS * 4 * 9);
    const idx = new Uint16Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4, o = q * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    this.fxVao = gl.createVertexArray();
    gl.bindVertexArray(this.fxVao);
    this.fxVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.fxData.byteLength, gl.DYNAMIC_DRAW);
    [3, 3, 1, 2].forEach((size, i) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, size, gl.FLOAT, false, 36, [0, 12, 24, 28][i]);
    });
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  setCamera(name) {
    if (!CAMERAS[name]) return;
    this.camName = name;
    this.cam = null; // re-frame instantly rather than swooping across
  }

  // Rebuild everything baked per circuit. heightScale 0 = flat, 1 = full relief.
  useTrack(heightScale = this.heightScale) {
    this.heightScale = heightScale;
    bankTable = buildBanking(heightScale);
    this.road = this.upload(buildRoadMesh(heightScale), [3, 3, 2]);
    this.terrain = this.upload(buildTerrainMesh(heightScale), [3, 3, 2]);
    const t = TRACK.theme;
    this.colors = {
      ground: hex(t.ground),
      groundAlt: hex(t.groundAlt[1]),
      road: hex(t.road),
      edge: hex(t.edge),
      fog: hex(t.sky ? t.sky[1] : t.void),
      skyTop: hex(t.sky ? t.sky[0] : t.void),
      skyHorizon: hex(t.sky ? t.sky[1] : t.void),
    };
    this.clearSkids();
    this.cam = null;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
  }

  groundY(x, z) {
    return surfaceUnder(x, z, this.heightScale).y;
  }

  // ------------------------------------------------------------- effects

  clearSkids() {
    this.marks.length = 0;
    this.skidAt.clear();
    this.skidPrev.clear();
    this.parts.length = 0;
  }

  kick(amount) {
    this.shake = Math.min(26, this.shake + amount);
  }

  skid(id, x, z, heading, now, strength) {
    if (now - (this.skidAt.get(id) || 0) < SKID_STEP_MS) return;
    this.skidAt.set(id, now);
    const cos = Math.cos(heading), sin = Math.sin(heading);
    const bx = x - cos * CAR.LEN * 0.3, bz = z - sin * CAR.LEN * 0.3;
    const ox = -sin * (CAR.WID / 2 - 1), oz = cos * (CAR.WID / 2 - 1);
    for (const side of [-1, 1]) {
      const px = bx + ox * side, pz = bz + oz * side;
      const key = `${id}:${side}`;
      const prev = this.skidPrev.get(key);
      // Height is baked in once — the mark never moves again.
      const py = this.groundY(px, pz) + 0.6;
      this.skidPrev.set(key, { x: px, y: py, z: pz, t: now });
      if (!prev || now - prev.t > 140) continue;
      const d2 = (px - prev.x) ** 2 + (pz - prev.z) ** 2;
      if (d2 < 1 || d2 > 8100) continue;
      this.marks.push({
        x1: prev.x, y1: prev.y, z1: prev.z,
        x2: px, y2: py, z2: pz, born: now, s: strength,
      });
    }
    while (this.marks.length > SKID_MAX) this.marks.shift();
  }

  spawn(x, y, z, vx, vy, vz, life, size, color, grow = 0) {
    if (this.parts.length >= PARTICLE_MAX) this.parts.shift();
    this.parts.push({ x, y, z, vx, vy, vz, life, max: life, size, color, grow });
  }

  dirt(x, z, heading, speed) {
    const back = heading + Math.PI;
    const spread = (Math.random() - 0.5) * 1.4;
    const v = 30 + speed * 0.25;
    const y = this.groundY(x, z);
    this.spawn(
      x + (Math.random() - 0.5) * 12, y + 3, z + (Math.random() - 0.5) * 12,
      Math.cos(back + spread) * v, 40 + Math.random() * 50, Math.sin(back + spread) * v,
      0.5 + Math.random() * 0.3, 3.5 + Math.random() * 4,
      hex(TRACK.theme.groundAlt[Math.random() < 0.5 ? 0 : 1]), 14
    );
  }

  flame(x, z, heading, tier) {
    const back = heading + Math.PI;
    const spread = (Math.random() - 0.5) * 0.5;
    const v = 60 + Math.random() * 90;
    const y = this.groundY(x, z);
    this.spawn(
      x + Math.cos(back) * CAR.LEN * 0.5, y + 6, z + Math.sin(back) * CAR.LEN * 0.5,
      Math.cos(back + spread) * v, 12, Math.sin(back + spread) * v,
      0.28 + Math.random() * 0.18, 4.5 + Math.random() * 5,
      hex(Math.random() < 0.45 ? '#fff3c4' : (TIER_COLOR[tier] || '#ffab40')), -6
    );
  }

  spark(x, z, heading, tier) {
    const back = heading + Math.PI;
    const spread = (Math.random() - 0.5) * 1.8;
    const v = 70 + Math.random() * 120;
    const y = this.groundY(x, z);
    this.spawn(
      x, y + 3, z,
      Math.cos(back + spread) * v, 55 + Math.random() * 60, Math.sin(back + spread) * v,
      0.18 + Math.random() * 0.16, 2.4 + Math.random() * 2.5,
      hex(TIER_COLOR[tier] || '#ffffff'), -4
    );
  }

  burst(x, z, tier) {
    const y = this.groundY(x, z);
    const color = hex(TIER_COLOR[tier] || '#ffffff');
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * 170;
      this.spawn(x, y + 6, z, Math.cos(a) * v, 60 + Math.random() * 90, Math.sin(a) * v,
        0.3 + Math.random() * 0.25, 3.5 + Math.random() * 4, color, -5);
    }
  }

  stepParticles(dt) {
    const parts = this.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - 2.6 * dt;
      p.vz *= 1 - 2.6 * dt;
      p.vy = p.vy * (1 - 2.0 * dt) - 120 * dt; // a little gravity
      p.size = Math.max(0.5, p.size + p.grow * dt);
    }
  }

  // ------------------------------------------------------------------ frame

  draw(camX, camY, cars, now, opts = {}) {
    const gl = this.gl;
    const dt = this.lastNow ? Math.min(0.05, (now - this.lastNow) / 1000) : 0.016;
    this.lastNow = now;
    this.stepParticles(dt);

    const cam = CAMERAS[this.camName] || CAMERAS.sweep;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);

    const placed = cars.map((c) => this.place(c));
    const follow = opts.follow || cars.find((c) => c.isMe) || cars[0];
    if (!follow) return;
    const me = this.place(follow);
    // Aim down the direction of travel, not the nose: mid-drift you want to
    // see where the car is going while it sits sideways in frame.
    const dir = (follow.speed ?? 0) > 25 ? (follow.travel ?? follow.heading) : follow.heading;
    const fx = Math.cos(dir), fz = Math.sin(dir);
    const wantEye = [me.x - fx * cam.back, me.y + cam.up, me.z - fz * cam.back];
    const wantTarget = [me.x + fx * cam.lead, me.y + 10, me.z + fz * cam.lead];

    if (!this.cam) this.cam = { eye: wantEye.slice(), target: wantTarget.slice() };
    const k = 1 - Math.exp(-CAM_LERP * dt);
    for (let i = 0; i < 3; i++) {
      this.cam.eye[i] += (wantEye[i] - this.cam.eye[i]) * k;
      this.cam.target[i] += (wantTarget[i] - this.cam.target[i]) * k;
    }

    const eye = this.cam.eye.slice();
    if (this.shake > 0.2) {
      for (let i = 0; i < 3; i++) eye[i] += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.max(0, 1 - 7 * dt);
    } else {
      this.shake = 0;
    }

    const view = lookAt(eye, this.cam.target);
    const proj = perspective((cam.fov * Math.PI) / 180, W / H, 6, 6000);
    const viewProj = multiply(proj, view);

    const toScreen = (x, y, z) => {
      const clip = [0, 1, 3].map((r) =>
        viewProj[r] * x + viewProj[4 + r] * y + viewProj[8 + r] * z + viewProj[12 + r]);
      if (clip[2] <= 0) return null;
      return {
        x: (clip[0] / clip[2] * 0.5 + 0.5) * this.cssW,
        y: (1 - (clip[1] / clip[2] * 0.5 + 0.5)) * this.cssH,
      };
    };
    this.debug = toScreen(me.x, me.y + 6, me.z);

    // Sky: clear depth, draw with the test off, then the world over the top.
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progSky.p);
    gl.uniform3fv(this.progSky.u.uTop, this.colors.skyTop);
    gl.uniform3fv(this.progSky.u.uHorizon, this.colors.skyHorizon);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);

    const common = (prog) => {
      gl.useProgram(prog.p);
      gl.uniformMatrix4fv(prog.u.uViewProj, false, viewProj);
      if (prog.u.uModel) gl.uniformMatrix4fv(prog.u.uModel, false, identity());
      if (prog.u.uLight) gl.uniform3fv(prog.u.uLight, [0.42, 0.83, -0.36]);
      gl.uniform3fv(prog.u.uFog, this.colors.fog);
      gl.uniform1f(prog.u.uFogDensity, 0.00052);
      gl.uniform3fv(prog.u.uEye, eye);
    };

    common(this.progTerrain);
    gl.uniform3fv(this.progTerrain.u.uGround, this.colors.ground);
    gl.uniform3fv(this.progTerrain.u.uGroundAlt, this.colors.groundAlt);
    gl.bindVertexArray(this.terrain.vao);
    gl.drawElements(gl.TRIANGLES, this.terrain.count, this.terrain.type, 0);

    common(this.progRoad);
    gl.uniform3fv(this.progRoad.u.uRoad, this.colors.road);
    gl.uniform3fv(this.progRoad.u.uEdge, this.colors.edge);
    gl.bindVertexArray(this.road.vao);
    gl.drawElements(gl.TRIANGLES, this.road.count, this.road.type, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    // Skid marks lie on the road, under everything else.
    const skidQuads = this.fillSkids(now);
    if (skidQuads) {
      common(this.progFx);
      gl.bindVertexArray(this.fxVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.fxData, 0, skidQuads * 36);
      gl.drawElements(gl.TRIANGLES, skidQuads * 6, gl.UNSIGNED_SHORT, 0);
    }

    // Contact shadows, then the cars over them.
    gl.useProgram(this.progShadow.p);
    gl.uniformMatrix4fv(this.progShadow.u.uViewProj, false, viewProj);
    gl.bindVertexArray(this.shadow.vao);
    placed.forEach((p, i) => {
      gl.uniformMatrix4fv(this.progShadow.u.uModel, false,
        carModel(p.x, p.y + 0.4, p.z, -cars[i].heading, p.pitch, p.roll));
      gl.drawElements(gl.TRIANGLES, this.shadow.count, this.shadow.type, 0);
    });
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    common(this.progCar);
    gl.bindVertexArray(this.car.vao);
    placed.forEach((p, i) => {
      gl.uniformMatrix4fv(this.progCar.u.uModel, false,
        carModel(p.x, p.y, p.z, -cars[i].heading, p.pitch, p.roll));
      gl.uniform3fv(this.progCar.u.uColor, hex(cars[i].color));
      gl.drawElements(gl.TRIANGLES, this.car.count, this.car.type, 0);
    });

    // Particles last so flames and dirt sit over the bodywork.
    const partQuads = this.fillParticles(eye, this.cam.target);
    if (partQuads) {
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      common(this.progFx);
      gl.bindVertexArray(this.fxVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.fxData, 0, partQuads * 36);
      gl.drawElements(gl.TRIANGLES, partQuads * 6, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);

    // Screen positions for the DOM name labels.
    this.labels = [];
    cars.forEach((c, i) => {
      if (c.isMe || !c.name) return;
      const s = toScreen(placed[i].x, placed[i].y + 26, placed[i].z);
      if (s && s.x > -80 && s.x < this.cssW + 80 && s.y > -40 && s.y < this.cssH + 40) {
        this.labels.push({ name: c.name, x: s.x, y: s.y });
      }
    });
  }

  // Pack skid segments into the quad buffer. Returns the quad count.
  fillSkids(now) {
    const marks = this.marks;
    while (marks.length && now - marks[0].born > SKID_LIFE_MS) marks.shift();
    const data = this.fxData;
    let q = 0;
    for (const m of marks) {
      if (q >= SKID_MAX) break;
      const dx = m.x2 - m.x1, dz = m.z2 - m.z1;
      const len = Math.hypot(dx, dz) || 1;
      const px = (-dz / len) * SKID_WIDTH, pz = (dx / len) * SKID_WIDTH;
      const a = (1 - (now - m.born) / SKID_LIFE_MS) * m.s * 0.5;
      const corners = [
        [m.x1 - px, m.y1, m.z1 - pz], [m.x2 - px, m.y2, m.z2 - pz],
        [m.x2 + px, m.y2, m.z2 + pz], [m.x1 + px, m.y1, m.z1 + pz],
      ];
      let o = q * 36;
      for (const c of corners) {
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
        data[o + 3] = 0.09; data[o + 4] = 0.08; data[o + 5] = 0.1;
        data[o + 6] = Math.max(0, a);
        data[o + 7] = 0; data[o + 8] = 0; // no radial falloff on rubber
        o += 9;
      }
      q++;
    }
    return q;
  }

  // Camera-facing billboards for the particles.
  fillParticles(eye, target) {
    const fwd = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(...fwd) || 1;
    fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;
    const right = [fwd[2], 0, -fwd[0]];
    const rl = Math.hypot(...right) || 1;
    right[0] /= rl; right[2] /= rl;
    const up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    const data = this.fxData;
    let q = 0;
    for (const p of this.parts) {
      if (q >= MAX_QUADS) break;
      const s = p.size;
      const a = Math.max(0, Math.min(1, p.life / p.max));
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      let o = q * 36;
      for (const [cx, cy] of corners) {
        data[o] = p.x + (right[0] * cx + up[0] * cy) * s;
        data[o + 1] = p.y + (right[1] * cx + up[1] * cy) * s;
        data[o + 2] = p.z + (right[2] * cx + up[2] * cy) * s;
        data[o + 3] = p.color[0]; data[o + 4] = p.color[1]; data[o + 5] = p.color[2];
        data[o + 6] = a;
        data[o + 7] = cx; data[o + 8] = cy;
        o += 9;
      }
      q++;
    }
    return q;
  }

  // Drop a car onto the surface, leaning with the camber and pitching on hills.
  place(car) {
    const scale = this.heightScale;
    const surf = surfaceUnder(car.x, car.y, scale);
    const ds = 9;
    const slope = (roadHeight(surf.s + ds, scale) - roadHeight(surf.s - ds, scale)) / (2 * ds);
    return {
      x: car.x,
      y: surf.y,
      z: car.y,
      roll: surf.bank,
      pitch: Math.atan(slope),
    };
  }
}
