// Two-client smoke test against wrangler dev on :8787.
import { chromium } from 'playwright';

const BASE = 'http://localhost:8787';
const fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const ok = (msg) => console.log('ok:', msg);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function newPlayer(name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console.error]`, m.text()); });
  page.on('pageerror', (e) => { console.log(`[${name} pageerror]`, e.message); fail('page error'); });
  await page.goto(BASE);
  await page.fill('#nameInput', name);
  return page;
}

// --- Player 1 creates a room
const p1 = await newPlayer('Alice');
await p1.click('#createBtn');
await p1.waitForSelector('#lobby:not(.hidden)', { timeout: 5000 });
const code = (await p1.textContent('#roomCode')).trim();
if (!/^[A-Z0-9]{4}$/.test(code)) fail(`bad room code: ${code}`);
ok(`room created: ${code}`);

// --- Player 2 joins via code
const p2 = await newPlayer('Bob');
await p2.fill('#codeInput', code);
await p2.click('#joinBtn');
await p2.waitForSelector('#lobby:not(.hidden)', { timeout: 5000 });
ok('player 2 joined lobby');

// Both lobbies should list 2 players; p1 is host and sees the start button.
await p1.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2, null, { timeout: 5000 });
await p2.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2, null, { timeout: 5000 });
ok('both lobbies show 2 players');
if (await p1.$eval('#startBtn', (el) => el.classList.contains('hidden'))) fail('host missing start button');
if (!(await p2.$eval('#startBtn', (el) => el.classList.contains('hidden')))) fail('non-host sees start button');
ok('host/non-host UI correct');

// --- Start the race
await p1.click('#startBtn');
await p1.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 5000 });
await p2.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 5000 });
ok('both clients entered racing phase');

// Three start lights: two reds come on in turn, then the last goes green.
const bulbs = await p1.$$eval('#lights i', (e) => e.length);
if (bulbs !== 3) fail(`expected 3 start lights, found ${bulbs}`);
await p1.waitForFunction(() => document.querySelectorAll('#lights i.on').length === 2, null, { timeout: 6000 });
ok('start lights: two reds lit');
await p1.waitForFunction(
  () => document.querySelectorAll('#lights i.go').length === 1 &&
        document.querySelectorAll('#lights i.on').length === 0,
  null,
  { timeout: 6000 }
);
ok('start lights: reds drop out and the last lamp goes green');

// --- Wait out the countdown, hold no keys: auto-accelerate should move cars.
await p1.waitForFunction(() => performance.now() > window.__game.race.startAt + 500, null, { timeout: 8000 });
const start1 = await p1.evaluate(() => ({ x: window.__game.race.car.x, y: window.__game.race.car.y }));
await p1.waitForTimeout(1500);
const now1 = await p1.evaluate(() => ({ x: window.__game.race.car.x, y: window.__game.race.car.y, speed: window.__game.race.car.speed }));
const moved = Math.hypot(now1.x - start1.x, now1.y - start1.y);
if (moved < 50) fail(`car 1 barely moved (${moved.toFixed(1)}px)`);
ok(`car 1 auto-drives (moved ${moved.toFixed(0)}px, speed ${now1.speed.toFixed(0)})`);

// --- p2 should be receiving p1's position packets and interpolating them
const snaps = await p2.evaluate(() => {
  const remotes = [...window.__game.remotes.values()];
  return remotes.map((r) => r.snaps.length);
});
if (!snaps.length || snaps[0] < 2) fail(`p2 has no snapshots of p1: ${JSON.stringify(snaps)}`);
ok(`p2 receives p1 position packets (${snaps[0]} buffered)`);

// p2's view of p1's car should be near p1's actual position (within ~200 world units, given 130ms delay)
const p1pos = await p1.evaluate(() => ({ x: window.__game.race.car.x, y: window.__game.race.car.y }));
const p2sees = await p2.evaluate(() => {
  const r = [...window.__game.remotes.values()][0];
  const s = r.snaps[r.snaps.length - 1];
  return { x: s.x, y: s.y };
});
const err = Math.hypot(p1pos.x - p2sees.x, p1pos.y - p2sees.y);
if (err > 250) fail(`replication error too big: ${err.toFixed(0)}`);
ok(`replication position error: ${err.toFixed(0)} world units`);

// --- Keyboard steering changes heading on p1
const h0 = await p1.evaluate(() => window.__game.race.car.heading);
await p1.keyboard.down('ArrowLeft');
await p1.waitForTimeout(500);
await p1.keyboard.up('ArrowLeft');
const h1 = await p1.evaluate(() => window.__game.race.car.heading);
if (Math.abs(h1 - h0) < 0.15) fail(`steering had no effect (dh=${(h1 - h0).toFixed(3)})`);
ok(`steering works (heading changed ${(h1 - h0).toFixed(2)} rad)`);

// --- Touch input: tap-and-hold right zone steers right
const h2 = await p1.evaluate(() => window.__game.race.car.heading);
await p1.evaluate(() => {
  // simulate a held touch in the right steering zone via the same handler path
  const ev = new TouchEvent('touchstart', {
    touches: [new Touch({ identifier: 1, target: document.getElementById('touch'), clientX: window.innerWidth * 0.9, clientY: 700 })],
    bubbles: true, cancelable: true,
  });
  document.getElementById('touch').dispatchEvent(ev);
});
await p1.waitForTimeout(400);
const h3 = await p1.evaluate(() => window.__game.race.car.heading);
await p1.evaluate(() => {
  const ev = new TouchEvent('touchend', { touches: [], bubbles: true, cancelable: true });
  document.getElementById('touch').dispatchEvent(ev);
});
if (h3 - h2 < 0.1) fail(`touch steer had no effect (dh=${(h3 - h2).toFixed(3)})`);
ok(`touch steering works (dh=${(h3 - h2).toFixed(2)} rad)`);

// --- Touch drift gesture: holding the far side while steering should brake
// and keep steering the way you already were, not cancel the turn.
const touchAt = (ids) => `
  const el = document.getElementById('touch');
  const t = ${JSON.stringify(ids)}.map(([id, fx]) =>
    new Touch({ identifier: id, target: el, clientX: window.innerWidth * fx, clientY: 700 }));
  el.dispatchEvent(new TouchEvent('touchstart', { touches: t, bubbles: true, cancelable: true }));
