// Hand tracking (MediaPipe Tasks Vision), synthetic demo hands, and gesture features.
const TV_VERSION = '0.10.14';
const TV_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export const TIPS = [4, 8, 12, 16, 20];
export const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* Camera tracker                                                      */
/* ------------------------------------------------------------------ */
export class CameraTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.fps = 0;
    this._frames = 0;
    this._fpsT = performance.now();
    this.latest = { left: null, right: null };
  }

  async load(onProgress) {
    onProgress?.('Loading hand model…');
    const vision = await import(`${TV_BASE}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${TV_BASE}/wasm`);
    const make = (delegate) =>
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    this._make = make;
    try {
      this.landmarker = await make('GPU');
    } catch (e) {
      console.warn('GPU delegate unavailable, using CPU', e);
      this.landmarker = await make('CPU');
    }
  }

  async startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
  }

  async fallbackToCpu() {
    if (!this._make || this._cpu) return;
    this._cpu = true;
    const old = this.landmarker;
    this.landmarker = null;
    try {
      this.landmarker = await this._make('CPU');
      this.lastVideoTime = -1;
      old?.close();
    } catch (e) {
      console.error(e);
      this.landmarker = old;
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Runs detection if a new video frame is available. Returns true when `latest` was updated. */
  detect() {
    const v = this.video;
    if (v.paused && this.stream) v.play().catch(() => {});
    if (v.currentTime !== this.lastVideoTime) this._stallT = performance.now();
    else if (this.stream && performance.now() - (this._stallT || 0) > 2000) {
      this._stallT = performance.now();
      this.latest = { left: null, right: null };
      v.srcObject = this.stream;
      v.play().catch(() => {});
    }
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = v.currentTime;
    const res = this.landmarker.detectForVideo(v, performance.now());
    this._frames++;
    const now = performance.now();
    if (now - this._fpsT > 1000) {
      this.fps = (this._frames * 1000) / (now - this._fpsT);
      this._frames = 0;
      this._fpsT = now;
    }
    const hands = (res.landmarks || []).map((lm, i) => {
      const pts = lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })); // mirror to match the selfie view
      const label = res.handednesses?.[i]?.[0]?.categoryName;
      // Labels assume a mirrored input; our input is raw, so "Left" is the user's right hand.
      const side = label === 'Left' ? 'right' : 'left';
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      return { pts, side, cx };
    });
    const out = { left: null, right: null };
    if (hands.length === 2) {
      hands.sort((a, b) => a.cx - b.cx);
      out.left = hands[0].pts;
      out.right = hands[1].pts;
    } else if (hands.length === 1) {
      out[hands[0].side] = hands[0].pts;
    }
    this.latest = out;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Synthetic hands for demo / attract mode                             */
/* ------------------------------------------------------------------ */
const FINGERS = [
  { base: [-0.3, -0.9], len: [0.45, 0.27, 0.21], ang: -0.14 },
  { base: [-0.06, -0.98], len: [0.5, 0.31, 0.23], ang: -0.03 },
  { base: [0.16, -0.92], len: [0.46, 0.28, 0.22], ang: 0.08 },
  { base: [0.35, -0.78], len: [0.36, 0.22, 0.2], ang: 0.22 },
];

/**
 * Build 21 landmarks. p: {x,y (0..1 display), size (palm length in screen heights), rot, open (0..1),
 * pinch (0..1 thumb→index), touch (index 0..3 of finger the thumb touches, with p.touchAmt)}.
 */
export function synthHand(p, side, aspect) {
  const s = p.size ?? 0.17;
  const rot = p.rot ?? 0;
  const mir = side === 'left' ? -1 : 1;
  const local = new Array(21);
  local[0] = [0, 0];
  const curlBase = 1 - (p.open ?? 1);
  const touchIdx = p.touchIdx ?? -1;
  const touchAmt = p.touchAmt ?? 0;
  FINGERS.forEach((f, fi) => {
    let curl = curlBase;
    if (fi === 0) curl = Math.max(curl, (p.pinch ?? 0) * 0.55);
    if (fi === touchIdx) curl = Math.max(curl, touchAmt * 0.6);
    const dir = [Math.sin(f.ang), -Math.cos(f.ang)];
    let x = f.base[0], y = f.base[1];
    local[5 + fi * 4] = [x, y];
    let cum = 0;
    const bends = [1.35, 1.6, 1.1];
    for (let j = 0; j < 3; j++) {
      cum += curl * bends[j];
      const L = f.len[j] * Math.cos(cum);
      x += dir[0] * L - Math.sin(cum) * 0.05 * dir[0];
      y += dir[1] * L;
      local[6 + fi * 4 + j] = [x, y];
    }
  });
  // Thumb
  const tOpen = [[-0.2, -0.22], [-0.42, -0.42], [-0.58, -0.6], [-0.7, -0.78]];
  const tFist = [[-0.2, -0.22], [-0.32, -0.45], [-0.22, -0.62], [-0.08, -0.66]];
  for (let j = 0; j < 4; j++) {
    const a = tOpen[j], b = tFist[j];
    local[1 + j] = [lerp(a[0], b[0], curlBase), lerp(a[1], b[1], curlBase)];
  }
  const target = touchIdx >= 0 ? 8 + touchIdx * 4 : 8;
  const amt = touchIdx >= 0 ? touchAmt : p.pinch ?? 0;
  if (amt > 0) {
    const t = local[target];
    local[4] = [lerp(local[4][0], t[0] - 0.02, amt), lerp(local[4][1], t[1] + 0.03, amt)];
    local[3] = [lerp(local[3][0], (local[2][0] + t[0]) / 2 - 0.08, amt * 0.8), lerp(local[3][1], (local[2][1] + t[1]) / 2, amt * 0.8)];
  }
  const c = Math.cos(rot), sn = Math.sin(rot);
  return local.map(([lx, ly]) => {
    const X = lx * mir, Y = ly;
    const rx = X * c - Y * sn, ry = X * sn + Y * c;
    return { x: p.x + (rx * s) / aspect, y: p.y + ry * s, z: 0 };
  });
}

