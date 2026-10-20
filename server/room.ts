import { BotController, type BotDifficulty } from '../shared/sim/bot';
import { BattleSim, PALETTE } from '../shared/sim/sim';
import { ROUND_TICKS_DEFAULT, SCORE_CAP_DEFAULT, TICK_RATE } from '../shared/constants';
import { mulberry32 } from '../shared/rng';
import type { MapDef, PlayerDef } from '../shared/types';
import type { C2SMessage, LobbyPlayer, RoomPhase, S2CMessage } from '../shared/protocol';

export type { RoomPhase };
export type { BotDifficulty };

/** 服务器侧连接抽象（index.ts 用 ws 实现；测试注入 fake） */
export interface Conn {
  readonly id: number;
  send(msg: S2CMessage): void;
}

export interface RoomOptions {
  seed?: number;
  scoreCap?: number;
  timeTicks?: number;
  /** 总坦克数（真人 + AI 合计），2~8；D3 默认 6，房主可运行时修改（FR-N3） */
  maxTanks?: number;
  /** AI 补位难度（FR-A3），房主可运行时修改 */
  botDifficulty?: BotDifficulty;
  /** 道具刷新间隔 tick（测试可缩短） */
  powerupInterval?: number;
}

interface Member {
  connId: number;
  name: string;
  color: string;
  /** 开局后分配；waiting 期间为 -1 */
  tankId: number;
  /** false = 对局中断线，坦克由 AI 托管（FR-N4） */
  online: boolean;
  /** 断线持续 tick 数（超时判离场） */
  offlineTicks: number;
}

const COUNTDOWN_TICKS = 3 * TICK_RATE;
const ROUNDEND_TICKS = 5 * TICK_RATE;
const DEFAULT_SEED = 20261019;
const MAX_TANKS_CAP = 8;                    // D3：总坦克数上限
const HOST_TIMEOUT_TICKS = 60 * TICK_RATE;  // FR-N4：断线 60s 未重连判离场
const MSG_RATE_LIMIT = 120;                 // NFR-6：每连接每秒消息上限

/**
 * 房间状态机（技术路线 §1.1-4）：Waiting → Countdown → Playing → RoundEnd → Waiting…
 * tick 由外部循环（gameLoop）驱动，step() 每次推进一帧。
 * 先加入者为房主；开局时真人优先、AI 补位至总坦克数上限；地图按局轮换。
 * M4：房主可配置人数/AI 难度（FR-N3）、大厅聊天（D4）、断线 AI 托管与重连接管（FR-N4）、
 * 输入消息限流（NFR-6）；对局中新玩家不可加入（防幽灵玩家）。
 */
export class Room {
  phase: RoomPhase = 'waiting';
  private readonly conns = new Map<number, Conn>();
  private readonly members = new Map<number, Member>();
  private sim: BattleSim | null = null;
  /** 补位 AI + 断线托管 AI，按 tankId 索引 */
  private bots = new Map<number, BotController>();
  private phaseTicks = 0;
  private mapIndex = 0;
  private totalTicks = 0;
  private msgWindow = -1;
  private readonly msgCounts = new Map<number, number>();
  private cfgMaxTanks: number | null = null;
  private cfgDifficulty: BotDifficulty | null = null;

  constructor(
    private readonly maps: MapDef[],
    private readonly opts: RoomOptions = {},
  ) {}

  private get maxTanks(): number {
    return this.cfgMaxTanks ?? this.opts.maxTanks ?? 6; // D3 默认 6
  }

  private get botDifficulty(): BotDifficulty {
    return this.cfgDifficulty ?? this.opts.botDifficulty ?? 'normal';
  }

  private get seed(): number {
    return this.opts.seed ?? DEFAULT_SEED;
  }

  /** 房主 = 在线成员中 connId 最小者 */
  ownerConnId(): number {
    let min = -1;
    for (const m of this.members.values()) {
      if (!m.online) continue;
      if (min === -1 || m.connId < min) min = m.connId;
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
    // FR-N4：对局中断线 → 成员保留、坦克 AI 托管，60s 内同名重连可接管
    if (this.sim && (this.phase === 'countdown' || this.phase === 'playing') && member.tankId >= 0) {
      member.online = false;
      member.offlineTicks = 0;
      this.hostBot(member.tankId);
      this.sim.setInput(member.tankId, 0);
    } else {
      this.members.delete(connId);
    }
    this.broadcastLobby();
  }

  handleMessage(connId: number, msg: C2SMessage): void {
    // NFR-6 消息限流：每连接每秒超限的消息静默丢弃（输入心跳 ~4/s，正常玩家不受影响）
    const window = Math.floor(this.totalTicks / TICK_RATE);
    if (window !== this.msgWindow) {
      this.msgWindow = window;
      this.msgCounts.clear();
    }
    const count = (this.msgCounts.get(connId) ?? 0) + 1;
    this.msgCounts.set(connId, count);
    if (count > MSG_RATE_LIMIT) return;

    switch (msg.t) {
      case 'join': this.join(connId, msg.name); break;
      case 'start': this.start(connId); break;
      case 'input': this.applyInput(connId, msg.mask); break;
      case 'config': this.configure(connId, msg.maxTanks, msg.botDifficulty); break;
      case 'chat': this.chat(connId, msg.text); break;
      default: break; // 未知消息忽略，服务器不崩溃（IT-08）
    }
  }

  /** 推进一帧（由 60Hz tick 循环调用） */
  step(): void {
    this.totalTicks++;
    if (this.phase === 'countdown') {
      this.phaseTicks--;
      if (this.phaseTicks % 30 === 0 || this.phaseTicks <= 0) this.broadcastLobby();
      if (this.phaseTicks <= 0) {
        this.phase = 'playing';
        this.broadcastLobby();
      }
    } else if (this.phase === 'playing') {
      const sim = this.sim!;
      for (const [tankId, bot] of this.bots) sim.setInput(tankId, bot.update());
      // FR-N4：断线成员超时判离场（成员移除，坦克继续由托管 AI 代打）
      for (const m of [...this.members.values()]) {
        if (!m.online && ++m.offlineTicks > HOST_TIMEOUT_TICKS) {
          this.members.delete(m.connId);
          this.broadcastLobby();
        }
      }
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
        this.bots.clear();
        for (const [cid, m] of this.members) {
          if (!m.online) this.members.delete(cid); // 结算时仍未归来的成员离场
          else { m.tankId = -1; m.offlineTicks = 0; }
        }
        this.broadcastLobby();
      }
    }
  }

