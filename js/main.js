import { CameraTracker, Gestures, synthHand, demoPose } from './hands.js';
import { AudioEngine, BANDS, BAND_ORDER } from './audio.js';
import { Visuals, PALETTES } from './visuals.js';
import { Recorder } from './recorder.js';
import { NOTE_NAMES, SCALES, scaleNotes, chord, chordLabel, pcName } from './music.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

const MODES = {
  theremin: { label: 'Theremin', hint: '<b>Right hand</b> up/down = pitch<span class="sep">·</span><b>Pinch</b> = pluck<span class="sep">·</span><b>Left hand</b> open = tone<span class="sep">·</span><b>Fist</b> = boom' },
  chords: { label: 'Chord Pad', hint: 'Tap your <b>thumb</b> to each <b>fingertip</b> for a chord<span class="sep">·</span><b>Left hand</b> open = brightness' },
  drums: { label: 'Air Drums', hint: '<b>Tap into a pad</b> with a fingertip (or swipe down over it)<span class="sep">·</span><b>Fist</b> = boom + crash' },
  conductor: { label: 'Conductor', hint: '<b>Wave</b> faster to speed up<span class="sep">·</span><b>Raise hands</b> for more energy<span class="sep">·</span>Hands apart = space' },
};
const MODE_ORDER = ['theremin', 'chords', 'drums', 'conductor'];
const PADS = [
  { name: 'Kick', hint: 'low', sound: 'kick' },
  { name: 'Snare', hint: 'crack', sound: 'snare' },
  { name: 'Hat', hint: 'tick', sound: 'hat' },
  { name: 'Clap', hint: 'snap', sound: 'clap' },
  { name: 'Tom', hint: 'thud', sound: 'tom' },
];
const RIGHT_DEGREES = [0, 4, 5, 3];
const LEFT_DEGREES = [1, 2, 0, 4];

const state = {
  band: 'pop',
  mode: 'theremin',
  root: 0,
  scale: 'Major Pentatonic',
  source: 'attract', // attract | demo | camera
  muted: false,
  thereminNote: null,
  noteIdx: -1,
  bpm: 96,
  energy: 0.5,
  space: 0.4,
  lastHandsSeen: 0,
  attractT0: performance.now(),
};

const stage = $('#stage');
const video = $('#cam');
const visuals = new Visuals(stage, video);
const gestures = new Gestures();
const audio = new AudioEngine();
const tracker = new CameraTracker(video);
const recorder = new Recorder(stage);

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */
const toastEl = $('#toast');
let toastTimer;
function toast(msg, ms = 4200) {
  toastEl.innerHTML = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function setCssPalette(mode) {
  const [a, b, c] = PALETTES[mode];
  const r = document.documentElement.style;
  r.setProperty('--a', a);
  r.setProperty('--b', b);
  r.setProperty('--c', c);
}

function moveIndicator() {
  const btn = document.querySelector(`#modes button[data-mode="${state.mode}"]`);
  const ind = $('#modeInd');
  ind.style.width = btn.offsetWidth + 'px';
  ind.style.transform = `translateX(${btn.offsetLeft}px)`;
}

function setMode(mode, fromUser = false) {
  if (!MODES[mode]) return;
  const prev = state.mode;
  state.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('#modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  moveIndicator();
  visuals.setPalette(mode);
  setCssPalette(mode);
  if (prev !== mode || fromUser) {
    audio.leadOff();
    state.thereminNote = null;
    state.noteIdx = -1;
    if (mode === 'conductor' && state.source !== 'attract') audio.startLoop();
    else audio.stopLoop();
  }
  if (fromUser && state.source === 'attract') state.attractLocked = true;
  showHint();
}

let hintTimer;
function showHint(text) {
  const el = $('#hint');
  if (state.source === 'attract') { el.classList.remove('show'); return; }
  el.innerHTML = text || MODES[state.mode].hint;
  el.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('show'), 9000);
}

function updateKeyLabel() {
  $('#keyLabel').textContent = `${NOTE_NAMES[state.root]} · ${state.scale}`;
}

function buildKeyPicker() {
  const keys = $('#keys');
  NOTE_NAMES.forEach((n, i) => {
    const b = document.createElement('button');
    b.textContent = n;
    b.setAttribute('aria-pressed', String(i === state.root));
    b.onclick = () => {
      state.root = i;
      keys.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
      applyKey();
    };
    keys.appendChild(b);
  });
  const scales = $('#scales');
  Object.keys(SCALES).forEach((s) => {
    const b = document.createElement('button');
    b.textContent = s;
    b.setAttribute('aria-pressed', String(s === state.scale));
    b.onclick = () => {
      state.scale = s;
      scales.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.textContent === s)));
      applyKey();
    };
    scales.appendChild(b);
  });
}

