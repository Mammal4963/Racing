// Racing — Cloudflare Worker entry + Room Durable Object.
//
// The Worker serves static assets and upgrades /ws/<ROOM_CODE> requests into
// a WebSocket handled by one Durable Object per room. The room is a thin
// relay: clients simulate their own car locally (ghost-mode collisions, so no
// authority is needed) and the room fans position packets out to everyone
// else, plus runs the lobby -> racing -> results state machine.

const MAX_PLAYERS = 8;
const FINISH_CUTOFF_MS = 45_000; // once someone finishes, others get this long
const COUNTDOWN_MS = 3_800;
const RESUME_GRACE_MS = 25_000; // a dropped phone can reclaim its car for this long

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cleanName = (v) => String(v ?? '').slice(0, 12).trim() || 'Racer';
const clampMs = (v) => Math.min(3_600_000, Math.max(0, v | 0));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/ws/')) {
      const code = (url.pathname.split('/')[2] || '').toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) {
        return new Response('bad room code', { status: 400 });
      }
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.phase = 'lobby'; // lobby | racing | results
    this.roster = []; // [{id, name, color}] snapshot of who lined up
    this.laps = new Map(); // id -> laps completed (for DNF ordering)
    this.finishes = []; // [{id, ms, best}] in arrival order
    this.gone = new Map(); // id -> {meta, at} — dropped, still inside the grace window
    this.cutoffAt = 0;
    this.nextOrder = 0;
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')
    );
    for (const ws of this.state.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      if (meta) this.nextOrder = Math.max(this.nextOrder, meta.order + 1);
    }
    // Hibernation drops every field above. Without restoring them an evicted
    // room forgets the race it was running: the cutoff alarm fires into an
    // empty `finishes`, nothing ends the race, and the room is wedged in
    // `racing` forever — where both `start` and `again` are ignored.
    this.ready = this.state.storage.get('room').then((s) => {
      if (!s) return;
      this.phase = s.phase ?? 'lobby';
      this.roster = s.roster ?? [];
      this.laps = new Map(s.laps ?? []);
      this.finishes = s.finishes ?? [];
      this.gone = new Map(s.gone ?? []);
      this.cutoffAt = s.cutoffAt ?? 0;
      this.nextOrder = Math.max(this.nextOrder, s.nextOrder ?? 0);
    });
  }

  async fetch(request) {
    await this.ready;
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  save() {
    return this.state.storage.put('room', {
      phase: this.phase,
      roster: this.roster,
      laps: [...this.laps],
      finishes: this.finishes,
      gone: [...this.gone],
      cutoffAt: this.cutoffAt,
      nextOrder: this.nextOrder,
    });
  }

  sockets() {
    return this.state
      .getWebSockets()
      .map((ws) => [ws, ws.deserializeAttachment()])
      .filter(([, meta]) => meta);
  }

  host() {
    let best = null;
    for (const [, meta] of this.sockets()) {
      if (!best || meta.order < best.order) best = meta;
    }
    return best;
  }

  broadcast(obj, exceptWs = null) {
    const raw = JSON.stringify(obj);
    for (const [ws] of this.sockets()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(raw);
      } catch {
        // closed socket; webSocketClose will clean up
      }
    }
  }

  pruneGone() {
    const cutoff = Date.now() - RESUME_GRACE_MS;
    for (const [id, entry] of this.gone) {
      if (entry.at < cutoff) this.gone.delete(id);
    }
  }

  // Public view of a player — never leaks the resume token.
  static pub(meta) {
    return { id: meta.id, name: meta.name, color: meta.color, order: meta.order };
  }

  async webSocketMessage(ws, raw) {
    await this.ready;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const meta = ws.deserializeAttachment();

    if (msg.t === 'join') {
      if (meta) return; // already joined
      await this.join(ws, msg);
      return;
    }

    if (!meta) return; // everything below requires a joined player

    switch (msg.t) {
      case 'start': {
        if (this.phase !== 'lobby' && this.phase !== 'results') return;
        if (meta.id !== this.host().id) return;
        this.phase = 'racing';
        this.laps = new Map();
        this.finishes = [];
        this.cutoffAt = 0;
        this.roster = this.sockets()
          .map(([, m]) => m)
          .sort((a, b) => a.order - b.order)
          .map((m) => ({ id: m.id, name: m.name, color: m.color }));
        await this.save();
        this.broadcast({
          t: 'go',
          startIn: COUNTDOWN_MS,
          order: this.roster.map((r) => r.id),
        });
        break;
      }
      case 's': {
        // Position packet: relay to everyone else. Anything that isn't a real
        // number is dropped here — one malformed packet would otherwise put
        // NaN into every other client's interpolation buffer.
        if (this.phase !== 'racing') return;
        const x = finite(msg.x), y = finite(msg.y), h = finite(msg.h);
        if (x === null || y === null || h === null) return;
        this.broadcast({ t: 's', id: meta.id, x, y, h }, ws);
        await this.maybeEndByCutoff();
        break;
      }
      case 'lap': {
        if (this.phase !== 'racing') return;
        const lap = Math.max(0, msg.lap | 0);
        this.laps.set(meta.id, lap);
        await this.save();
        this.broadcast({ t: 'lap', id: meta.id, lap }, ws);
        break;
      }
      case 'finish': {
        if (this.phase !== 'racing') return;
        if (this.finishes.some((f) => f.id === meta.id)) return;
        const ms = clampMs(msg.ms);
        const best = finite(msg.best) === null ? null : clampMs(msg.best);
        this.finishes.push({ id: meta.id, ms, best });
        if (!this.cutoffAt) this.cutoffAt = Date.now() + FINISH_CUTOFF_MS;
        await this.save();
        await this.scheduleAlarm();
        this.broadcast({ t: 'fin', id: meta.id, ms }, ws);
        await this.checkAllFinished();
        break;
      }
      case 'again': {
        if (this.phase !== 'results') return;
        if (meta.id !== this.host().id) return;
        this.phase = 'lobby';
        this.roster = [];
        this.laps = new Map();
        this.finishes = [];
        await this.save();
        this.broadcast({ t: 'lobby' });
        break;
      }
    }
  }

  async join(ws, msg) {
    this.pruneGone();
    // A phone that locked, lost signal or switched apps comes back with the
    // id + token it was given, and picks its own car back up mid-race.
    const parked = msg.resume && this.gone.get(String(msg.resume.id));
    const resuming = parked && parked.meta.token === msg.resume.token;

    // `create` means "I made this code up" — if anyone is already here the
    // client rolls a different one rather than gatecrashing their race.
    if (msg.create && !resuming && this.sockets().length > 0) {
      ws.send(JSON.stringify({ t: 'taken' }));
      ws.close(1000, 'code taken');
      return;
    }

    let me;
    if (resuming) {
      me = parked.meta;
      this.gone.delete(me.id);
      if (msg.name) me.name = cleanName(msg.name);
    } else {
      if (this.sockets().length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'full' }));
        ws.close(1000, 'room full');
        return;
      }
      const used = new Set([
        ...this.sockets().map(([, m]) => m.color),
        ...[...this.gone.values()].map((e) => e.meta.color),
      ]);
      let color = 0;
      while (used.has(color)) color++;
      me = {
        id: crypto.randomUUID().slice(0, 8),
        token: crypto.randomUUID(),
        name: cleanName(msg.name),
        color,
        order: this.nextOrder++,
      };
    }
    ws.serializeAttachment(me);
    await this.save();

    ws.send(
      JSON.stringify({
        t: 'welcome',
        id: me.id,
        token: me.token,
        phase: this.phase,
        hostId: this.host().id,
        players: this.sockets().map(([, m]) => Room.pub(m)),
        racers: this.roster.map((r) => r.id),
      })
    );
    // Re-announce a resuming player with the lap they were on, so everyone
    // else's standings pick up where they left off instead of showing L1.
    const announced = Room.pub(me);
    if (resuming && this.laps.has(me.id)) announced.lap = this.laps.get(me.id);
    this.broadcast({ t: 'join', p: announced }, ws);
    // Always re-announce the host: a resuming player keeps its join order, so
    // a host that dropped becomes host again and everyone needs to agree.
    this.broadcast({ t: 'host', id: this.host().id });
  }

  async webSocketClose(ws, code) {
    // Finish the closing handshake. A hibernatable WebSocket does not reply to
    // the client's close frame on its own, and a browser left waiting for that
    // reply sits in CLOSING — its `onclose` never fires, so the client-side
    // reconnect never gets a chance to start. 1005/1006 are receive-only codes
    // and cannot be echoed back.
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    } catch {
      // already fully closed
    }
    const meta = ws.deserializeAttachment();
    if (!meta) return;
    ws.serializeAttachment(null);
    const remaining = this.sockets();
    if (remaining.length === 0) {
      this.phase = 'lobby';
      this.roster = [];
      this.laps = new Map();
      this.finishes = [];
      this.gone = new Map();
      this.cutoffAt = 0;
      await this.save();
      await this.state.storage.deleteAlarm();
      return;
    }
    // Park the player so a reconnect within the grace window gets its identity
    // back — same car mid-race, and in the lobby the same colour and join
    // order, so a blinking host doesn't hand the start button away for good.
    this.gone.set(meta.id, { meta, at: Date.now() });
    await this.save();
    this.broadcast({ t: 'leave', id: meta.id });
    this.broadcast({ t: 'host', id: this.host().id });
    if (this.phase === 'racing') {
      await this.checkAllFinished();
      if (this.phase === 'racing') await this.scheduleAlarm();
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  // One alarm, two deadlines: the post-first-finisher cutoff, and each parked
  // player's resume window closing. Whichever comes first wins; `alarm` then
  // re-arms for whatever is still pending.
  async scheduleAlarm() {
    const times = [];
    if (this.cutoffAt) times.push(this.cutoffAt);
    for (const entry of this.gone.values()) times.push(entry.at + RESUME_GRACE_MS);
    if (times.length) await this.state.storage.setAlarm(Math.min(...times));
    else await this.state.storage.deleteAlarm();
  }

  async alarm() {
    await this.ready;
    if (this.phase !== 'racing') return;
    this.pruneGone();
    if (this.cutoffAt && Date.now() >= this.cutoffAt) {
      await this.endRace();
      return;
    }
    // A racer's resume window just closed — they are not coming back, so the
    // race may now be over. Without this a room whose racers all walked away
    // would sit in `racing` forever, refusing to start another one.
    await this.checkAllFinished();
    if (this.phase === 'racing') {
      await this.save();
      await this.scheduleAlarm();
    }
  }

  async maybeEndByCutoff() {
    if (this.cutoffAt && Date.now() >= this.cutoffAt) await this.endRace();
  }

  async checkAllFinished() {
    this.pruneGone();
    const finished = new Set(this.finishes.map((f) => f.id));
    const live = new Set(this.sockets().map(([, m]) => m.id));
    // Only the cars that actually lined up matter here: someone who joined
    // mid-race is a spectator, and waiting on them would hold the race open
    // until the 45s cutoff. A racer inside the resume grace still counts as
    // out on track, so a brief dropout doesn't end the race under them.
    const stillOut = this.roster.some(
      (r) => !finished.has(r.id) && (live.has(r.id) || this.gone.has(r.id))
    );
    if (!stillOut && this.roster.length > 0) await this.endRace();
  }

  async endRace() {
    if (this.phase !== 'racing') return;
    this.phase = 'results';
    const byId = new Map(this.roster.map((r) => [r.id, r]));
    const finished = new Set(this.finishes.map((f) => f.id));
    const dnf = this.roster
      .map((r) => r.id)
      .filter((id) => !finished.has(id))
      .sort((a, b) => (this.laps.get(b) || 0) - (this.laps.get(a) || 0))
      .map((id) => ({ id, ms: null, best: null }));
    // Results carry names and colors so the table still reads correctly for
    // racers who have already closed the tab.
    const list = [...this.finishes]
      .sort((a, b) => a.ms - b.ms)
      .concat(dnf)
      .map((row) => ({ ...row, ...byId.get(row.id) }));
    this.cutoffAt = 0;
    await this.save();
    this.broadcast({ t: 'results', list });
    await this.state.storage.deleteAlarm();
  }
}
