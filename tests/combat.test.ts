import { describe, expect, it } from 'vitest';
import { BattleSim } from '../shared/sim/sim';
import { CELL, Dir, INPUT_DOWN, INPUT_FIRE, INPUT_UP, RESPAWN_TICKS, SCORE_KILL, SHIELD_TICKS } from '../shared/constants';
import { TerrainType } from '../shared/types';
import { EMPTY_ROW, makeSim } from './helpers';

/** A 在 (4,24) 出生点朝上，B 摆在正上方一格（贴脸） */
function faceToFace(sim: ReturnType<typeof makeSim>): void {
  const a = sim.tanks[0]!;
  const b = sim.tanks[1]!;
  a.x = 4 * CELL; a.y = 24 * CELL; a.dir = Dir.Up;
  b.x = 4 * CELL; b.y = 22 * CELL; b.dir = Dir.Down;
}

describe('子弹 vs 地形（FR-M1/M2/M3）', () => {
  it('砖墙按小格损毁（一次打掉 2 小格宽条带）', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[20] = '....BBBB..................'; // x 4..7，条带外 (6,20)/(7,20) 应保留为砖
    const sim = makeSim(rows);
    const a = sim.tanks[0]!;
    a.dir = Dir.Up; // 出生点 (64,384)，正上方是砖 (4,20)/(5,20)
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step(); // 只开一炮，避免持续补弹干扰断言
    sim.setInput(0, INPUT_UP);
    for (let i = 0; i < 39; i++) sim.step();
    expect(sim.terrainAt(4, 20)).toBe(TerrainType.Empty);
    expect(sim.terrainAt(5, 20)).toBe(TerrainType.Empty);
    expect(sim.terrainAt(6, 20)).toBe(TerrainType.Brick); // 条带外不受损
    expect(sim.terrainAt(7, 20)).toBe(TerrainType.Brick);
    expect(sim.bullets.length).toBe(0);
  });

  it('砖墙损毁深度仅 1 小格', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[19] = '....BB....................';
    rows[20] = '....BB....................';
    const sim = makeSim(rows);
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    sim.setInput(0, INPUT_UP);
    for (let i = 0; i < 39; i++) sim.step();
    expect(sim.terrainAt(4, 20)).toBe(TerrainType.Empty);
    expect(sim.terrainAt(4, 19)).toBe(TerrainType.Brick); // 更深的砖保留
  });

  it('钢墙挡弹且不损毁', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[20] = '....SS....................';
    const sim = makeSim(rows);
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    for (let i = 0; i < 40; i++) sim.step();
    expect(sim.terrainAt(4, 20)).toBe(TerrainType.Steel);
    expect(sim.terrainAt(5, 20)).toBe(TerrainType.Steel);
    expect(sim.bullets.length).toBe(0);
  });

  it('子弹穿越水面（FR-M3）', () => {
    const rows = Array(26).fill(EMPTY_ROW) as string[];
    rows[10] = '..........WWWW............';
    const sim = makeSim(rows);
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    let crossed = false;
    for (let i = 0; i < 60; i++) {
      sim.step();
      if (sim.bullets.some((b) => b.y < 10 * CELL)) crossed = true;
    }
    expect(crossed).toBe(true);
  });
});

describe('子弹互消与击杀计分（FR-T2、D1）', () => {
  it('对射的子弹相互抵消', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    a.x = 4 * CELL; a.y = 20 * CELL; a.dir = Dir.Up;
    b.x = 4 * CELL; b.y = 4 * CELL; b.dir = Dir.Down;
    a.shieldTicks = 0; b.shieldTicks = 0;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.setInput(1, INPUT_DOWN | INPUT_FIRE);
    let cancelled = false;
    for (let i = 0; i < 50; i++) {
      sim.step();
      if (sim.bullets.length === 0) { cancelled = true; break; }
    }
    expect(cancelled).toBe(true);
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
  });

  it('击毁对手 +100 分，2 秒后带护盾重生', () => {
    const sim = makeSim();
    faceToFace(sim);
    sim.tanks[1]!.shieldTicks = 0;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    expect(b.alive).toBe(false);
    expect(a.score).toBe(SCORE_KILL);
    expect(a.kills).toBe(1);
    expect(b.deaths).toBe(1);

    for (let i = 0; i < RESPAWN_TICKS; i++) sim.step();
    expect(b.alive).toBe(true);
    expect(b.shieldTicks).toBe(SHIELD_TICKS);
    expect(b.score).toBe(0); // 被击毁不扣分
  });

  it('护盾期免疫击毁（FR-T5）', () => {
    const sim = makeSim();
    faceToFace(sim); // B 刚出生自带护盾
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    expect(sim.tanks[1]!.alive).toBe(true);
    expect(sim.tanks[0]!.score).toBe(0);
  });

  it('击杀事件包含双方 id 与位置', () => {
    const sim = makeSim();
    faceToFace(sim);
    sim.tanks[1]!.shieldTicks = 0;
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    sim.step();
    const events = sim.drainEvents();
    const kill = events.find((e) => e.type === 'kill');
    expect(kill).toMatchObject({ type: 'kill', killerId: 0, victimId: 1 });
  });

  it('同屏弹量限制为 1（M1 等级 L0）', () => {
    const sim = makeSim();
    sim.setInput(0, INPUT_UP | INPUT_FIRE);
    for (let i = 0; i < 10; i++) sim.step();
    expect(sim.bullets.filter((b) => b.ownerId === 0).length).toBe(1);
  });
});

describe('回合胜负（D1：积分制）', () => {
  it('达到积分上限立即结束，胜者为先达者', () => {
    const s = new BattleSim(
      { name: 't', size: 26, terrain: Array(26).fill(EMPTY_ROW), spawns: [{ x: 4, y: 24 }, { x: 20, y: 0 }], base: null },
      [{ name: 'A' }, { name: 'B' }],
      { seed: 42, scoreCap: 100 },
    );
    faceToFace(s);
    s.tanks[1]!.shieldTicks = 0;
    s.setInput(0, INPUT_UP | INPUT_FIRE);
    s.step();
    expect(s.gameOver).toBe(true);
    expect(s.winnerId).toBe(0);
    // 结束后 step 不再推进
    const tick = s.tick;
    s.step();
    expect(s.tick).toBe(tick);
  });

  it('限时耗尽按积分最高者获胜', () => {
    const s = new BattleSim(
      { name: 't', size: 26, terrain: Array(26).fill(EMPTY_ROW), spawns: [{ x: 4, y: 24 }, { x: 20, y: 0 }], base: null },
      [{ name: 'A' }, { name: 'B' }],
      { seed: 42, timeTicks: 600 },
    );
    s.tanks[0]!.score = 500;
    s.tanks[1]!.score = 300;
    for (let i = 0; i < 601; i++) s.step();
    expect(s.gameOver).toBe(true);
    expect(s.winnerId).toBe(0);
  });

  it('积分相同则平局', () => {
    const s = new BattleSim(
      { name: 't', size: 26, terrain: Array(26).fill(EMPTY_ROW), spawns: [{ x: 4, y: 24 }, { x: 20, y: 0 }], base: null },
      [{ name: 'A' }, { name: 'B' }],
      { seed: 42, timeTicks: 100 },
    );
    for (let i = 0; i < 101; i++) s.step();
    expect(s.gameOver).toBe(true);
    expect(s.winnerId).toBe(null);
  });
});