function applyKey() {
  audio.setKey(state.root, state.scale);
  updateKeyLabel();
  state.noteIdx = -1;
  rebuildGuide();
  rebuildChordLabels();
  const tri = chord(state.root, state.scale, 0, 60);
  if (audio.ready && state.source !== 'attract') audio.strum(tri, 0.5);
}

function setBand(id, fromUser = false) {
  const b = BANDS[id];
  if (!b) return;
  state.band = id;
  audio.setBand(id);
  state.bpm = b.tempo[2];
  $('#bandLabel').textContent = b.name;
  document.querySelectorAll('#bands button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.band === id)));
  if (fromUser && state.mode !== 'conductor') setMode('conductor', true);
  if (fromUser) showHint(`<b>${b.name}</b><span class="sep">·</span>${b.desc}<span class="sep">·</span>press <b>B</b> for the next band`);
}
function buildBandPicker() {
  const list = $('#bands');
  BAND_ORDER.forEach((id) => {
    const b = BANDS[id];
    const btn = document.createElement('button');
    btn.dataset.band = id;
    btn.innerHTML = `<span class="bn">${b.name}</span><span class="bd">${b.desc} · ${b.tempo[2]} BPM</span>`;
    btn.setAttribute('aria-pressed', String(id === state.band));
    btn.onclick = () => { setBand(id, true); toggleBandPop(false); if (state.source === 'attract') startDemo(); };
    list.appendChild(btn);
  });
}
const bandBtn = $('#bandBtn');
const bandPop = $('#bandPop');
function toggleBandPop(open = bandPop.hidden) {
  bandPop.hidden = !open;
  bandBtn.setAttribute('aria-expanded', String(open));
  if (open) toggleKeyPop(false);
}
bandBtn.onclick = (e) => { e.stopPropagation(); toggleBandPop(); };
document.addEventListener('pointerdown', (e) => {
  if (!bandPop.hidden && !bandPop.contains(e.target) && !bandBtn.contains(e.target)) toggleBandPop(false);
});

const keyBtn = $('#keyBtn');
const keyPop = $('#keyPop');
function toggleKeyPop(open = keyPop.hidden) {
  keyPop.hidden = !open;
  keyBtn.setAttribute('aria-expanded', String(open));
  if (open) toggleBandPop(false);
}
keyBtn.onclick = (e) => { e.stopPropagation(); toggleKeyPop(); };
document.addEventListener('pointerdown', (e) => {
  if (!keyPop.hidden && !keyPop.contains(e.target) && !keyBtn.contains(e.target)) toggleKeyPop(false);
});

function openModal(el) {
  el.hidden = false;
  el.classList.remove('closing');
}
function closeModal(el) {
  if (el.hidden) return;
  el.classList.add('closing');
  setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 280);
}
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
  });
});
$('#helpBtn').onclick = () => openModal($('#help'));

