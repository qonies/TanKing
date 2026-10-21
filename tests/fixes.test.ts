import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../server/http';
import { Room, type Conn } from '../server/room';
import { loadMap } from '../shared/map/loader';
import { BattleSim } from '../shared/sim/sim';
import { MAPS } from '../shared/maps';
import {
  Dir, INPUT_DOWN, INPUT_LEFT, INPUT_RIGHT, INPUT_UP, SHOVEL_TICKS, TICK_RATE,
} from '../shared/constants';
import { PowerupType, TerrainType, type MapDef } from '../shared/types';
import type { S2CMessage } from '../shared/protocol';
import { makeMap, makeSim, TWO_SPAWNS } from './helpers';

type LobbyMsg = Extract<S2CMessage, { t: 'lobbyState' }>;
type TerrainSetEvt = Extract<ReturnType<BattleSim['drainEvents']>[number], { type: 'terrainSet' }>;

class FakeConn implements Conn {
  readonly sent: S2CMessage[] = [];
  constructor(readonly id: number) {}
  send(msg: S2CMessage): void { this.sent.push(msg); }
  last<T extends S2CMessage['t']>(t: T): Extract<S2CMessage, { t: T }> | undefined {
    return [...this.sent].reverse().find((m): m is Extract<S2CMessage, { t: T }> => m.t === t);
  }
  get snapshots(): Extract<S2CMessage, { t: 'snapshot' }>[] {
    return this.sent.filter((m): m is Extract<S2CMessage, { t: 'snapshot' }> => m.t === 'snapshot');
  }
}

function joinedRoom(maxTanks = 2, opts: ConstructorParameters<typeof Room>[1] = {}): { room: Room; a: FakeConn; b: FakeConn } {
  const room = new Room([makeMap([], TWO_SPAWNS)], { maxTanks, ...opts });
  const a = new FakeConn(1);
  const b = new FakeConn(2);
  room.addConnection(a);
  room.addConnection(b);
  room.handleMessage(1, { t: 'join', name: 'Alice' });
  room.handleMessage(2, { t: 'join', name: 'Bob' });
  return { room, a, b };
}

function startPlaying(room: Room, steps = 3 * TICK_RATE): void {
  room.handleMessage(1, { t: 'start' });
  for (let i = 0; i < steps; i++) room.step();
}

// ---------------------------------------------------------------- P0

describe('P0 修复：出生点唯一分配', () => {
  for (const mapDef of MAPS) {
    it(`${mapDef.name}: 8 人开局位置唯一且坦克 0 可移动`, () => {
      const sim = new BattleSim(
        mapDef,
        Array.from({ length: 8 }, (_, i) => ({ name: `P${i}` })),
        { seed: 1 },
      );
      const positions = new Set(sim.tanks.map((t) => `${t.x},${t.y}`));
      expect(positions.size).toBe(8); // 不再多辆坦克重叠在同一出生点

      // 坦克 0 至少有一个方向可移动（不被重叠坦克/地形完全卡死）
      const tank = sim.tanks[0]!;
      const startX = tank.x;
      const startY = tank.y;
      let moved = false;
      for (const mask of [INPUT_UP, INPUT_DOWN, INPUT_LEFT, INPUT_RIGHT]) {
        tank.x = startX;
        tank.y = startY;
        sim.setInput(0, mask);
        for (let i = 0; i < 5; i++) sim.step();
        if (tank.x !== startX || tank.y !== startY) { moved = true; break; }
      }
      expect(moved).toBe(true);
    });
  }

  it('出生点不足时兜底扫描保证位置唯一（2 个出生点 + 6 人）', () => {
    const sim = new BattleSim(
      makeMap([], TWO_SPAWNS),
      Array.from({ length: 6 }, (_, i) => ({ name: `P${i}` })),
      { seed: 1 },
    );
    const positions = new Set(sim.tanks.map((t) => `${t.x},${t.y}`));
    expect(positions.size).toBe(6);
  });
});

