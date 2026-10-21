import {
  CELL,
  clamp,
  Dir,
  DIR_INPUT,
  DIR_VEC,
  GRID,
  INPUT_DIR_MASK,
  INPUT_FIRE,
  TANK_SIZE,
  type Dir as DirT,
} from '../constants';
import { TerrainType, type TankState } from '../types';
import type { BattleSim, Tank } from './sim';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

/**
 * AI 速度档位（M5，参数对照表 §2）：
 * 原版敌人坦克分基础（≈0.375 px/帧 @208）/ 快速（≈0.75 px/帧）两档，×2 折算即 0.75 / 1.5 px/tick @416。
 * PvP 适配：按 AI 难度分档——easy 取原版基础档，normal 折中，hard 与真人同速。
 */
export const BOT_SPEED_BY_DIFFICULTY: Record<BotDifficulty, number> = { easy: 0.75, normal: 1.0, hard: 1.5 };

const DECIDE_INTERVAL = 10;   // 每 10 tick 重新决策
const STUCK_TICKS = 30;       // 卡墙判定
const FIRE_COOLDOWN: Record<BotDifficulty, number> = { easy: 60, normal: 30, hard: 15 };
const FIRE_CHANCE: Record<BotDifficulty, number> = { easy: 0.3, normal: 0.6, hard: 0.9 };

/**
 * AI 机器人控制器（FR-A2）：
 * 对齐敌人时直接瞄准开火；否则在 25×25 坦克位网格上 BFS 寻路逼近目标
 * （砖墙视为可通行——卡住时开火开路）；无目标则随机巡逻。
 * 与真人共用 setInput 通道，产出输入位掩码。
 */
export class BotController {
  private decideCd = 0;
  private fireCd = 0;
  private stuckTicks = 0;
  private lastX = -1;
  private lastY = -1;
  private mask = 0;

  constructor(
    private readonly sim: BattleSim,
    readonly tankId: number,
    private readonly rng: () => number,
    private readonly difficulty: BotDifficulty = 'normal',
  ) {}

