import { TerrainType, type MapDef } from '../shared/types';
import { loadMap } from '../shared/map/loader';
import type { Snapshot, SnapshotTank } from '../shared/protocol';

/** 快照缓冲 + 客户端插值（技术路线 §4.3：渲染时刻 = 最新 tick − 2，两帧间线性插值） */
export class SnapshotBuffer {
  private readonly snaps: Snapshot[] = [];

  push(s: Snapshot): void {
    this.snaps.push(s);
    if (this.snaps.length > 180) this.snaps.splice(0, this.snaps.length - 180);
  }

  get latest(): Snapshot | null {
    return this.snaps.length > 0 ? this.snaps[this.snaps.length - 1]! : null;
  }

  clear(): void {
    this.snaps.length = 0;
  }

  sample(delay = 2): Snapshot | null {
    if (this.snaps.length === 0) return null;
    const latest = this.snaps[this.snaps.length - 1]!;
    if (this.snaps.length === 1) return latest;
    const rt = latest.tick - delay;

    let s0: Snapshot | null = null;
    let s1: Snapshot | null = null;
    for (let i = this.snaps.length - 1; i > 0; i--) {
      const a = this.snaps[i - 1]!;
      const b = this.snaps[i]!;
      if (a.tick <= rt && rt <= b.tick) { s0 = a; s1 = b; break; }
    }
    if (!s0 || !s1) return latest;

    const span = s1.tick - s0.tick;
    const alpha = span > 0 ? (rt - s0.tick) / span : 1;
    const prev = new Map<number, SnapshotTank>(s0.tanks.map((t) => [t.id, t]));
    const tanks = s1.tanks.map((t) => {
      const p = prev.get(t.id);
      // 重生等瞬移场景不做插值
      if (!p || Math.abs(t.x - p.x) > 64 || Math.abs(t.y - p.y) > 64) return t;
      return { ...t, x: p.x + (t.x - p.x) * alpha, y: p.y + (t.y - p.y) * alpha };
    });
    return { tick: rt, tanks, bullets: s1.bullets, powerups: s1.powerups, baseAlive: s1.baseAlive };
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
}