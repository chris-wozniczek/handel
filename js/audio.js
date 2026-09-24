// Sound engine: warm synths, tasteful FX, drums, and a conductor loop. Built on Tone.js.
import { chord, midiToFreq } from './music.js';

let Tone = null;
export async function loadTone() {
  if (!Tone) Tone = await import('https://cdn.jsdelivr.net/npm/tone@15.0.4/+esm');
  return Tone;
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.root = 0;
    this.scale = 'Major Pentatonic';
    this.leadActive = false;
    this.loopOn = false;
    this.step = 0;
    this.intensity = 0.5;
    this.onBeat = null;
    this.onLoopNote = null;
  }

  async start() {
    const T = await loadTone();
    await T.start();
    if (this.ready) return;
    const ctx = T.getContext();
    ctx.lookAhead = 0.03;

    // Master chain
    this.master = new T.Gain(0.9);
    this.comp = new T.Compressor({ threshold: -20, ratio: 3, attack: 0.01, release: 0.25 });
    this.limiter = new T.Limiter(-1.5);
    this.master.chain(this.comp, this.limiter, T.getDestination());
    this.recordDest = ctx.rawContext.createMediaStreamDestination();
    T.connect(this.limiter, this.recordDest);

    this.meter = new T.Meter({ normalRange: true, smoothing: 0.85 });
    this.fft = new T.Analyser('fft', 64);
    this.limiter.connect(this.meter);
    this.limiter.connect(this.fft);

    // FX sends
    this.bus = new T.Gain(1).connect(this.master);
    this.revSmall = new T.Reverb({ decay: 1.8, preDelay: 0.01, wet: 1 });
    this.revLarge = new T.Reverb({ decay: 7.5, preDelay: 0.04, wet: 1 });
    await Promise.all([this.revSmall.ready, this.revLarge.ready]);
    this.revXfade = new T.CrossFade(0.4).connect(this.master);
    this.revSmall.connect(this.revXfade.a);
    this.revLarge.connect(this.revXfade.b);
    this.revSend = new T.Gain(0.45);
    this.revSend.fan(this.revSmall, this.revLarge);
    this.delay = new T.FeedbackDelay({ delayTime: '8n.', feedback: 0.32, wet: 1 });
    this.delayTone = new T.Filter({ type: 'lowpass', frequency: 2600 });
    this.delaySend = new T.Gain(0.16);
    this.delaySend.chain(this.delay, this.delayTone);
    this.delayTone.connect(this.master);
    this.delayTone.connect(this.revSend);
    const sends = (node, rev = 1, del = 1) => {
      node.connect(this.bus);
      if (rev) node.connect(this.revSend);
      if (del) node.connect(this.delaySend);
      return node;
    };

    // Theremin lead: detuned saw stack + sine sub, through a resonant lowpass and gentle vibrato.
    this.leadOut = sends(new T.Gain(0), 1, 1);
    this.leadFilter = new T.Filter({ type: 'lowpass', frequency: 1400, Q: 1.8, rolloff: -24 });
    this.vibrato = new T.Vibrato({ frequency: 5.2, depth: 0.06 });
    this.leadFilter.chain(this.vibrato, this.leadOut);
    this.lead = new T.Synth({
      oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
      envelope: { attack: 0.18, decay: 0.3, sustain: 0.85, release: 1.4 },
      portamento: 0.085,
      volume: -12,
    }).connect(this.leadFilter);
    this.leadSub = new T.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.18, decay: 0.3, sustain: 0.9, release: 1.4 },
      portamento: 0.085,
      volume: -10,
    }).connect(this.leadFilter);

    // Bell pluck (FM)
    this.pluckSynth = sends(
      new T.PolySynth(T.FMSynth, {
        maxPolyphony: 12,
        harmonicity: 3.01,
        modulationIndex: 1.8,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.1, sustain: 0, release: 1.4 },
        modulation: { type: 'triangle' },
        modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.4 },
        volume: -9,
      }),
    );

    // Warm pad
    this.padFilter = new T.Filter({ type: 'lowpass', frequency: 1600, Q: 0.6, rolloff: -24 });
    this.chorus = new T.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.6, wet: 0.5 }).start();
    this.padOut = sends(new T.Gain(1), 1, 0);
    this.padFilter.chain(this.chorus, this.padOut);
    this.pad = new T.PolySynth(T.Synth, {
      maxPolyphony: 16,
      oscillator: { type: 'fatsawtooth', count: 3, spread: 30 },
      envelope: { attack: 0.3, decay: 0.8, sustain: 0.55, release: 2.6 },
      volume: -17,
    }).connect(this.padFilter);

    // Drums
    this.drumBus = new T.Gain(1);
    this.drumBus.connect(this.bus);
    this.drumRev = new T.Gain(0.25);
    this.drumBus.connect(this.drumRev);
    this.drumRev.connect(this.revSend);
    this.kick = new T.MembraneSynth({
      pitchDecay: 0.045, octaves: 5.5,
      envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.2 }, volume: -3,
    }).connect(this.drumBus);
    this.tom = new T.MembraneSynth({
      pitchDecay: 0.08, octaves: 2.5,
      envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.2 }, volume: -8,
    }).connect(this.drumBus);
    const snHP = new T.Filter({ type: 'bandpass', frequency: 2400, Q: 0.7 }).connect(this.drumBus);
    this.snare = new T.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.17, sustain: 0 }, volume: -10 }).connect(snHP);
    this.snareBody = new T.Synth({ oscillator: { type: 'triangle' }, envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.05 }, volume: -12 }).connect(this.drumBus);
    const hatHP = new T.Filter({ type: 'highpass', frequency: 7500 }).connect(this.drumBus);
    this.hat = new T.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.045, sustain: 0 }, volume: -20 }).connect(hatHP);
    const clapBP = new T.Filter({ type: 'bandpass', frequency: 1500, Q: 1.1 }).connect(this.drumBus);
    this.clap = new T.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.001, decay: 0.12, sustain: 0 }, volume: -9 }).connect(clapBP);
    const crashHP = new T.Filter({ type: 'highpass', frequency: 4500 }).connect(this.drumBus);
    this.crash = new T.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.002, decay: 1.4, sustain: 0 }, volume: -24 }).connect(crashHP);

    // Bass for the conductor loop
    this.bass = sends(
      new T.MonoSynth({
        oscillator: { type: 'sawtooth' },
        filter: { Q: 1.5, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.005, decay: 0.25, sustain: 0.4, release: 0.3 },
        filterEnvelope: { attack: 0.005, decay: 0.18, sustain: 0.2, release: 0.3, baseFrequency: 90, octaves: 3 },
        volume: -12,
      }),
      0, 0,
    );

    this.transport = T.getTransport();
    this.transport.bpm.value = 96;
    this.loop = new T.Loop((time) => this._tick(time), '16n');
    this.loopGain = 1;
    this.ready = true;
  }

  get T() { return Tone; }
  now() { return Tone.now(); }

  setKey(root, scale) { this.root = root; this.scale = scale; }

  /* ---------------- Theremin ---------------- */
  leadOn(midi) {
    if (!this.ready) return;
    const t = Tone.now();
    if (!this.leadActive) {
      this.lead.triggerAttack(midiToFreq(midi), t);
      this.leadSub.triggerAttack(midiToFreq(midi - 12), t);
      this.leadActive = true;
    } else {
      this.lead.setNote(midiToFreq(midi), t);
      this.leadSub.setNote(midiToFreq(midi - 12), t);
    }
  }
  leadOff() {
    if (!this.ready || !this.leadActive) return;
    const t = Tone.now();
    this.lead.triggerRelease(t);
    this.leadSub.triggerRelease(t);
    this.leadActive = false;
  }
  /** expr 0..1 from left-hand openness: brightness + volume */
  setLeadExpression(expr, present = true) {
    if (!this.ready) return;
    const e = clamp(expr);
    this.leadFilter.frequency.rampTo(280 + Math.pow(e, 1.6) * 4200, 0.08);
    this.leadOut.gain.rampTo(present ? 0.25 + 0.75 * e : 0.7, 0.1);
  }

  /* ---------------- Notes ---------------- */
  pluck(midi, vel = 0.8) {
    if (!this.ready) return;
    this.pluckSynth.triggerAttackRelease(midiToFreq(midi), 0.4, Tone.now(), vel);
  }

  strum(notes, vel = 0.8) {
    if (!this.ready) return;
    const t = Tone.now();
    this.pad.releaseAll(t);
    notes.forEach((m, i) => {
      this.pad.triggerAttackRelease(midiToFreq(m), 1.6, t + i * 0.018, vel);
    });
    notes.forEach((m, i) => this.pluckSynth.triggerAttackRelease(midiToFreq(m + 12), 0.3, t + 0.05 + i * 0.07, vel * 0.45));
  }

  setPadBrightness(e) {
    if (!this.ready) return;
    this.padFilter.frequency.rampTo(450 + Math.pow(clamp(e), 1.5) * 3800, 0.1);
  }

  drum(name, vel = 0.9, time) {
    if (!this.ready) return;
    const t = time ?? Tone.now();
    switch (name) {
      case 'kick': this.kick.triggerAttackRelease('C1', '8n', t, vel); break;
      case 'snare':
        this.snare.triggerAttackRelease('16n', t, vel);
        this.snareBody.triggerAttackRelease(185, '32n', t, vel);
        break;
      case 'hat': this.hat.triggerAttackRelease('32n', t, vel); break;
      case 'clap':
        for (let i = 0; i < 3; i++) this.clap.triggerAttackRelease(0.02, t + i * 0.011, vel * (i === 2 ? 1 : 0.6));
        this.clap.triggerAttackRelease('16n', t + 0.034, vel);
        break;
      case 'tom': this.tom.triggerAttackRelease('A1', '8n', t, vel); break;
      case 'tomHi': this.tom.triggerAttackRelease('E2', '8n', t, vel); break;
      case 'crash': this.crash.triggerAttackRelease('2n', t, vel); break;
      case 'boom':
        this.kick.triggerAttackRelease('A0', '4n', t, vel);
        this.crash.triggerAttackRelease('2n', t, vel * 0.7);
        break;
    }
  }

  /* ---------------- FX ---------------- */
  setSpace(s) {
    if (!this.ready) return;
    const v = clamp(s);
    this.revXfade.fade.rampTo(v, 0.2);
    this.revSend.gain.rampTo(0.28 + v * 0.5, 0.2);
  }

  /* ---------------- Conductor ---------------- */
  startLoop() {
    if (!this.ready || this.loopOn) return;
    this.step = 0;
    this.loop.start(0);
    this.transport.start('+0.05');
    this.loopOn = true;
  }
  stopLoop() {
    if (!this.ready || !this.loopOn) return;
    this.loop.stop();
    this.transport.stop();
    this.pad.releaseAll();
    this.loopOn = false;
  }
  setTempo(bpm) { if (this.ready) this.transport.bpm.rampTo(bpm, 0.35); }
  setIntensity(i) { this.intensity = clamp(i); }
  setLoopLevel(g) { this.loopGain = clamp(g); }

  _tick(time) {
    const s = this.step % 16;
    const bar = Math.floor(this.step / 16) % 4;
    const I = this.intensity;
    const g = this.loopGain;
    const prog = [0, 4, 5, 3];
    const deg = prog[bar];
    const tri = chord(this.root, this.scale, deg, 48, true);
    if (g > 0.02) {
      if (s % 4 === 0) this.drum('kick', 0.85 * g, time);
      if (I > 0.3 && (s === 4 || s === 12)) this.drum(I > 0.7 ? 'clap' : 'snare', 0.7 * g, time);
      if (I > 0.12 && s % 2 === 1) this.drum('hat', (s % 4 === 3 ? 0.7 : 0.4) * g, time);
      if ([0, 3, 6, 10, 11, 14].includes(s) && I > 0.2) {
        const bassNote = tri[0] - 12 + (s === 14 && I > 0.5 ? 7 : 0);
        this.bass.triggerAttackRelease(midiToFreq(bassNote), '16n', time, 0.8 * g);
      }
      if (s === 0) {
        tri.forEach((m, i) => this.pad.triggerAttackRelease(midiToFreq(m + 12), '1m', time + i * 0.012, 0.55 * g));
      }
      if (I > 0.55) {
        const arp = [0, 1, 2, 3, 2, 1, 0, 2];
        if (s % 2 === 0 || I > 0.85) {
          const m = tri[arp[(s >> (I > 0.85 ? 0 : 1)) % 8] % tri.length] + 24;
          this.pluckSynth.triggerAttackRelease(midiToFreq(m), '16n', time, 0.35 * g);
          Tone.getDraw().schedule(() => this.onLoopNote?.(m), time);
        }
      }
    }
    const st = s;
    Tone.getDraw().schedule(() => this.onBeat?.(st, bar), time);
    this.step++;
  }

  /* ---------------- Analysis ---------------- */
  level() { return this.ready ? this.meter.getValue() : 0; }
  bands() {
    if (!this.ready) return [0, 0, 0];
    const v = this.fft.getValue();
    const norm = (db) => clamp((db + 100) / 70);
    let lo = 0, mid = 0, hi = 0;
    for (let i = 0; i < 4; i++) lo += norm(v[i]);
    for (let i = 4; i < 16; i++) mid += norm(v[i]);
    for (let i = 16; i < 40; i++) hi += norm(v[i]);
    return [lo / 4, mid / 12, hi / 24];
  }

  setMuted(m) { if (this.ready) this.master.gain.rampTo(m ? 0 : 0.9, 0.15); }
  allOff() {
    if (!this.ready) return;
    this.leadOff();
    this.stopLoop();
    this.pad.releaseAll();
  }
}
