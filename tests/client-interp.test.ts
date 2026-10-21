import { describe, expect, it } from 'vitest';
import { Dir, TICK_MS } from '../shared/constants';
import { TerrainType } from '../shared/types';
import type { Snapshot, SnapshotTank } from '../shared/protocol';
import { SnapshotBuffer, TerrainView } from '../client/interp';
import { makeMap } from './helpers';

function tank(id: number, x: number, y: number, dir: Dir, moving: boolean): SnapshotTank {
  return {
    id, x, y, dir, moving, alive: true, shieldTicks: 0, respawnTicks: 0,
    level: 0, frozenTicks: 0, score: 0, kills: 0, deaths: 0, bonus: false,
  };
}

function snap(tick: number, tanks: SnapshotTank[]): Snapshot {
  return { tick, tanks, bullets: [], powerups: [], baseAlive: true, ticksLeft: null };
}

/** 可注入时钟的两帧缓冲：t=0 收到 tick10，t=TICK_MS 收到 tick11，t=2×TICK_MS 渲染 */
function bufferWithTwoSnaps(): SnapshotBuffer {
  let now = 0;
  const buf = new SnapshotBuffer(() => now);
  buf.push(snap(10, [tank(1, 100, 200, Dir.Right, true), tank(2, 300, 200, Dir.Left, true)]));
  now = TICK_MS;
  buf.push(snap(11, [tank(1, 101.5, 200, Dir.Right, true), tank(2, 298.5, 200, Dir.Left, true)]));
  now = TICK_MS * 2;
  return buf;
}

describe('客户端插值：本机坦克航位推算（NFR-2）', () => {
  it('本机坦克在最新快照上按移动方向外推（抵消 2 帧缓冲延迟）', () => {
    const s = bufferWithTwoSnaps().sample(2, 1)!;
    // frac = 1：本机坦克 = 最新快照位置 + 1 tick × TANK_SPEED(1.5)
    expect(s.tanks.find((t) => t.id === 1)!.x).toBeCloseTo(101.5 + 1.5, 3);
  });

  it('非本机坦克仍按两帧快照线性插值', () => {
    const s = bufferWithTwoSnaps().sample(2, 1)!;
    // 渲染时刻 = 11 − 2 + frac(1) = 10 → alpha = 0 → 取旧帧位置
    expect(s.tanks.find((t) => t.id === 2)!.x).toBeCloseTo(300, 3);
  });

  it('静止或死亡的本机坦克不外推（回落到插值路径）', () => {
    let now = 0;
    const buf = new SnapshotBuffer(() => now);
    buf.push(snap(10, [tank(1, 100, 200, Dir.Right, false)]));
    now = TICK_MS;
    buf.push(snap(11, [{ ...tank(1, 100, 200, Dir.Right, true), alive: false }]));
    now = TICK_MS * 2;
    const s = buf.sample(2, 1)!;
    expect(s.tanks[0]!.x).toBeCloseTo(100, 3);
  });
});

describe('TerrainView 地形视图', () => {
  it('breakBrick / setCells 应用事件，越界安全', () => {
    const rows = ['..BB' + '.'.repeat(22), ...Array.from({ length: 25 }, () => '.'.repeat(26))];
    const view = new TerrainView(makeMap(rows, [{ x: 4, y: 24 }, { x: 20, y: 0 }]));
    expect(view.terrainAt(2, 0)).toBe(TerrainType.Brick);
    view.breakBrick(2, 0);
    expect(view.terrainAt(2, 0)).toBe(TerrainType.Empty);
    view.setCells([{ x: 3, y: 0, t: TerrainType.Steel }, { x: -1, y: 0, t: TerrainType.Steel }]);
    expect(view.terrainAt(3, 0)).toBe(TerrainType.Steel);
    expect(view.terrainAt(-1, 0)).toBe(TerrainType.Steel); // 越界读取返回 Steel，不写坏数组
  });

  it('applyTerrain 仅在长度一致时整表替换（重连地形同步）', () => {
    const view = new TerrainView(makeMap([], [{ x: 4, y: 24 }, { x: 20, y: 0 }]));
    view.applyTerrain(new Array(26 * 26).fill(TerrainType.Brick as number));
    expect(view.terrainAt(0, 0)).toBe(TerrainType.Brick);
    view.applyTerrain([1, 2, 3]); // 长度不符 → 忽略
    expect(view.terrainAt(0, 0)).toBe(TerrainType.Brick);
  });
});