const GLYPHS = {
  g1: '<svg viewBox="0 0 56 56"><path class="acc" d="M46 10v36M42 14l4-4 4 4M42 42l4 4 4-4" opacity=".7"/><g class="hand"><path d="M18 44V28M22 44V20a2 2 0 014 0v14M26 34V17a2 2 0 014 0v17M30 34V19a2 2 0 014 0v17M34 36V24a2 2 0 014 0v12c0 6-4 10-10 10h-4c-4 0-6-2-8-5l-5-8a2 2 0 013-3l4 4"/></g></svg>',
  g2: '<svg viewBox="0 0 56 56"><g class="hand"><path d="M16 46c-2-6-2-12 2-16l6-5M24 25c2-4 6-8 10-9M34 16c2 0 3 2 1 4l-6 6M22 30c4-2 8-2 12 0M18 42h14c4 0 7-3 7-7v-5"/></g><g class="spark"><path class="acc" d="M34 8v-4M40 10l3-3M42 16h4M28 10l-3-3"/></g></svg>',
  g3: '<svg viewBox="0 0 56 56"><g class="hand"><path d="M16 42c0 4 4 8 10 8h4c6 0 10-4 10-10v-8"/><g class="fing"><path d="M20 40V16a2 2 0 014 0v18M24 34V12a2 2 0 014 0v22M28 34V14a2 2 0 014 0v20M32 34V20a2 2 0 014 0v12"/></g><path d="M16 42l-4-8a2 2 0 013-3l5 5"/></g></svg>',
  g4: '<svg viewBox="0 0 56 56"><circle class="acc ripple" cx="28" cy="32" r="18"/><g class="hand"><rect x="16" y="22" width="24" height="18" rx="8"/><path d="M22 22v6M28 22v6M34 22v6M16 32c4 0 8-2 10-4"/></g></svg>',
  g5: '<svg viewBox="0 0 56 56"><path class="acc" d="M20 28h16" stroke-dasharray="2 4"/><g class="hand l"><path d="M14 38V22a2 2 0 014 0v8M10 32V26a2 2 0 014 0M18 30v-10a2 2 0 014 0v14c0 4-3 6-6 6h-2c-3 0-4-2-4-4v-4"/></g><g class="hand r"><path d="M42 38V22a2 2 0 00-4 0v8M46 32V26a2 2 0 00-4 0M38 30v-10a2 2 0 00-4 0v14c0 4 3 6 6 6h2c3 0 4-2 4-4v-4"/></g></svg>',
};
for (const [k, svg] of Object.entries(GLYPHS)) document.querySelector('.' + k).innerHTML = svg;

/* ------------------------------------------------------------------ */
/* Music mapping                                                       */
/* ------------------------------------------------------------------ */
const GUIDE_TOP = 0.2, GUIDE_BOT = 0.8;
function rebuildGuide() {
  const lo = 57 + ((state.root - 9 + 12) % 12); // start near A3, on the root
  const notes = scaleNotes(state.root, state.scale, lo, lo + 24);
  const n = notes.length;
  state.guide = {
    notes: notes.map((m, i) => ({
      midi: m,
      label: pcName(m) + (Math.floor(m / 12) - 1),
      root: (m - state.root) % 12 === 0,
      y: GUIDE_BOT - (i / (n - 1)) * (GUIDE_BOT - GUIDE_TOP),
    })),
    active: null,
  };
}

function noteAtY(y, prevIdx) {
  const notes = state.guide.notes;
  const n = notes.length;
  const f = ((GUIDE_BOT - y) / (GUIDE_BOT - GUIDE_TOP)) * (n - 1);
  let idx = Math.round(clamp(f, 0, n - 1));
  if (prevIdx >= 0 && Math.abs(f - prevIdx) < 0.62) idx = prevIdx; // hysteresis
  return idx;
}

function seventhName(root, deg) {
  const t = chord(root, state.scale, deg, 48, true);
  const third = (t[1] - t[0] + 12) % 12, fifth = (t[2] - t[0] + 12) % 12, sev = (t[3] - t[0] + 12) % 12;
  const base = pcName(t[0]);
  if (fifth === 6) return base + 'ø7';
  if (third === 3) return base + 'm7';
  return base + (sev === 11 ? 'maj7' : '7');
}

function rebuildChordLabels() {
  state.chordLabels = {
    right: RIGHT_DEGREES.map((d) => chordLabel(state.root, state.scale, d)),
    left: LEFT_DEGREES.map((d) => ({ name: seventhName(state.root, d) })),
  };
}