/** Choreography for the attract screen / demo mode. Returns synth params per side. */
export function demoPose(mode, t) {
  const L = { x: 0.3, y: 0.62, size: 0.17, rot: 0.15, open: 1, pinch: 0 };
  const R = { x: 0.7, y: 0.5, size: 0.17, rot: -0.15, open: 1, pinch: 0 };
  const beat = (period, width = 0.18, phase = 0) => {
    const u = (((t + phase) % period) + period) % period / period;
    return u < width ? Math.sin((u / width) * Math.PI) : 0;
  };
  if (mode === 'theremin') {
    R.y = 0.5 + 0.28 * Math.sin(t * 0.9) * Math.cos(t * 0.37);
    R.x = 0.7 + 0.06 * Math.sin(t * 0.7);
    R.pinch = beat(0.75, 0.22);
    L.open = 0.55 + 0.45 * Math.sin(t * 0.6);
    L.y = 0.58 + 0.08 * Math.sin(t * 0.5);
    L.x = 0.3 + 0.08 * Math.sin(t * 0.33);
    L.rot = 0.2 + 0.1 * Math.sin(t);
  } else if (mode === 'chords') {
    const step = Math.floor(t / 1.1) % 4;
    const ph = (t % 1.1) / 1.1;
    R.touchIdx = step;
    R.touchAmt = ph < 0.45 ? Math.sin((ph / 0.45) * Math.PI) : 0;
    R.y = 0.48 + 0.04 * Math.sin(t);
    L.open = 0.6 + 0.4 * Math.sin(t * 0.4);
    L.y = 0.6 + 0.05 * Math.sin(t * 0.8);
  } else if (mode === 'drums') {
    const hitL = beat(0.9, 0.35, 0.45), hitR = beat(0.9, 0.35);
    L.y = 0.42 + 0.3 * hitL; R.y = 0.42 + 0.3 * hitR;
    L.x = 0.24 + 0.1 * Math.sin(t * 0.4); R.x = 0.72 + 0.12 * Math.sin(t * 0.55);
    L.open = 0.7; R.open = 0.7;
    const fist = beat(3.6, 0.12, 1.4);
    if (fist > 0.3) { L.open = 0; }
  } else if (mode === 'conductor') {
    const w = t * 2.6;
    R.x = 0.68 + 0.12 * Math.sin(w); R.y = 0.45 + 0.14 * Math.abs(Math.cos(w));
    L.x = 0.32 - 0.1 * Math.sin(w); L.y = 0.5 + 0.12 * Math.abs(Math.cos(w));
    R.rot = -0.3 * Math.sin(w); L.rot = 0.3 * Math.sin(w);
  }
  return { left: L, right: R };
}

