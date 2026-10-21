import type { Dir } from './constants';
import type { SimEvent } from './types';
import type { BotDifficulty } from './sim/bot';

/** 房间状态机（技术路线 §1.1-4） */
export type RoomPhase = 'waiting' | 'countdown' | 'playing' | 'roundEnd';

/** 大厅成员（tankId 在开局后分配；AI 成员 connId = -1；online=false 表示断线被 AI 托管） */
export interface LobbyPlayer {
  connId: number;
  tankId: number;
  name: string;
  color: string;
  isBot: boolean;
  online: boolean;
}

/** 快照实体（字段级精简，位置为像素浮点） */
export interface SnapshotTank {
  id: number;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  alive: boolean;
  shieldTicks: number;
  respawnTicks: number;
  level: number;
  frozenTicks: number;
  score: number;
  kills: number;
  deaths: number;
  /** 闪红坦克（M5）：击毁时掉落道具，客户端闪烁渲染 */
  bonus: boolean;
}

export interface RoundRank { tankId: number; score: number; kills: number; deaths: number }

/** 回合结算（roundEnd 阶段随 lobbyState 下发，FR-U4） */
export interface RoundResult {
  winnerId: number | null;
  ranks: RoundRank[];
}

export interface SnapshotBullet {
  id: number;
  ownerId: number;
  dir: Dir;
  x: number;
  y: number;
}

export interface SnapshotPowerup {
  id: number;
  type: number;
  x: number;
  y: number;
}

export interface Snapshot {
  tick: number;
  tanks: SnapshotTank[];
  bullets: SnapshotBullet[];
  powerups: SnapshotPowerup[];
  baseAlive: boolean;
}

// ---- C→S ----
export type C2SMessage =
  | { t: 'join'; name: string }
  | { t: 'start' }
  | { t: 'input'; mask: number }
  | { t: 'config'; maxTanks?: number; botDifficulty?: BotDifficulty; map?: string | null } // 房主设置（FR-N3；map 为 null/'' 表示随机轮换）
  | { t: 'chat'; text: string }; // 大厅聊天 / 游戏中快捷短语（D4）

// ---- S→C ----
export type S2CMessage =
  | { t: 'welcome'; connId: number }
  | { t: 'start'; map: string }
  | { t: 'lobbyState'; phase: RoomPhase; ownerConnId: number; secondsLeft: number | null; players: LobbyPlayer[]; maxTanks: number; botDifficulty: BotDifficulty;
      /** 房主选定的下一局地图（null = 随机轮换，M5 FR-N3） */
      selectedMap?: string | null;
      map?: string; terrain?: number[]; ticksLeft?: number | null; roundResult?: RoundResult | null }
  | { t: 'snapshot'; tick: number; tanks: SnapshotTank[]; bullets: SnapshotBullet[]; powerups: SnapshotPowerup[]; baseAlive: boolean }
  | { t: 'event'; event: SimEvent }
  | { t: 'chat'; from: string; color: string; text: string }
  | { t: 'error'; message: string };