/* ------------------------------------------------------------------ */
/* Gesture events                                                      */
/* ------------------------------------------------------------------ */
function drumPadRect(i) {
  const W = visuals.W, H = visuals.H, n = PADS.length, gap = 12;
  const padW = Math.min(170, (W - 48 - gap * (n - 1)) / n);
  const totalW = padW * n + gap * (n - 1);
  const padH = Math.min(92, H * 0.12);
  return { x: (W - totalW) / 2 + i * (padW + gap), y: H - 110 - padH - 72, w: padW, h: padH, gap };
}
function inDrumZone(i, nx, ny, slack = 0) {
  const r = drumPadRect(i), px = nx * visuals.W, py = ny * visuals.H, m = r.gap / 2 + slack;
  return px >= r.x - m && px <= r.x + r.w + m && py >= r.y - r.h * 0.6 - m && py <= r.y + r.h + 24 + m;
}
function hitDrum(i, v, x, y) {
  audio.drum(PADS[i].sound, 0.5 + v * 0.5);
  visuals.flashKey('pad' + i);
  const r = drumPadRect(i);
  visuals.burst(x, Math.max(y, (r.y + r.h / 2) / visuals.H * 0.9), 20, i, 0.9 + v * 0.5);
  visuals.ring(x, y, i, 0.6 + v);
}
/* Touch-to-hit: a fingertip entering a drum pad hits it; it must leave (with slack) before that pad re-triggers. */
const drumTouch = { left: { pad: -1, t: 0 }, right: { pad: -1, t: 0 } };
function drumTouchUpdate(now) {
  for (const side of ['left', 'right']) {
    const h = gestures.hands[side], ds = drumTouch[side];
    if (!h.present || !h.pts) { ds.pad = -1; continue; }
    const tip = h.pts[8];
    if (ds.pad >= 0 && inDrumZone(ds.pad, tip.x, tip.y, 18)) continue;
    let i = -1;
    for (let k = 0; k < PADS.length; k++) if (inDrumZone(k, tip.x, tip.y)) { i = k; break; }
    if (i >= 0 && now - ds.t > 70) {
      hitDrum(i, clamp(0.45 + h.speed * 0.3, 0.35, 1), tip.x, tip.y);
      ds.t = now;
    }
    ds.pad = i;
  }
}

function padIndexAt(x) {
  const W = visuals.W, n = PADS.length, gap = 12;
  const padW = Math.min(170, (W - 48 - gap * (n - 1)) / n);
  const totalW = padW * n + gap * (n - 1);
  const x0 = (W - totalW) / 2;
  const px = x * W;
  return clamp(Math.floor((px - x0 + gap / 2) / (padW + gap)), 0, n - 1);
}

gestures.on((type, side, d) => {
  const mode = state.mode;
  const colorIdx = side === 'right' ? 0 : 2;
  if (type === 'fist' && mode !== 'chords') {
    audio.drum('boom', 0.95);
    visuals.ring(d.x, d.y, colorIdx, 2.2);
    visuals.burst(d.x, d.y, 34, colorIdx, 1.4);
    return;
  }
  if (mode === 'theremin' && type === 'pinch') {
    const h = gestures.hands[side];
    const idx = side === 'right' && state.noteIdx >= 0 ? state.noteIdx : noteAtY(h.palm.y, -1);
    const m = state.guide.notes[idx].midi + 12;
    audio.pluck(m, 0.85);
    visuals.burst(d.x, d.y, 22, colorIdx);
    visuals.ring(d.x, d.y, colorIdx, 0.8);
  }
  if (mode === 'chords' && type === 'touch') {
    const degs = side === 'right' ? RIGHT_DEGREES : LEFT_DEGREES;
    const notes = chord(state.root, state.scale, degs[d.finger], side === 'right' ? 60 : 48, side === 'left');
    audio.strum(notes, 0.8);
    visuals.flashKey(side + 'c' + d.finger);
    visuals.burst(d.x, d.y, 26, d.finger, 1.1);
    visuals.ring(d.x, d.y, d.finger, 1.2);
  }
  if (mode === 'chords' && type === 'fist') {
    audio.drum('kick', 0.8);
    visuals.ring(d.x, d.y, colorIdx, 1.4);
  }
  if (mode === 'drums' && type === 'strike') {
    const ds = drumTouch[side];
    if (state.source === 'camera' && performance.now() - ds.t < 180) return;
    hitDrum(padIndexAt(d.x), d.v, d.x, d.y);
    ds.t = performance.now();
  }
});

audio.onBeat = (step) => {
  if (step % 4 === 0) {
    const beat = step / 4;
    visuals.flashKey('beat' + beat);
    const hs = gestures.hands;
    for (const side of ['left', 'right']) {
      if (hs[side].present) visuals.ring(hs[side].palm.x, hs[side].palm.y, side === 'right' ? 0 : 2, beat === 0 ? 1.2 : 0.6);
    }
    if (beat === 0) visuals.pulse = Math.min(1.2, visuals.pulse + 0.5);
  }
};
audio.onLoopNote = () => {
  const h = gestures.hands.right.present ? gestures.hands.right : gestures.hands.left;
  if (h.present && h.pts) visuals.burst(h.pts[8].x, h.pts[8].y, 4, 1, 0.5);
};

