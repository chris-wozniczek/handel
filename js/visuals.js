// Rendering: WebGL shader backdrop (stylized mirrored webcam + audio-reactive aurora) composited
// into a 2D stage canvas with glowing fingertip ribbons, particles, and HUD guides.
import { BONES, TIPS } from './hands.js';

const VERT = `attribute vec2 p; varying vec2 vUv; void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes; uniform float uTime; uniform sampler2D uVideo; uniform float uVideoOn; uniform vec2 uVidScale;
uniform float uLevel; uniform float uBass; uniform float uPulse;
uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uColC;
uniform vec4 uHandL; uniform vec4 uHandR;
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float v=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p; a*=.5; } return v; }
float luma(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
void main(){
  vec2 uv = vUv;
  float ar = uRes.x/uRes.y;
  vec2 p = (uv-.5)*vec2(ar,1.);
  float t = uTime*.045;
  vec2 q = vec2(fbm(p*1.3+vec2(t, -t)), fbm(p*1.3+vec2(3.1-t, 1.7+t)));
  vec2 r = vec2(fbm(p*1.7+q*1.8+vec2(1.7, 9.2)+t*1.5), fbm(p*1.7+q*1.8+vec2(8.3, 2.8)-t));
  float f = fbm(p*1.6 + r*1.6 + uBass*0.6);
  vec3 ink = vec3(0.018, 0.018, 0.035);
  vec3 col = ink;
  float glow = .55 + uLevel*.9 + uPulse*.45;
  col = mix(col, uColB*.34, smoothstep(.3,.95,f)*glow);
  col = mix(col, uColA*.42, smoothstep(.55,1.05,r.x)*.8*glow);
  col += uColC*.16*smoothstep(.62,1.,q.y)*glow;
  // hand glows
  vec2 hl = (uHandL.xy-.5)*vec2(ar,1.); hl.y = -hl.y;
  vec2 hr = (uHandR.xy-.5)*vec2(ar,1.); hr.y = -hr.y;
  float dl = length(p-hl), dr = length(p-hr);
  col += uColC * uHandL.z * exp(-dl*dl*7.) * (.14 + .25*uHandL.w + uLevel*.3);
  col += uColA * uHandR.z * exp(-dr*dr*7.) * (.14 + .25*uHandR.w + uLevel*.3);
  // stylized mirrored webcam: duotone luminance + edge glow
  if (uVideoOn > .001) {
    vec2 vuv = (uv-.5)*uVidScale+.5; vuv.x = 1.-vuv.x;
    vec2 px = 1.5/uRes;
    float c0 = luma(texture2D(uVideo, vuv).rgb);
    float cx = luma(texture2D(uVideo, vuv+vec2(px.x,0.)).rgb) - luma(texture2D(uVideo, vuv-vec2(px.x,0.)).rgb);
    float cy = luma(texture2D(uVideo, vuv+vec2(0.,px.y)).rgb) - luma(texture2D(uVideo, vuv-vec2(0.,px.y)).rgb);
    float edge = smoothstep(.04,.35,length(vec2(cx,cy)));
    float l = pow(smoothstep(.04,.96,c0), 1.35);
    vec3 duo = mix(ink*2., mix(uColB*.55, vec3(.92,.9,1.)*.75, l), l);
    vec3 vid = duo*.4 + edge*mix(uColA, uColC, uv.y)*(.35+uLevel*.8);
    col = mix(col, col*.55 + vid, uVideoOn);
  }
  // vignette + grain
  float vig = smoothstep(1.25, .25, length((uv-.5)*vec2(ar*.85,1.)));
  col *= .35 + .65*vig;
  col += (hash(uv*uRes + fract(uTime)*91.)-.5)*.035;
  col += uColA*uPulse*.05;
  gl_FragColor = vec4(pow(max(col,0.), vec3(.92)), 1.);
}`;

