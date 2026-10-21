import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../server/http';
import { startTickLoop } from '../server/gameLoop';
import { Room, type Conn } from '../server/room';
import { loadMap } from '../shared/map/loader';
import { BattleSim } from '../shared/sim/sim';
import { BotController } from '../shared/sim/bot';
import { MAPS } from '../shared/maps';
import { mulberry32 } from '../shared/rng';
import {
  CELL, Dir, INPUT_DOWN, INPUT_FIRE, INPUT_LEFT, INPUT_RIGHT, INPUT_UP, SHOVEL_TICKS, TICK_RATE,
} from '../shared/constants';
import { PowerupType, TerrainType, type MapDef } from '../shared/types';
import type { S2CMessage } from '../shared/protocol';
import { makeMap, makeSim, EMPTY_ROW, TWO_SPAWNS } from './helpers';

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
  // 自包含：不依赖 dist 构建产物（干净 checkout 上 npm test 也能通过）
  const distDir = mkdtempSync(join(tmpdir(), 'tanking-http-'));
  writeFileSync(join(distDir, 'index.html'), '<html><body>SPA</body></html>');
  writeFileSync(join(distDir, 'app.js'), 'console.log(1)');
  const server = createHttpServer(distDir);
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(distDir, { recursive: true, force: true });
  });

  it('畸形 URL 返回 400；正常请求 200；逃逸与缺失资源不泄露外部文件', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const get = async (p: string) => fetch(`http://127.0.0.1:${port}${p}`);

    const bad = await get('/%E0%A4%A'); // 旧实现会抛 URIError 打崩进程
    expect(bad.status).toBe(400);

    const ok = await get('/');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('SPA');

    const missingJs = await get('/missing.js');
    expect(missingJs.status).toBe(404); // 资源缺失不回落 SPA（避免 MIME 混淆）

    const escaped = await get('/..%2f..%2fpackage.json');
    expect(escaped.status).toBe(404); // 逃逸路径直接 404
    expect(await escaped.text()).not.toContain('"name"'); // 绝不读到目录之外
  });
});

// ---------------------------------------------------------------- 复审修复（2026-10-21）

/** 构造一次射击场景：坦克位于 (tankX, tankY) 朝 dir 开火，砖墙位于指定行/列 */
function fireSetup(
  dir: Dir, level: number, tankX: number, tankY: number,
  brickRows: number[], brickCols: number[],
): BattleSim {
  const rows = Array.from({ length: 26 }, () => EMPTY_ROW);
  for (const y of brickRows) {
    const r = [...rows[y]!];
    for (const x of brickCols) r[x] = 'B';
    rows[y] = r.join('');
  }
  const sim = new BattleSim(
    makeMap(rows, [{ x: Math.floor(tankX / CELL), y: Math.floor(tankY / CELL) }]),
    [{ name: 'A' }], { seed: 1 },
  );
  const a = sim.tanks[0]!;
  a.level = level;
  a.x = tankX;
  a.y = tankY;
  a.dir = dir;
  a.shieldTicks = 0;
  sim.setInput(0, INPUT_FIRE);
  sim.step();
  sim.setInput(0, 0);
  for (let i = 0; i < 30; i++) sim.step();
  return sim;
}

describe('修复：L3 砖墙四方向整大格摧毁（FR-M1，旧实现向右/向下完全无效）', () => {
  it('向右射击摧毁命中砖格所属的 2×2 大格', () => {
    const sim = fireSetup(Dir.Right, 3, 16 * CELL, 10 * CELL, [10, 11], [22, 23]);
    for (const [cx, cy] of [[22, 10], [23, 10], [22, 11], [23, 11]] as const) {
      expect(sim.terrainAt(cx, cy)).toBe(TerrainType.Empty);
    }
  });

  it('向下射击摧毁命中砖格所属的 2×2 大格', () => {
    const sim = fireSetup(Dir.Down, 3, 10 * CELL, 16 * CELL, [20, 21], [10, 11]);
    for (const [cx, cy] of [[10, 20], [11, 20], [10, 21], [11, 21]] as const) {
      expect(sim.terrainAt(cx, cy)).toBe(TerrainType.Empty);
    }
  });

  it('L0 行为不变：仅命中格损毁，深度之外保留', () => {
    const sim = fireSetup(Dir.Right, 0, 16 * CELL, 10 * CELL, [10, 11], [22, 23]);
    expect(sim.terrainAt(22, 10)).toBe(TerrainType.Empty);
    expect(sim.terrainAt(23, 10)).toBe(TerrainType.Brick);
  });
});

describe('修复：铁锹贴边基地不越界写地形（FR-P5）', () => {
  it('基地在左上角时只修改场内小格，到期恢复原状', () => {
    const def = makeMap(Array.from({ length: 26 }, () => EMPTY_ROW), [{ x: 4, y: 24 }]);
    def.base = { x: 0, y: 0 };
    const sim = new BattleSim(def, [{ name: 'A' }], { seed: 1 });
    const a = sim.tanks[0]!;
    sim.powerups.push({ id: 1, type: PowerupType.Shovel, x: a.x, y: a.y });
    sim.step();
    expect(sim.terrainAt(2, 0)).toBe(TerrainType.Steel);  // 场内环绕格生效
    expect(sim.terrainAt(25, 0)).toBe(TerrainType.Empty); // 场外小格不回绕写坏 row0 末列
    expect(sim.terrainAt(25, 1)).toBe(TerrainType.Empty);
    for (let i = 0; i < SHOVEL_TICKS; i++) sim.step();
    expect(sim.terrainAt(2, 0)).toBe(TerrainType.Empty); // 到期恢复
  });
});

