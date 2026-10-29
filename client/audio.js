// WebAudio 로 합성하는 효과음. 외부 사운드 파일 없이 동작한다.
// 위치가 있는 소리는 PannerNode 로 3D 배치한다.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.6;
    this.noiseBuf = null;
  }

  // 사용자 입력(클릭) 이후에 호출해야 소리가 난다.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setListener(pos, fwd) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  out(pos) {
    if (!pos) return this.master;
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.maxDistance = 120;
    p.rolloffFactor = 1.1;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.master);
    return p;
  }

  noise(dest, { dur = 0.2, gain = 0.5, type = 'lowpass', freq = 2000, freqEnd = null, q = 0.8, attack = 0.002 } = {}) {
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  tone(dest, { freq = 440, freqEnd = null, dur = 0.15, gain = 0.3, type = 'sine', delay = 0, attack = 0.004 } = {}) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // name: 효과음 종류, pos: {x,y,z} 또는 null(2D)
  play(name, pos = null) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const d = this.out(pos);
    switch (name) {
      case 'rifle':
        this.noise(d, { dur: 0.09, gain: 0.45, freq: 3200, freqEnd: 900 });
        this.tone(d, { freq: 160, freqEnd: 60, dur: 0.07, gain: 0.35, type: 'square' });
        break;
      case 'shotgun':
        this.noise(d, { dur: 0.32, gain: 0.8, freq: 2200, freqEnd: 300 });
        this.tone(d, { freq: 110, freqEnd: 40, dur: 0.2, gain: 0.6, type: 'sawtooth' });
        break;
      case 'rail':
        this.tone(d, { freq: 1800, freqEnd: 200, dur: 0.35, gain: 0.35, type: 'sawtooth' });
        this.noise(d, { dur: 0.25, gain: 0.5, type: 'highpass', freq: 3000 });
        this.tone(d, { freq: 90, freqEnd: 40, dur: 0.25, gain: 0.5, type: 'sine' });
        break;
      case 'plasma':
        this.tone(d, { freq: 300, freqEnd: 900, dur: 0.18, gain: 0.3, type: 'sawtooth' });
        this.noise(d, { dur: 0.3, gain: 0.35, type: 'bandpass', freq: 800, freqEnd: 2500, q: 2 });
        break;
      case 'orb':
        this.tone(d, { freq: 700, freqEnd: 1200, dur: 0.1, gain: 0.25, type: 'triangle' });
        break;
      case 'turret':
        this.noise(d, { dur: 0.05, gain: 0.25, freq: 4000 });
        break;
      case 'boom':
        this.noise(d, { dur: 0.9, gain: 1, freq: 1200, freqEnd: 80, attack: 0.005 });
        this.tone(d, { freq: 70, freqEnd: 30, dur: 0.6, gain: 0.8, type: 'sine' });
        break;
      case 'smallboom':
        this.noise(d, { dur: 0.4, gain: 0.6, freq: 1800, freqEnd: 150 });
        break;
      case 'slam':
        this.noise(d, { dur: 1.2, gain: 1, freq: 600, freqEnd: 40 });
        this.tone(d, { freq: 55, freqEnd: 25, dur: 0.9, gain: 1, type: 'sine' });
        break;
      case 'dash':
        this.noise(d, { dur: 0.25, gain: 0.35, type: 'bandpass', freq: 600, freqEnd: 3000, q: 1.5 });
        break;
      case 'jump':
        this.noise(d, { dur: 0.35, gain: 0.4, type: 'bandpass', freq: 400, freqEnd: 1600, q: 1 });
        break;
      case 'hit':
        this.tone(d, { freq: 1500, dur: 0.05, gain: 0.25, type: 'square' });
        break;
      case 'head':
        this.tone(d, { freq: 2100, dur: 0.08, gain: 0.3, type: 'square' });
        this.tone(d, { freq: 2800, dur: 0.1, gain: 0.2, type: 'sine', delay: 0.03 });
        break;
      case 'kill':
        this.tone(d, { freq: 900, dur: 0.1, gain: 0.3, type: 'triangle' });
        this.tone(d, { freq: 1350, dur: 0.18, gain: 0.3, type: 'triangle', delay: 0.08 });
        break;
      case 'hurt':
        this.noise(d, { dur: 0.12, gain: 0.35, freq: 700 });
        break;
      case 'heal':
        this.tone(d, { freq: 520, freqEnd: 780, dur: 0.25, gain: 0.2, type: 'sine' });
        break;
      case 'pulse':
        this.tone(d, { freq: 400, freqEnd: 900, dur: 0.5, gain: 0.3, type: 'sine' });
        this.tone(d, { freq: 600, freqEnd: 1350, dur: 0.5, gain: 0.2, type: 'sine' });
        break;
      case 'ult-ally':
        [523, 659, 784].forEach((f, i) => this.tone(d, { freq: f, dur: 0.5, gain: 0.22, type: 'triangle', delay: i * 0.07 }));
        break;
      case 'ult-enemy':
        [392, 370, 311].forEach((f, i) => this.tone(d, { freq: f, dur: 0.5, gain: 0.25, type: 'sawtooth', delay: i * 0.09 }));
        break;
      case 'cap':
        [660, 880].forEach((f, i) => this.tone(d, { freq: f, dur: 0.35, gain: 0.25, type: 'triangle', delay: i * 0.12 }));
        break;
      case 'reload':
        this.tone(d, { freq: 300, dur: 0.05, gain: 0.2, type: 'square' });
        this.tone(d, { freq: 450, dur: 0.05, gain: 0.2, type: 'square', delay: 0.12 });
        break;
      case 'pack':
        this.tone(d, { freq: 600, freqEnd: 1200, dur: 0.3, gain: 0.25, type: 'triangle' });
        break;
      case 'empty':
        this.tone(d, { freq: 200, dur: 0.04, gain: 0.15, type: 'square' });
        break;
      case 'step':
        this.noise(d, { dur: 0.06, gain: 0.12, freq: 500 });
        break;
      case 'deny':
        this.tone(d, { freq: 180, dur: 0.15, gain: 0.2, type: 'square' });
        break;
      default:
        break;
    }
  }
}
