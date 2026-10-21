import { describe, expect, it } from 'vitest';
import { BattleSim } from '../shared/sim/sim';
import {
  CELL,
  Dir,
  FIELD,
  ICE_SLIDE_TICKS,
  INPUT_DOWN,
  INPUT_RIGHT,
  INPUT_UP,
  TANK_SIZE,
  TANK_SPEED,
} from '../shared/constants';
import { TerrainType } from '../shared/types';
import { EMPTY_ROW, makeSim, TWO_SPAWNS } from './helpers';

describe('坦克移动与半格吸附（FR-T1）', () => {
  it('按住方向键持续移动', () => {
    const sim = makeSim();
    sim.setInput(0, INPUT_UP);
    for (let i = 0; i < 20; i++) sim.step();
    const t = sim.tanks[0]!;
    expect(t.y).toBe(24 * CELL - 20 * TANK_SPEED);
    expect(t.moving).toBe(true);
  });

  it('松开按键后吸附到 16px 网格', () => {
    const sim = makeSim();
    sim.setInput(0, INPUT_RIGHT);
    for (let i = 0; i < 7; i++) sim.step(); // 移动 10.5px，x = 74.5
    sim.setInput(0, 0);
    sim.step();
    const t = sim.tanks[0]!;
    expect(t.x % CELL).toBe(0);
    expect(t.x).toBe(Math.round((4 * CELL + 10.5) / CELL) * CELL);
  });

  it('转向时原移动轴吸附半格', () => {
    const sim = makeSim();
    sim.setInput(0, INPUT_RIGHT);
    for (let i = 0; i < 7; i++) sim.step();
    sim.setInput(0, INPUT_UP);
    sim.step();
    const t = sim.tanks[0]!;
    expect(t.dir).toBe(Dir.Up);
    expect(t.x % CELL).toBe(0);
  });

  it('不能越出场地上边界', () => {
    const sim = makeSim();
    sim.setInput(0, INPUT_UP);
    for (let i = 0; i < 400; i++) sim.step();
    expect(sim.tanks[0]!.y).toBe(0);
  });
});

describe('坦克碰撞（FR-M1/M2/M3、坦克互为障碍）', () => {
  it('钢墙阻挡移动', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[20] = '..............SS..........'; // 小格 x=14,15 → px 224..255
    const sim = makeSim(rows);
    const t = sim.tanks[0]!;
    t.x = 8 * CELL; t.y = 20 * CELL; // 与钢墙同行
    t.dir = Dir.Right;
    sim.setInput(0, INPUT_RIGHT);
    for (let i = 0; i < 120; i++) sim.step();
    sim.setInput(0, 0);
    sim.step(); // 松开吸附
    expect(t.x).toBe(224 - TANK_SIZE); // 贴墙而停
  });

  it('水面阻挡坦克', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[12] = '..........WWWW............'; // 小格 x 10..13 → px 160..223
    const sim = makeSim(rows);
    const t = sim.tanks[0]!;
    t.x = 8 * CELL; t.y = 12 * CELL; // 右缘贴水（水从小格 x=10 起）
    t.dir = Dir.Right;
    sim.setInput(0, 1 << Dir.Right);
    for (let i = 0; i < 60; i++) sim.step();
    expect(t.x).toBe(8 * CELL); // 被水挡住
  });

  it('树林不阻挡坦克', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[12] = '..........TTTT............';
    const sim = makeSim(rows);
    const t = sim.tanks[0]!;
    t.x = 8 * CELL; t.y = 12 * CELL;
    t.dir = Dir.Right;
    sim.setInput(0, INPUT_RIGHT);
    for (let i = 0; i < 30; i++) sim.step();
    expect(t.x).toBeGreaterThan(8 * CELL);
  });

  it('坦克之间互为障碍', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    a.x = 4 * CELL; a.y = 10 * CELL; a.dir = Dir.Down;
    b.x = 4 * CELL; b.y = 13 * CELL; // a 下方隔一格
    sim.setInput(0, INPUT_DOWN);
    for (let i = 0; i < 120; i++) sim.step();
    sim.setInput(0, 0);
    sim.step(); // 松开吸附
    expect(a.y).toBe(13 * CELL - TANK_SIZE);
  });

  it('重生点不会与其他坦克重叠', () => {
    const sim = makeSim([], TWO_SPAWNS, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    const c = sim.tanks[2]!;
    // P0 修复后初始出生点唯一分配：tank0 → spawn0、tank1 → spawn1、tank2 → 兜底安全位
    expect(b.x).toBe(TWO_SPAWNS[1]!.x * CELL);
    expect(new Set([a, b, c].map((t) => `${t.x},${t.y}`)).size).toBe(3);
    a.alive = false;
    a.respawnTicks = 1;
    sim.step(); // 触发 A 重生（出生点被占 → 走随机/兜底搜索）
    expect(a.alive).toBe(true);
    for (const o of [b, c]) {
      const overlap = a.x < o.x + TANK_SIZE && a.x + TANK_SIZE > o.x &&
                      a.y < o.y + TANK_SIZE && a.y + TANK_SIZE > o.y;
      expect(overlap).toBe(false);
    }
  });
});

describe('冰面滑行（FR-M5）', () => {
  it('冰面上松开按键后继续滑行一段距离', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[11] = '................III.......'; // 冰面 x 16..18 → px 256..303
    const sim = makeSim(rows);
    const t = sim.tanks[0]!;
    t.x = 16 * CELL; t.y = 10 * CELL; // 站在冰上（中心格在冰面行）
    sim.setInput(0, INPUT_RIGHT);
    for (let i = 0; i < 10; i++) sim.step(); // 松开前 x = 256+15 = 271
    sim.setInput(0, 0);
    sim.step(); // 吸附 → 272，且开始滑行
    expect(t.x).toBe(272);
    expect(t.slideTicks).toBe(ICE_SLIDE_TICKS);
    for (let i = 0; i < 30; i++) sim.step();
    expect(t.x).toBeGreaterThan(272); // 滑出了一段
    expect(t.x % CELL).toBe(0);       // 最终停稳吸附
  });
});

describe('地图加载', () => {
  it('非法地图抛错', () => {
    expect(() => new BattleSim({ name: 'x', size: 26, terrain: ['B'], spawns: [{ x: 0, y: 0 }] }, [{ name: 'A' }]))
      .toThrow(/行数非法/);
  });

  it('场地下边界夹紧', () => {
    const sim = makeSim();
    const t = sim.tanks[0]!;
    t.y = FIELD - TANK_SIZE;
    t.dir = Dir.Down;
    sim.setInput(0, INPUT_DOWN);
    for (let i = 0; i < 30; i++) sim.step();
    expect(t.y).toBe(FIELD - TANK_SIZE);
    expect(sim.terrainAt(4, 25)).toBe(TerrainType.Empty);
  });
});
