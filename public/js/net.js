// WebSocket wrapper: joins the room on open, JSON in/out, keepalive pings
// (answered server-side without waking the Durable Object), and — the part
// that matters on a phone — automatic reconnect. Locking the screen, taking a
// call or walking through a tunnel drops the socket; the room hands out a
// resume token so we climb back into the same car instead of the race ending
// at a "DISCONNECTED" wall.

const BACKOFF_MS = [400, 800, 1600, 3000, 5000, 5000];
const PING_INTERVAL_MS = 20000;
const STALE_MS = 50000; // no traffic for this long: assume the link is gone

export class Net {
  // onState receives 'open' | 'lost' | 'dead'.
  constructor(code, name, { create = false, onMsg, onState }) {
    this.code = code;
    this.name = name;
    this.create = create;
    this.onMsg = onMsg;
    this.onState = onState;
    this.resume = null; // {id, token} once the room has welcomed us
    this.attempt = 0;
    this.closed = false;
    this.open();
  }

  open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.code}`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastRx = Date.now();
      // `create` only applies to the very first attempt: on a reconnect the
      // players already in the room are our own race, not a code collision.
      this.send({ t: 'join', name: this.name, resume: this.resume, create: this.create });
      this.create = false;
      this.onState('open');
    };

    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'pong') return;
      if (msg.t === 'welcome') this.resume = { id: msg.id, token: msg.token };
      this.onMsg(msg);
    };

    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed || ws !== this.ws) return;
      if (this.attempt >= BACKOFF_MS.length) {
        this.onState('dead');
        return;
      }
      this.onState('lost');
      this.retryTimer = setTimeout(() => this.open(), BACKOFF_MS[this.attempt++]);
    };

    ws.onerror = () => {};
    this.lastRx = Date.now();
    this.pingTimer = setInterval(() => this.tick(), PING_INTERVAL_MS);
  }

  // Losing signal or backgrounding the tab kills the link without a close
  // frame, and the browser can sit on that for minutes before giving up. If
  // the room has gone quiet — pings included — dial a fresh socket instead of
  // waiting for a TCP timeout.
  tick() {
    if (Date.now() - this.lastRx > STALE_MS) {
      const dead = this.ws;
      dead.onclose = dead.onmessage = dead.onopen = null;
      try { dead.close(); } catch { /* already gone */ }
      clearInterval(this.pingTimer);
      this.onState('lost');
      this.open();
      return;
    }
    this.send({ t: 'ping' });
  }

  // No-ops while the socket is down, so a mid-race dropout doesn't take the
  // render loop with it.
  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  get online() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.ws.close();
  }
}