/* ------------------------------------------------------------------ */
/* Continuous control per frame                                        */
/* ------------------------------------------------------------------ */
function continuous(dt) {
  const { left: L, right: R } = gestures.hands;
  const d = gestures.distance;
  const spaceTarget = d == null ? 0.35 : clamp((d - 0.15) / 0.55);
  state.space = lerp(state.space, spaceTarget, 1 - Math.exp(-dt * 4));
  audio.setSpace(state.space);

  if (state.mode === 'theremin') {
    if (R.present) {
      const idx = noteAtY(R.palm.y, state.noteIdx);
      if (idx !== state.noteIdx) {
        state.noteIdx = idx;
        const m = state.guide.notes[idx].midi;
        state.guide.active = m;
        audio.leadOn(m);
        visuals.burst(R.pts[8].x, R.pts[8].y, 5, 0, 0.5);
      } else audio.leadOn(state.guide.notes[idx].midi);
    } else if (state.noteIdx !== -1) {
      state.noteIdx = -1;
      state.guide.active = null;
      audio.leadOff();
    }
    audio.setLeadExpression(L.present ? L.open : 0.7, L.present);
  } else if (state.mode === 'chords') {
    audio.setPadBrightness(L.present ? L.open : 0.6);
  } else if (state.mode === 'conductor') {
    const sp = Math.max(L.present ? L.speed : 0, R.present ? R.speed : 0);
    const any = L.present || R.present;
    const [lo, hi, idle] = audio.band.tempo;
    const target = any ? lo + clamp(sp / 2.4) * (hi - lo) : idle;
    state.bpm = lerp(state.bpm, target, 1 - Math.exp(-dt * 1.2));
    audio.setTempo(state.bpm);
    const ys = [L, R].filter((h) => h.present).map((h) => h.palm.y);
    const avgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0.6;
    state.energy = lerp(state.energy, clamp((0.85 - avgY) / 0.55), 1 - Math.exp(-dt * 3));
    audio.setIntensity(state.energy);
    audio.setLoopLevel(any ? 1 : 0.55);
    audio.setPadBrightness(L.present ? 0.25 + L.open * 0.75 : 0.6);
  }
}

/* ------------------------------------------------------------------ */
/* Sources: attract / demo / camera                                    */
/* ------------------------------------------------------------------ */
function demoTargets(t) {
  const pose = demoPose(state.mode, t);
  const aspect = visuals.W / visuals.H;
  const narrow = visuals.W < 760;
  const attract = state.source === 'attract';
  const fit = (p) => {
    const q = { ...p };
    if (attract && !narrow) {
      q.x = 0.7 + (p.x - 0.5) * 0.52;
    } else if (narrow) {
      q.x = 0.5 + (p.x - 0.5) * 1.1;
      q.y = attract ? 0.12 + p.y * 0.42 : p.y;
      q.size = (p.size ?? 0.17) * 0.75;
    }
    q.size = (q.size ?? 0.17) * Math.min(1.25, Math.max(0.8, 1.35 / aspect + 0.3));
    return q;
  };
  return { left: synthHand(fit(pose.left), 'left', aspect), right: synthHand(fit(pose.right), 'right', aspect) };
}

function cameraTargets() {
  const [sx, sy] = visuals.coverScale();
  const map = (pts) => pts && pts.map((p) => ({ x: (p.x - 0.5) / sx + 0.5, y: (p.y - 0.5) / sy + 0.5, z: p.z }));
  return { left: map(tracker.latest.left), right: map(tracker.latest.right) };
}

function setStatus(kind, text) {
  const el = $('#status');
  el.className = 'status ' + kind;
  $('#statusText').textContent = text;
}

async function ensureAudio() {
  try {
    await audio.start();
    audio.setKey(state.root, state.scale);
    audio.setMuted(state.muted);
    return true;
  } catch (e) {
    console.error(e);
    toast('Audio could not start in this browser. Visuals still work.');
    return false;
  }
}

let firstVisit = false;
try { firstVisit = !localStorage.getItem('handel.seenHelp'); } catch { firstVisit = true; }
function maybeShowHelp() {
  if (!firstVisit) return;
  firstVisit = false;
  try { localStorage.setItem('handel.seenHelp', '1'); } catch {}
  openModal($('#help'));
}

