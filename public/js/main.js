import { TRACK, HALF_WIDTH, project, progressDelta, startSlots } from './track.js';
import { createCar, stepCar, angleDelta } from './car.js';
import { Net } from './net.js';
import { Renderer, PALETTE } from './render.js';

const LAPS = 3;
const SEND_INTERVAL_MS = 66; // ~15 position packets/sec
const INTERP_DELAY_MS = 130; // render remote cars slightly in the past
const CAM_LEAD_S = 0.26; // camera looks this far up the road
const CAM_SMOOTH = 7; // camera catch-up rate; higher is tighter
const HUD_INTERVAL_MS = 60;
const SKID_SLIP = 0.22; // radians of slide before the tyres start marking

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), lobby: $('lobby'), results: $('results'), disc: $('disconnected') };

function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
  $('hud').classList.toggle('hidden', name !== null);
}

const G = {
  net: null,
  code: null,
  myId: null,
  hostId: null,
  phase: 'menu', // menu | lobby | racing | results
  spectating: false,
  players: new Map(), // id -> {id, name, color, order, lap?, finishMs?}
  remotes: new Map(), // id -> {snaps: [{t,x,y,h}], lastS}
  race: null,
  results: null,
  cam: { x: 0, y: 0 },
};

const input = { steer: 0, brake: false };
const PARKED = { steer: 0, brake: true };

// ---------------------------------------------------------------- menu / net

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');

function getName() {
  const name = $('nameInput').value.trim().slice(0, 12) || 'Racer';
  localStorage.setItem('racer-name', name);
  return name;
}

let createTries = 0;

function connect(code, create = false) {
  G.code = code;
  history.replaceState(null, '', `?r=${code}`);
  G.net = new Net(code, getName(), { create, onMsg: onMessage, onState: onNetState });
}

function onNetState(state) {
  const el = $('netMsg');
  if (state === 'open') {
    el.classList.add('hidden');
    return;
  }
  if (state === 'lost') {
    // Keep rendering the race underneath — most dropouts last a second or two
    // and the local car keeps driving; sends simply no-op until we are back.
    el.textContent = 'Reconnecting…';
    el.classList.remove('hidden');
    return;
  }
  el.classList.add('hidden');
  G.phase = 'menu';
  G.race = null;
  showScreen('disc');
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      const racers = msg.racers || [];
      // Same id back means the room recognised our resume token: our local car,
      // lap count and clock are all still valid, so slot straight back in.
      const resumed = msg.phase === 'racing' && msg.id === G.myId && G.race && racers.includes(msg.id);
      G.myId = msg.id;
      G.hostId = msg.hostId;
      G.players = new Map(msg.players.map((p) => [p.id, p]));
      if (resumed) {
        G.phase = 'racing';
        G.spectating = false;
        G.remotes = new Map();
        for (const id of racers) if (id !== G.myId) G.remotes.set(id, { snaps: [], lastS: null });
        showScreen(null);
      } else if (msg.phase === 'racing') {
        G.spectating = true;
        G.phase = 'racing';
        G.remotes = new Map(
          racers.filter((id) => id !== G.myId).map((id) => [id, { snaps: [], lastS: null }])
        );
        G.race = { startAt: 0, order: racers };
        $('banner').textContent = 'Race in progress — you race next round';
        $('banner').classList.remove('hidden');
        showScreen(null);
      } else {
        enterLobby();
      }
      break;
    }
    case 'full':
      G.net.close();
      alert('That room is full (8 players max).');
      location.href = location.pathname;
      break;
    case 'taken':
      // Room code collision on create — roll another one.
      G.net.close();
      if (++createTries < 8) connect(genCode(), true);
      else alert('Could not find a free room code. Try again.');
      break;
    case 'join':
      G.players.set(msg.p.id, msg.p);
      // A racer who dropped and reconnected needs its interpolation buffer back.
      if (G.phase === 'racing' && G.race?.order.includes(msg.p.id) && msg.p.id !== G.myId) {
        G.remotes.set(msg.p.id, { snaps: [], lastS: null });
      }
      renderLobby();
      break;
    case 'leave':
      G.players.delete(msg.id);
      G.remotes.delete(msg.id);
      renderLobby();
      break;
    case 'host':
      G.hostId = msg.id;
      renderLobby();
      renderResults();
      break;
    case 'go':
      startRace(msg.startIn, msg.order);
      break;
    case 's': {
      const r = G.remotes.get(msg.id);
      if (!r) break;
      r.snaps.push({ t: performance.now(), x: msg.x, y: msg.y, h: msg.h });
      if (r.snaps.length > 6) r.snaps.shift();
      break;
    }
    case 'lap': {
      const p = G.players.get(msg.id);
      if (p) p.lap = msg.lap;
      break;
    }
    case 'fin': {
      const p = G.players.get(msg.id);
      if (p) p.finishMs = msg.ms;
      break;
    }
    case 'results':
      G.phase = 'results';
      G.spectating = false;
      G.results = msg.list;
      renderResults();
      showScreen('results');
      break;
    case 'lobby':
      enterLobby();
      break;
  }
}

