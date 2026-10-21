/** 8-bit 音效/音乐合成（Web Audio，PRD §4；无采样、零素材依赖）。
 *  M5：音效/音乐独立音量（FR-S2，localStorage 持久化）+ 开场/结算旋律 + 循环 BGM（原创旋律，规避版权） */
export type JingleKind = 'start' | 'gameOver';

interface Volumes { sfx: number; music: number } // 0..1

const VOLUME_KEY = 'tanking-volume';
const DEFAULT_VOLUMES: Volumes = { sfx: 0.8, music: 0.5 };

function loadVolumes(): Volumes {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return { ...DEFAULT_VOLUMES };
    const parsed = JSON.parse(raw) as Partial<Volumes>;
    const clamp01 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
    return {
      sfx: clamp01(parsed.sfx) ?? DEFAULT_VOLUMES.sfx,
      music: clamp01(parsed.music) ?? DEFAULT_VOLUMES.music,
    };
  } catch {
    return { ...DEFAULT_VOLUMES };
  }
}

export class AudioFx {
  private ac: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private volumes: Volumes = loadVolumes();
  private bgmTimer = 0;
  private bgmStep = 0;
  private bgmNextTime = 0;

  /** 需在用户手势中调用（浏览器自动播放策略） */
  unlock(): void {
    if (!this.ac) {
      this.ac = new AudioContext();
      this.sfxGain = this.ac.createGain();
      this.sfxGain.gain.value = this.volumes.sfx;
      this.sfxGain.connect(this.ac.destination);
      this.musicGain = this.ac.createGain();
      this.musicGain.gain.value = this.volumes.music;
      this.musicGain.connect(this.ac.destination);
    }
    if (this.ac.state === 'suspended') void this.ac.resume();
  }

  get sfxVolume(): number { return this.volumes.sfx; }
  get musicVolume(): number { return this.volumes.music; }

  setSfxVolume(v: number): void {
    this.volumes.sfx = Math.min(1, Math.max(0, v));
    if (this.sfxGain) this.sfxGain.gain.value = this.volumes.sfx;
    this.persist();
  }

  setMusicVolume(v: number): void {
    this.volumes.music = Math.min(1, Math.max(0, v));
    if (this.musicGain) this.musicGain.gain.value = this.volumes.music;
    this.persist();
  }

  private persist(): void {
    try { localStorage.setItem(VOLUME_KEY, JSON.stringify(this.volumes)); } catch { /* 存储不可用时忽略 */ }
  }

  /** 音乐音符（走 musicGain） */
  private note(type: OscillatorType, freq: number, at: number, dur: number, vol: number): void {
    if (!this.ac || !this.musicGain) return;
    const osc = this.ac.createOscillator();
    const gain = this.ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(vol, at);
    gain.gain.setTargetAtTime(0.0001, at + dur * 0.7, dur * 0.15);
    osc.connect(gain).connect(this.musicGain);
    osc.start(at);
    osc.stop(at + dur);
  }

  private beep(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    if (!this.ac || !this.sfxGain) return;
    const t = this.ac.currentTime + delay;
    const osc = this.ac.createOscillator();
    const gain = this.ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + dur);
  }

  private noise(dur: number, vol: number, cutoff = 1200): void {
    if (!this.ac || !this.sfxGain) return;
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
    src.connect(filter).connect(gain).connect(this.sfxGain);
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

  /** 旋律类音效（M5）：开场号角 / 结算旋律（原创短句，规避原版版权素材） */
  jingle(kind: JingleKind): void {
    if (!this.ac || !this.musicGain) return;
    const t0 = this.ac.currentTime + 0.02;
    const seq: [number, number, number][] = kind === 'start'
      ? [[392, 0, 0.12], [523, 0.14, 0.12], [659, 0.28, 0.12], [784, 0.42, 0.35]] // 开场号角：上行三连 + 长音
      : [[659, 0, 0.15], [587, 0.17, 0.15], [523, 0.34, 0.15], [392, 0.51, 0.5]]; // 结算：下行收束
    for (const [f, at, dur] of seq) {
      this.note(kind === 'start' ? 'square' : 'triangle', f, t0 + at, dur, 0.16);
    }
  }
  /** 循环 BGM（M5）：前瞻调度，每 100ms 补排未来 0.3s 内的音符 */
  startBgm(): void {
    if (!this.ac || !this.musicGain || this.bgmTimer) return;
    this.bgmStep = 0;
    this.bgmNextTime = this.ac.currentTime + 0.05;
    this.bgmTimer = window.setInterval(() => this.scheduleBgm(), 100);
  }

  stopBgm(): void {
    if (this.bgmTimer) {
      window.clearInterval(this.bgmTimer);
      this.bgmTimer = 0;
    }
  }

  private scheduleBgm(): void {
    if (!this.ac || !this.musicGain) return;
    const lookahead = this.ac.currentTime + 0.3;
    while (this.bgmNextTime < lookahead) {
      const step = this.bgmStep % BGM_BASS.length;
      const bass = BGM_BASS[step]!;
      if (bass > 0) this.note('triangle', bass, this.bgmNextTime, BGM_STEP * 1.8, 0.12);
      const mel = BGM_MELODY[step]!;
      if (mel > 0) this.note('square', mel, this.bgmNextTime, BGM_STEP * 0.9, 0.05);
      this.bgmStep++;
      this.bgmNextTime += BGM_STEP;
    }
  }
}

/** BGM：原创 8-bit 循环（32 步，步长 0.14s）；0 = 休止。低音伴奏 + 主旋律 */
const BGM_STEP = 0.14;
const BGM_BASS: number[] = [
  110, 0, 110, 0, 131, 0, 131, 0, 98, 0, 98, 0, 82, 0, 98, 0,
  110, 0, 110, 0, 131, 0, 131, 0, 147, 0, 131, 0, 110, 0, 98, 0,
];
const BGM_MELODY: number[] = [
  440, 0, 523, 0, 587, 523, 440, 0, 392, 0, 440, 0, 330, 0, 0, 0,
  440, 0, 523, 0, 659, 587, 523, 0, 587, 0, 523, 0, 440, 0, 0, 0,
];