function leaveAttract(source) {
  state.source = source;
  document.body.classList.remove('attract');
  gestures.hands.left.reset();
  gestures.hands.right.reset();
  setMode(state.mode, true);
}

async function startDemo() {
  const ok = await ensureAudio();
  leaveAttract('demo');
  setStatus('demo', 'Demo · simulated hands');
  if (ok) applyKey();
  maybeShowHelp();
  showHint('Demo mode: simulated hands are playing<span class="sep">·</span>press <b>Start camera</b> anytime with <b>C</b>');
}

const startBtn = $('#startBtn');
async function startCamera() {
  if (state.source === 'camera') return;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('This browser can’t open a camera here. Try desktop Chrome over https — playing the demo instead.');
    startDemo();
    return;
  }
  startBtn.classList.add('loading');
  startBtn.querySelector('span').textContent = 'Waking up the camera…';
  const audioOk = ensureAudio();
  try {
    await tracker.startCamera();
  } catch (e) {
    console.warn(e);
    startBtn.classList.remove('loading');
    startBtn.querySelector('span').textContent = 'Start camera';
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied
      ? 'Camera access was blocked. Allow it from the address bar to play with your hands — here’s the demo meanwhile.'
      : 'No camera found. Playing the demo with simulated hands instead.', 6500);
    await audioOk;
    startDemo();
    return;
  }
  try {
    startBtn.querySelector('span').textContent = 'Loading hand model…';
    if (!tracker.landmarker) await tracker.load();
  } catch (e) {
    console.error(e);
    tracker.stop();
    startBtn.classList.remove('loading');
    startBtn.querySelector('span').textContent = 'Start camera';
    toast('The hand-tracking model couldn’t load (offline?). Playing the demo instead.', 6500);
    await audioOk;
    startDemo();
    return;
  }
  await audioOk;
  startBtn.classList.remove('loading');
  startBtn.querySelector('span').textContent = 'Start camera';
  leaveAttract('camera');
  setStatus('live', 'Live · looking for hands');
  state.lastHandsSeen = performance.now();
  applyKey();
  maybeShowHelp();
}

startBtn.onclick = startCamera;
$('#demoBtn').onclick = startDemo;

document.querySelectorAll('#modes button').forEach((b) => {
  b.onclick = async () => {
    if (state.source === 'attract') {
      setMode(b.dataset.mode, true);
      return;
    }
    setMode(b.dataset.mode, true);
  };
});

const muteBtn = $('#muteBtn');
muteBtn.onclick = () => {
  state.muted = !state.muted;
  muteBtn.classList.toggle('muted', state.muted);
  muteBtn.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
  audio.setMuted(state.muted);
};

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */
const REC_SECONDS = 15;
const recBtn = $('#recBtn');
const recProg = $('#recProg');
const recLabel = $('#recLabel');
let lastClipUrl = null;

async function countdown() {
  const el = $('#countdown');
  for (const n of ['3', '2', '1']) {
    el.textContent = n;
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
    audio.pluck(84 + state.root, 0.25);
    await new Promise((r) => setTimeout(r, 750));
  }
  el.classList.remove('tick');
}

