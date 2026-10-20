import { BotController } from '../shared/sim/bot';
import { BattleSim, PALETTE } from '../shared/sim/sim';
import { ROUND_TICKS_DEFAULT, SCORE_CAP_DEFAULT, TICK_RATE } from '../shared/constants';
import { mulberry32 } from '../shared/rng';
import type { MapDef, PlayerDef } from '../shared/types';
import type { C2SMessage, LobbyPlayer, RoomPhase, S2CMessage } from '../shared/protocol';

export type { RoomPhase };

/** 服务器侧连接抽象（index.ts 用 ws 实现；测试注入 fake） */
export interface Conn {
  readonly id: number;
  send(msg: S2CMessage): void;
}

export interface RoomOptions {
  seed?: number;
  scoreCap?: number;
  timeTicks?: number;
  /** 总坦克数（真人 + AI 合计）；M2 默认 2 */
  maxTanks?: number;
  /** 道具刷新间隔 tick（测试可缩短） */
  powerupInterval?: number;
}

interface Member {
  connId: number;
  name: string;
  color: string;
  /** 开局后分配；waiting 期间为 -1 */
  tankId: number;
}

const COUNTDOWN_TICKS = 3 * TICK_RATE;
const ROUNDEND_TICKS = 5 * TICK_RATE;
const DEFAULT_SEED = 20261019;

/**
 * 房间状态机（技术路线 §1.1-4）：Waiting → Countdown → Playing → RoundEnd → Waiting…
 * tick 由外部循环（gameLoop）驱动，step() 每次推进一帧。
 * 先加入者为房主；开局时真人优先、AI 补位至总坦克数上限；地图按局轮换。
 */
export class Room {
  phase: RoomPhase = 'waiting';
  private readonly conns = new Map<number, Conn>();
  private readonly members = new Map<number, Member>();
  private sim: BattleSim | null = null;
  private bots: BotController[] = [];
  private phaseTicks = 0;
  private mapIndex = 0;

  constructor(
    private readonly maps: MapDef[],
    private readonly opts: RoomOptions = {},
  ) {}

  private get maxTanks(): number {
    return this.opts.maxTanks ?? 2;
  }

  /** 房主 = 当前成员中 connId 最小者 */
  ownerConnId(): number {
    let min = -1;
    for (const id of this.members.keys()) {
      if (min === -1 || id < min) min = id;
    }
    return min;
  }

  addConnection(conn: Conn): void {
    this.conns.set(conn.id, conn);
  }

  removeConnection(connId: number): void {
    this.conns.delete(connId);
    const member = this.members.get(connId);
    if (!member) return;
    this.members.delete(connId);
    // 对局中：断线玩家坦克输入清零（AI 托管在 M4 实现，FR-N4）
    if (this.sim && member.tankId >= 0) this.sim.setInput(member.tankId, 0);
    this.broadcastLobby();
  }

  handleMessage(connId: number, msg: C2SMessage): void {
    switch (msg.t) {
      case 'join': this.join(connId, msg.name); break;
      case 'start': this.start(connId); break;
      case 'input': this.applyInput(connId, msg.mask); break;
      default: break; // 未知消息忽略，服务器不崩溃（IT-08）
    }
  }

  /** 推进一帧（由 60Hz tick 循环调用） */
  step(): void {
    if (this.phase === 'countdown') {
      this.phaseTicks--;
      if (this.phaseTicks % 30 === 0 || this.phaseTicks <= 0) this.broadcastLobby();
      if (this.phaseTicks <= 0) {
        this.phase = 'playing';
        this.broadcastLobby();
      }
    } else if (this.phase === 'playing') {
      const sim = this.sim!;
      for (const bot of this.bots) sim.setInput(bot.tankId, bot.update());
      sim.step();
      this.broadcastSnapshot();
      for (const e of sim.drainEvents()) this.broadcast({ t: 'event', event: e });
      if (sim.gameOver) {
        this.phase = 'roundEnd';
        this.phaseTicks = ROUNDEND_TICKS;
        this.broadcastLobby();
      }
    } else if (this.phase === 'roundEnd') {
      this.phaseTicks--;
      if (this.phaseTicks % 60 === 0 || this.phaseTicks <= 0) this.broadcastLobby();
      if (this.phaseTicks <= 0) {
        this.phase = 'waiting';
        this.sim = null;
        this.bots = [];
        for (const m of this.members.values()) m.tankId = -1;
        this.broadcastLobby();
      }
    }
  }

