import { describe, expect, it } from 'vitest';
import { Room, type Conn } from '../server/room';
import { BattleSim } from '../shared/sim/sim';
import { BOT_SPEED_BY_DIFFICULTY } from '../shared/sim/bot';
import { INPUT_FIRE, INPUT_UP, TICK_RATE } from '../shared/constants';
import type { S2CMessage } from '../shared/protocol';
import { makeMap, TWO_SPAWNS } from './helpers';

type SnapshotMsg = Extract<S2CMessage, { t: 'snapshot' }>;

class FakeConn implements Conn {
  readonly sent: S2CMessage[] = [];
  constructor(readonly id: number) {}
  send(msg: S2CMessage): void { this.sent.push(msg); }
  last<T extends S2CMessage['t']>(t: T): Extract<S2CMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m): m is Extract<S2CMessage, { t: T }> => m.t === t);
  }
  get snapshots(): SnapshotMsg[] {
    return this.sent.filter((m): m is SnapshotMsg => m.t === 'snapshot');
  }
}

describe('M5：AI 速度档位（参数对照表 §2）', () => {
  it('三档速度按 BOT_SPEED_BY_DIFFICULTY 生效', () => {
    const mapDef = makeMap([], [{ x: 4, y: 24 }, { x: 20, y: 0 }, { x: 12, y: 12 }]);
    const run = (speed: number): number => {
      const sim = new BattleSim(mapDef, [{ name: 'A' }, { name: 'B' }, { name: 'C', isBot: true, speed }], { seed: 42 });
      // 第 3 辆为受测坦克：空地图上持续向上移动
      sim.tanks[0]!.alive = false;
      sim.tanks[1]!.alive = false;
      sim.tanks[2]!.x = 192;
      sim.tanks[2]!.y = 384;
      sim.tanks[2]!.dir = 0; // Up
      sim.tanks[2]!.shieldTicks = 0;
      sim.setInput(2, INPUT_UP);
      for (let i = 0; i < 30; i++) sim.step();
      return 384 - sim.tanks[2]!.y;
    };
    const easy = run(BOT_SPEED_BY_DIFFICULTY.easy);
    const hard = run(BOT_SPEED_BY_DIFFICULTY.hard);
    expect(easy).toBeCloseTo(0.75 * 30, 3);
    expect(hard).toBeCloseTo(1.5 * 30, 3);
    expect(hard).toBeGreaterThan(easy);
  });

  it('未指定速度的玩家坦克保持 TANK_SPEED', () => {
    const sim = new BattleSim(makeMap([], TWO_SPAWNS), [{ name: 'A' }]);
    expect(sim.tanks[0]!.speed).toBe(1.5);
  });
});

describe('M5：闪红 AI 掉落（FR-P 适配）', () => {
  it('闪红坦克被击毁时原地掉落随机道具', () => {
    // 同列布置：A(64,384) 朝上开火，B(64,192) 为闪红坦克
    const mapDef = makeMap([], [{ x: 4, y: 24 }, { x: 4, y: 12 }]);
    const sim = new BattleSim(mapDef, [{ name: 'A' }, { name: 'B', isBot: true, bonus: true }], { seed: 7 });
    const victim = sim.tanks[1]!;
    victim.shieldTicks = 0; // 跳过出生护盾
    sim.setInput(0, INPUT_FIRE);
    for (let i = 0; i < 60 && sim.powerups.length === 0; i++) sim.step();
    expect(sim.powerups.length).toBe(1);
    expect(sim.powerups[0]!.x).toBe(victim.x);
    expect(sim.powerups[0]!.y).toBe(victim.y);
  });

  it('普通坦克被击毁不掉落', () => {
    const mapDef = makeMap([], [{ x: 4, y: 24 }, { x: 4, y: 12 }]);
    const sim = new BattleSim(mapDef, [{ name: 'A' }, { name: 'B' }], { seed: 7 });
    sim.tanks[1]!.shieldTicks = 0;
    sim.setInput(0, INPUT_FIRE);
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.powerups.length).toBe(0);
  });

  it('掉落点已有道具时跳过（不重叠）', () => {
    const mapDef = makeMap([], [{ x: 4, y: 24 }, { x: 4, y: 12 }]);
    mapDef.powerupSpots = [{ x: 4, y: 12 }]; // 与闪红坦克位置相同的定点刷新点
    const sim = new BattleSim(mapDef, [{ name: 'A' }, { name: 'B', isBot: true, bonus: true }], { seed: 7, powerupInterval: 1 });
    sim.tanks[1]!.shieldTicks = 0;
    sim.setInput(0, INPUT_FIRE);
    // 第 1 tick 定点刷新在 (64,192)，随后击毁的掉落应被跳过 → 始终只有 1 个道具
    for (let i = 0; i < 60; i++) sim.step();
    expect(sim.powerups.length).toBe(1);
  });
});

describe('M5：房主地图选择（FR-N3）', () => {
  function twoMapRoom(): { room: Room; a: FakeConn; b: FakeConn } {
    const mapA = makeMap([], TWO_SPAWNS);           // name 'test'
    const mapB = { ...makeMap([], TWO_SPAWNS), name: 'other' };
    const room = new Room([mapA, mapB], { maxTanks: 2 });
    const a = new FakeConn(1);
    const b = new FakeConn(2);
    room.addConnection(a);
    room.addConnection(b);
    room.handleMessage(1, { t: 'join', name: 'Alice' });
    room.handleMessage(2, { t: 'join', name: 'Bob' });
    return { room, a, b };
  }

  it('房主选定地图后按其开局；非房主设置无效', () => {
    const { room, a } = twoMapRoom();
    room.handleMessage(2, { t: 'config', map: 'other' }); // 非房主
    expect(a.last('lobbyState')!.selectedMap).toBeNull();

    room.handleMessage(1, { t: 'config', map: 'other' });
    expect(a.last('lobbyState')!.selectedMap).toBe('other');

    room.handleMessage(1, { t: 'start' });
    expect(a.last('start')!.map).toBe('other');
  });

  it('非法地图名回落随机轮换（selectedMap = null）', () => {
    const { room, a } = twoMapRoom();
    room.handleMessage(1, { t: 'config', map: 'not-exist' });
    expect(a.last('lobbyState')!.selectedMap).toBeNull();
    room.handleMessage(1, { t: 'start' });
    expect(['test', 'other']).toContain(a.last('start')!.map);
  });

  it('显式选择 null 恢复随机轮换', () => {
    const { room, a } = twoMapRoom();
    room.handleMessage(1, { t: 'config', map: 'other' });
    room.handleMessage(1, { t: 'config', map: null });
    expect(a.last('lobbyState')!.selectedMap).toBeNull();
  });
});

describe('M5：快照闪红字段', () => {
  it('快照坦克携带 bonus 布尔字段', () => {
    const room = new Room([makeMap([], TWO_SPAWNS)], { maxTanks: 2 });
    const a = new FakeConn(1);
    room.addConnection(a);
    room.handleMessage(1, { t: 'join', name: 'Alice' });
    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE + 5; i++) room.step();
    const snap = a.snapshots[a.snapshots.length - 1]!;
    expect(snap.tanks.length).toBeGreaterThan(0);
    for (const t of snap.tanks) expect(typeof t.bonus).toBe('boolean');
  });
});