// -------------------------------------------------------------------- lobby

function enterLobby() {
  G.phase = 'lobby';
  G.spectating = false;
  G.race = null;
  G.remotes = new Map();
  for (const p of G.players.values()) { delete p.lap; delete p.finishMs; }
  $('banner').classList.add('hidden');
  $('roomCode').textContent = G.code;
  renderLobby();
  showScreen('lobby');
}

function renderLobby() {
  if (G.phase !== 'lobby') return;
  const list = $('playerList');
  list.innerHTML = '';
  const players = [...G.players.values()].sort((a, b) => a.order - b.order);
  for (const p of players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = PALETTE[p.color % PALETTE.length];
    li.append(dot, ` ${p.name}`);
    if (p.id === G.hostId) li.append(makeTag('host'));
    if (p.id === G.myId) li.append(makeTag('you'));
    list.append(li);
  }
  const isHost = G.myId === G.hostId;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('waitMsg').classList.toggle('hidden', isHost);
}

function makeTag(text) {
  const s = document.createElement('span');
  s.className = 'tag';
  s.textContent = text;
  return s;
}

// --------------------------------------------------------------------- race

function startRace(startIn, order) {
  G.phase = 'racing';
  G.spectating = !order.includes(G.myId);
  G.remotes = new Map();
  for (const p of G.players.values()) { p.lap = 0; delete p.finishMs; }

  const slots = startSlots(order.length);
  const myIdx = order.indexOf(G.myId);
  for (const id of order) if (id !== G.myId) G.remotes.set(id, { snaps: [], lastS: null });

  const slot = myIdx >= 0 ? slots[myIdx] : slots[0];
  const startS = project(slot.x, slot.y).s;
  G.race = {
    startAt: performance.now() + startIn,
    order,
    car: createCar(slot.x, slot.y, slot.heading),
    lastS: startS,
    onTrack: true,
    // Grid slots sit behind the line, so start the lap odometer negative:
    // every car completes each lap exactly at the finish line.
    lapDist: progressDelta(startS, 0),
    lapsDone: 0,
    wrongWayDist: 0,
    finished: false,
    finishMs: null,
    lapStartAt: performance.now() + startIn,
    bestLap: null,
    lastSend: 0,
    lastHud: 0,
  };
  G.cam.x = slot.x;
  G.cam.y = slot.y;
  renderer.clearSkids();
  $('banner').classList.add('hidden');
  $('lapText').textContent = `LAP 1/${LAPS}`;
  $('lapTime').textContent = '0:00.00';
  $('bestLap').textContent = 'BEST —';
  showScreen(null);
}

