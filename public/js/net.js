// Thin WebSocket wrapper: joins the room on open, JSON in/out, keepalive
// pings (answered server-side without waking the Durable Object).

export class Net {
  constructor(code, name, onMsg, onClose) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);
    this.ws.onopen = () => this.send({ t: 'join', name });
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t !== 'pong') onMsg(msg);
    };
    this.ws.onclose = () => { this.dispose(); onClose(); };
    this.ws.onerror = () => {};
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), 20000);
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  dispose() {
    clearInterval(this.pingTimer);
  }

  close() {
    this.dispose();
    this.ws.onclose = null;
    this.ws.close();
  }
}
