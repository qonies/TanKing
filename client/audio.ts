/** 8-bit 音效合成（Web Audio，PRD §4；无采样、零素材依赖） */
export class AudioFx {
  private ac: AudioContext | null = null;

  /** 需在用户手势中调用（浏览器自动播放策略） */
  unlock(): void {
    if (!this.ac) this.ac = new AudioContext();
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  private beep(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    if (!this.ac) return;
    const t = this.ac.currentTime + delay;
    const osc = this.ac.createOscillator();
    const gain = this.ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.ac.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  private noise(dur: number, vol: number, cutoff = 1200): void {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    const len = Math.floor(this.ac.sampleRate * dur);
    const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ac.createBufferSource();
    src.buffer = buf;
    const filter = this.ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = this.ac.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(this.ac.destination);
    src.start(t);
  }

  shoot(): void {
    this.beep('square', 900, 450, 0.08, 0.06);
  }

  explosion(big: boolean): void {
    this.noise(big ? 0.6 : 0.25, big ? 0.35 : 0.15, big ? 800 : 1400);
  }

  pickup(): void {
    this.beep('square', 660, 660, 0.06, 0.1);
    this.beep('square', 990, 990, 0.08, 0.1, 0.07);
  }

  upgrade(): void {
    this.beep('square', 523, 523, 0.07, 0.1);
    this.beep('square', 659, 659, 0.07, 0.1, 0.08);
    this.beep('square', 784, 784, 0.12, 0.1, 0.16);
  }

  baseDestroyed(): void {
    this.noise(0.9, 0.4, 600);
    this.beep('sawtooth', 110, 40, 0.8, 0.2);
  }
}