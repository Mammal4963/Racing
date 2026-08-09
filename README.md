# Slipstream 🏎️

A multiplayer racing game that runs in the browser — built for phones, playable
anywhere. Create a race, share the link in the group chat, and everyone who
taps it is on the starting grid.

- **Top-down arcade driving** — auto-accelerate, steer with your thumbs. Three
  buttons, one skill ceiling. Grass slows you down; there are no walls to get
  stuck on.
- **Brake into a corner and the tail steps out.** Hold the drift to charge a
  turbo — three tiers, the longer you hold it the bigger the boost. Run wide
  onto the grass and you lose the lot.
- **Slipstream** — tuck in behind someone and get towed along at +17% top
  speed. Cars are ghosts and never collide, so the tow is the whole reason to
  chase.
- **Four circuits**, each with its own handling character and palette: a
  flowing opener, a fast one, a technical one, and one that will hurt you.
- **Championships** — 1, 3 or 5 rounds, a different circuit each round, points
  down to 8th, live standings between races and a champion at the end.
- **Rooms with 4-letter codes** — up to 8 players, first player in is the host.
- **Lap timing** with best-lap and per-circuit personal bests, live standings,
  a finish cutoff, and a results screen.
- **Survives a dropped signal** — lock your phone or walk into a tunnel and the
  client reconnects and climbs back into the same car, mid-race.
- Start lights, skid marks, dirt, exhaust flames, camera shake, haptics and a
  fully synthesised engine (no audio files to download).

## How it works

| Piece | Tech |
| --- | --- |
| Client | Vanilla JS + canvas, no build step (`public/`) |
| Server | Cloudflare Worker (`src/worker.js`) serving the static client |
| Rooms | One Durable Object per room code, relaying WebSocket messages |

Each client runs its own physics at 60fps and broadcasts `{x, y, heading}`
about 15 times a second. Everyone else renders those cars ~130ms in the past,
interpolating between the last two packets. The Durable Object is a relay plus
referee: lobby state, start countdown, lap reports, finish order, championship
points, and a 45s cutoff after the first finisher.

Because cars never collide there is nothing to arbitrate, so the slipstream is
computed locally from the ghost positions every client already has.

The room persists the race it is running, because a Durable Object can be
evicted between messages and would otherwise wake up having forgotten it. It
also hands each player a resume token: a socket that drops is parked for 25
seconds rather than deleted, so a reconnecting phone gets its own car, colour
and place in the running order back.

## Develop

```sh
npm install
npm run dev        # http://localhost:8787 — open two tabs to race yourself
npm test           # physics checks, then a full two-player race in Chromium
```

`test/physics.mjs` needs neither a browser nor the server: it drives `car.js`
and `track.js` directly and pins down what a held drift pays, that a drift
turns tighter than a flat corner, that the slide can't become a spin, that the
slipstream tows, and that no circuit has a spline cusp in it.

`test/smoke.mjs` needs the dev server running. It plays a full race in headless
Chromium — lobby, start lights, driving, drifting, replication between clients,
a mid-race disconnect that resumes, a late joiner who spectates, results, and a
championship round that rolls onto a new circuit — and saves a screenshot to
`test/race.png`. Set `CHROMIUM_PATH` if Playwright hasn't downloaded its own
browser.

## Deploy

```sh
npx wrangler login # once
npm run deploy
```

Or connect the repo to Cloudflare (Workers & Pages → Create → import this
repo) and every push deploys automatically. Durable Objects require the
`migrations` block in `wrangler.jsonc`, which is already set up — the free
plan works since the Room class uses SQLite-backed storage.

## Controls

| | Steer | Brake / drift | Gas |
| --- | --- | --- | --- |
| Phone | hold either half of the screen | add your other thumb | automatic |
| Keyboard | ← → or A D | hold both, or ↓ / S / Space | automatic |

The screen is two halves and that's it. Hold one side to steer; while you're
turning, put your other thumb down and the car brakes and the tail steps out.
The drift always goes the way you were *already* steering, so the second thumb
never fights the first — let it go and you're back to a clean turn.

Braking in a straight line is a real anchor. Braking *while turning* is a
handbrake: it barely scrubs speed, swings the tail out, turns about 60% tighter
than a grip corner, and fills the turbo meter. That is the whole game. (Grab
both sides from neutral and you get the straight-line anchor instead.)