/* ------------------------------------------------------------------ */
/* Gesture features + events                                           */
/* ------------------------------------------------------------------ */
function dist(a, b, aspect) {
  const dx = (a.x - b.x) * aspect, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

class HandState {
  constructor(side) {
    this.side = side;
    this.reset();
  }
  reset() {
    this.present = false;
    this.presence = 0; // eased 0..1 for visuals
    this.pts = null; // displayed (smoothed) landmarks
    this.target = null;
    this.open = 1;
    this.pinchRatio = 1;
    this.pinched = false;
    this.fist = false;
    this.touch = [false, false, false, false];
    this.touchRatio = [1, 1, 1, 1];
    this.palm = { x: 0.5, y: 0.5 };
    this.vel = { x: 0, y: 0 };
    this.speed = 0;
    this.size = 0.15;
    this.lostAt = 0;
    this.strikeArmed = true;
    this.lastStrike = 0;
  }
}

export class Gestures {
  constructor() {
    this.hands = { left: new HandState('left'), right: new HandState('right') };
    this.listeners = [];
  }
  on(fn) { this.listeners.push(fn); }
  emit(type, side, data = {}) { this.listeners.forEach((fn) => fn(type, side, data)); }

  /** Feed new target landmarks (may be null). */
  setTargets(targets, now) {
    for (const side of ['left', 'right']) {
      const h = this.hands[side];
      const t = targets[side];
      if (t) {
        if (!h.present) {
          h.pts = t.map((p) => ({ ...p }));
          h.present = true;
          this.emit('enter', side);
        }
        h.target = t;
        h.lostAt = now;
      } else if (h.present && now - h.lostAt > 180) {
        h.present = false;
        if (h.pinched) this.emit('pinchEnd', side);
        h.pinched = false;
        h.fist = false;
        h.touch = [false, false, false, false];
        this.emit('leave', side);
      }
    }
  }

  /** Per render frame: smooth, compute features, fire events. */
  update(dt, aspect, now) {
    for (const side of ['left', 'right']) {
      const h = this.hands[side];
      h.presence = lerp(h.presence, h.present ? 1 : 0, 1 - Math.exp(-dt * 8));
      if (!h.present || !h.target) {
        h.vel.x *= 0.9; h.vel.y *= 0.9; h.speed *= 0.9;
        continue;
      }
      // Speed-adaptive smoothing (fast moves follow tightly, slow moves stay steady).
      const prevPalm = { ...h.palm };
      let move = 0;
      for (let i = 0; i < 21; i++) move += Math.abs(h.target[i].x - h.pts[i].x) + Math.abs(h.target[i].y - h.pts[i].y);
      move /= 21;
      const k = clamp(0.28 + move * 18, 0.28, 0.85);
      const a = 1 - Math.pow(1 - k, dt * 60);
      for (let i = 0; i < 21; i++) {
        h.pts[i].x = lerp(h.pts[i].x, h.target[i].x, a);
        h.pts[i].y = lerp(h.pts[i].y, h.target[i].y, a);
      }
      const P = h.pts;
      h.palm = {
        x: (P[0].x + P[5].x + P[9].x + P[13].x + P[17].x) / 5,
        y: (P[0].y + P[5].y + P[9].y + P[13].y + P[17].y) / 5,
      };
      if (dt > 0) {
        const vx = (h.palm.x - prevPalm.x) / dt, vy = (h.palm.y - prevPalm.y) / dt;
        const b = 1 - Math.exp(-dt * 14);
        h.vel.x = lerp(h.vel.x, vx, b);
        h.vel.y = lerp(h.vel.y, vy, b);
        h.speed = lerp(h.speed, Math.hypot(vx * aspect, vy), 1 - Math.exp(-dt * 4));
      }
      const size = Math.max(1e-3, dist(P[0], P[9], aspect));
      h.size = size;
      let tipSum = 0;
      for (const ti of [8, 12, 16, 20]) tipSum += dist(P[ti], P[0], aspect) / size;
      h.open = clamp((tipSum / 4 - 1.05) / 0.8);
      h.pinchRatio = dist(P[4], P[8], aspect) / size;

      // Fist
      if (!h.fist && h.open < 0.12) { h.fist = true; this.emit('fist', side, { x: h.palm.x, y: h.palm.y }); }
      else if (h.fist && h.open > 0.35) h.fist = false;

      // Pinch (thumb + index) with hysteresis; suppressed while in a fist.
      if (!h.pinched && h.pinchRatio < 0.3 && h.open > 0.2) {
        h.pinched = true;
        this.emit('pinch', side, { x: (P[4].x + P[8].x) / 2, y: (P[4].y + P[8].y) / 2 });
      } else if (h.pinched && h.pinchRatio > 0.48) {
        h.pinched = false;
        this.emit('pinchEnd', side);
      }

      // Thumb touching each fingertip (chord pad)
      for (let f = 0; f < 4; f++) {
        const r = dist(P[4], P[8 + f * 4], aspect) / size;
        h.touchRatio[f] = r;
        if (!h.touch[f] && r < 0.28 && h.open > 0.15) {
          // Only the closest finger fires.
          let best = f;
          for (let g = 0; g < 4; g++) if (dist(P[4], P[8 + g * 4], aspect) / size < r) best = g;
          if (best === f) {
            h.touch[f] = true;
            this.emit('touch', side, { finger: f, x: P[8 + f * 4].x, y: P[8 + f * 4].y });
          }
        } else if (h.touch[f] && r > 0.45) h.touch[f] = false;
      }

      // Downward strike (air drums)
      const vy = h.vel.y;
      if (h.strikeArmed && vy > 1.5 && now - h.lastStrike > 150) {
        h.strikeArmed = false;
        h.lastStrike = now;
        this.emit('strike', side, { x: h.palm.x, y: h.palm.y, v: clamp((vy - 1.2) / 3, 0.25, 1) });
      } else if (!h.strikeArmed && vy < 0.3) h.strikeArmed = true;
    }
  }

  get distance() {
    const L = this.hands.left, R = this.hands.right;
    if (!L.present || !R.present) return null;
    return Math.hypot(L.palm.x - R.palm.x, L.palm.y - R.palm.y);
  }
}
