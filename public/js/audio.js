// All sound is synthesised — there are no audio files to download, which
// matters when the whole point is tapping a link in a group chat and playing.
//
// Three continuous layers follow the car (engine, tyre scrub, wind) plus
// one-shot blips for the start lights, laps, turbo and the flag. Browsers
// refuse to start audio outside a user gesture, so nothing exists until
// `unlock()` is called from a tap.

export class Sound {
  constructor() {
    this.ctx = null;
    this.on = localStorage.getItem('racer-sound') !== 'off';
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return; // no audio available; the game just runs silent
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 1 : 0;
    this.master.connect(ctx.destination);

    // One looping noise buffer feeds both the tyres and the wind.
    const frames = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.buildEngine();
  }

  buildEngine() {
    const ctx = this.ctx;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.master);
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.connect(this.engineGain);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc1.frequency.value = 48;
    this.osc1.connect(this.engineFilter);
    this.osc1.start();

    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2.frequency.value = 72;
    const o2 = ctx.createGain();
    o2.gain.value = 0.3;
    this.osc2.connect(o2);
    o2.connect(this.engineFilter);
    this.osc2.start();

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidGain.connect(this.master);
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 2400;
    skidFilter.Q.value = 1.4;
    skidFilter.connect(this.skidGain);

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windGain.connect(this.master);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 900;
    windFilter.connect(this.windGain);

    src.connect(skidFilter);
    src.connect(windFilter);
    src.start();
  }

  setEnabled(on) {
    this.on = on;
    localStorage.setItem('racer-sound', on ? 'on' : 'off');
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  // Continuous layers, driven once per frame.
  drive({ speed = 0, boosting = false, slip = 0, draft = 0, live = false }) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime;
    const r = Math.min(1, speed / 340);
    const f = 46 + r * 148 + (boosting ? 34 : 0);
    this.osc1.frequency.setTargetAtTime(f, t, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 1.51, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(480 + r * 2100 + (boosting ? 900 : 0), t, 0.05);
    this.engineGain.gain.setTargetAtTime(live ? 0.05 + r * 0.045 : 0.012, t, 0.08);
    this.skidGain.gain.setTargetAtTime(Math.min(0.15, slip * 0.28), t, 0.05);
    this.windGain.gain.setTargetAtTime(live ? 0.015 + r * 0.04 + draft * 0.05 : 0, t, 0.1);
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of [this.engineGain, this.skidGain, this.windGain]) {
      g.gain.setTargetAtTime(0, t, 0.1);
    }
  }

  blip(freq, dur = 0.12, type = 'sine', vol = 0.22, delay = 0) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Rising whoosh when a charged drift cashes in.
  turbo(tier = 1) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(380, t);
    bp.frequency.exponentialRampToValueAtTime(2400 + tier * 650, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13 + tier * 0.025, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.55);
    this.blip(170 + tier * 55, 0.22, 'sawtooth', 0.1);
  }

  light(final = false) {
    this.blip(final ? 880 : 440, final ? 0.5 : 0.16, 'square', final ? 0.24 : 0.18);
  }

  lap() {
    this.blip(760, 0.1, 'triangle', 0.16);
  }

  best() {
    this.blip(880, 0.09, 'triangle', 0.18);
    this.blip(1320, 0.14, 'triangle', 0.16, 0.09);
  }

  overtake() {
    this.blip(520, 0.07, 'square', 0.13);
    this.blip(700, 0.09, 'square', 0.12, 0.06);
  }

  dumped() {
    this.blip(160, 0.18, 'sawtooth', 0.11);
  }

  flag(won) {
    const notes = won ? [523, 659, 784, 1047] : [523, 659, 784];
    notes.forEach((n, i) => this.blip(n, 0.3, 'triangle', 0.2, i * 0.12));
  }
}
