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
    this.laps = new Map(); // id -> laps completed (for DNF ordering)
    this.finishes = []; // [{id, ms}] in arrival order
    this.cutoffAt = 0;
    this.nextOrder = 0;
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}')
    );
    // Rebuild transient counters after a hibernation wake-up.
    for (const ws of this.state.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      if (meta) this.nextOrder = Math.max(this.nextOrder, meta.order + 1);
    }
    this.ready = this.state.storage.get('phase').then((p) => {
      if (p) this.phase = p;
    });
  }

  async fetch(request) {
    await this.ready;
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
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

  async setPhase(phase) {
    this.phase = phase;
    await this.state.storage.put('phase', phase);
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
      if (this.sockets().length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: 'full' }));
        ws.close(1000, 'room full');
        return;
      }
      const used = new Set(this.sockets().map(([, m]) => m.color));
      let color = 0;
      while (used.has(color)) color++;
      const me = {
        id: crypto.randomUUID().slice(0, 8),
        name: String(msg.name || 'Racer').slice(0, 12).trim() || 'Racer',
        color,
        order: this.nextOrder++,
      };
      ws.serializeAttachment(me);
      ws.send(
        JSON.stringify({
          t: 'welcome',
          id: me.id,
          phase: this.phase,
          hostId: this.host().id,
          players: this.sockets().map(([, m]) => m),
        })
      );
      this.broadcast({ t: 'join', p: me }, ws);
      return;
    }

    if (!meta) return; // everything below requires a joined player

    switch (msg.t) {
      case 'start': {
        if (this.phase !== 'lobby' && this.phase !== 'results') return;
        if (meta.id !== this.host().id) return;
        await this.setPhase('racing');
        this.laps = new Map();
        this.finishes = [];
        this.cutoffAt = 0;
        const order = this.sockets()
          .map(([, m]) => m)
          .sort((a, b) => a.order - b.order)
          .map((m) => m.id);
        this.broadcast({ t: 'go', startIn: COUNTDOWN_MS, order });
        break;
      }
      case 's': {
        // Position packet: relay to everyone else.
        if (this.phase !== 'racing') return;
        this.broadcast(
          { t: 's', id: meta.id, x: msg.x, y: msg.y, h: msg.h },
          ws
        );
        this.maybeEndByCutoff();
        break;
      }
      case 'lap': {
        if (this.phase !== 'racing') return;
        this.laps.set(meta.id, msg.lap | 0);
        this.broadcast({ t: 'lap', id: meta.id, lap: msg.lap | 0 }, ws);
        break;
      }
      case 'finish': {
        if (this.phase !== 'racing') return;
        if (this.finishes.some((f) => f.id === meta.id)) return;
        this.finishes.push({ id: meta.id, ms: Math.max(0, msg.ms | 0) });
        if (!this.cutoffAt) {
          this.cutoffAt = Date.now() + FINISH_CUTOFF_MS;
          await this.state.storage.setAlarm(this.cutoffAt);
        }
        this.broadcast({ t: 'fin', id: meta.id, ms: msg.ms | 0 }, ws);
        await this.checkAllFinished();
        break;
      }
      case 'again': {
        if (this.phase !== 'results') return;
        if (meta.id !== this.host().id) return;
        await this.setPhase('lobby');
        this.broadcast({ t: 'lobby' });
        break;
      }
    }
  }

  async webSocketClose(ws) {
    const meta = ws.deserializeAttachment();
    if (!meta) return;
    ws.serializeAttachment(null);
    const remaining = this.sockets();
    if (remaining.length === 0) {
      await this.setPhase('lobby');
      this.laps = new Map();
      this.finishes = [];
      this.cutoffAt = 0;
      await this.state.storage.deleteAlarm();
      return;
    }
    this.broadcast({ t: 'leave', id: meta.id });
    this.broadcast({ t: 'host', id: this.host().id });
    if (this.phase === 'racing') await this.checkAllFinished();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.ready;
    if (this.phase === 'racing' && this.cutoffAt) await this.endRace();
  }

  maybeEndByCutoff() {
    if (this.cutoffAt && Date.now() >= this.cutoffAt) this.endRace();
  }

  async checkAllFinished() {
    const finished = new Set(this.finishes.map((f) => f.id));
    const connected = this.sockets().map(([, m]) => m.id);
    if (connected.every((id) => finished.has(id))) await this.endRace();
  }

  async endRace() {
    if (this.phase !== 'racing') return;
    await this.setPhase('results');
    const finished = new Set(this.finishes.map((f) => f.id));
    const dnf = this.sockets()
      .map(([, m]) => m.id)
      .filter((id) => !finished.has(id))
      .sort((a, b) => (this.laps.get(b) || 0) - (this.laps.get(a) || 0))
      .map((id) => ({ id, ms: null }));
    const list = [...this.finishes].sort((a, b) => a.ms - b.ms).concat(dnf);
    this.broadcast({ t: 'results', list });
    this.cutoffAt = 0;
    await this.state.storage.deleteAlarm();
  }
}
