import {
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
} from '../shared/constants';

const KEYMAP: Record<string, number> = {
  ArrowUp: INPUT_UP,
  ArrowDown: INPUT_DOWN,
  ArrowLeft: INPUT_LEFT,
  ArrowRight: INPUT_RIGHT,
  KeyW: INPUT_UP,
  KeyS: INPUT_DOWN,
  KeyA: INPUT_LEFT,
  KeyD: INPUT_RIGHT,
  Space: INPUT_FIRE,
  KeyJ: INPUT_FIRE,
};

/** 键盘输入采集 → 输入位掩码（M2 起改为经 WS 上报服务器） */
export class KeyboardInput {
  private readonly down = new Set<string>();

  constructor(private readonly onRestart: () => void) {
    window.addEventListener('keydown', (e) => {
      if (e.code in KEYMAP || e.code === 'KeyR') e.preventDefault();
      if (e.code === 'KeyR' && !e.repeat) this.onRestart();
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  getMask(): number {
    let m = 0;
    for (const code of this.down) m |= KEYMAP[code] ?? 0;
    return m;
  }
}
