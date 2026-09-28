// Microphone recorder with simple voice-activity detection, for browsers without built-in speech
// recognition (iPhone home-screen app, Firefox, …). It waits for speech, records until ~1 s of
// silence, and hands back a 16 kHz mono WAV that the server transcribes.
// Needs a secure (https) page, like every microphone API.

export interface VadCallbacks {
  onSpeechStart?: () => void;
  onUtterance: (wav: Blob) => void;
  onLevel?: (level: number) => void; // 0–1, for the orb animation
}

const TARGET_RATE = 16000;
const SILENCE_MS = 1100;
const MIN_SPEECH_MS = 350;
const MAX_UTTERANCE_MS = 20000;
const PREROLL_MS = 350;

export function recorderSupported(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
}

export class VadRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private paused = true;
  private recording = false;
  private chunks: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private recMs = 0;
  private noise = 0.01;
  private calibrated = 0;

  constructor(private cb: VadCallbacks) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0));
    src.connect(this.node);
    this.node.connect(this.ctx.destination); // required for onaudioprocess to fire in Safari (outputs silence)
    this.paused = false;
  }

  /** Stop listening for a while (e.g. while the answer is spoken) without releasing the mic. */
  pause() { this.paused = true; this.reset(); }
  resume() { this.paused = false; this.reset(); }

  stop() {
    this.paused = true;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null; this.stream = null; this.ctx = null;
  }

  private reset() { this.recording = false; this.chunks = []; this.preroll = []; this.speechMs = 0; this.silenceMs = 0; this.recMs = 0; }

  private process(input: Float32Array) {
    const frame = new Float32Array(input); // copy — the buffer is reused
    const ms = (frame.length / (this.ctx?.sampleRate ?? 48000)) * 1000;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.cb.onLevel?.(Math.min(1, rms * 12));
    if (this.paused) return;

    // Learn the room's background level during the first ~0.6 s, then track it slowly.
    if (this.calibrated < 600) { this.noise = this.calibrated === 0 ? rms : this.noise * 0.8 + rms * 0.2; this.calibrated += ms; return; }
    const threshold = Math.max(0.015, this.noise * 3);
    const loud = rms > threshold;
    if (!this.recording && !loud) this.noise = this.noise * 0.98 + rms * 0.02;

    if (!this.recording) {
      this.preroll.push(frame);
      let pre = this.preroll.reduce((t, f) => t + f.length, 0);
      const maxPre = ((this.ctx?.sampleRate ?? 48000) * PREROLL_MS) / 1000;
      while (pre > maxPre && this.preroll.length > 1) pre -= this.preroll.shift()!.length;
      this.speechMs = loud ? this.speechMs + ms : 0;
      if (this.speechMs >= 120) {
        this.recording = true;
        this.chunks = [...this.preroll];
        this.preroll = [];
        this.silenceMs = 0;
        this.recMs = 0;
        this.cb.onSpeechStart?.();
      }
      return;
    }

    this.chunks.push(frame);
    this.recMs += ms;
    this.silenceMs = loud ? 0 : this.silenceMs + ms;
    if (this.silenceMs >= SILENCE_MS || this.recMs >= MAX_UTTERANCE_MS) {
      const spoken = this.recMs - this.silenceMs;
      const chunks = this.chunks;
      this.reset();
      if (spoken >= MIN_SPEECH_MS) {
        this.paused = true; // caller resumes after answering
        this.cb.onUtterance(toWav(chunks, this.ctx?.sampleRate ?? 48000));
      }
    }
  }
}

/** Float32 frames → 16 kHz mono 16-bit WAV. */
function toWav(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((t, c) => t + c.length, 0);
  const ratio = rate / TARGET_RATE;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  let ci = 0;
  let off = 0;
  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const target = Math.floor(i * ratio);
    while (pos + (chunks[ci]?.length ?? 0) <= target && ci < chunks.length - 1) { pos += chunks[ci].length; ci++; }
    off = target - pos;
    const s = Math.max(-1, Math.min(1, chunks[ci]?.[off] ?? 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, TARGET_RATE, true);
  v.setUint32(28, TARGET_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