describe('P0 修复：吸附碰撞校验（trySnap）', () => {
  function setupOverlap(): { sim: ReturnType<typeof makeSim>; a: ReturnType<typeof makeSim>['tanks'][number]; b: ReturnType<typeof makeSim>['tanks'][number] } {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    // 构造 A.x=92（未对齐）、B.x=124：吸附目标 96..128 与 B 的 124..156 重叠
    a.x = 92;
    a.dir = Dir.Right;
    b.x = 124;
    b.y = a.y;
    b.dir = Dir.Right;
    sim.setInput(1, INPUT_RIGHT); // B 保持移动（不会松开吸附自己挪走）
    return { sim, a, b };
  }

  it('松开吸附不会把坦克推进另一辆坦克', () => {
    const { sim, a, b } = setupOverlap();
    sim.step(); // A 松开、B 持续移动
    expect(a.x).toBe(92); // 吸附被拒绝（旧实现会叠进 B 后永久卡死）
    expect(b.x).toBe(125.5); // B 正常移动
  });

  it('吸附被拒绝后坦克仍可正常移动（不卡死）', () => {
    const { sim, a } = setupOverlap();
    sim.step();
    sim.setInput(0, INPUT_LEFT);
    sim.step();
    expect(a.x).toBeLessThan(92); // 转向吸附同样被挡，但移动本身不受影响
  });
});


// ---------------------------------------------------------------- P1

describe('P1 修复：炸弹尊重护盾（FR-T5）', () => {
  it('护盾期内坦克不会被炸弹击毁', () => {
    const sim = makeSim();
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    const applyBomb = (sim as unknown as { applyPowerup: (t: unknown, k: number, x: number, y: number) => void });

    b.shieldTicks = 300;
    applyBomb.applyPowerup(a, PowerupType.Bomb, 0, 0);
    expect(b.alive).toBe(true);
    expect(a.kills).toBe(0);

    b.shieldTicks = 0; // 护盾结束后仍会被击毁
    applyBomb.applyPowerup(a, PowerupType.Bomb, 0, 0);
    expect(b.alive).toBe(false);
    expect(a.kills).toBe(1);
  });
});

describe('P1 修复：铁锹地形事件（联机地形同步）', () => {
  it('激活与到期都下发 terrainSet 事件', () => {
    const mapDef = makeMap([], TWO_SPAWNS);
    mapDef.base = { x: 12, y: 12 };
    const sim = new BattleSim(mapDef, [{ name: 'A' }, { name: 'B' }], { seed: 1 });
    (sim as unknown as { activateShovel: () => void }).activateShovel();

    const setEvt = sim.drainEvents().find((e) => e.type === 'terrainSet') as TerrainSetEvt | undefined;
    expect(setEvt).toBeTruthy();
    expect(setEvt!.cells.length).toBeGreaterThan(0);
    expect(setEvt!.cells.every((c) => c.t === TerrainType.Steel)).toBe(true);

    for (let i = 0; i < SHOVEL_TICKS + 1; i++) sim.step(); // 到期恢复
    const restoreEvt = sim.drainEvents().find((e) => e.type === 'terrainSet') as TerrainSetEvt | undefined;
    expect(restoreEvt).toBeTruthy();
    expect(restoreEvt!.cells.every((c) => c.t === TerrainType.Empty)).toBe(true);
  });
});

describe('P1 修复：房主配置下限（防超员开局）', () => {
  it('maxTanks 不能低于当前成员数，开局人数与配置一致', () => {
    const room = new Room([makeMap([], TWO_SPAWNS)], { maxTanks: 6 });
    const a = new FakeConn(1);
    room.addConnection(a);
    room.handleMessage(1, { t: 'join', name: 'A' });
    for (const id of [2, 3, 4]) {
      const c = new FakeConn(id);
      room.addConnection(c);
      room.handleMessage(id, { t: 'join', name: `P${id}` });
    }
    room.handleMessage(1, { t: 'config', maxTanks: 2 }); // 试图调到 2（当前 4 人）
    const lobby = a.last('lobbyState') as LobbyMsg;
    expect(lobby.maxTanks).toBe(4); // 被夹取到当前成员数

    startPlaying(room, 3 * TICK_RATE + 10);
    const snap = a.snapshots[a.snapshots.length - 1]!;
    expect(snap.tanks.length).toBe(4); // 实际开局人数 == 配置上限
  });
});

