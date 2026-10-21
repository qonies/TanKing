import { DIR_VEC, TANK_SPEED, TICK_MS } from '../shared/constants';
import { TerrainType, type MapDef } from '../shared/types';
import { loadMap } from '../shared/map/loader';
import type { Snapshot, SnapshotTank } from '../shared/protocol';

/** 带接收时间戳的快照（用于计算 tick 内插值分数） */
interface BufferedSnapshot { snap: Snapshot; recvAt: number }

/**
 * 快照缓冲 + 客户端插值（技术路线 §4.3：渲染时刻 = 最新 tick − 2 + tick 内时间分数，两帧间线性插值）。
 * 本机坦克额外做 1 tick 内的航位推算（dead reckoning，NFR-2）：沿快照中的移动方向按速度外推，
 * 抵消 2 帧插值缓冲带来的显示延迟；新快照到达即以服务器权威位置自我修正。
 */
export class SnapshotBuffer {
  private readonly snaps: BufferedSnapshot[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  push(s: Snapshot): void {
    this.snaps.push({ snap: s, recvAt: this.now() });
    if (this.snaps.length > 180) this.snaps.splice(0, this.snaps.length - 180);
  }

  get latest(): Snapshot | null {
    return this.snaps.length > 0 ? this.snaps[this.snaps.length - 1]!.snap : null;
  }

  clear(): void {
    this.snaps.length = 0;
  }

  sample(delay = 2, localTankId?: number): Snapshot | null {
    if (this.snaps.length === 0) return null;
    const last = this.snaps[this.snaps.length - 1]!;
    const latest = last.snap;
    if (this.snaps.length === 1) return latest;

    // 渲染时刻 = 最新 tick − delay + tick 内时间分数：分数随时间从 0 → 1 连续推进，
    // 新快照到达时 tick+1、分数归零，渲染时刻保持连续（实现真正的帧间插值）。
    const frac = Math.min(1, Math.max(0, (this.now() - last.recvAt) / TICK_MS));
    const rt = latest.tick - delay + frac;

    let s0: Snapshot | null = null;
    let s1: Snapshot | null = null;
    for (let i = this.snaps.length - 1; i > 0; i--) {
      const a = this.snaps[i - 1]!.snap;
      const b = this.snaps[i]!.snap;
      if (a.tick <= rt && rt <= b.tick) { s0 = a; s1 = b; break; }
    }
    if (!s0 || !s1) return latest;

    const span = s1.tick - s0.tick;
    const alpha = span > 0 ? (rt - s0.tick) / span : 1;
    const prev = new Map<number, SnapshotTank>(s0.tanks.map((t) => [t.id, t]));
    const tanks = s1.tanks.map((t) => {
      // 本机坦克航位推算（NFR-2）：在最新快照基础上沿移动方向外推 tick 内时间分数
      if (t.id === localTankId && t.alive && t.moving) {
        const v = DIR_VEC[t.dir]!;
        return { ...t, x: t.x + v.x * TANK_SPEED * frac, y: t.y + v.y * TANK_SPEED * frac };
      }
      const p = prev.get(t.id);
      // 重生等瞬移场景不做插值
      if (!p || Math.abs(t.x - p.x) > 64 || Math.abs(t.y - p.y) > 64) return t;
      return { ...t, x: p.x + (t.x - p.x) * alpha, y: p.y + (t.y - p.y) * alpha };
    });
    return { tick: rt, tanks, bullets: s1.bullets, powerups: s1.powerups, baseAlive: s1.baseAlive, ticksLeft: s1.ticksLeft };
  }
}

/** 客户端本地地形视图：以地图初始状态为底，应用服务器下发的 brickBreak 事件 */
export class TerrainView {
  private readonly grid: Uint8Array;
  readonly size: number;

  constructor(mapDef: MapDef) {
    const loaded = loadMap(mapDef);
    this.grid = loaded.terrain;
    this.size = loaded.size;
  }

  terrainAt(cx: number, cy: number): TerrainType {
    if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return TerrainType.Steel;
    return this.grid[cy * this.size + cx]! as TerrainType;
  }

  breakBrick(cx: number, cy: number): void {
    if (cx >= 0 && cy >= 0 && cx < this.size && cy < this.size) {
      this.grid[cy * this.size + cx] = TerrainType.Empty;
    }
  }

  /** 重连同步：应用服务器下发的完整地形（含已破坏砖墙与铁锹钢墙） */
  applyTerrain(cells: number[]): void {
    if (cells.length === this.grid.length) this.grid.set(cells);
  }

  /** terrainSet 事件（FR-P5 铁锹）：设置/恢复若干小格地形 */
  setCells(cells: { x: number; y: number; t: TerrainType }[]): void {
    for (const c of cells) {
      if (c.x >= 0 && c.y >= 0 && c.x < this.size && c.y < this.size) {
        this.grid[c.y * this.size + c.x] = c.t;
      }
    }
  }
}