  // ---------------------------------------------------------------- 内部

  private join(connId: number, rawName: string): void {
    if (this.members.has(connId)) return;
    if (this.members.size >= this.maxTanks) {
      this.conns.get(connId)?.send({ t: 'error', message: '房间已满' });
      return;
    }
    const name = rawName.trim().slice(0, 12) || `玩家${connId}`; // 昵称校验（NFR-6）
    const color = PALETTE[this.members.size % PALETTE.length]!;
    this.members.set(connId, { connId, name, color, tankId: -1 });
    this.conns.get(connId)?.send({ t: 'welcome', connId });
    this.broadcastLobby();
  }

  private start(connId: number): void {
    if (this.phase !== 'waiting' && this.phase !== 'roundEnd') return;
    if (connId !== this.ownerConnId() || this.members.size === 0) return;

    const seed = this.opts.seed ?? DEFAULT_SEED;
    const mapDef = this.maps[this.mapIndex % this.maps.length]!;
    this.mapIndex++;
    const humans = [...this.members.values()].sort((a, b) => a.connId - b.connId);
    const playerDefs: PlayerDef[] = humans.map((m) => ({ name: m.name, isBot: false, color: m.color }));
    while (playerDefs.length < this.maxTanks) {
      const i = playerDefs.length;
      playerDefs.push({ name: `Bot-${i}`, isBot: true, color: PALETTE[i % PALETTE.length]! });
    }

    this.sim = new BattleSim(mapDef, playerDefs, {
      seed,
      scoreCap: this.opts.scoreCap ?? SCORE_CAP_DEFAULT,
      timeTicks: this.opts.timeTicks ?? ROUND_TICKS_DEFAULT,
      powerupInterval: this.opts.powerupInterval,
    });
    this.bots = [];
    humans.forEach((m, i) => { m.tankId = i; });
    for (let i = humans.length; i < playerDefs.length; i++) {
      this.bots.push(new BotController(this.sim, i, mulberry32(seed + i * 7919), 'normal'));
    }
    this.phase = 'countdown';
    this.phaseTicks = COUNTDOWN_TICKS;
    this.broadcast({ t: 'start', map: mapDef.name });
    this.broadcastLobby();
  }

  private applyInput(connId: number, mask: number): void {
    const member = this.members.get(connId);
    if (this.sim && member && member.tankId >= 0) {
      this.sim.setInput(member.tankId, mask & 0xff);
    }
  }

  private broadcast(msg: S2CMessage): void {
    for (const conn of this.conns.values()) conn.send(msg);
  }

  private broadcastLobby(): void {
    const players: LobbyPlayer[] = [...this.members.values()]
      .sort((a, b) => a.connId - b.connId)
      .map((m) => ({ connId: m.connId, tankId: m.tankId, name: m.name, color: m.color, isBot: false }));
    if (this.sim) {
      for (const t of this.sim.tanks) {
        if (t.isBot) players.push({ connId: -1, tankId: t.id, name: t.name, color: t.color, isBot: true });
      }
    }
    this.broadcast({
      t: 'lobbyState',
      phase: this.phase,
      ownerConnId: this.ownerConnId(),
      secondsLeft: this.phase === 'countdown' || this.phase === 'roundEnd'
        ? Math.ceil(this.phaseTicks / TICK_RATE)
        : null,
      players,
    });
  }

  private broadcastSnapshot(): void {
    const sim = this.sim!;
    this.broadcast({
      t: 'snapshot',
      tick: sim.tick,
      tanks: sim.tanks.map((t) => ({
        id: t.id, x: t.x, y: t.y, dir: t.dir, moving: t.moving, alive: t.alive,
        shieldTicks: t.shieldTicks, respawnTicks: t.respawnTicks, level: t.level, frozenTicks: t.frozenTicks,
        score: t.score, kills: t.kills,
      })),
      bullets: sim.bullets.map((b) => ({ id: b.id, ownerId: b.ownerId, dir: b.dir, x: b.x, y: b.y })),
      powerups: sim.powerups.map((p) => ({ id: p.id, type: p.type, x: p.x, y: p.y })),
      baseAlive: sim.baseAlive,
    });
  }
}