import { describe, expect, it } from 'vitest';
import { Room, type Conn } from '../server/room';
import type { LobbyPlayer, RoomPhase, S2CMessage, Snapshot } from '../shared/protocol';
import { INPUT_LEFT, TICK_RATE } from '../shared/constants';
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
  get phases(): RoomPhase[] {
    return this.sent.filter((m): m is LobbyMsg => m.t === 'lobbyState').map((m) => m.phase);
  }
}

function makeRoom(opts?: ConstructorParameters<typeof Room>[1]): { room: Room; a: FakeConn; b: FakeConn } {
  const room = new Room([makeMap([], TWO_SPAWNS)], { maxTanks: 2, ...opts });
  const a = new FakeConn(1);
  const b = new FakeConn(2);
  room.addConnection(a);
  room.addConnection(b);
  room.handleMessage(1, { t: 'join', name: '  Alice ' });
  room.handleMessage(2, { t: 'join', name: 'Bob' });
  return { room, a, b };
}

function startPlaying(room: Room, steps = 3 * TICK_RATE): void {
  room.handleMessage(1, { t: 'start' });
  for (let i = 0; i < steps; i++) room.step();
}

describe('L2 集成：join 与大厅（IT-01）', () => {
  it('join 后广播 lobbyState，先加入者为房主，昵称被 trim', () => {
    const { room, a, b } = makeRoom();
    expect(room.phase).toBe('waiting');
    const lobby = a.last('lobbyState')!;
    expect(lobby.ownerConnId).toBe(1);
    expect(lobby.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(b.last('lobbyState')).toBeTruthy(); // 广播到所有成员
    expect(a.last('welcome')).toMatchObject({ t: 'welcome', connId: 1 });
  });

  it('房间满时拒绝加入并回 error', () => {
    const room = new Room([makeMap([], TWO_SPAWNS)], { maxTanks: 2 });
    const a = new FakeConn(1);
    const b = new FakeConn(2);
    const c = new FakeConn(3);
    room.addConnection(a);
    room.addConnection(b);
    room.addConnection(c);
    room.handleMessage(1, { t: 'join', name: 'A' });
    room.handleMessage(2, { t: 'join', name: 'B' });
    room.handleMessage(3, { t: 'join', name: 'C' }); // 已满（M2 上限 2）
    expect(c.last('error')).toMatchObject({ t: 'error', message: '房间已满' });
    expect(room.ownerConnId()).toBe(1);
  });
});

describe('L2 集成：开局与快照同步（IT-02/03）', () => {
  it('非房主无法开局；房主开局经倒计时进入对局', () => {
    const { room, a } = makeRoom();
    room.handleMessage(2, { t: 'start' });
    expect(room.phase).toBe('waiting');
    room.handleMessage(1, { t: 'start' });
    expect(room.phase).toBe('countdown');
    expect(a.phases[a.phases.length - 1]).toBe('countdown');
    for (let i = 0; i < 3 * TICK_RATE; i++) room.step();
    expect(room.phase).toBe('playing');
  });

  it('对局中快照按 tick 下发，输入驱动坦克移动', () => {
    const { room, b } = makeRoom();
    startPlaying(room);
    expect(room.phase).toBe('playing');
    room.handleMessage(2, { t: 'input', mask: INPUT_LEFT });
    for (let i = 0; i < 60; i++) room.step();
    const snaps = b.snapshots;
    expect(snaps.length).toBe(60);
    const tank1 = snaps[snaps.length - 1]!.tanks.find((t) => t.id === 1)!;
    // B 出生在 (320,0)，向左移动 60 tick × 1.5px = 90px，第 0 行无障碍
    expect(tank1.x).toBe(320 - 90);
    expect(tank1.moving).toBe(true);
  });

  it('人数不足时 AI 补位并参与行动', () => {
    const room = new Room([makeMap([], TWO_SPAWNS)], { seed: 7, maxTanks: 2 });
    const a = new FakeConn(1);
    room.addConnection(a);
    room.handleMessage(1, { t: 'join', name: 'Solo' });
    startPlaying(room);
    expect(room.phase).toBe('playing');
    const players: LobbyPlayer[] = a.last('lobbyState')!.players;
    expect(players.filter((p) => p.isBot).length).toBe(1);
    for (let i = 0; i < 120; i++) room.step();
    const botTank = a.snapshots[a.snapshots.length - 1]!.tanks.find((t) => t.id === 1)!;
    expect(botTank.x !== 320 || botTank.y !== 0).toBe(true); // AI 在 120 tick 内产生了位移
  });
});

describe('L2 集成：回合结束与断线（IT-05/06）', () => {
  it('限时耗尽进入结算，倒计时后回 Waiting 可再来一局', () => {
    const { room, a } = makeRoom({ timeTicks: 120 });
    startPlaying(room);
    for (let i = 0; i < 121; i++) room.step();
    expect(room.phase).toBe('roundEnd');
    expect(a.last('event')!.event.type).toBe('gameOver');
    for (let i = 0; i < 5 * TICK_RATE; i++) room.step();
    expect(room.phase).toBe('waiting');
    expect(a.last('lobbyState')!.players.every((p) => p.tankId === -1)).toBe(true);
    // 可再次开局
    room.handleMessage(1, { t: 'start' });
    expect(room.phase).toBe('countdown');
  });

  it('对局中断线：坦克由 AI 托管、成员标记离线，服务器不崩溃（FR-N4）', () => {
    const { room, a } = makeRoom();
    startPlaying(room);
    room.handleMessage(2, { t: 'input', mask: INPUT_LEFT });
    room.removeConnection(2);
    const lobby = a.last('lobbyState')!;
    const bob = lobby.players.find((p) => p.name === 'Bob')!;
    expect(bob.isBot).toBe(true); // P2 修复：托管成员合并为单条「托管」记录
    expect(bob.online).toBe(false); // 成员保留（60s 内可重连）
    expect(lobby.players.filter((p) => p.name === 'Bob').length).toBe(1);
    expect(room.ownerConnId()).toBe(1);
    for (let i = 0; i < 60; i++) room.step(); // 对局继续，托管 AI 驱动其坦克
    expect(room.phase).toBe('playing');
  });
});

describe('L2 集成：非法消息与快照契约（IT-08）', () => {
  it('未知消息类型 / 未加入连接的输入均被忽略', () => {
    const { room } = makeRoom();
    expect(() => room.handleMessage(1, { t: 'bogus' } as never)).not.toThrow();
    expect(() => room.handleMessage(99, { t: 'input', mask: 31 })).not.toThrow();
    expect(room.phase).toBe('waiting');
  });

  it('快照包含全部坦克与字段', () => {
    const { room, a } = makeRoom();
    startPlaying(room);
    room.handleMessage(2, { t: 'input', mask: INPUT_LEFT });
    room.step();
    const s: Snapshot = a.snapshots[a.snapshots.length - 1]!;
    expect(s.tanks.length).toBe(2);
    for (const t of s.tanks) {
      for (const key of ['id', 'x', 'y', 'dir', 'moving', 'alive', 'shieldTicks', 'respawnTicks', 'score', 'kills'] as const) {
        expect(t).toHaveProperty(key);
      }
    }
  });
});

