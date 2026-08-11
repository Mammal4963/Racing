import {
  TRACK, TRACK_COUNT, trackInfo, setTrack, project, progressDelta, startSlots,
} from './track.js';
import { createCar, stepCar, angleDelta, driftTier, TIER_COLOR } from './car.js';
import { Net } from './net.js';
import { Renderer, PALETTE } from './render.js';
import { Renderer3D } from './render3d.js';
import { Sound } from './audio.js';

const LAPS = 3;
const SEND_INTERVAL_MS = 66; // ~15 position packets/sec
const INTERP_DELAY_MS = 130; // render remote cars slightly in the past
const CAM_LEAD_S = 0.26; // camera looks this far up the road
const CAM_SMOOTH = 7; // camera catch-up rate; higher is tighter
const HUD_INTERVAL_MS = 60;
const SKID_SLIP = 0.22; // radians of slide before the tyres start marking
const LIGHT_STEP_MS = 1200; // one start light per this long
const ROUND_CHOICES = [1, 3, 5];

// Slipstream: how close, how directly in front, and how aligned another car
// has to be before you start getting towed along behind it.
const DRAFT_NEAR = 26;
const DRAFT_FAR = 200;
const DRAFT_CONE = 0.45;
const DRAFT_ALIGN = 1.1;

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
  series: null,
  setup: { track: 0, rounds: 1 },
  lastPos: 0,
  cam: { x: 0, y: 0 },
  view: '2d', // 2d | chase | raised | sweep | high
};

const input = { steer: 0, brake: false };
const PARKED = { steer: 0, brake: true };
const sound = new Sound();

// ------------------------------------------------------------------ helpers

const fmtTime = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(2);
  return `${m}:${s.padStart(5, '0')}`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

let toastTimer = 0;
function toast(text, color = '#ffd740', ms = 950) {
  const el = $('toast');
  el.textContent = text;
  el.style.color = color;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const pbKey = (track) => `pb-track-${track}`;
const personalBest = (track) => Number(localStorage.getItem(pbKey(track))) || 0;

function useTrack(index) {
  if (TRACK.index === index) return;
  setTrack(index);
  renderer.useTrack();
}

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
  sound.silence();
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
      G.setup = msg.setup || G.setup;
      G.series = msg.series || null;
      if (msg.phase === 'racing') useTrack(msg.track | 0);
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
        G.race = { startAt: 0, startIn: 0, order: racers, lights: -1, lightsOut: true };
        $('trackTag').textContent = TRACK.name;
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
    case 'setup':
      G.setup = { track: msg.track, rounds: msg.rounds };
      renderSetup();
      break;
    case 'go':
      G.series = msg.series || null;
      startRace(msg.startIn, msg.order, msg.track | 0);
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
      G.series = msg.series || null;
      sound.silence();
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
  G.series = null;
  for (const p of G.players.values()) { delete p.lap; delete p.finishMs; }
  sound.silence();
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
  renderSetup();
}

function makeTag(text) {
  const s = document.createElement('span');
  s.className = 'tag';
  s.textContent = text;
  return s;
}

function buildPickers() {
  const tp = $('trackPick');
  for (let i = 0; i < TRACK_COUNT; i++) {
    const b = document.createElement('button');
    b.className = 'pick';
    b.dataset.track = String(i);
    b.innerHTML = `${escapeHtml(trackInfo(i).name)}<small></small>`;
    b.addEventListener('click', () => sendSetup({ track: i }));
    tp.append(b);
  }
  const rp = $('roundPick');
  for (const r of ROUND_CHOICES) {
    const b = document.createElement('button');
    b.className = 'pick';
    b.dataset.rounds = String(r);
    b.textContent = r === 1 ? 'Single race' : `${r} rounds`;
    b.addEventListener('click', () => sendSetup({ rounds: r }));
    rp.append(b);
  }
}

function sendSetup(patch) {
  G.setup = { ...G.setup, ...patch };
  renderSetup();
  G.net?.send({ t: 'setup', ...G.setup });
}