`;
await p1.evaluate(new Function(touchAt([[1, 0.85]])));
await p1.waitForTimeout(160); // well past the "pressed together" window
const oneSide = await p1.evaluate(() => ({ ...window.__input }));
if (oneSide.steer !== 1 || oneSide.brake) fail(`one side should steer only: ${JSON.stringify(oneSide)}`);

await p1.evaluate(new Function(touchAt([[1, 0.85], [2, 0.15]])));
await p1.waitForTimeout(60);
const bothSides = await p1.evaluate(() => ({
  ...window.__input,
  lit: document.querySelectorAll('.zone.drift').length,
}));
if (!bothSides.brake) fail(`adding the far thumb should brake: ${JSON.stringify(bothSides)}`);
if (bothSides.steer !== 1) fail(`drift should keep steering right, got ${JSON.stringify(bothSides)}`);
if (bothSides.lit !== 2) fail(`expected both zones lit for the drift, got ${bothSides.lit}`);
ok('far-side touch brakes and drifts in the direction already steered');

// Both grabbed at once from neutral is a straight-line stop, not a drift.
await p1.evaluate(() => document.getElementById('touch')
  .dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true, cancelable: true })));
await p1.evaluate(new Function(touchAt([[1, 0.85], [2, 0.15]])));
await p1.waitForTimeout(60);
const together = await p1.evaluate(() => ({ ...window.__input }));
if (!together.brake || together.steer !== 0) fail(`both at once should brake straight: ${JSON.stringify(together)}`);
ok('both sides grabbed together brakes in a straight line');
await p1.evaluate(() => document.getElementById('touch')
  .dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true, cancelable: true })));

// --- Drifting: braking while steering should charge the boost meter, and the
// HUD bar should follow it.
if (!(await p1.$eval('#lights', (el) => el.classList.contains('hidden')))) {
  fail('start lights still showing after the green');
}
await p1.evaluate(async () => {
  const { pointAt } = await import('/js/track.js');
  const g = window.__game;
  const pos = pointAt(g.race.lastS + 40);
  Object.assign(g.race.car, { x: pos.x, y: pos.y, heading: pos.ang, travel: pos.ang, speed: 320 });
});
await p1.keyboard.down('ArrowRight');
await p1.keyboard.down('ArrowDown');
let peakCharge = 0, barAtPeak = '0%';
for (let i = 0; i < 8; i++) {
  const s = await p1.evaluate(() => ({
    c: window.__game.race.car.charge,
    w: document.getElementById('boostBar').style.width,
  }));
  if (s.c > peakCharge) { peakCharge = s.c; barAtPeak = s.w; }
  await p1.waitForTimeout(60);
}
await p1.keyboard.up('ArrowDown');
await p1.keyboard.up('ArrowRight');
if (peakCharge <= 0) fail('braking into a turn never charged the boost meter');
if (barAtPeak === '0%') fail('boost meter charged but the HUD bar stayed empty');
ok(`drifting charges the boost meter (peak ${peakCharge.toFixed(2)}, bar ${barAtPeak})`);

// --- 3D view: switching mid-race must not disturb the race underneath.
// Skipped rather than failed where the browser has no WebGL2 at all.
await p1.click('#viewBtn');
await p1.waitForTimeout(700);
const view3d = await p1.evaluate(() => ({
  view: window.__game.view,
  canvasShown: !document.getElementById('game3d').classList.contains('hidden'),
}));
if (view3d.view === '2d') {
  ok('3D view unavailable in this browser — skipped (game stayed on 2D)');
} else {
  if (!view3d.canvasShown) fail(`3D view active but its canvas is hidden: ${JSON.stringify(view3d)}`);
  const before = await p1.evaluate(() => window.__game.race.lapDist);
  await p1.waitForTimeout(700);
  const after = await p1.evaluate(() => window.__game.race.lapDist);
  if (after === before) fail('the race stopped advancing while in the 3D view');
  ok(`3D view (${view3d.view}) renders and the race keeps running`);

  // Touch must keep working when the visible canvas changes underneath it.
  await p1.evaluate(new Function(touchAt([[7, 0.85]])));
  await p1.waitForTimeout(80);
  const touch3d = await p1.evaluate(() => ({ ...window.__input }));
  await p1.evaluate(() => document.getElementById('touch')
    .dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true, cancelable: true })));
  if (touch3d.steer !== 1) fail(`touch does not reach the 3D view: ${JSON.stringify(touch3d)}`);
  ok('touch steering still works in the 3D view');
  for (let i = 0; i < 6 && (await p1.evaluate(() => window.__game.view)) !== '2d'; i++) {
    await p1.click('#viewBtn');
  }
  if ((await p1.evaluate(() => window.__game.view)) !== '2d') fail('could not cycle back to 2D');
  if (await p1.$eval('#game', (el) => el.classList.contains('hidden'))) fail('2D canvas still hidden');
  ok('cycles back round to the 2D view');
}

// --- Reconnect: drop p2's socket mid-race. It should climb back into the same
// car (same id, same lap) instead of dead-ending on the disconnect screen.
const p2id = await p2.evaluate(() => window.__game.myId);
await p2.evaluate(() => window.__game.net.ws.close());
await p2.waitForFunction(() => window.__game.net.online, null, { timeout: 15000 });
await p2.waitForTimeout(300);
const back = await p2.evaluate(() => ({
  id: window.__game.myId,
  phase: window.__game.phase,
  spectating: window.__game.spectating,
  hasCar: !!window.__game.race?.car,
}));
if (back.id !== p2id) fail(`resume handed out a new identity: ${p2id} -> ${back.id}`);
if (back.phase !== 'racing' || back.spectating || !back.hasCar) {
  fail(`p2 did not resume racing: ${JSON.stringify(back)}`);
}
ok('p2 dropped its socket and resumed the same car mid-race');

// p1 must re-establish p2 as a remote car, not leave a hole in the grid.
await p1.waitForFunction(
  (id) => window.__game.remotes.get(id)?.snaps.length > 0,
  p2id,
  { timeout: 10000 }
);
ok('p1 picked p2 back up after the reconnect');

// --- A phone joining mid-race spectates, and must not hold the race open:
// the room ends on the racers who lined up, not on everyone connected.
const p3 = await newPlayer('Carol');
await p3.fill('#codeInput', code);
await p3.click('#joinBtn');
await p3.waitForFunction(
  () => window.__game.phase === 'racing' && window.__game.spectating,
  null,
  { timeout: 8000 }
);
ok('late joiner spectates the race in progress');

// --- Fast-forward a race end: teleport p1 around the track by feeding laps
// (drive the real lap-counting path by warping the car forward along the centerline)
for (const page of [p1, p2]) {
  await page.evaluate(async () => {
    const { pointAt } = await import('/js/track.js');
    const g = window.__game;
    // advance in 120-unit hops so progressDelta stays wrap-safe
    const hop = () => {
      const cur = g.race.lastS;
      const p = pointAt(cur + 120);
      g.race.car.x = p.x; g.race.car.y = p.y;
      g.race.car.heading = p.ang; g.race.car.travel = p.ang;
      g.race.car.speed = 200;
    };
    window.__hop = hop;
  });
}
// hop both cars until both finish
for (let i = 0; i < 200; i++) {
  await p1.evaluate(() => window.__hop());
  await p2.evaluate(() => window.__hop());
  await p1.waitForTimeout(35);
  const done = await p1.evaluate(() => window.__game.phase === 'results');
  const done2 = await p2.evaluate(() => window.__game.phase === 'results');
  if (done && done2) break;
}
const res1 = await p1.evaluate(() => window.__game.phase);
const res2 = await p2.evaluate(() => window.__game.phase);
if (res1 !== 'results' || res2 !== 'results') fail(`race did not end: p1=${res1} p2=${res2}`);
ok('race completed → results phase on both clients');

// --- Finishing first should hand the camera to whoever is still running,
// rather than parking it on your own stopped car.
// Carol has seen enough; from here on it is just the two racers, so a round
// isn't left waiting on a car nobody is driving.
await p3.context().close();
await p1.click('#againBtn');
await p1.waitForSelector('#lobby:not(.hidden)', { timeout: 5000 });
await p1.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2, null, { timeout: 8000 });
await p1.click('#startBtn');
for (const page of [p1, p2]) {
  await page.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 8000 });
  await page.waitForFunction(() => performance.now() > window.__game.race.startAt, null, { timeout: 12000 });
}
// Send p1 to the flag on its own; p2 keeps driving.
for (let i = 0; i < 260 && !(await p1.evaluate(() => window.__game.race.finished)); i++) {
  await p1.evaluate(() => window.__hop());
  await p1.waitForTimeout(30);
}
if (!(await p1.evaluate(() => window.__game.race.finished))) fail('p1 never finished');
await p1.waitForTimeout(400);
const watch = await p1.evaluate(() => ({
  watching: window.__game.race.watching,
  banner: document.getElementById('banner').textContent,
  meterHidden: document.getElementById('boostWrap').classList.contains('hidden'),
  myX: Math.round(window.__game.race.car.x),
  camX: Math.round(window.__game.cam.x),
}));
if (!watch.watching) fail(`camera did not pick up another racer: ${JSON.stringify(watch)}`);
if (!/watching /.test(watch.banner)) fail(`no spectate banner: "${watch.banner}"`);
if (!watch.meterHidden) fail('boost meter still showing after finishing');
ok(`finishing hands the camera to the next racer ("${watch.banner}")`);

// Let p2 finish so the room lands back on results for the rest of the run.
for (let i = 0; i < 260 && !(await p1.evaluate(() => window.__game.phase === 'results')); i++) {
  await p2.evaluate(() => window.__hop());
  await p2.waitForTimeout(30);
}
if (await p1.evaluate(() => window.__game.phase !== 'results')) fail('second race never ended');
ok('second race completed');

const rows = await p1.$$eval('#resultRows tr', (trs) => trs.map((tr) => tr.textContent.trim()));
if (rows.length !== 2) fail(`expected 2 result rows, got ${rows.length}: ${rows}`);
if (rows.some((r) => r.includes('DNF'))) fail(`spectator scored as DNF: ${rows}`);
ok(`results table: ${JSON.stringify(rows)}`);

// Every finisher should have a best-lap time next to its total.
const bests = await p1.$$eval('#resultRows tr td:nth-child(4)', (tds) => tds.map((td) => td.textContent.trim()));
if (bests.some((b) => !/^\d+:\d\d\.\d\d$/.test(b))) fail(`missing best-lap times: ${JSON.stringify(bests)}`);
ok(`best-lap column: ${JSON.stringify(bests)}`);

// --- Host resets to lobby
await p1.click('#againBtn');
await p1.waitForSelector('#lobby:not(.hidden)', { timeout: 5000 });
await p2.waitForSelector('#lobby:not(.hidden)', { timeout: 5000 });
ok('race again returns both clients to lobby');

// --- The circuit picker leads on the best time for the whole race, with the
// best single lap under it, and a placeholder where nothing has been set.
const raced = await p1.evaluate(() => window.__game.setup.track);
const chips = await p1.$$eval('#trackPick .pick', (els) =>
  els.map((el) => ({
    track: Number(el.dataset.track),
    race: el.querySelector('.pb').textContent.trim(),
    lap: el.querySelector('.pblap').textContent.trim(),
    unset: el.querySelector('.pb').classList.contains('none'),
  })));
if (chips.length !== 4) fail(`expected 4 circuit chips, got ${chips.length}`);
const racedChip = chips.find((c) => c.track === raced);
if (racedChip.unset || !/^\d+:\d\d\.\d\d$/.test(racedChip.race)) {
  fail(`no race time shown for the circuit just raced: ${JSON.stringify(racedChip)}`);
}
if (!/^best lap \d+:\d\d\.\d\d$/.test(racedChip.lap)) {
  fail(`no best lap under the race time: ${JSON.stringify(racedChip)}`);
}
// The whole race must be slower than any single lap of it.
const toMs = (t) => { const [m, s] = t.replace(/[^\d:.]/g, '').split(':'); return (+m) * 60000 + (+s) * 1000; };
if (toMs(racedChip.race) <= toMs(racedChip.lap)) {
  fail(`race time should exceed a single lap: ${JSON.stringify(racedChip)}`);
}
if (!chips.some((c) => c.track !== raced && c.unset)) {
  fail(`unraced circuits should show a placeholder: ${JSON.stringify(chips)}`);
}
ok(`circuit picker shows race times (${chips.map((c) => c.race).join(' | ')}), ${racedChip.lap}`);

// A non-host sees the times too, but can't change the selection.
const guest = await p2.evaluate(() => ({
  boxShown: !document.getElementById('setupBox').classList.contains('hidden'),
  readonly: document.getElementById('setupBox').classList.contains('readonly'),
  chips: document.querySelectorAll('#trackPick .pb').length,
}));
if (!guest.boxShown || guest.chips !== 4) fail(`non-host cannot see the circuits: ${JSON.stringify(guest)}`);
if (!guest.readonly) fail('non-host got an editable circuit picker');
const guestTrackBefore = await p2.evaluate(() => window.__game.setup.track);
await p2.evaluate(() => document.querySelector('#trackPick .pick:nth-child(4)').click());
await p2.waitForTimeout(150);
if (await p2.evaluate(() => window.__game.setup.track) !== guestTrackBefore) {
  fail('a non-host managed to change the circuit');
}
ok('non-host sees the circuit times but cannot change the pick');

// --- Championship: points, standings, and a new circuit each round.
await p1.click('#roundPick .pick:nth-child(2)'); // 3 rounds
await p2.waitForFunction(() => window.__game.setup.rounds === 3, null, { timeout: 5000 });
ok('host race setup propagates to the other players');

await p1.click('#startBtn');
await p1.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 8000 });
await p2.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 8000 });
const round1Track = await p1.evaluate(() => window.__game.series && document.getElementById('trackTag').textContent);
if (!/R1\/3/.test(round1Track || '')) fail(`round 1 not flagged in the HUD: ${round1Track}`);
ok(`championship round 1 under way (${round1Track})`);

// Laps only count once the lights go out, so wait for the green first.
for (const page of [p1, p2]) {
  await page.waitForFunction(() => performance.now() > window.__game.race.startAt, null, { timeout: 12000 });
}
for (let i = 0; i < 240; i++) {
  await p1.evaluate(() => window.__hop());
  await p2.evaluate(() => window.__hop());
  await p1.waitForTimeout(30);
  if (await p1.evaluate(() => window.__game.phase === 'results')) break;
}
if (await p1.evaluate(() => window.__game.phase !== 'results')) {
  fail(`championship round 1 never finished (laps: ${await p1.evaluate(() => window.__game.race?.lapsDone)})`);
}

const standings = await p1.$$eval('#seriesRows tr', (trs) => trs.map((tr) => tr.textContent.trim()));
if (standings.length !== 2) fail(`expected 2 championship rows, got ${JSON.stringify(standings)}`);
const points = await p1.evaluate(() => window.__game.series.standings.map((s) => s.pts));
if (points[0] !== 10 || points[1] !== 8) fail(`unexpected points: ${JSON.stringify(points)}`);
ok(`championship standings after round 1: ${JSON.stringify(standings)}`);

const nextLabel = await p1.textContent('#againBtn');
if (!/Next round/.test(nextLabel)) fail(`expected a next-round button, got "${nextLabel}"`);
await p1.click('#againBtn');
await p1.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 10000 });
await p2.waitForFunction(() => window.__game.phase === 'racing', null, { timeout: 10000 });
const round2Track = await p1.evaluate(() => document.getElementById('trackTag').textContent);
if (round2Track === round1Track) fail(`round 2 reused the same circuit: ${round2Track}`);
ok(`round 2 moved to a different circuit (${round1Track} → ${round2Track})`);

// --- Screenshot for the human
await p1.waitForFunction(() => performance.now() > window.__game.race.startAt + 1500, null, { timeout: 12000 });
await p1.screenshot({ path: new URL('./race.png', import.meta.url).pathname });
ok('screenshot saved');

await browser.close();
console.log('\nALL SMOKE TESTS PASSED');
process.exit(0);