export const PALETTES = {
  theremin: ['#4ff0d2', '#7a5cff', '#ff6fae'],
  chords: ['#ffc46b', '#ff5f7e', '#a77bff'],
  drums: ['#ff5e62', '#ff9f43', '#4fd1ff'],
  conductor: ['#8dffb0', '#4f7dff', '#ffd76a'],
};
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const rgba = (c, a) => `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export class Visuals {
  constructor(stage, video) {
    this.stage = stage;
    this.ctx = stage.getContext('2d');
    this.video = video;
    this.gl = null;
    this.glCanvas = document.createElement('canvas');
    this.palette = PALETTES.theremin.map(hex);
    this.targetPalette = this.palette;
    this.trails = {};
    this.particles = [];
    this.rings = [];
    this.pulse = 0;
    this.videoOn = 0;
    this.flash = {};
    this._initGL();
    this._sprite = this._makeSprite();
    this.resize();
  }

  _initGL() {
    const gl = this.glCanvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.u = {};
      for (const n of ['uRes', 'uTime', 'uVideo', 'uVideoOn', 'uVidScale', 'uLevel', 'uBass', 'uPulse', 'uColA', 'uColB', 'uColC', 'uHandL', 'uHandR'])
        this.u[n] = gl.getUniformLocation(prog, n);
      this.gl = gl;
    } catch (e) {
      console.warn('WebGL backdrop unavailable', e);
      this.gl = null;
    }
  }

  _makeSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    this.W = w; this.H = h; this.dpr = dpr;
    this.stage.width = Math.round(w * dpr);
    this.stage.height = Math.round(h * dpr);
    const gs = Math.min(1, 900 / Math.max(w, h));
    this.glCanvas.width = Math.max(2, Math.round(w * gs));
    this.glCanvas.height = Math.max(2, Math.round(h * gs));
    this.gl?.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
  }

  /** Scale factors mapping screen uv → video uv for a cover fit. */
  coverScale() {
    const v = this.video;
    const va = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    const ca = this.W / this.H;
    return ca > va ? [1, va / ca] : [ca / va, 1];
  }

  setPalette(mode) { this.targetPalette = PALETTES[mode].map(hex); }

  burst(x, y, n = 18, colorIdx = 0, power = 1) {
    const c = this.palette[colorIdx % 3];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (60 + Math.random() * 260) * power;
      this.particles.push({
        x: x * this.W, y: y * this.H, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40,
        life: 0, max: 0.6 + Math.random() * 0.8, size: 6 + Math.random() * 18 * power, c: mix3(c, [1, 1, 1], Math.random() * 0.5),
      });
    }
    if (this.particles.length > 700) this.particles.splice(0, this.particles.length - 700);
  }

  ring(x, y, colorIdx = 0, size = 1) {
    this.rings.push({ x: x * this.W, y: y * this.H, life: 0, max: 0.9, size, c: this.palette[colorIdx % 3] });
    this.pulse = Math.min(1.2, this.pulse + 0.35 * size);
  }

  flashKey(key) { this.flash[key] = 1; }

  render(scene, dt, time) {
    const { ctx, W, H, dpr } = this;
    for (let i = 0; i < 3; i++) this.palette[i] = mix3(this.palette[i], this.targetPalette[i], 1 - Math.exp(-dt * 3));
    this.pulse *= Math.exp(-dt * 4);
    this.videoOn += ((scene.videoOn ? 1 : 0) - this.videoOn) * (1 - Math.exp(-dt * 2.5));
    for (const k in this.flash) this.flash[k] *= Math.exp(-dt * 6);
    const hands = scene.gestures.hands;

    // 1. Shader backdrop
    if (this.gl) {
      const gl = this.gl, u = this.u;
      if (scene.videoOn && this.video.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      }
      const cs = this.coverScale();
      gl.uniform2f(u.uRes, this.glCanvas.width, this.glCanvas.height);
      gl.uniform1f(u.uTime, time);
      gl.uniform1i(u.uVideo, 0);
      gl.uniform1f(u.uVideoOn, this.videoOn);
      gl.uniform2f(u.uVidScale, cs[0], cs[1]);
      gl.uniform1f(u.uLevel, clamp(scene.level * 1.6));
      gl.uniform1f(u.uBass, scene.bands[0]);
      gl.uniform1f(u.uPulse, this.pulse);
      gl.uniform3fv(u.uColA, this.palette[0]);
      gl.uniform3fv(u.uColB, this.palette[1]);
      gl.uniform3fv(u.uColC, this.palette[2]);
      const L = hands.left, R = hands.right;
      gl.uniform4f(u.uHandL, L.palm.x, L.palm.y, L.presence, L.open);
      gl.uniform4f(u.uHandR, R.palm.x, R.palm.y, R.presence, R.open);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (this.gl) ctx.drawImage(this.glCanvas, 0, 0, this.stage.width, this.stage.height);
    else {
      ctx.fillStyle = '#07070d';
      ctx.fillRect(0, 0, this.stage.width, this.stage.height);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 2. HUD under the light layer
    this._hud(scene, time);

    // 3. Additive light: ribbons, particles, rings
    ctx.globalCompositeOperation = 'lighter';
    for (const side of ['left', 'right']) this._trails(hands[side], side, time);
    this._particles(dt);
    this._rings(dt);
    ctx.globalCompositeOperation = 'source-over';

    for (const side of ['left', 'right']) this._skeleton(hands[side], side);
    if (scene.recording) this._watermark(scene);
  }

  _trails(h, side, time) {
    const { ctx, W, H } = this;
    const now = time;
    for (let f = 0; f < 5; f++) {
      const key = side + f;
      let tr = this.trails[key];
      if (!tr) tr = this.trails[key] = [];
      if (h.present && h.pts) {
        const p = h.pts[TIPS[f]];
        tr.push({ x: p.x * W, y: p.y * H, t: now });
      }
      while (tr.length && (now - tr[0].t > 0.55 || tr.length > 40)) tr.shift();
      if (tr.length < 3) continue;
      const cA = this.palette[side === 'right' ? 0 : 2];
      const cB = this.palette[1];
      const col = mix3(cA, cB, f / 5);
      const base = (f === 1 || f === 0 ? 7 : 4.5) * (0.7 + h.presence * 0.3);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < tr.length - 1; i++) {
          const a = tr[i - 1], b = tr[i], c = tr[i + 1];
          const age = clamp(1 - (now - b.t) / 0.55);
          const w = base * age * (pass === 0 ? 3.2 : 1);
          ctx.strokeStyle = rgba(pass === 0 ? col : mix3(col, [1, 1, 1], 0.55), (pass === 0 ? 0.13 : 0.75) * age * age);
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
          ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
          ctx.stroke();
        }
      }
      // tip glow
      if (h.present) {
        const last = tr[tr.length - 1];
        const s = (f === 0 || f === 1 ? 46 : 32) * (1 + this.pulse * 0.4);
        ctx.globalAlpha = 0.55 * h.presence;
        this._tint(col);
        ctx.drawImage(this._tinted, last.x - s / 2, last.y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
    }
  }

  _tint(c) {
    const key = c.map((v) => (v * 16) | 0).join();
    this._tintCache ||= new Map();
    let cv = this._tintCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      g.drawImage(this._sprite, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = rgba(c, 1);
      g.fillRect(0, 0, 64, 64);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.5;
      g.drawImage(this._sprite, 16, 16, 32, 32);
      if (this._tintCache.size > 400) this._tintCache.clear();
      this._tintCache.set(key, cv);
    }
    this._tinted = cv;
  }

  _particles(dt) {
    const { ctx } = this;
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life += dt;
      if (p.life > p.max) { ps.splice(i, 1); continue; }
      const k = Math.exp(-dt * 2.2);
      p.vx *= k; p.vy = p.vy * k + 30 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const a = 1 - p.life / p.max;
      const s = p.size * (0.4 + a * 0.6);
      ctx.globalAlpha = a * 0.9;
      this._tint(p.c);
      ctx.drawImage(this._tinted, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  _rings(dt) {
    const { ctx } = this;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      if (r.life > r.max) { this.rings.splice(i, 1); continue; }
      const u = r.life / r.max;
      const e = 1 - Math.pow(1 - u, 3);
      ctx.strokeStyle = rgba(r.c, (1 - u) * 0.8);
      ctx.lineWidth = 2.5 * (1 - u) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 12 + e * 120 * r.size, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _skeleton(h, side) {
    if (!h.pts || h.presence < 0.02) return;
    const { ctx, W, H } = this;
    const P = h.pts;
    ctx.globalAlpha = h.presence;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const [a, b] of BONES) {
      ctx.moveTo(P[a].x * W, P[a].y * H);
      ctx.lineTo(P[b].x * W, P[b].y * H);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 21; i++) {
      const r = TIPS.includes(i) ? 3 : 1.6;
      ctx.beginPath();
      ctx.arc(P[i].x * W, P[i].y * H, r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (h.pinched) {
      const x = ((P[4].x + P[8].x) / 2) * W, y = ((P[4].y + P[8].y) / 2) * H;
      ctx.strokeStyle = rgba(this.palette[0], 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- HUD ---------------- */
  _label(text, x, y, opts = {}) {
    const { ctx } = this;
    const size = opts.size || 11;
    ctx.font = `${opts.weight || 500} ${size}px ${opts.font || '"Geist Mono", ui-monospace, monospace'}`;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = 'middle';
    if (opts.pill) {
      const w = ctx.measureText(text).width + 16;
      const h = size + 10;
      const bx = opts.align === 'right' ? x - w + 8 : opts.align === 'center' ? x - w / 2 : x - 8;
      ctx.fillStyle = opts.pill;
      this._round(bx, y - h / 2, w, h, h / 2);
      ctx.fill();
    }
    ctx.fillStyle = opts.color || 'rgba(255,255,255,0.6)';
    ctx.fillText(text, x, y + 0.5);
  }

  _round(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _hud(scene, time) {
    const { ctx, W, H } = this;
    const hands = scene.gestures.hands;
    const A = this.palette[0], C = this.palette[2];
    const top = scene.safeTop ?? 90, bottom = scene.safeBottom ?? 120;

    if ((scene.mode === 'theremin' || scene.mode === 'chords') && !scene.attract) {
      // Left hand: tone meter
      const L = hands.left;
      const mx = 28, my0 = H * 0.3, my1 = H * 0.7;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      this._round(mx - 2, my0, 4, my1 - my0, 2);
      ctx.fill();
      const val = L.present ? L.open : scene.demoOpen ?? 0;
      const fy = my1 - (my1 - my0) * val;
      const g = ctx.createLinearGradient(0, my1, 0, my0);
      g.addColorStop(0, rgba(C, 0.2));
      g.addColorStop(1, rgba(C, 0.95));
      ctx.fillStyle = g;
      this._round(mx - 2, fy, 4, my1 - fy, 2);
      ctx.fill();
      this._label('TONE', mx - 4, my0 - 16, { size: 10, color: 'rgba(255,255,255,0.45)' });
      this._label('left hand · open/close', mx - 4, my1 + 16, { size: 9.5, color: 'rgba(255,255,255,0.32)' });
    }

    if (scene.mode === 'theremin' && scene.guide) {
      const { notes, active } = scene.guide;
      const x0 = W * 0.56, x1 = W - 24;
      for (const n of notes) {
        const y = n.y * H;
        const on = n.midi === active;
        const isRoot = n.root;
        ctx.strokeStyle = on ? rgba(A, 0.9) : `rgba(255,255,255,${isRoot ? 0.16 : 0.07})`;
        ctx.lineWidth = on ? 1.5 : 1;
        ctx.setLineDash(on || isRoot ? [] : [2, 6]);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1 - 44, y);
        ctx.stroke();
        ctx.setLineDash([]);
        this._label(n.label, x1, y, {
          align: 'right', size: on ? 12 : 10, weight: on ? 600 : 500,
          color: on ? '#06060b' : `rgba(255,255,255,${isRoot ? 0.6 : 0.34})`,
          pill: on ? rgba(A, 0.95) : null,
        });
      }
      this._label('PITCH · right hand up/down', x1, top - 2 + 18, { align: 'right', size: 10, color: 'rgba(255,255,255,0.4)' });
    }

    if (scene.mode === 'chords' && scene.chordLabels) {
      for (const side of ['left', 'right']) {
        const h = hands[side];
        if (!h.pts || h.presence < 0.05) continue;
        const labels = scene.chordLabels[side];
        for (let f = 0; f < 4; f++) {
          const tip = h.pts[8 + f * 4];
          const on = this.flash[side + 'c' + f] || 0;
          ctx.globalAlpha = h.presence;
          this._label(labels[f].name, tip.x * W, tip.y * H - 26, {
            align: 'center', size: 11 + on * 4, weight: 600,
            color: on > 0.1 ? '#0a0a10' : 'rgba(255,255,255,0.85)',
            pill: on > 0.1 ? rgba(mix3(A, [1, 1, 1], 0.2), 0.4 + on * 0.6) : 'rgba(10,10,20,0.45)',
          });
          ctx.globalAlpha = 1;
        }
      }
    }

    if (scene.mode === 'drums' && scene.pads) {
      const n = scene.pads.length;
      const gap = 12;
      const padW = Math.min(170, (W - 48 - gap * (n - 1)) / n);
      const totalW = padW * n + gap * (n - 1);
      const x0 = (W - totalW) / 2;
      const padH = Math.min(92, H * 0.12);
      const y0 = H - bottom - padH - 72;
      scene.pads.forEach((pad, i) => {
        const x = x0 + i * (padW + gap);
        const on = this.flash['pad' + i] || 0;
        const col = this.palette[i % 3];
        ctx.fillStyle = `rgba(255,255,255,${0.04 + on * 0.1})`;
        this._round(x, y0, padW, padH, 18);
        ctx.fill();
        ctx.strokeStyle = on > 0.05 ? rgba(col, 0.4 + on * 0.6) : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1 + on * 1.5;
        ctx.stroke();
        if (on > 0.02) {
          const g = ctx.createRadialGradient(x + padW / 2, y0 + padH / 2, 0, x + padW / 2, y0 + padH / 2, padW * 0.7);
          g.addColorStop(0, rgba(col, 0.45 * on));
          g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g;
          this._round(x, y0, padW, padH, 18);
          ctx.fill();
        }
        this._label(pad.name, x + padW / 2, y0 + padH / 2 - 7, { align: 'center', size: 15, weight: 400, font: '"Instrument Serif", serif', color: 'rgba(255,255,255,0.92)' });
        this._label(pad.hint, x + padW / 2, y0 + padH / 2 + 13, { align: 'center', size: 9.5, color: 'rgba(255,255,255,0.38)' });
        // column guide
        ctx.fillStyle = `rgba(255,255,255,${0.018 + on * 0.05})`;
        ctx.fillRect(x, top, padW, y0 - top - 10);
      });
      this._label('SWIPE DOWN FAST OVER A PAD · MAKE A FIST FOR A BOOM', W / 2, y0 - 22, { align: 'center', size: 10, color: 'rgba(255,255,255,0.42)' });
    }

    if (scene.mode === 'conductor' && scene.conductor) {
      const c = scene.conductor;
      const cx = W / 2, cy = top + 70;
      ctx.font = `400 ${Math.min(96, W * 0.12)}px "Instrument Serif", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(String(Math.round(c.bpm)), cx, cy + 20);
      this._label('BPM · wave faster to speed up', cx, cy + 46, { align: 'center', size: 10, color: 'rgba(255,255,255,0.85)', pill: 'rgba(8,10,16,0.45)' });
      for (let i = 0; i < 4; i++) {
        const on = this.flash['beat' + i] || 0;
        ctx.fillStyle = on > 0.05 ? rgba(mix3(A, [1, 1, 1], on * 0.4), 0.35 + on * 0.65) : 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.arc(cx - 36 + i * 24, cy + 72, 3.5 + on * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // energy meter along the right edge
      const x = W - 30, y0 = H * 0.3, y1 = H * 0.7;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      this._round(x - 2, y0, 4, y1 - y0, 2);
      ctx.fill();
      const fy = y1 - (y1 - y0) * c.energy;
      ctx.fillStyle = rgba(A, 0.9);
      this._round(x - 2, fy, 4, y1 - fy, 2);
      ctx.fill();
      this._label('ENERGY', x + 4, y0 - 16, { align: 'right', size: 10, color: 'rgba(255,255,255,0.45)' });
      this._label('raise hands', x + 4, y1 + 16, { align: 'right', size: 9.5, color: 'rgba(255,255,255,0.32)' });
      const layers = ['kick', 'hats', 'bass', 'snare', 'arp'];
      const th = [0, 0.12, 0.2, 0.3, 0.55];
      layers.forEach((l, i) => {
        const on = c.energy > th[i];
        this._label(l, x - 16, y1 - (y1 - y0) * (th[i] + 0.04), { align: 'right', size: 9.5, color: on ? rgba(A, 0.9) : 'rgba(255,255,255,0.22)' });
      });
    }

    // Space (reverb) link between both hands
    const L = hands.left, R = hands.right;
    if (scene.mode !== 'drums' && L.presence > 0.05 && R.presence > 0.05 && scene.space != null) {
      const a = Math.min(L.presence, R.presence);
      const x1 = L.palm.x * W, y1 = L.palm.y * H, x2 = R.palm.x * W, y2 = R.palm.y * H;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + 40;
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([2, 7]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx, my + 30, x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      this._label(`SPACE ${Math.round(scene.space * 100)}%`, mx, my + 14, { align: 'center', size: 10, color: 'rgba(255,255,255,0.7)', pill: 'rgba(8,8,16,0.5)' });
      ctx.globalAlpha = 1;
    }
  }

  _watermark(scene) {
    const { W, H } = this;
    this._label('handel', 24, H - 28, { size: 22, font: '"Instrument Serif", serif', weight: 400, color: 'rgba(255,255,255,0.9)' });
    this._label(`${scene.modeLabel} · ${scene.keyLabel} · played with hands`, 92, H - 26, { size: 10.5, color: 'rgba(255,255,255,0.5)' });
    this._label('chris-wozniczek.github.io/handel', W - 24, H - 26, { align: 'right', size: 10.5, color: 'rgba(255,255,255,0.5)' });
  }
}
