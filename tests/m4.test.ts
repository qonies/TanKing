import { describe, expect, it } from 'vitest';
import { Room, type Conn } from '../server/room';
import { loadMap } from '../shared/map/loader';
import { BotController } from '../shared/sim/bot';
import { BattleSim } from '../shared/sim/sim';
import { TICK_RATE } from '../shared/constants';
import { mulberry32 } from '../shared/rng';
import type { S2CMessage } from '../shared/protocol';
import { makeMap, TWO_SPAWNS } from './helpers';

type SnapshotMsg = Extract<S2CMessage, { t: 'snapshot' }>;
type LobbyMsg = Extract<S2CMessage, { t: 'lobbyState' }>;

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

describe('M4 修复：地图加载校验', () => {
  it('size 字段非法时抛错', () => {
    const def = { ...makeMap([], TWO_SPAWNS), size: 99 };
    expect(() => loadMap(def)).toThrow(/size/);
  });

  it('出生点越界时抛错', () => {
    expect(() => loadMap(makeMap([], [{ x: 99, y: 0 }]))).toThrow(/出生点越界/);
    expect(() => loadMap(makeMap([], [{ x: -1, y: 0 }]))).toThrow(/出生点越界/);
  });

  it('基地点位越界时抛错', () => {
    const def = { ...makeMap([], TWO_SPAWNS), base: { x: 30, y: 30 } };
    expect(() => loadMap(def)).toThrow(/基地/);
  });

  it('合法地图不受影响', () => {
    expect(() => loadMap(makeMap([], TWO_SPAWNS))).not.toThrow();
  });
});

describe('M4 修复：对局中禁止新玩家加入（防幽灵玩家）', () => {
  it('playing 阶段 join 被拒绝并回 error', () => {
    const { room, a } = joinedRoom();
    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE; i++) room.step();
    expect(room.phase).toBe('playing');
    const c = new FakeConn(3);
    room.addConnection(c);
    room.handleMessage(3, { t: 'join', name: 'Newbie' });
    expect(c.last('error')).toMatchObject({ t: 'error', message: '对局进行中，请等待下一局再加入' });
    expect(a.last('lobbyState')!.players.some((p) => p.name === 'Newbie')).toBe(false);
  });
});

describe('M4：断线托管与重连接管（FR-N4）', () => {
  it('断线成员 60s 内同名重连可接管原坦克', () => {
    const { room, b } = joinedRoom();
    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE; i++) room.step();
    expect(room.phase).toBe('playing');

    const obs = new FakeConn(5);
    room.addConnection(obs);
    room.removeConnection(1); // 房主断线 → AI 托管
    expect(room.ownerConnId()).toBe(2); // Bob 仍在线，成为房主
    for (let i = 0; i < 120; i++) room.step(); // 托管期间坦克仍被驱动
    const hosted = b.snapshots[b.snapshots.length - 1]!.tanks.find((t) => t.id === 0)!;
    expect(hosted.x !== 64 || hosted.y !== 384).toBe(true); // AI 在驱动该坦克
    // P2 修复：托管成员合并为单条「托管」记录；未加入的连接不再接收广播
    const lobbyAfterDisconnect = b.last('lobbyState')!;
    const aliceRow = lobbyAfterDisconnect.players.find((p) => p.name === 'Alice')!;
    expect(aliceRow.isBot).toBe(true);
    expect(aliceRow.online).toBe(false);
    expect(lobbyAfterDisconnect.players.filter((p) => p.name === 'Alice').length).toBe(1);
    expect(obs.sent.length).toBe(0);

    const a2 = new FakeConn(9);
    room.addConnection(a2);
    room.handleMessage(9, { t: 'join', name: 'Alice' }); // 同名重连
    expect(a2.last('welcome')).toMatchObject({ t: 'welcome', connId: 9 });
    const alice = a2.last('lobbyState')!.players.find((p) => p.name === 'Alice' && !p.isBot)!;
    expect(alice.online).toBe(true);
    expect(alice.tankId).toBe(0); // 接管原坦克
    expect(alice.connId).toBe(9);
    expect(room.ownerConnId()).toBe(2); // 房主仍是先加入的 Bob

    // 接管后真人输入恢复驱动（向左）
    const xBefore = b.snapshots[b.snapshots.length - 1]!.tanks.find((t) => t.id === 0)!.x;
    room.handleMessage(9, { t: 'input', mask: 4 }); // 4 = INPUT_LEFT
    for (let i = 0; i < 10; i++) room.step();
    const xAfter = a2.snapshots[a2.snapshots.length - 1]!.tanks.find((t) => t.id === 0)!.x;
    expect(xAfter).toBeLessThanOrEqual(xBefore);
  });

  it('断线超过 60s 判离场：成员移除，坦克继续由 AI 代打', () => {
    const { room, a } = joinedRoom();
    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE; i++) room.step();
    room.removeConnection(2);
    for (let i = 0; i < 60 * TICK_RATE + 5; i++) room.step();
    const lobby = a.last('lobbyState')!;
    expect(lobby.players.some((p) => p.name === 'Bob' && !p.isBot)).toBe(false); // 成员已移除
    expect(lobby.players.filter((p) => p.name === 'Bob').length).toBe(1); // 坦克仍在（AI 代打）
    expect(room.phase).toBe('playing');
  });

  it('结算回 waiting 时仍未归来的成员被移除', () => {
    const { room, a } = joinedRoom(2, { timeTicks: 60 * TICK_RATE });
    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE; i++) room.step();
    room.removeConnection(2);
    for (let i = 0; i < 60 * TICK_RATE + 5 * TICK_RATE + 1; i++) room.step(); // 超时 + 结算 5s
    expect(room.phase).toBe('waiting');
    expect(a.last('lobbyState')!.players.map((p) => p.name)).toEqual(['Alice']);
    expect(a.last('lobbyState')!.players.every((p) => p.tankId === -1)).toBe(true);
  });
});