describe('P1 修复：重连同步地图与地形', () => {
  it('重连时收到当前地图名与完整地形数组', () => {
    const rows = Array.from({ length: 26 }, () => '.'.repeat(26));
    rows[10] = 'B'.repeat(26);
    const mapDef: MapDef = { name: '重连测试图', size: 26, terrain: rows, spawns: TWO_SPAWNS, base: null };
    const room = new Room([mapDef], { maxTanks: 2 });
    const a = new FakeConn(1);
    room.addConnection(a);
    room.handleMessage(1, { t: 'join', name: 'Alice' });
    startPlaying(room);

    room.removeConnection(1);
    const a2 = new FakeConn(9);
    room.addConnection(a2);
    room.handleMessage(9, { t: 'join', name: 'Alice' });

    const lobby = a2.last('lobbyState') as LobbyMsg;
    expect(lobby.map).toBe('重连测试图');
    expect(lobby.terrain!.length).toBe(26 * 26);
    expect(lobby.terrain![10 * 26]).toBe(TerrainType.Brick); // 下发的是完整地形而非初始视图
    expect(lobby.phase).toBe('playing');
  });

  it('结算时下发 roundResult（胜者 + 排名）', () => {
    const { room, a } = joinedRoom(2, { timeTicks: 120 });
    startPlaying(room);
    for (let i = 0; i < 121; i++) room.step();
    expect(room.phase).toBe('roundEnd');
    const lobby = a.last('lobbyState') as LobbyMsg;
    expect(lobby.roundResult).toBeTruthy();
    expect(lobby.roundResult!.ranks.length).toBe(2);
    expect(lobby.roundResult!.ranks[0]!.score).toBeGreaterThanOrEqual(lobby.roundResult!.ranks[1]!.score);
  });
});

describe('P1 修复：广播范围与输入超时', () => {
  it('未加入的连接不接收任何广播', () => {
    const { room, a } = joinedRoom();
    const outsider = new FakeConn(7);
    room.addConnection(outsider);
    room.handleMessage(1, { t: 'chat', text: 'hello' });
    expect(a.last('chat')).toBeTruthy();
    expect(outsider.sent.length).toBe(0);
  });

  it('停止输入 1 秒后坦克停住（输入超时归零）', () => {
    const { room, b } = joinedRoom();
    startPlaying(room);
    room.handleMessage(2, { t: 'input', mask: INPUT_LEFT });
    for (let i = 0; i < 30; i++) room.step();
    const mid = b.snapshots[b.snapshots.length - 1]!.tanks.find((t) => t.id === 1)!;

    for (let i = 0; i < TICK_RATE + 20; i++) room.step(); // 超过 1s 无输入
    const stopped = b.snapshots[b.snapshots.length - 1]!.tanks.find((t) => t.id === 1)!;
    expect(stopped.x).toBeLessThan(mid.x); // 超时前仍在移动

    const frozen = stopped.x;
    for (let i = 0; i < 30; i++) room.step();
    const after = b.snapshots[b.snapshots.length - 1]!.tanks.find((t) => t.id === 1)!;
    expect(after.x).toBe(frozen); // 超时后不再移动
  });
});

// ---------------------------------------------------------------- P2

describe('P2 修复：地图加载校验', () => {
  it('出生点重复时抛错', () => {
    expect(() => loadMap(makeMap([], [{ x: 4, y: 24 }, { x: 4, y: 24 }]))).toThrow(/出生点重复/);
  });

  it('出生点落在实体地形上时抛错', () => {
    const rows = Array.from({ length: 26 }, () => '.'.repeat(26));
    rows[0] = 'B'.repeat(26);
    expect(() => loadMap(makeMap(rows, TWO_SPAWNS))).toThrow(/出生点.*实体地形/);
  });

  it('基地被地形覆盖时抛错', () => {
    const rows = Array.from({ length: 26 }, () => '.'.repeat(26));
    rows[10] = 'B'.repeat(26);
    const def = makeMap(rows, TWO_SPAWNS);
    def.base = { x: 0, y: 10 };
    expect(() => loadMap(def)).toThrow(/基地格/);
  });
});

describe('P2 修复：HTTP 服务健壮性', () => {
  const server = createHttpServer(fileURLToPath(new URL('../dist', import.meta.url)));
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('畸形 URL 返回 400；正常请求 200；路径逃逸不泄露外部文件', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const bad = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`); // 旧实现会抛 URIError 打崩进程
    expect(bad.status).toBe(400);

    const ok = await fetch(`http://127.0.0.1:${port}/`);
    expect(ok.status).toBe(200);

    const escaped = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
    expect([200, 404]).toContain(escaped.status); // 回落 index.html
    expect(await escaped.text()).not.toContain('"name"'); // 绝不读到 dist 之外
  });
});