  /** 每 tick 调用，返回本 tick 输入掩码 */
  update(): number {
    const me = this.sim.tankById(this.tankId);
    if (!me || !me.alive || this.sim.gameOver) {
      this.mask = 0;
      return 0;
    }
    if (this.fireCd > 0) this.fireCd--;
    if (--this.decideCd <= 0) {
      this.decide(me);
      this.decideCd = DECIDE_INTERVAL;
    }

    // 卡墙检测：有方向输入但长时间未位移 → 随机变向 + 开火开路
    if (me.x === this.lastX && me.y === this.lastY && this.mask & INPUT_DIR_MASK) {
      if (++this.stuckTicks >= STUCK_TICKS) {
        this.stuckTicks = 0;
        const dir = Math.floor(this.rng() * 4) as DirT;
        this.mask = DIR_INPUT[dir]! | INPUT_FIRE;
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastX = me.x;
    this.lastY = me.y;

    let m = this.mask;
    if (this.fireCd > 0) m &= ~INPUT_FIRE;
    return m;
  }

  private decide(me: Tank): void {
    const enemy = this.nearestEnemy(me);
    // 困难档（FR-A3）：无对枪机会时优先逼近场上的道具（抢道具）
    if (this.difficulty === 'hard' && this.sim.powerups.length > 0) {
      const aligned = enemy !== undefined && this.alignedDir(me, enemy) !== null;
      if (!aligned) {
        const pu = this.sim.powerups[0]!;
        const d = this.bfsDir(me, pu.x + TANK_SIZE / 2, pu.y + TANK_SIZE / 2, -1);
        if (d !== null) {
          this.mask = DIR_INPUT[d]!;
          return;
        }
      }
    }
    if (enemy) {
      const dir = this.alignedDir(me, enemy);
      if (dir !== null) {
        if (!this.tryFire(me, enemy, dir)) this.mask = DIR_INPUT[dir]!;
        return;
      }
      const d = this.bfsDir(me, enemy.x + TANK_SIZE / 2, enemy.y + TANK_SIZE / 2, enemy.id);
      if (d !== null) {
        this.mask = DIR_INPUT[d]!;
        return;
      }
    }
    // 巡逻：无方向或随机换向
    if (!(this.mask & INPUT_DIR_MASK) || this.rng() < 0.3) {
      this.mask = DIR_INPUT[Math.floor(this.rng() * 4) as DirT]!;
    }
  }

  /** 与目标同行/同列（半格容差）时的开火方向；未对齐返回 null */
  private alignedDir(me: Tank, enemy: TankState): DirT | null {
    const mcx = me.x + TANK_SIZE / 2;
    const mcy = me.y + TANK_SIZE / 2;
    const ecx = enemy.x + TANK_SIZE / 2;
    const ecy = enemy.y + TANK_SIZE / 2;
    if (Math.abs(mcx - ecx) <= CELL / 2 && mcy !== ecy) return ecy < mcy ? Dir.Up : Dir.Down;
    if (Math.abs(mcy - ecy) <= CELL / 2 && mcx !== ecx) return ecx < mcx ? Dir.Left : Dir.Right;
    return null;
  }

  private tryFire(me: Tank, enemy: TankState, dir: DirT): boolean {
    if (this.fireCd > 0) return false;
    if (this.rng() > FIRE_CHANCE[this.difficulty]) return false;
    if (!this.losClear(me, enemy, dir)) return false;
    this.mask = DIR_INPUT[dir]! | INPUT_FIRE;
    this.fireCd = FIRE_COOLDOWN[this.difficulty];
    return true;
  }

  private nearestEnemy(me: Tank): Tank | undefined {
    let best: Tank | undefined;
    let bestD = Infinity;
    const base = this.sim.map.base;
    for (const t of this.sim.tanks) {
      if (t.id === me.id || !t.alive) continue;
      const dx = t.x - me.x;
      const dy = t.y - me.y;
      let d = dx * dx + dy * dy;
      // 困难档护家（FR-A3）：优先攻击逼近基地的敌人
      if (this.difficulty === 'hard' && base && this.sim.baseAlive) {
        const bx = t.x - base.x;
        const by = t.y - base.y;
        if (bx * bx + by * by <= 4 * CELL * (4 * CELL)) d = 0;
      }
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** 视线：沿线钢墙/砖墙阻挡（子弹可穿水） */
  private losClear(me: TankState, enemy: TankState, dir: DirT): boolean {
    const v = DIR_VEC[dir]!;
    const gx = Math.floor((enemy.x + TANK_SIZE / 2) / CELL);
    const gy = Math.floor((enemy.y + TANK_SIZE / 2) / CELL);
    let cx = Math.floor((me.x + TANK_SIZE / 2) / CELL) + v.x;
    let cy = Math.floor((me.y + TANK_SIZE / 2) / CELL) + v.y;
    while (cx >= 0 && cy >= 0 && cx < GRID && cy < GRID) {
      if (cx === gx && cy === gy) return true;
      const tt = this.sim.terrainAt(cx, cy);
      if (tt === TerrainType.Steel || tt === TerrainType.Brick) return false;
      cx += v.x;
      cy += v.y;
    }
    return false;
  }

  /**
   * BFS 寻路：节点 = 坦克左上角所在小格 (i,j)，i,j ∈ 0..24（坦克占 2×2 小格）。
   * 钢/水阻塞；砖可通行（配合卡墙开火开路）；其他坦克占位阻塞（ignoreId 除外）。
   * 目标为任意像素点（取其中心折算小格）。
   */
  private bfsDir(me: Tank, tx: number, ty: number, ignoreId: number): DirT | null {
    const N = GRID - 1;
    const si = Math.round(me.x / CELL);
    const sj = Math.round(me.y / CELL);
    // 目标为中心像素折算的小格，需钳制在场内（坦克贴边时中心折算可能 = GRID-1 越过 N-1）
    const gi = clamp(Math.round(tx / CELL), 0, N - 1);
    const gj = clamp(Math.round(ty / CELL), 0, N - 1);
    if (si < 0 || sj < 0 || si >= N || sj >= N) return null;

    const blocked = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        for (let cy = j; cy <= j + 1 && !blocked[j * N + i]; cy++) {
          for (let cx = i; cx <= i + 1; cx++) {
            const tt = this.sim.terrainAt(cx, cy);
            if (tt === TerrainType.Steel || tt === TerrainType.Water) {
              blocked[j * N + i] = 1;
              break;
            }
          }
        }
      }
    }
    for (const t of this.sim.tanks) {
      if (!t.alive || t.id === me.id || t.id === ignoreId) continue;
      const ti = Math.round(t.x / CELL);
      const tj = Math.round(t.y / CELL);
      if (ti >= 0 && tj >= 0 && ti < N && tj < N) blocked[tj * N + ti] = 1;
    }

    const start = sj * N + si;
    const goal = gj * N + gi;
    if (start === goal) return null;

    const prev = new Int32Array(N * N).fill(-1);
    prev[start] = start;
    const queue: number[] = [start];
    for (let h = 0; h < queue.length; h++) {
      const cur = queue[h]!;
      if (cur === goal) break;
      const ci = cur % N;
      const cj = (cur - ci) / N;
      for (const [di, dj] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nIdx = nj * N + ni;
        if (prev[nIdx] !== -1) continue;
        if (nIdx !== goal && blocked[nIdx]) continue;
        prev[nIdx] = cur;
        queue.push(nIdx);
      }
    }
    if (prev[goal] === -1) return null;

    // 回溯到起点的下一格
    let cur = goal;
    while (prev[cur] !== start) cur = prev[cur]!;
    const ni = cur % N;
    const nj = (cur - ni) / N;
    const di = ni - si;
    const dj = nj - sj;
    if (di === 1) return Dir.Right;
    if (di === -1) return Dir.Left;
    if (dj === 1) return Dir.Down;
    if (dj === -1) return Dir.Up;
    return null;
  }
}