  // ---------------------------------------------------------------- 内部

  private join(connId: number, rawName: string): void {
    const conn = this.conns.get(connId);
    if (!conn || this.members.has(connId)) return;
    const name = rawName.trim().slice(0, 12) || `玩家${connId}`; // 昵称校验（NFR-6）

    // 对局中仅允许断线成员同名重连接管（FR-N4）；其余拒绝，避免产生无坦克的幽灵玩家
    if (this.phase === 'countdown' || this.phase === 'playing') {
      const gone = [...this.members.values()].find((m) => !m.online && m.name === name && m.tankId >= 0);
      if (!gone) {
        conn.send({ t: 'error', message: '对局进行中，请等待下一局再加入' });
        return;
      }
      this.members.delete(gone.connId);
      gone.connId = connId;
      gone.online = true;
      gone.offlineTicks = 0;
      this.members.set(connId, gone);
      this.bots.delete(gone.tankId); // 撤销 AI 托管
      conn.send({ t: 'welcome', connId });
      this.broadcastLobby();
      return;
    }

    if (this.members.size >= this.maxTanks) {
      conn.send({ t: 'error', message: '房间已满' });
      return;
    }
    const color = PALETTE[this.members.size % PALETTE.length]!;
    this.members.set(connId, { connId, name, color, tankId: -1, online: true, offlineTicks: 0 });
    conn.send({ t: 'welcome', connId });
    this.broadcastLobby();
  }

  private start(connId: number): void {
    if (this.phase !== 'waiting' && this.phase !== 'roundEnd') return;
    if (connId !== this.ownerConnId() || this.members.size === 0) return;

    const seed = this.seed;
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
    this.bots.clear();
    humans.forEach((m, i) => {
      m.tankId = i;
      if (!m.online) this.hostBot(i); // 开局时已断线的成员直接托管
    });
    for (let i = humans.length; i < playerDefs.length; i++) {
      this.hostBot(i); // AI 补位（难度由房主配置，FR-A3/FR-N3）
    }
    this.phase = 'countdown';
    this.phaseTicks = COUNTDOWN_TICKS;
    this.broadcast({ t: 'start', map: mapDef.name });
    this.broadcastLobby();
  }

  /** 为某坦克创建 AI 控制器（补位或断线托管）；已存在则跳过 */
  private hostBot(tankId: number): void {
    if (this.sim && !this.bots.has(tankId)) {
      this.bots.set(tankId, new BotController(this.sim, tankId, mulberry32(this.seed + tankId * 104729), this.botDifficulty));
    }
  }

  /** 房主设置（FR-N3）：仅 waiting/roundEnd 阶段、仅房主可改 */
  private configure(connId: number, maxTanks?: number, difficulty?: BotDifficulty): void {
    if (this.phase !== 'waiting' && this.phase !== 'roundEnd') return;
    if (connId !== this.ownerConnId()) return;
    if (maxTanks !== undefined) {
      const n = Math.round(Number(maxTanks));
      if (Number.isFinite(n)) this.cfgMaxTanks = Math.min(MAX_TANKS_CAP, Math.max(2, n));
    }
    if (difficulty === 'easy' || difficulty === 'normal' || difficulty === 'hard') {
      this.cfgDifficulty = difficulty;
    }
    this.broadcastLobby();
  }

  /** 聊天（D4）：大厅文字聊天 / 游戏中快捷短语；成员限定、长度截断 */
  private chat(connId: number, text: string): void {
    const member = this.members.get(connId);
    if (!member || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 60);
    if (!trimmed) return;
    this.broadcast({ t: 'chat', from: member.name, color: member.color, text: trimmed });
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
      .map((m) => ({ connId: m.connId, tankId: m.tankId, name: m.name, color: m.color, isBot: false, online: m.online }));
    if (this.sim) {
      for (const t of this.sim.tanks) {
        // 补位 AI 与断线托管坦克均以 AI 身份展示
        if (t.isBot || this.bots.has(t.id)) {
          players.push({ connId: -1, tankId: t.id, name: t.name, color: t.color, isBot: true, online: true });
        }
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
      maxTanks: this.maxTanks,
      botDifficulty: this.botDifficulty,
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