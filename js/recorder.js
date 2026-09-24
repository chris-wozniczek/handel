// Captures the stage canvas + the synth output into a single clip, fully on-device.
const TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.rec = null;
    this.active = false;
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined' && !!this.canvas.captureStream;
  }

  start(audioStream, maxSeconds, onTick, onDone) {
    const mime = pickMime();
    const video = this.canvas.captureStream(30);
    const tracks = [...video.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])];
    const stream = new MediaStream(tracks);
    const chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
    this.rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    this.rec.onstop = () => {
      this.active = false;
      clearInterval(this._timer);
      video.getVideoTracks().forEach((t) => t.stop());
      const type = this.rec.mimeType || mime || 'video/webm';
      const blob = new Blob(chunks, { type });
      onDone(blob, type.includes('mp4') ? 'mp4' : 'webm');
    };
    this.t0 = performance.now();
    this.rec.start(250);
    this.active = true;
    this._timer = setInterval(() => {
      const s = (performance.now() - this.t0) / 1000;
      onTick(s / maxSeconds, s);
      if (s >= maxSeconds) this.stop();
    }, 50);
  }

  stop() {
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
  }
}
