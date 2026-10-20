import type { Dir } from './constants';
import type { SimEvent } from './types';

/** 房间状态机（技术路线 §1.1-4） */
export type RoomPhase = 'waiting' | 'countdown' | 'playing' | 'roundEnd';

/** 大厅成员（tankId 在开局后分配；AI 成员 connId = -1） */
export interface LobbyPlayer {
  connId: number;
  tankId: number;
  name: string;
  color: string;
  isBot: boolean;
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
  | { t: 'input'; mask: number };

// ---- S→C ----
export type S2CMessage =
  | { t: 'welcome'; connId: number }
  | { t: 'start'; map: string }
  | { t: 'lobbyState'; phase: RoomPhase; ownerConnId: number; secondsLeft: number | null; players: LobbyPlayer[] }
  | { t: 'snapshot'; tick: number; tanks: SnapshotTank[]; bullets: SnapshotBullet[]; powerups: SnapshotPowerup[]; baseAlive: boolean }
  | { t: 'event'; event: SimEvent }
  | { t: 'error'; message: string };