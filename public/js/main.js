import { TRACK, HALF_WIDTH, project, progressDelta, startSlots } from './track.js';
import { createCar, stepCar, angleDelta } from './car.js';
import { Net } from './net.js';
import { Renderer, PALETTE } from './render.js';

const LAPS = 3;
const SEND_INTERVAL_MS = 66; // ~15 position packets/sec
const INTERP_DELAY_MS = 130; // render remote cars slightly in the past

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
  remotes: new Map(), // id -> {snaps: [{t,x,y,h}]}
  race: null,
};

const input = { steer: 0, brake: false };

// ---------------------------------------------------------------- menu / net

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');

function getName() {
  const name = $('nameInput').value.trim().slice(0, 12) || 'Racer';
  localStorage.setItem('racer-name', name);
  return name;
}

function connect(code) {
  G.code = code;
  history.replaceState(null, '', `?r=${code}`);
  G.net = new Net(code, getName(), onMessage, onDisconnected);
}

function onDisconnected() {
  G.net = null;
  showScreen('disc');
}

function onMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      G.myId = msg.id;
      G.hostId = msg.hostId;
      G.players = new Map(msg.players.map((p) => [p.id, p]));
      if (msg.phase === 'racing') {
        G.spectating = true;
        G.phase = 'racing';
        G.remotes = new Map(
          msg.players.filter((p) => p.id !== G.myId).map((p) => [p.id, { snaps: [] }])
        );
        G.race = { startAt: 0, order: msg.players.map((p) => p.id) };
        $('banner').textContent = 'Race in progress — you race next round';
        $('banner').classList.remove('hidden');
        showScreen(null);
      } else {
        enterLobby();
      }
      break;
    }
    case 'full':
      alert('That room is full (8 players max).');
      location.href = location.pathname;
      break;
    case 'join':
      G.players.set(msg.p.id, msg.p);
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
      G.raceResults = msg.list;
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
  for (const id of order) if (id !== G.myId) G.remotes.set(id, { snaps: [] });

  const slot = myIdx >= 0 ? slots[myIdx] : slots[0];
  const startS = project(slot.x, slot.y).s;
  G.race = {
    startAt: performance.now() + startIn,
    order,
    car: createCar(slot.x, slot.y, slot.heading),
    lastS: startS,
    // Grid slots sit behind the line, so start the lap odometer negative:
    // every car completes each lap exactly at the finish line.
    lapDist: progressDelta(startS, 0),
    lapsDone: 0,
    wrongWayDist: 0,
    finished: false,
    finishMs: null,
    lastSend: 0,
  };
  $('banner').classList.add('hidden');
  $('lapText').textContent = `LAP 1/${LAPS}`;
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

  if (!G.spectating) {
    const car = race.car;
    const live = countdownLeft <= 0 && !race.finished;
    // Not live (countdown, or already finished): hold the brake so the car
    // stays put on the grid / rolls to a stop after the flag.
    const frameInput = live ? input : { steer: 0, brake: true };
    const proj = project(car.x, car.y);
    stepCar(car, frameInput, proj.d <= HALF_WIDTH, dt);
    const b = TRACK.bounds;
    car.x = Math.max(b.minX - 200, Math.min(b.maxX + 200, car.x));
    car.y = Math.max(b.minY - 200, Math.min(b.maxY + 200, car.y));

    // Lap progress via wrap-aware accumulation; driving backwards subtracts,
    // so cutting the line in reverse can't count a lap.
    const proj2 = project(car.x, car.y);
    const ds = progressDelta(proj2.s, race.lastS);
    race.lastS = proj2.s;
    if (live) {
      race.lapDist += ds;
      race.wrongWayDist = ds < -0.5 ? race.wrongWayDist + ds : 0;
      if (race.lapDist >= TRACK.length) {
        race.lapDist -= TRACK.length;
        race.lapsDone++;
        G.net.send({ t: 'lap', lap: race.lapsDone });
        if (race.lapsDone >= LAPS) {
          race.finished = true;
          race.finishMs = Math.round(now - race.startAt);
          G.net.send({ t: 'finish', ms: race.finishMs });
          $('banner').textContent = `Finished — ${fmtTime(race.finishMs)}`;
          $('banner').classList.remove('hidden');
        } else {
          $('lapText').textContent = `LAP ${race.lapsDone + 1}/${LAPS}`;
        }
      }
    }
    $('wrongWay').classList.toggle('hidden', race.wrongWayDist > -70);

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
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    heading: a.h + angleDelta(b.h, a.h) * t,
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
  return (p?.lap || 0) * TRACK.length + project(pos.x, pos.y).s;
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
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const fmtTime = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(2);
  return `${m}:${s.padStart(5, '0')}`;
};

function renderResults() {
  if (G.phase !== 'results' || !G.raceResults) return;
  const tbody = $('resultRows');
  tbody.innerHTML = '';
  G.raceResults.forEach((r, i) => {
    const p = G.players.get(r.id);
    if (!p) return;
    const tr = document.createElement('tr');
    if (r.id === G.myId) tr.className = 'me';
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td><span class="dot" style="background:${PALETTE[p.color % PALETTE.length]}"></span> ${escapeHtml(p.name)}</td>` +
      `<td>${r.ms == null ? 'DNF' : fmtTime(r.ms)}</td>`;
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
    cars.push({ ...pos, color: PALETTE[p.color % PALETTE.length], name: p.name });
  }
  let camX, camY;
  if (!G.spectating) {
    const car = G.race.car;
    cars.push({
      x: car.x, y: car.y, heading: car.heading,
      color: PALETTE[(G.players.get(G.myId)?.color ?? 0) % PALETTE.length],
      braking: input.brake, isMe: true,
    });
    camX = car.x; camY = car.y;
  } else {
    // Spectate whoever is furthest along.
    let best = cars[0];
    let bestProg = -1;
    for (const [id] of G.remotes) {
      const prog = totalProgress(id, now);
      if (prog > bestProg && prog !== Infinity) {
        bestProg = prog;
        best = cars.find((c) => c.name === G.players.get(id)?.name) || best;
      }
    }
    camX = best ? best.x : TRACK.pts[0][0];
    camY = best ? best.y : TRACK.pts[0][1];
  }
  renderer.draw(camX, camY, cars);

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

$('createBtn').addEventListener('click', () => connect(genCode()));
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