function tickRace(now, dt) {
  const race = G.race;
  const countdownLeft = race.startAt - now;
  const cd = $('countdown');
  if (countdownLeft > 0) {
    cd.classList.remove('hidden');
    cd.textContent = countdownLeft > 3000 ? 'READY' : String(Math.ceil(countdownLeft / 1000));
  } else if (countdownLeft > -900) {
    cd.classList.remove('hidden');
    cd.textContent = 'GO!';
  } else {
    cd.classList.add('hidden');
  }

  if (G.spectating) return;

  const car = race.car;
  const live = countdownLeft <= 0 && !race.finished;
  // Not live (countdown, or already finished): hold the brake so the car
  // stays put on the grid / rolls to a stop after the flag.
  stepCar(car, live ? input : PARKED, race.onTrack, dt);
  const b = TRACK.bounds;
  car.x = Math.max(b.minX - 200, Math.min(b.maxX + 200, car.x));
  car.y = Math.max(b.minY - 200, Math.min(b.maxY + 200, car.y));

  // One projection per frame, hinted by last frame's arc position. The
  // surface it reports is used by the *next* step, which is a frame of lag
  // nobody can see and saves sweeping the centerline twice.
  const proj = project(car.x, car.y, race.lastS);
  race.onTrack = proj.d <= HALF_WIDTH;
  // Lap progress via wrap-aware accumulation; driving backwards subtracts,
  // so cutting the line in reverse can't count a lap.
  const ds = progressDelta(proj.s, race.lastS);
  race.lastS = proj.s;

  if (live) {
    race.lapDist += ds;
    race.wrongWayDist = ds < -0.5 ? race.wrongWayDist + ds : 0;
    if (race.lapDist >= TRACK.length) {
      race.lapDist -= TRACK.length;
      race.lapsDone++;
      const lapMs = Math.round(now - race.lapStartAt);
      race.lapStartAt = now;
      if (race.bestLap == null || lapMs < race.bestLap) {
        race.bestLap = lapMs;
        $('bestLap').textContent = `BEST ${fmtTime(lapMs)}`;
      }
      G.net.send({ t: 'lap', lap: race.lapsDone });
      if (race.lapsDone >= LAPS) {
        race.finished = true;
        race.finishMs = Math.round(now - race.startAt);
        G.net.send({ t: 'finish', ms: race.finishMs, best: race.bestLap });
        $('banner').textContent = `Finished — ${fmtTime(race.finishMs)}`;
        $('banner').classList.remove('hidden');
      } else {
        $('lapText').textContent = `LAP ${race.lapsDone + 1}/${LAPS}`;
      }
    }
    if (now - race.lastHud >= HUD_INTERVAL_MS) {
      race.lastHud = now;
      $('lapTime').textContent = fmtTime(now - race.lapStartAt);
    }
  }
  $('wrongWay').classList.toggle('hidden', race.wrongWayDist > -70);

  maybeSkid(G.myId, car.x, car.y, car.heading, car.travel, car.speed, input.brake, now);

  if (now - race.lastSend >= SEND_INTERVAL_MS) {
    race.lastSend = now;
    G.net.send({
      t: 's',
      x: Math.round(car.x * 10) / 10,
      y: Math.round(car.y * 10) / 10,
      h: Math.round(car.heading * 1000) / 1000,
    });
  }
}

// Rubber goes down when the car is sliding sideways, or hauling on the brakes.
function maybeSkid(id, x, y, heading, travel, speed, braking, now) {
  if (speed < 130) return;
  const slip = Math.abs(angleDelta(heading, travel));
  let strength = Math.min(1, Math.max(0, (slip - SKID_SLIP) * 2.5));
  if (braking && speed > 200) strength = Math.max(strength, 0.55);
  if (strength > 0) renderer.skid(id, x, y, heading, now, strength);
}

function remoteCarAt(id, now) {
  const r = G.remotes.get(id);
  if (!r || r.snaps.length === 0) return null;
  const snaps = r.snaps;
  const target = now - INTERP_DELAY_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = 0; i < snaps.length - 1; i++) {
    if (snaps[i].t <= target && target <= snaps[i + 1].t) {
      a = snaps[i];
      b = snaps[i + 1];
      break;
    }
  }
  if (target >= b.t) a = b; // no newer data: hold last known position
  const span = b.t - a.t;
  const t = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
  // Direction and speed of the packet pair stand in for the remote car's
  // `travel`, which is what tells us it is sliding.
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const heading = a.h + angleDelta(b.h, a.h) * t;
  return {
    x: a.x + dx * t,
    y: a.y + dy * t,
    heading,
    travel: dist > 0.5 ? Math.atan2(dy, dx) : heading,
    speed: span > 0 ? (dist / span) * 1000 : 0,
  };
}

// ---------------------------------------------------------------- standings

