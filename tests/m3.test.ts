import { describe, expect, it } from 'vitest';
import { BattleSim } from '../shared/sim/sim';
import { PowerupType, TerrainType } from '../shared/types';
import {
  BULLET_SPEED_BY_LEVEL,
  CELL,
  Dir,
  FREEZE_TICKS,
  HELMET_TICKS,
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_UP,
  SCORE_BASE,
  SCORE_KILL,
  SCORE_STAR_MAX,
  SCORE_TANK_POWERUP,
  SHOVEL_TICKS,
  TANK_SIZE,
} from '../shared/constants';
import { loadMap } from '../shared/map/loader';
import { MAPS, mapByName } from '../shared/maps';
import { EMPTY_ROW, makeSim } from './helpers';
import type { MapDef } from '../shared/types';

function makeBaseMap(): MapDef {
  return {
    name: 'base-test',
    size: 26,
    terrain: Array(26).fill(EMPTY_ROW),
    spawns: [{ x: 4, y: 24 }, { x: 20, y: 0 }],
    base: { x: 12, y: 12 },
    powerupSpots: [],
  };
}

describe('坦克等级（FR-T3/T4、D6）', () => {
  it('星星逐级升级至 L3，满级星星改 +100 分', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    sim.powerups.push(
      { id: 1, type: PowerupType.Star, x: a.x, y: a.y },
      { id: 2, type: PowerupType.Star, x: a.x, y: a.y },
      { id: 3, type: PowerupType.Star, x: a.x, y: a.y },
      { id: 4, type: PowerupType.Star, x: a.x, y: a.y },
    );
    sim.step(); // 同 tick 内全部拾取
    expect(a.level).toBe(3);
    expect(a.score).toBe(SCORE_STAR_MAX); // 第 4 颗满级 → +100
  });

  it('L2 双发：同屏弹量 2', () => {
    const sim = makeSim();
    sim.tanks[0]!.level = 2;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    for (let i = 0; i < 3; i++) sim.step();
    expect(sim.bullets.filter((b) => b.ownerId === 0).length).toBe(2);
  });

  it('L1 快速子弹：弹速 8px/tick', () => {
    const sim = makeSim();
    sim.tanks[0]!.level = 1;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    const b = sim.bullets[0]!;
    const y0 = b.y;
    sim.step();
    expect(b.y).toBe(y0 - BULLET_SPEED_BY_LEVEL[1]!);
  });

  it('L3 破钢：钢墙被摧毁', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[20] = '....SS....................';
    const sim = makeSim(rows);
    const a = sim.tanks[0]!;
    a.level = 3;
    a.x = 4 * CELL; a.y = 24 * CELL; a.dir = Dir.Up;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    sim.setInput(0, 0);
    for (let i = 0; i < 8; i++) sim.step();
    expect(sim.terrainAt(4, 20)).toBe(TerrainType.Empty);
    expect(sim.terrainAt(5, 20)).toBe(TerrainType.Empty);
  });

  it('L3 砖墙整大格摧毁（2×2 小格）', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[20] = '....BB....................';
    rows[21] = '....BB....................';
    const sim = makeSim(rows);
    const a = sim.tanks[0]!;
    a.level = 3;
    a.x = 4 * CELL; a.y = 24 * CELL; a.dir = Dir.Up;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    sim.setInput(0, 0);
    for (let i = 0; i < 8; i++) sim.step();
    for (const [cx, cy] of [[4, 20], [5, 20], [4, 21], [5, 21]] as const) {
      expect(sim.terrainAt(cx, cy)).toBe(TerrainType.Empty);
    }
  });

  it('被击毁降 1 级（D6）', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    a.x = 4 * CELL; a.y = 24 * CELL; a.dir = Dir.Up;
    b.x = 4 * CELL; b.y = 22 * CELL; b.dir = Dir.Down;
    a.shieldTicks = 0; b.shieldTicks = 0;
    b.level = 2;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    expect(b.alive).toBe(false);
    expect(b.level).toBe(1);
    expect(a.score).toBe(SCORE_KILL);
  });
});