function renderSetup() {
  const isHost = G.myId === G.hostId;
  $('setupBox').classList.toggle('hidden', !isHost);
  for (const b of $('trackPick').children) {
    const i = Number(b.dataset.track);
    b.classList.toggle('on', i === G.setup.track);
    // Your own best lap is the reason to come back to a circuit.
    const pb = personalBest(i);
    b.querySelector('small').textContent = pb ? `best ${fmtTime(pb)}` : trackInfo(i).blurb;
  }
  for (const b of $('roundPick').children) {
    b.classList.toggle('on', Number(b.dataset.rounds) === G.setup.rounds);
  }
  const t = trackInfo(G.setup.track);
  const len = G.setup.rounds === 1 ? 'single race' : `${G.setup.rounds}-round championship`;
  $('setupInfo').innerHTML = isHost ? '' : `<b>${escapeHtml(t.name)}</b> · ${len}`;
  $('setupInfo').classList.toggle('hidden', isHost);
  $('startBtn').textContent =
    G.setup.rounds === 1 ? `Start race · ${t.name}` : `Start ${G.setup.rounds}-round championship`;
}

// --------------------------------------------------------------------- race

function startRace(startIn, order, track) {
  useTrack(track);
  G.phase = 'racing';
  G.spectating = !order.includes(G.myId);
  G.remotes = new Map();
  G.lastPos = 0;
  for (const p of G.players.values()) { p.lap = 0; delete p.finishMs; }

  const slots = startSlots(order.length);
  const myIdx = order.indexOf(G.myId);
  for (const id of order) if (id !== G.myId) G.remotes.set(id, { snaps: [], lastS: null });

  const slot = myIdx >= 0 ? slots[myIdx] : slots[0];
  const startS = project(slot.x, slot.y).s;
  G.race = {
    startAt: performance.now() + startIn,
    startIn,
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
    watching: null, // who the camera follows once we've taken the flag
    lapStartAt: performance.now() + startIn,
    bestLap: null,
    boostTier: 1,
    lights: -1,
    lightsOut: false,
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
  $('trackTag').textContent =
    TRACK.name + (G.series ? ` · R${G.series.round}/${G.series.rounds}` : '');
  $('boostBar').style.width = '0%';
  $('boostCap').classList.toggle('hidden', personalBest(TRACK.index) > 0);
  $('draftTag').classList.add('hidden');
  showScreen(null);
  sound.unlock();
}

// Three start lights: two reds come on in turn, then they drop out and the
// last lamp goes green on the flag.
function updateLights(race, left) {
  const lights = $('lights');
  const bulbs = lights.children;
  const cd = $('countdown');
  if (left > 0) {
    const reds = Math.min(bulbs.length - 1, 1 + Math.floor((race.startIn - left) / LIGHT_STEP_MS));
    if (reds !== race.lights) {
      race.lights = reds;
      sound.light(false);
      buzz(12);
    }
    lights.classList.remove('hidden');
    for (let i = 0; i < bulbs.length; i++) {
      bulbs[i].classList.toggle('on', i < reds);
      bulbs[i].classList.remove('go');
    }
    cd.classList.add('hidden');
    return;
  }
  if (!race.lightsOut) {
    race.lightsOut = true;
    sound.light(true);
    buzz([0, 40]);
    renderer.kick(7);
  }
  for (let i = 0; i < bulbs.length; i++) {
    bulbs[i].classList.remove('on');
    bulbs[i].classList.toggle('go', i === bulbs.length - 1);
  }
  if (left > -900) {
    lights.classList.remove('hidden');
    cd.classList.remove('hidden');
    cd.textContent = 'GO!';
  } else {
    lights.classList.add('hidden');
    cd.classList.add('hidden');
  }
}

// How hard the car in front is towing us along, 0..1.
function draftAmount(car, others) {
  let best = 0;
  for (const o of others) {
    const dx = o.x - car.x, dy = o.y - car.y;
    const dist = Math.hypot(dx, dy);
    if (dist < DRAFT_NEAR || dist > DRAFT_FAR) continue;
    if (Math.abs(angleDelta(Math.atan2(dy, dx), car.travel)) > DRAFT_CONE) continue;
    if (Math.abs(angleDelta(o.heading, car.heading)) > DRAFT_ALIGN) continue;
    best = Math.max(best, 1 - (dist - DRAFT_NEAR) / (DRAFT_FAR - DRAFT_NEAR));
  }
  return best;
}

function tickRace(now, dt, others) {
  const race = G.race;
  updateLights(race, race.startAt - now);

  if (G.spectating) {
    sound.drive({ live: false });
    return;
  }

  const car = race.car;
  const live = race.startAt - now <= 0 && !race.finished;
  // Not live (countdown, or already finished): hold the brake so the car
  // stays put on the grid / rolls to a stop after the flag.
  const draft = live ? draftAmount(car, others) : 0;
  stepCar(car, live ? input : PARKED, { onTrack: race.onTrack, draft }, dt);
  const b = TRACK.bounds;
  car.x = Math.max(b.minX - 200, Math.min(b.maxX + 200, car.x));
  car.y = Math.max(b.minY - 200, Math.min(b.maxY + 200, car.y));

  // One projection per frame, hinted by last frame's arc position. The
  // surface it reports is used by the *next* step, which is a frame of lag
  // nobody can see and saves sweeping the centerline twice.
  const proj = project(car.x, car.y, race.lastS);
  race.onTrack = proj.d <= TRACK.half;
  // Lap progress via wrap-aware accumulation; driving backwards subtracts,
  // so cutting the line in reverse can't count a lap.
  const ds = progressDelta(proj.s, race.lastS);
  race.lastS = proj.s;

  if (live) {
    race.lapDist += ds;
    race.wrongWayDist = ds < -0.5 ? race.wrongWayDist + ds : 0;
    if (race.lapDist >= TRACK.length) completeLap(race, now);
    if (now - race.lastHud >= HUD_INTERVAL_MS) {
      race.lastHud = now;
      $('lapTime').textContent = fmtTime(now - race.lapStartAt);
    }
  }
  $('wrongWay').classList.toggle('hidden', race.wrongWayDist > -70);

  driveEffects(race, car, draft, live, now);

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

function completeLap(race, now) {
  race.lapDist -= TRACK.length;
  race.lapsDone++;
  const lapMs = Math.round(now - race.lapStartAt);
  race.lapStartAt = now;

  const improved = race.bestLap != null && lapMs < race.bestLap;
  if (race.bestLap == null || lapMs < race.bestLap) {
    race.bestLap = lapMs;
    $('bestLap').textContent = `BEST ${fmtTime(lapMs)}`;
  }
  const pb = personalBest(TRACK.index);
  if (!pb || lapMs < pb) {
    localStorage.setItem(pbKey(TRACK.index), String(lapMs));
    if (pb) {
      toast('TRACK RECORD', '#ffd740', 1300);
      sound.best();
    }
  } else if (improved) {
    toast('BEST LAP', '#69f0ae');
    sound.best();
  } else {
    sound.lap();
  }

  G.net.send({ t: 'lap', lap: race.lapsDone });

  if (race.lapsDone >= LAPS) {
    race.finished = true;
    race.finishMs = Math.round(now - race.startAt);
    G.net.send({ t: 'finish', ms: race.finishMs, best: race.bestLap });
    $('banner').textContent = `Finished — ${fmtTime(race.finishMs)}`;
    $('banner').classList.remove('hidden');
    sound.flag(G.lastPos === 1);
    buzz([0, 60, 40, 60]);
    renderer.kick(9);
    return;
  }
  $('lapText').textContent = `LAP ${race.lapsDone + 1}/${LAPS}`;
  if (race.lapsDone === LAPS - 1) toast('FINAL LAP', '#ff5252', 1300);
}

// Particles, shake, sound and haptics — everything that sells the driving.
function driveEffects(race, car, draft, live, now) {
  const tier = driftTier(car.charge);

  if (car.released) {
    race.boostTier = car.released;
    $('boostCap').classList.add('hidden'); // you've got it — stop explaining
    renderer.burst(car.x, car.y, car.released);
    renderer.kick(5 + car.released * 3);
    sound.turbo(car.released);
    buzz(car.released >= 3 ? [0, 20, 30, 45] : 18);
    toast(['', 'TURBO', 'BIG TURBO', 'MEGA TURBO'][car.released], TIER_COLOR[car.released], 700);
  }
  if (car.dumped) {
    sound.dumped();
    toast('LOST IT', '#ff5252', 700);
  }
  if (car.boostMs > 0) {
    renderer.flame(car.x, car.y, car.heading, race.boostTier);
    if (Math.random() < 0.5) renderer.flame(car.x, car.y, car.heading, race.boostTier);
  }
  if (car.drifting && tier > 0 && Math.random() < 0.6) {
    const back = car.heading + Math.PI;
    renderer.spark(car.x + Math.cos(back) * 12, car.y + Math.sin(back) * 12, car.heading, tier);
  }
  if (!race.onTrack && car.speed > 60) {
    if (Math.random() < 0.7) renderer.dirt(car.x, car.y, car.heading, car.speed);
    renderer.kick(0.6);
  }

  maybeSkid(G.myId, car, input.brake, now);

  const bar = $('boostBar');
  const boosting = car.boostMs > 0;
  bar.style.width = `${(boosting ? 1 : car.charge) * 100}%`;
  bar.style.background = boosting ? '#ffffff' : TIER_COLOR[tier];
  $('draftTag').classList.toggle('hidden', draft < 0.2);

  sound.drive({
    speed: car.speed,
    boosting,
    slip: Math.abs(car.slip),
    draft,
    live,
  });
}

// Rubber goes down when a car is sliding sideways, or hauling on the brakes.
function maybeSkid(id, c, braking, now) {
  if (c.speed < 130) return;
  const slip = Math.abs(angleDelta(c.heading, c.travel));
  let strength = Math.min(1, Math.max(0, (slip - SKID_SLIP) * 2.5));
  if (braking && c.speed > 200) strength = Math.max(strength, 0.55);
  if (strength > 0) renderer.skid(id, c.x, c.y, c.heading, now, strength);
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
    if (row.id === G.myId) {
      const place = i + 1;
      $('posText').textContent = `P${place}`;
      // Gaining a place mid-race is worth shouting about.
      if (G.lastPos && place < G.lastPos && !G.race?.finished && !G.spectating) {
        toast(`▲ P${place}`, '#69f0ae', 800);
        sound.overtake();
      }
      G.lastPos = place;
    }
  });
}