function totalProgress(id, now) {
  const p = G.players.get(id);
  if (p?.finishMs != null) return Infinity;
  if (id === G.myId && G.race && !G.spectating) {
    return G.race.lapsDone * TRACK.length + G.race.lapDist;
  }
  const pos = remoteCarAt(id, now);
  if (!pos) return -1;
  const r = G.remotes.get(id);
  const proj = project(pos.x, pos.y, r.lastS);
  r.lastS = proj.s;
  return (p?.lap || 0) * TRACK.length + proj.s;
}

function renderStandings(now) {
  const ids = G.race ? G.race.order.filter((id) => G.players.has(id) || id === G.myId) : [];
  const rows = ids
    .map((id) => ({
      id,
      p: G.players.get(id),
      fin: G.players.get(id)?.finishMs ?? (id === G.myId ? G.race?.finishMs : null),
      prog: totalProgress(id, now),
    }))
    .sort((a, b) => {
      if (a.fin != null && b.fin != null) return a.fin - b.fin;
      if (a.fin != null) return -1;
      if (b.fin != null) return 1;
      return b.prog - a.prog;
    });
  const el = $('standings');
  el.innerHTML = '';
  rows.forEach((row, i) => {
    if (!row.p) return;
    const div = document.createElement('div');
    div.className = 'standing' + (row.id === G.myId ? ' me' : '');
    div.innerHTML =
      `<span class="pos">${i + 1}</span>` +
      `<span class="dot" style="background:${PALETTE[row.p.color % PALETTE.length]}"></span>` +
      `<span class="sname">${escapeHtml(row.p.name)}</span>` +
      `<span class="slap">${row.fin != null ? '✓' : `L${Math.min((row.p.lap ?? 0) + 1, LAPS)}`}</span>`;
    el.append(div);
    if (row.id === G.myId) $('posText').textContent = `P${i + 1}`;
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const fmtTime = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(2);
  return `${m}:${s.padStart(5, '0')}`;
};

function renderResults() {
  if (G.phase !== 'results' || !G.results) return;
  const tbody = $('resultRows');
  tbody.innerHTML = '';
  G.results.forEach((r, i) => {
    const p = G.players.get(r.id);
    const name = r.name ?? p?.name ?? 'Racer';
    const color = PALETTE[(r.color ?? p?.color ?? 0) % PALETTE.length];
    const tr = document.createElement('tr');
    if (r.id === G.myId) tr.className = 'me';
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td><span class="dot" style="background:${color}"></span> ${escapeHtml(name)}</td>` +
      `<td>${r.ms == null ? 'DNF' : fmtTime(r.ms)}</td>` +
      `<td>${r.best == null ? '—' : fmtTime(r.best)}</td>`;
    tbody.append(tr);
  });
  const isHost = G.myId === G.hostId;
  $('againBtn').classList.toggle('hidden', !isHost);
  $('againWait').classList.toggle('hidden', isHost);
}

// --------------------------------------------------------------------- loop

const canvas = $('game');
const renderer = new Renderer(canvas);
window.addEventListener('resize', () => renderer.resize());

let lastFrame = performance.now();
let lastStandings = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (G.phase !== 'racing' || !G.race) return;

  tickRace(now, dt);

  const cars = [];
  for (const [id] of G.remotes) {
    const pos = remoteCarAt(id, now);
    const p = G.players.get(id);
    if (!pos || !p) continue;
    maybeSkid(id, pos.x, pos.y, pos.heading, pos.travel, pos.speed, false, now);
    cars.push({ ...pos, id, color: PALETTE[p.color % PALETTE.length], name: p.name });
  }

  let targetX, targetY;
  if (!G.spectating) {
    const car = G.race.car;
    cars.push({
      x: car.x, y: car.y, heading: car.heading, id: G.myId,
      color: PALETTE[(G.players.get(G.myId)?.color ?? 0) % PALETTE.length],
      braking: input.brake, isMe: true,
    });
    // Lead the camera down the road so there is time to react at speed.
    targetX = car.x + Math.cos(car.travel) * car.speed * CAM_LEAD_S;
    targetY = car.y + Math.sin(car.travel) * car.speed * CAM_LEAD_S;
  } else {
    // Spectate whoever is furthest along.
    let bestId = null, bestProg = -Infinity;
    for (const [id] of G.remotes) {
      const prog = totalProgress(id, now);
      if (prog !== Infinity && prog > bestProg) {
        bestProg = prog;
        bestId = id;
      }
    }
    const lead = cars.find((c) => c.id === bestId) || cars[0];
    targetX = lead ? lead.x : TRACK.pts[0][0];
    targetY = lead ? lead.y : TRACK.pts[0][1];
  }
  const k = 1 - Math.exp(-CAM_SMOOTH * dt);
  G.cam.x += (targetX - G.cam.x) * k;
  G.cam.y += (targetY - G.cam.y) * k;
  renderer.draw(G.cam.x, G.cam.y, cars, now);

  if (now - lastStandings > 500) {
    lastStandings = now;
    renderStandings(now);
  }
}
requestAnimationFrame(frame);

// -------------------------------------------------------------------- input

const keys = new Set();
const KEY_LEFT = ['ArrowLeft', 'KeyA'];
const KEY_RIGHT = ['ArrowRight', 'KeyD'];
const KEY_BRAKE = ['ArrowDown', 'KeyS', 'Space'];

function updateKeyInput() {
  const l = KEY_LEFT.some((k) => keys.has(k));
  const r = KEY_RIGHT.some((k) => keys.has(k));
  keySteer = (r ? 1 : 0) - (l ? 1 : 0);
  keyBrake = KEY_BRAKE.some((k) => keys.has(k));
  mergeInput();
}
let keySteer = 0, keyBrake = false;
let touchSteer = 0, touchBrake = false;

function mergeInput() {
  input.steer = Math.max(-1, Math.min(1, keySteer + touchSteer));
  input.brake = keyBrake || touchBrake;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ([...KEY_LEFT, ...KEY_RIGHT, ...KEY_BRAKE].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  updateKeyInput();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  updateKeyInput();
});
// A tab switch eats the keyup, which would otherwise leave the car locked
// into a turn when you come back.
window.addEventListener('blur', () => {
  keys.clear();
  updateKeyInput();
});

// Touch: left/right edge zones steer, middle zone brakes. Auto-accelerate.
function readTouches(touches) {
  let l = false, r = false, b = false;
  for (const t of touches) {
    const fx = t.clientX / window.innerWidth;
    if (fx < 0.42) l = true;
    else if (fx > 0.58) r = true;
    else b = true;
  }
  touchSteer = (r ? 1 : 0) - (l ? 1 : 0);
  touchBrake = b;
  mergeInput();
  $('zoneL').classList.toggle('active', l);
  $('zoneR').classList.toggle('active', r);
  $('zoneB').classList.toggle('active', b);
}
for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
  canvas.addEventListener(ev, (e) => { e.preventDefault(); readTouches(e.touches); }, { passive: false });
}

// ----------------------------------------------------------------------- UI

$('nameInput').value = localStorage.getItem('racer-name') || '';

$('createBtn').addEventListener('click', () => {
  createTries = 0;
  connect(genCode(), true);
});
$('joinBtn').addEventListener('click', () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (/^[A-Z0-9]{4,8}$/.test(code)) connect(code);
  else $('codeInput').focus();
});
$('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinBtn').click();
});

$('shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}/?r=${G.code}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Race me!', url });
      return;
    }
  } catch { /* fall through to clipboard */ }
  try {
    await navigator.clipboard.writeText(url);
    $('shareBtn').textContent = 'Link copied!';
    setTimeout(() => ($('shareBtn').textContent = 'Share link'), 1500);
  } catch { prompt('Copy this link:', url); }
});

$('startBtn').addEventListener('click', () => G.net.send({ t: 'start' }));
$('againBtn').addEventListener('click', () => G.net.send({ t: 'again' }));
$('reloadBtn').addEventListener('click', () => location.reload());

// Auto-fill room code from the URL (?r=CODE) so shared links drop straight in.
const urlCode = new URLSearchParams(location.search).get('r');
if (urlCode && /^[A-Za-z0-9]{4,8}$/.test(urlCode)) {
  $('codeInput').value = urlCode.toUpperCase();
}
showScreen('menu');

// Debug handle for automated tests.
window.__game = G;