describe('修复：FR-N3 回合规则与道具开关', () => {
  it('房主可配置积分上限 / 回合时长 / 道具开关并随 lobbyState 下发；快照携带 ticksLeft', () => {
    const { room, a } = joinedRoom(2);
    room.handleMessage(2, { t: 'config', scoreCap: 300 }); // 非房主无效
    expect(a.last('lobbyState')!.scoreCap).toBe(1000);

    room.handleMessage(1, { t: 'config', scoreCap: 300, roundMinutes: 2, powerups: false });
    const lobby = a.last('lobbyState')!;
    expect(lobby.scoreCap).toBe(300);
    expect(lobby.roundMinutes).toBe(2);
    expect(lobby.powerups).toBe(false);

    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE + 3; i++) room.step();
    const snap = a.snapshots[a.snapshots.length - 1]!;
    expect(typeof snap.ticksLeft).toBe('number');
    expect(snap.ticksLeft!).toBeLessThanOrEqual(2 * 60 * TICK_RATE);
    expect(snap.ticksLeft!).toBeGreaterThan(2 * 60 * TICK_RATE - 200);
  });

  it('道具开关关闭：无定点刷新、闪红不掉落', () => {
    const sim = new BattleSim(
      makeMap([], [{ x: 4, y: 24 }, { x: 4, y: 12 }]),
      [{ name: 'A' }, { name: 'B', isBot: true, bonus: true }],
      { seed: 7, powerupInterval: 1, powerups: false },
    );
    sim.tanks[1]!.shieldTicks = 0;
    sim.setInput(0, INPUT_FIRE);
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.powerups.length).toBe(0);
  });
});

describe('修复：loader 出生点/基地重叠校验', () => {
  it('出生点 2×2 矩形重叠时抛错', () => {
    expect(() => loadMap(makeMap([], [{ x: 4, y: 4 }, { x: 5, y: 4 }]))).toThrow(/重叠/);
  });

  it('出生点与基地重叠时抛错', () => {
    const def = makeMap([], [{ x: 4, y: 24 }]);
    def.base = { x: 4, y: 24 };
    expect(() => loadMap(def)).toThrow(/与基地重叠/);
  });
});

describe('修复：Room 输入与配置健壮性', () => {
  it('空地图数组直接抛配置错误', () => {
    expect(() => new Room([], { maxTanks: 2 })).toThrow(/地图/);
  });

  it('opts.maxTanks 越界被夹取到 2~8', () => {
    const room = new Room([makeMap([], TWO_SPAWNS)], { maxTanks: 99 });
    const a = new FakeConn(1);
    room.addConnection(a);
    room.handleMessage(1, { t: 'join', name: 'A' });
    expect(a.last('lobbyState')!.maxTanks).toBe(8);
  });

  it('非字符串昵称不崩溃并使用默认昵称', () => {
    const { room, a } = joinedRoom(3);
    const c = new FakeConn(3);
    room.addConnection(c);
    expect(() => room.handleMessage(3, { t: 'join', name: 42 as never })).not.toThrow();
    expect(a.last('lobbyState')!.players.some((p) => p.name === '玩家3')).toBe(true);
  });

  it('config 传 null 的 maxTanks 不生效', () => {
    const { room, a } = joinedRoom(2);
    room.handleMessage(1, { t: 'config', maxTanks: null as never });
    expect(a.last('lobbyState')!.maxTanks).toBe(2);
  });
});

describe('修复：gameLoop tick 异常容错（NFR-5）', () => {
  it('onTick 抛异常后循环继续推进（不再永久停摆）', async () => {
    let n = 0;
    const stop = startTickLoop(2, () => {
      n++;
      if (n === 3) throw new Error('boom');
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(n).toBeGreaterThan(5);
  });
});

describe('修复：AI 基地嗅探（FR-A2）', () => {
  it('困难档无敌人可追踪时逼近中立基地', () => {
    const def = makeMap(Array.from({ length: 26 }, () => EMPTY_ROW), [{ x: 4, y: 24 }]);
    def.base = { x: 12, y: 12 };
    const sim = new BattleSim(def, [{ name: 'Bot', isBot: true }], { seed: 7 });
    const bot = new BotController(sim, 0, mulberry32(7), 'hard');
    const base = sim.map.base!;
    const dist0 = Math.hypot(sim.tanks[0]!.x - base.x, sim.tanks[0]!.y - base.y);
    for (let i = 0; i < 600; i++) {
      sim.setInput(0, bot.update());
      sim.step();
      sim.drainEvents();
    }
    const t = sim.tanks[0]!;
    const dist1 = Math.hypot(t.x - base.x, t.y - base.y);
    expect(dist1).toBeLessThan(dist0 - 64);
  });
});