recBtn.onclick = async () => {
  if (recorder.active) { recorder.stop(); return; }
  if (state.recBusy) return;
  if (!recorder.supported) { toast('Recording isn’t supported in this browser. Try desktop Chrome.'); return; }
  state.recBusy = true;
  await ensureAudio();
  if (state.source === 'attract') { leaveAttract('demo'); setStatus('demo', 'Demo · simulated hands'); applyKey(); }
  await countdown();
  state.recBusy = false;
  document.body.classList.add('recording');
  recBtn.classList.add('on');
  recBtn.setAttribute('aria-label', 'Stop recording');
  recorder.start(audio.recordDest.stream, REC_SECONDS, (frac, s) => {
    recProg.style.strokeDashoffset = String(119.4 * (1 - frac));
    recLabel.textContent = `0:${String(Math.min(REC_SECONDS, Math.floor(s))).padStart(2, '0')}`;
  }, (blob, ext) => {
    document.body.classList.remove('recording');
    recBtn.classList.remove('on');
    recBtn.setAttribute('aria-label', 'Record a 15 second clip');
    recProg.style.strokeDashoffset = '119.4';
    recLabel.textContent = 'Record';
    if (lastClipUrl) URL.revokeObjectURL(lastClipUrl);
    lastClipUrl = URL.createObjectURL(blob);
    const v = $('#clipVideo');
    v.src = lastClipUrl;
    v.play().catch(() => {});
    const name = `handel-${state.mode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
    const dl = $('#downloadBtn');
    dl.href = lastClipUrl;
    dl.download = name;
    dl.textContent = `Download .${ext}`;
    $('#clipMeta').textContent = `${(blob.size / 1e6).toFixed(1)} MB · made on your device`;
    const text = `I just played a ${MODES[state.mode].label.toLowerCase()} with my bare hands in the browser 🎶 #handel #hackyard`;
    $('#shareX').href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://chris-wozniczek.github.io/handel/')}`;
    openModal($('#clip'));
  });
};

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.key === 'Escape') { document.querySelectorAll('.modal').forEach(closeModal); toggleKeyPop(false); toggleBandPop(false); }
  else if (e.key === '?' || e.key === 'h') openModal($('#help'));
  else if (e.key >= '1' && e.key <= '4') setMode(MODE_ORDER[+e.key - 1], true);
  else if (e.key === 'm') muteBtn.click();
  else if (e.key === 'b') setBand(BAND_ORDER[(BAND_ORDER.indexOf(state.band) + 1) % BAND_ORDER.length], true);
  else if (e.key === 'r') recBtn.click();
  else if (e.key === 'c') startCamera();
});

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */
let last = performance.now();
let attractModeT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  try {
    tick(now);
  } catch (e) {
    console.error(e);
  }
}

let trackErrors = 0;
function tick(now) {
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  const t = now / 1000;

  if (state.source === 'camera') {
    let fresh = false;
    try {
      fresh = tracker.detect();
      trackErrors = 0;
    } catch (e) {
      if (++trackErrors === 1) console.warn('Hand tracking frame failed', e);
      if (trackErrors === 30) tracker.fallbackToCpu();
    }
    if (fresh) gestures.setTargets(cameraTargets(), now);
  } else {
    gestures.setTargets(demoTargets(t), now);
    if (state.source === 'attract' && !state.attractLocked && now - attractModeT > 7000) {
      attractModeT = now;
      setMode(MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length]);
    }
  }
  const aspect = visuals.W / visuals.H;
  gestures.update(dt, aspect, now);
  continuous(dt);
  if (state.mode === 'drums' && state.source === 'camera') drumTouchUpdate(now);

  if (state.source === 'camera') {
    const n = (gestures.hands.left.present ? 1 : 0) + (gestures.hands.right.present ? 1 : 0);
    if (n) state.lastHandsSeen = now;
    const fps = Math.round(tracker.fps);
    setStatusThrottled(n ? 'live' : 'warn', n ? `Live · ${n} hand${n > 1 ? 's' : ''} · ${fps} fps` : `Live · no hands yet · ${fps} fps`);
    if (!n && now - state.lastHandsSeen > 3500 && !state.noHandsHinted) {
      state.noHandsHinted = true;
      showHint('Raise <b>both hands</b> into view<span class="sep">·</span>good light helps');
    }
    if (n) state.noHandsHinted = false;
  }

  visuals.render({
    gestures,
    mode: state.mode,
    attract: state.source === 'attract',
    videoOn: state.source === 'camera',
    level: audio.level(),
    bands: audio.bands(),
    guide: state.guide,
    chordLabels: state.chordLabels,
    pads: PADS,
    conductor: { bpm: state.bpm, energy: state.energy },
    space: state.space,
    recording: recorder.active,
    modeLabel: MODES[state.mode].label,
    keyLabel: `${NOTE_NAMES[state.root]} ${state.scale}`,
    safeTop: 90,
    safeBottom: 110,
  }, dt, t);
}

let statusCache = '';
let statusT = 0;
function setStatusThrottled(kind, text) {
  const now = performance.now();
  if (text === statusCache || now - statusT < 400) return;
  statusCache = text;
  statusT = now;
  setStatus(kind, text);
}

window.addEventListener('resize', () => { visuals.resize(); moveIndicator(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) audio.leadOff(); });

buildKeyPicker();
buildBandPicker();
updateKeyLabel();
rebuildGuide();
rebuildChordLabels();
setMode('theremin');
document.fonts?.ready.then(moveIndicator);
if (firstVisit) setTimeout(() => $('#helpBtn').classList.add('pulse'), 1200);
requestAnimationFrame(frame);