// The next car due to take the flag: furthest along of those still running.
function pickFollow(cars, now) {
  let bestId = null, bestProg = -Infinity;
  for (const [id] of G.remotes) {
    const prog = totalProgress(id, now);
    if (prog === Infinity) continue; // already finished
    if (prog > bestProg) {
      bestProg = prog;
      bestId = id;
    }
  }
  return cars.find((c) => c.id === bestId) || null;
}

function showWatching(race, follow) {
  const id = follow && !follow.isMe ? follow.id : null;
  if (id === race.watching) return;
  race.watching = id;
  const done = `Finished — ${fmtTime(race.finishMs)}`;
  const who = id ? G.players.get(id)?.name : null;
  $('banner').textContent = who ? `${done} · watching ${who}` : done;
  $('banner').classList.remove('hidden');
}

function renderResults() {
  if (G.phase !== 'results' || !G.results) return;
  $('resultTrack').textContent = TRACK.name;
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

  const s = G.series;
  $('seriesBox').classList.toggle('hidden', !s);
  if (s) {
    $('seriesTitle').textContent = `Championship · round ${s.round} of ${s.rounds}`;
    const rows = $('seriesRows');
    rows.innerHTML = '';
    s.standings.forEach((row, i) => {
      const tr = document.createElement('tr');
      if (row.id === G.myId) tr.className = 'me';
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td><span class="dot" style="background:${PALETTE[row.color % PALETTE.length]}"></span> ${escapeHtml(row.name)}</td>` +
        `<td>${row.pts}</td>`;
      rows.append(tr);
    });
    const champ = $('champion');
    champ.classList.toggle('hidden', !s.complete || !s.standings.length);
    if (s.complete && s.standings.length) {
      champ.textContent = `🏆 ${s.standings[0].name} takes the title`;
    }
  }

  const isHost = G.myId === G.hostId;
  const more = s && !s.complete;
  $('againBtn').textContent = more ? `Next round · ${s.round + 1}/${s.rounds}` : 'Race again';
  $('againBtn').classList.toggle('hidden', !isHost);
  $('againWait').classList.toggle('hidden', isHost);
}

// --------------------------------------------------------------------- loop

// Two renderers over the same game state. The 2D one is the default and
// always works; the 3D one is built on first use so a WebGL failure can never
// take the game down with it.
const canvas = $('game');
const canvas3d = $('game3d');
const renderer2d = new Renderer(canvas);
let renderer3d = null;
let renderer = renderer2d;

const VIEWS = ['2d', 'chase', 'raised', 'sweep', 'high'];

function setView(name) {
  if (!VIEWS.includes(name)) name = '2d';
  if (name !== '2d' && !renderer3d) {
    try {
      renderer3d = new Renderer3D(canvas3d);
    } catch (e) {
      toast('3D UNAVAILABLE', '#ff5252', 1600);
      name = '2d';
    }
  }
  G.view = name;
  localStorage.setItem('racer-view', name);
  const is3d = name !== '2d';
  renderer = is3d ? renderer3d : renderer2d;
  if (is3d) renderer.setCamera(name);
  canvas.classList.toggle('hidden', is3d);
  canvas3d.classList.toggle('hidden', !is3d);
  $('labels3d').classList.toggle('hidden', !is3d);
  if (!is3d) $('labels3d').innerHTML = '';
  renderer.resize();
  renderer.useTrack();
  renderer.clearSkids();
  const btn = $('viewBtn');
  btn.textContent = `VIEW: ${is3d ? name.toUpperCase() : '2D'}`;
  btn.classList.toggle('on3d', is3d);
}

// Project the 3D renderer's label positions onto pooled DOM nodes.
function syncLabels() {
  const box = $('labels3d');
  const list = renderer === renderer3d ? renderer.labels || [] : [];
  while (box.children.length < list.length) box.append(document.createElement('div'));
  [...box.children].forEach((el, i) => {
    const l = list[i];
    if (!l) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.textContent = l.name;
    el.style.transform = `translate(-50%, -100%) translate(${l.x}px, ${l.y}px)`;
  });
}

window.addEventListener('resize', () => renderer.resize());

let lastFrame = performance.now();
let lastStandings = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (G.phase !== 'racing' || !G.race) return;

  // Remote cars first — the local car's slipstream depends on where they are.
  const cars = [];
  for (const [id] of G.remotes) {
    const pos = remoteCarAt(id, now);
    const p = G.players.get(id);
    if (!pos || !p) continue;
    maybeSkid(id, pos, false, now);
    cars.push({ ...pos, id, color: PALETTE[p.color % PALETTE.length], name: p.name });
  }

  tickRace(now, dt, cars);

  let myEntry = null;
  if (!G.spectating) {
    const car = G.race.car;
    myEntry = {
      x: car.x, y: car.y, heading: car.heading, travel: car.travel,
      speed: car.speed, id: G.myId,
      color: PALETTE[(G.players.get(G.myId)?.color ?? 0) % PALETTE.length],
      braking: input.brake, isMe: true,
      charge: car.charge, tier: driftTier(car.charge), draft: car.draft,
    };
    cars.push(myEntry);
  }

  // Once you've taken the flag there is nothing left to drive, so hand the
  // camera to whoever is still out there — otherwise you sit watching your own
  // parked car for up to the full 45s cutoff.
  const watching = G.spectating || G.race.finished;
  const follow = (watching ? pickFollow(cars, now) : myEntry) || myEntry || cars[0];
  if (!G.spectating && G.race.finished) showWatching(G.race, follow);
  $('boostWrap').classList.toggle('hidden', watching);

  const speedRatio = follow ? Math.min(1, follow.speed / 340) : 0;
  // Lead the camera down the road so there is time to react at speed.
  const targetX = follow ? follow.x + Math.cos(follow.travel) * follow.speed * CAM_LEAD_S : TRACK.pts[0][0];
  const targetY = follow ? follow.y + Math.sin(follow.travel) * follow.speed * CAM_LEAD_S : TRACK.pts[0][1];
  const k = 1 - Math.exp(-CAM_SMOOTH * dt);
  G.cam.x += (targetX - G.cam.x) * k;
  G.cam.y += (targetY - G.cam.y) * k;
  // The 2D renderer uses the smoothed look-at point; the 3D one builds its own
  // camera from the car being followed and ignores it.
  renderer.draw(G.cam.x, G.cam.y, cars, now, { speedRatio, follow });
  if (renderer === renderer3d) syncLabels();

  if (now - lastStandings > 500) {
    lastStandings = now;
    renderStandings(now);
  }
}
requestAnimationFrame(frame);

// -------------------------------------------------------------------- input

// Two controls, one per side. Hold a side to steer that way; add the other
// thumb to brake — and because braking mid-turn is a handbrake, that is how
// you drift. The slide goes the way you were already steering, so the second
// thumb never fights the first. Grabbing both from neutral is a straight stop.
const SIMUL_MS = 90; // pressed closer together than this counts as "together"

function resolveSides(l, r, lAt, rAt) {
  if (l === r) {
    if (!l) return { steer: 0, brake: false };
    // Both held: keep steering the way the first thumb asked for.
    const gap = lAt - rAt;
    return { steer: Math.abs(gap) < SIMUL_MS ? 0 : gap < 0 ? -1 : 1, brake: true };
  }
  return { steer: r ? 1 : -1, brake: false };
}

const keys = new Set();
const KEY_LEFT = ['ArrowLeft', 'KeyA'];
const KEY_RIGHT = ['ArrowRight', 'KeyD'];
const KEY_BRAKE = ['ArrowDown', 'KeyS', 'Space'];

let keySteer = 0, keyBrake = false;
let touchSteer = 0, touchBrake = false;
const heldAt = { keyL: 0, keyR: 0, touchL: 0, touchR: 0 };
const held = { keyL: false, keyR: false, touchL: false, touchR: false };

// Stamp the moment a side goes from released to held, so we know which came
// first when both end up down.
function stamp(side, on) {
  if (on && !held[side]) heldAt[side] = performance.now();
  held[side] = on;
}

function updateKeyInput() {
  const l = KEY_LEFT.some((k) => keys.has(k));
  const r = KEY_RIGHT.some((k) => keys.has(k));
  stamp('keyL', l);
  stamp('keyR', r);
  const sides = resolveSides(l, r, heldAt.keyL, heldAt.keyR);
  keySteer = sides.steer;
  keyBrake = sides.brake || KEY_BRAKE.some((k) => keys.has(k));
  mergeInput();
}

function mergeInput() {
  input.steer = Math.max(-1, Math.min(1, keySteer + touchSteer));
  input.brake = keyBrake || touchBrake;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyC') { cycleView(); return; } // quick camera swap while testing
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

// Touch: the screen is two halves. Hold one to steer, add the other to drift.
function readTouches(touches) {
  let l = false, r = false;
  for (const t of touches) {
    if (t.clientX / window.innerWidth < 0.5) l = true;
    else r = true;
  }
  stamp('touchL', l);
  stamp('touchR', r);
  const sides = resolveSides(l, r, heldAt.touchL, heldAt.touchR);
  touchSteer = sides.steer;
  touchBrake = sides.brake;
  mergeInput();
  $('zoneL').classList.toggle('active', l);
  $('zoneR').classList.toggle('active', r);
  $('zoneL').classList.toggle('drift', sides.brake);
  $('zoneR').classList.toggle('drift', sides.brake);
}
// Touch listens on its own full-screen surface rather than on a canvas. The
// visible canvas changes when the view is switched, and a listener bound to
// one of them leaves the other view with no controls at all.
const touchSurface = $('touch');
for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
  touchSurface.addEventListener(ev, (e) => {
    e.preventDefault();
    readTouches(e.touches);
  }, { passive: false });
}

// ----------------------------------------------------------------------- UI

$('nameInput').value = localStorage.getItem('racer-name') || '';
buildPickers();
renderSetup();

function syncSoundBtn() {
  $('soundBtn').textContent = sound.on ? '♪ SOUND' : '♪ MUTED';
}
syncSoundBtn();
$('soundBtn').addEventListener('click', () => {
  sound.unlock();
  sound.setEnabled(!sound.on);
  syncSoundBtn();
});

function cycleView() {
  setView(VIEWS[(VIEWS.indexOf(G.view) + 1) % VIEWS.length]);
}
$('viewBtn').addEventListener('click', cycleView);
setView(localStorage.getItem('racer-view') || '2d');

$('createBtn').addEventListener('click', () => {
  sound.unlock();
  createTries = 0;
  connect(genCode(), true);
});
$('joinBtn').addEventListener('click', () => {
  sound.unlock();
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

// Debug handles for automated tests.
window.__game = G;
window.__input = input;
