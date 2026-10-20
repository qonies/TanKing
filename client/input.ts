import {
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
} from '../shared/constants';

export type Action = 'up' | 'down' | 'left' | 'right' | 'fire';

/** 固定备用键：自定义主键之外始终生效（WASD / J），保证默认手感 */
const ALT_KEYMAP: Record<string, number> = {
  KeyW: INPUT_UP,
  KeyS: INPUT_DOWN,
  KeyA: INPUT_LEFT,
  KeyD: INPUT_RIGHT,
  KeyJ: INPUT_FIRE,
};

const DEFAULT_BINDS: Record<Action, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  fire: 'Space',
};

/** 同一键被别的动作占用时，原动作回落到这组备用键 */
const FALLBACK_BINDS: Record<Action, string> = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  fire: 'KeyJ',
};

const STORAGE_KEY = 'tanking-keybinds';

function loadBinds(): Record<Action, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINDS };
    const parsed = JSON.parse(raw) as Partial<Record<Action, string>>;
    const binds = { ...DEFAULT_BINDS };
    for (const a of Object.keys(DEFAULT_BINDS) as Action[]) {
      const code = parsed[a];
      if (typeof code === 'string' && code) binds[a] = code;
    }
    return binds;
  } catch {
    return { ...DEFAULT_BINDS };
  }
}

function actionMask(action: Action): number {
  switch (action) {
    case 'up': return INPUT_UP;
    case 'down': return INPUT_DOWN;
    case 'left': return INPUT_LEFT;
    case 'right': return INPUT_RIGHT;
    case 'fire': return INPUT_FIRE;
  }
}

/** 键盘输入采集 → 输入位掩码；支持自定义键位（FR-S1，localStorage 持久化） */
export class KeyboardInput {
  private readonly down = new Set<string>();
  private binds: Record<Action, string> = loadBinds();
  /** 正在等待改键的动作（改键 UI 置位；下次按键即写入绑定） */
  capturing: Action | null = null;
  onBindChange: (() => void) | null = null;

  constructor(private readonly onRestart: () => void) {
    window.addEventListener('keydown', (e) => {
      if (this.capturing !== null) {
        e.preventDefault();
        e.stopPropagation();
        this.setBind(this.capturing, e.code);
        this.capturing = null;
        this.onBindChange?.();
        return;
      }
      const bound = Object.values(this.binds).includes(e.code);
      if (bound || e.code in ALT_KEYMAP || e.code === 'KeyR') e.preventDefault();
      if (e.code === 'KeyR' && !e.repeat) this.onRestart();
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  private codeMask(code: string): number {
    for (const a of Object.keys(this.binds) as Action[]) {
      if (this.binds[a] === code) return actionMask(a);
    }
    return ALT_KEYMAP[code] ?? 0;
  }

  getMask(): number {
    let m = 0;
    for (const code of this.down) m |= this.codeMask(code);
    return m;
  }

  setBind(action: Action, code: string): void {
    for (const a of Object.keys(this.binds) as Action[]) {
      if (a !== action && this.binds[a] === code) this.binds[a] = FALLBACK_BINDS[a]!;
    }
    this.binds[action] = code;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.binds)); } catch { /* 存储不可用时忽略 */ }
  }

  getBind(action: Action): string {
    return this.binds[action]!;
  }
}
