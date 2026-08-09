# Slipstream 🏎️

A multiplayer racing game that runs in the browser — built for phones, playable
anywhere. Create a race, share the link in the group chat, and everyone who
taps it is on the starting grid.

- **Top-down arcade driving** — auto-accelerate, steer with your thumbs,
  drift through corners. Grass slows you down; there are no walls to get
  stuck on. Slide hard enough and you leave rubber on the road.
- **Ghost multiplayer** — cars don't collide, so every phone simulates its own
  car and just streams positions. No lag fights, no rubber-banding.
- **Rooms with 4-letter codes** — up to 8 players, first player in is the host.
- **3-lap races** with live standings, lap and best-lap timing, a finish
  cutoff, and a results screen.
- **Survives a dropped signal** — lock your phone or walk into a tunnel and
  the client reconnects and climbs back into the same car, mid-race.

## How it works

| Piece | Tech |
| --- | --- |
| Client | Vanilla JS + canvas, no build step (`public/`) |
| Server | Cloudflare Worker (`src/worker.js`) serving the static client |
| Rooms | One Durable Object per room code, relaying WebSocket messages |

Each client runs its own physics at 60fps and broadcasts `{x, y, heading}`
about 15 times a second. Everyone else renders those cars ~130ms in the past,
interpolating between the last two packets. The Durable Object is a relay plus
referee: lobby state, start countdown, lap reports, finish order, and a 45s
cutoff after the first finisher.

The room persists the race it is running, because a Durable Object can be
evicted between messages and would otherwise wake up having forgotten it. It
also hands each player a resume token: a socket that drops is parked for 25
seconds rather than deleted, so a reconnecting phone gets its own car, colour
and place in the running order back.

## Develop

```sh
npm install
npm run dev        # http://localhost:8787 — open two tabs to race yourself
```

With the dev server running, `npm test` plays a full race in headless Chromium
— lobby, countdown, driving, replication between clients, a mid-race
disconnect that resumes, a late joiner who spectates, results, race again —
and saves a screenshot to `test/race.png`. Set `CHROMIUM_PATH` if Playwright
hasn't downloaded its own browser.

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

| | Steer | Brake | Gas |
| --- | --- | --- | --- |
| Phone | hold left / right side of screen | hold middle | automatic |
| Keyboard | ← → or A D | ↓ / S / Space | automatic |