describe('M4：房主配置（FR-N3）', () => {
  it('房主可设置坦克数与 AI 难度；非房主无效', () => {
    const { room, a } = joinedRoom(6);
    room.handleMessage(2, { t: 'config', maxTanks: 8, botDifficulty: 'hard' });
    let lobby: LobbyMsg = a.last('lobbyState')!;
    expect(lobby.maxTanks).toBe(6);
    expect(lobby.botDifficulty).toBe('normal');

    room.handleMessage(1, { t: 'config', maxTanks: 8, botDifficulty: 'hard' });
    lobby = a.last('lobbyState')!;
    expect(lobby.maxTanks).toBe(8);
    expect(lobby.botDifficulty).toBe('hard');

    room.handleMessage(1, { t: 'config', maxTanks: 99 }); // 越界夹取
    expect(a.last('lobbyState')!.maxTanks).toBe(8);
    room.handleMessage(1, { t: 'config', maxTanks: 1 });
    expect(a.last('lobbyState')!.maxTanks).toBe(2);
  });

  it('开局按配置补位 AI', () => {
    const { room, a } = joinedRoom(8);
    room.handleMessage(1, { t: 'config', botDifficulty: 'hard' });
    room.handleMessage(1, { t: 'start' });
    for (let i = 0; i < 3 * TICK_RATE + 10; i++) room.step();
    expect(room.phase).toBe('playing');
    expect(a.snapshots[a.snapshots.length - 1]!.tanks.length).toBe(8);
    expect(a.last('lobbyState')!.players.filter((p) => p.isBot).length).toBe(6);
  });
});

describe('M4：聊天（D4）', () => {
  it('聊天广播全房间；空文本与非成员被忽略', () => {
    const { room, a, b } = joinedRoom();
    room.handleMessage(1, { t: 'chat', text: '  大家好！  ' });
    expect(a.last('chat')).toMatchObject({ t: 'chat', from: 'Alice', text: '大家好！' });
    expect(b.last('chat')).toMatchObject({ t: 'chat', from: 'Alice', text: '大家好！' });

    room.handleMessage(1, { t: 'chat', text: '   ' });
    room.handleMessage(99, { t: 'chat', text: 'ghost' });
    expect(a.sent.filter((m) => m.t === 'chat').length).toBe(1);
  });
});

describe('M4：消息限流（NFR-6）', () => {
  it('每秒超限消息被丢弃，服务器不崩溃', () => {
    const { room, b } = joinedRoom();
    expect(() => {
      for (let i = 0; i < 300; i++) room.handleMessage(1, { t: 'chat', text: `spam ${i}` });
    }).not.toThrow();
    const chats = b.sent.filter((m) => m.t === 'chat');
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.length).toBeLessThanOrEqual(120);
  });
});

describe('M4：AI 三档难度（FR-A3）', () => {
  it('困难档 AI 无对枪机会时主动抢道具', () => {
    const mapDef = makeMap([], [{ x: 4, y: 24 }]);
    mapDef.powerupSpots = [{ x: 4, y: 20 }];
    const sim = new BattleSim(mapDef, [{ name: 'A' }], { seed: 7, powerupInterval: 1 });
    const bot = new BotController(sim, 0, mulberry32(7), 'hard');
    sim.step(); // tick 1：道具生成
    expect(sim.powerups.length).toBe(1);
    const startY = sim.tanks[0]!.y;
    for (let i = 0; i < 15; i++) {
      sim.setInput(0, bot.update());
      sim.step();
    }
    expect(sim.tanks[0]!.y).toBeCloseTo(startY - 22.5, 3); // 持续向道具移动（15 tick × 1.5px）
    expect(sim.tanks[0]!.x).toBe(64);
    expect(sim.powerups.length).toBe(1); // 尚未拾取
  });
});


