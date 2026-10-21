/** 全局游戏参数 —— 数值依据《docs/参数对照表.md》，M1 期间需与原版逐项核定 */

// ---- tick / 网格 ----
export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

export const GRID = 26;            // 26×26 小格（= 13×13 大格 × 2）
export const CELL = 16;            // 小格像素（大格 = 32px）
export const FIELD = GRID * CELL;  // 416 逻辑分辨率
export const TANK_SIZE = 32;       // 坦克 = 1 大格
export const BULLET_SIZE = 8;
export const SNAP = 16;            // 半格吸附（小格粒度）

// ---- 计分（D1：积分制）----
export const SCORE_KILL = 100;          // 1 击杀
export const SCORE_BASE = 500;          // 摧毁中立基地（M3）
export const SCORE_TANK_POWERUP = 200;  // 坦克道具（M3）
export const SCORE_STAR_MAX = 100;      // 满级星星（M3）
export const SCORE_CAP_DEFAULT = 1000;  // 默认积分上限
export const ROUND_TICKS_DEFAULT = 8 * 60 * TICK_RATE; // 默认 8 分钟

// ---- 坦克 / 子弹（原版 60fps、208×208 下的值 ×2 折算到 416×416）----
export const TANK_SPEED = 1.5;    // px/tick（原版 ≈0.75 px/帧）
export const BULLET_SPEED = 4;    // px/tick（原版 ≈2 px/帧，L0 基准值）
export const MAX_BULLETS = 1;     // L0 同屏弹量（M3 起按等级表）

// ---- 坦克等级（FR-T3/T4，D6；数值见参数对照表 §2）----
export const MAX_LEVEL = 3;
export const BULLET_SPEED_BY_LEVEL: readonly number[] = [4, 8, 8, 8]; // L1+ 快速子弹
export const MAX_BULLETS_BY_LEVEL: readonly number[] = [1, 1, 2, 2];  // L2+ 双发

// ---- 道具（FR-P1~P6）----
export const POWERUP_INTERVAL_TICKS = 20 * TICK_RATE; // 定点刷新间隔 20s
export const MAX_POWERUPS = 1;                        // 同时在场数量上限
export const HELMET_TICKS = 10 * TICK_RATE;           // 头盔：10s 护盾
export const FREEZE_TICKS = 8 * TICK_RATE;            // 定时器：冻结对手 8s
export const SHOVEL_TICKS = 15 * TICK_RATE;           // 铁锹：基地钢墙 15s

// ---- 生命周期 ----
export const RESPAWN_TICKS = 2 * TICK_RATE;  // 被击毁 2 秒后重生
export const SHIELD_TICKS = 3 * TICK_RATE;   // 重生 3 秒无敌
export const ICE_SLIDE_TICKS = 20;           // 冰面滑行时长（近似原版惯性手感）

// ---- 闪红坦克（M5，FR-P 适配：低概率闪红 AI 被击毁时原地掉落道具）----
export const BONUS_BOT_PROBABILITY = 0.2;

// ---- 方向 ----
export const Dir = { Up: 0, Right: 1, Down: 2, Left: 3 } as const;
export type Dir = (typeof Dir)[keyof typeof Dir];

export interface Vec { x: number; y: number }
export const DIR_VEC: readonly Vec[] = [
  { x: 0, y: -1 }, // Up
  { x: 1, y: 0 },  // Right
  { x: 0, y: 1 },  // Down
  { x: -1, y: 0 }, // Left
] as const;

export function isHorizontal(dir: Dir): boolean {
  return dir === Dir.Left || dir === Dir.Right;
}

// ---- 输入位掩码（协议预留：1 字节）----
export const INPUT_UP = 1;
export const INPUT_DOWN = 2;
export const INPUT_LEFT = 4;
export const INPUT_RIGHT = 8;
export const INPUT_FIRE = 16;
export const INPUT_DIR_MASK = 0b1111;

export const DIR_INPUT: Readonly<Record<Dir, number>> = {
  [Dir.Up]: INPUT_UP,
  [Dir.Right]: INPUT_RIGHT,
  [Dir.Down]: INPUT_DOWN,
  [Dir.Left]: INPUT_LEFT,
};

/** 从位掩码解析方向键（多键同按按 上→下→左→右 优先级） */
export function maskDir(mask: number): Dir | null {
  if (mask & INPUT_UP) return Dir.Up;
  if (mask & INPUT_DOWN) return Dir.Down;
  if (mask & INPUT_LEFT) return Dir.Left;
  if (mask & INPUT_RIGHT) return Dir.Right;
  return null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 半格吸附：吸附到最近 16px 网格并夹到场内 */
export function snap(v: number): number {
  return clamp(Math.round(v / SNAP) * SNAP, 0, FIELD - TANK_SIZE);
}