describe('道具效果（FR-P1~P6）', () => {
  it('头盔：10s 护盾（FR-P2）', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    sim.powerups.push({ id: 1, type: PowerupType.Helmet, x: a.x, y: a.y });
    sim.step();
    expect(a.shieldTicks).toBe(HELMET_TICKS);
  });

  it('定时器：冻结所有对手 8s，不可移动/开火（FR-P3）', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    sim.powerups.push({ id: 1, type: PowerupType.Timer, x: a.x, y: a.y });
    sim.step();
    expect(b.frozenTicks).toBe(FREEZE_TICKS);
    sim.setInput(1, INPUT_DOWN | INPUT_FIRE);
    for (let i = 0; i < 10; i++) sim.step();
    expect(b.y).toBe(0); // 冻结中不能移动
    expect(sim.bullets.filter((x) => x.ownerId === 1).length).toBe(0); // 不能开火
    expect(b.frozenTicks).toBeLessThan(FREEZE_TICKS); // 倒计时在走
  });

  it('炸弹：全图对手击毁并按击杀归属计分（FR-P4）', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    sim.powerups.push({ id: 1, type: PowerupType.Bomb, x: a.x, y: a.y });
    sim.step();
    expect(b.alive).toBe(false);
    expect(a.score).toBe(SCORE_KILL);
    expect(a.kills).toBe(1);
    expect(a.alive).toBe(true); // 拾取者存活
  });

  it('坦克道具：+200 分（FR-P6）', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    sim.powerups.push({ id: 1, type: PowerupType.Tank, x: a.x, y: a.y });
    sim.step();
    expect(a.score).toBe(SCORE_TANK_POWERUP);
  });

  it('铁锹：基地周围变钢墙 15s，到期恢复原状（FR-P5）', () => {
    const sim = new BattleSim(makeBaseMap(), [{ name: 'A' }, { name: 'B' }], { seed: 1 });
    const a = sim.tanks[0]!;
    a.x = 8 * CELL; a.y = 16 * CELL; // 远离基地的空地
    sim.powerups.push({ id: 1, type: PowerupType.Shovel, x: a.x, y: a.y });
    sim.step();
    // 环 = 基地 2×2 外一圈小格（11..14 × 11..14，扣除基地格）
    expect(sim.terrainAt(12, 11)).toBe(TerrainType.Steel);
    expect(sim.terrainAt(11, 12)).toBe(TerrainType.Steel);
    expect(sim.terrainAt(12, 12)).toBe(TerrainType.Empty); // 基地格本身不变
    for (let i = 0; i < SHOVEL_TICKS; i++) sim.step();
    expect(sim.terrainAt(12, 11)).toBe(TerrainType.Empty); // 恢复原状
  });
});

describe('中立基地（FR-M6/D2）', () => {
  it('子弹摧毁基地：+500 分，回合不结束', () => {
    const sim = new BattleSim(makeBaseMap(), [{ name: 'A' }, { name: 'B' }], { seed: 1, timeTicks: 1000 });
    const a = sim.tanks[0]!;
    a.shieldTicks = 0;
    a.x = 12 * CELL; a.y = 10 * CELL; // 基地正上方 2 格
    a.dir = Dir.Down;
    sim.setInput(0, INPUT_DOWN | INPUT_FIRE);
    sim.step();
    expect(sim.baseAlive).toBe(false);
    expect(sim.tanks[0]!.score).toBe(SCORE_BASE);
    expect(sim.gameOver).toBe(false); // D2：回合不结束
  });

  it('基地为实体障碍；被毁后可通过', () => {
    const sim = new BattleSim(makeBaseMap(), [{ name: 'A' }, { name: 'B' }], { seed: 1 });
    const a = sim.tanks[0]!;
    a.shieldTicks = 0;
    a.x = 12 * CELL; a.y = 10 * CELL; a.dir = Dir.Down;
    sim.setInput(0, INPUT_DOWN);
    sim.step();
    expect(a.y).toBe(10 * CELL); // 被基地挡住
    // 摧毁基地后可穿过（A 挪到基地下方，避免挡住弹道）
    sim.setInput(0, 0);
    a.y = 15 * CELL;
    sim.bullets.push({ id: 99, ownerId: 1, dir: Dir.Down, x: 12 * CELL + TANK_SIZE / 2 - 4, y: 9 * CELL, level: 0 });
    for (let i = 0; i < 30 && sim.baseAlive; i++) sim.step();
    expect(sim.baseAlive).toBe(false);
    sim.setInput(0, INPUT_DOWN);
    for (let i = 0; i < 30; i++) sim.step();
    expect(a.y).toBeGreaterThan(15 * CELL);
  });
});

describe('地图注册表（M3 内置 6 张）', () => {
  it('6 张地图均可加载，含基地与道具点，出生点合法', () => {
    expect(MAPS.length).toBe(6);
    const names = new Set<string>();
    for (const m of MAPS) {
      const loaded = loadMap(m);
      names.add(loaded.name);
      expect(loaded.base).not.toBeNull();
      expect(loaded.powerupSpots.length).toBeGreaterThan(0);
      expect(loaded.spawns.length).toBeGreaterThanOrEqual(2);
      // 出生点 2×2 范围内不得有砖/钢/水
      for (const s of loaded.spawns) {
        for (let y = s.y / 16; y < s.y / 16 + 2; y++) {
          for (let x = s.x / 16; x < s.x / 16 + 2; x++) {
            const tt = loaded.terrain[y! * loaded.size + x!]!;
            expect([TerrainType.Brick, TerrainType.Steel, TerrainType.Water]).not.toContain(tt);
          }
        }
      }
    }
    expect(names.size).toBe(6);
  });

  it('map01 经 M3 修补后含基地环', () => {
    const m1 = mapByName('经典对称 01');
    expect(m1).toBeDefined();
    const loaded = loadMap(m1!);
    expect(loaded.base).toEqual({ x: 12 * 16, y: 12 * 16 });
    // 基地上方环为砖（可被打开）
    expect(loaded.terrain[11 * loaded.size + 12]).toBe(TerrainType.Brick);
  });
});

