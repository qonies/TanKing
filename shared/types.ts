import type { Dir } from './constants';

// ---- 地形 ----
export const TerrainType = {
  Empty: 0,
  Brick: 1,
  Steel: 2,
  Water: 3,
  Trees: 4,
  Ice: 5,
} as const;
export type TerrainType = (typeof TerrainType)[keyof typeof TerrainType];

// ---- 地图定义（maps/*.json）----
/** 出生点/道具点坐标，单位为小格（16px），运行时 × CELL 折算为像素 */
export interface PointDef { x: number; y: number }

export interface MapDef {
  name: string;
  size: number;              // 小格数（26）
  terrain: string[];         // 字符矩阵：. 空 B 砖 S 钢 W 水 T 树 I 冰
  spawns: PointDef[];
  base?: PointDef | null;    // 全局唯一中立基地（M3 生效）
  powerupSpots?: PointDef[]; // 道具刷新点（M3 生效）
}

export interface LoadedMap {
  name: string;
  size: number;
  terrain: Uint8Array;       // size×size
  spawns: { x: number; y: number }[]; // 像素坐标（坦克左上角）
}

// ---- 玩家 / 实体 ----
export interface PlayerDef {
  name: string;
  isBot?: boolean;
  color?: string;
}

export interface TankState {
  id: number;
  name: string;
  isBot: boolean;
  color: string;
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  alive: boolean;
  shieldTicks: number;
  respawnTicks: number;   // >0 表示重生倒计时
  score: number;
  kills: number;
  deaths: number;
}

export interface BulletState {
  id: number;
  ownerId: number;
  dir: Dir;
  x: number;
  y: number;
}

// ---- 事件（下行播报，M2 起经 WS 转发）----
export type SimEvent =
  | { type: 'kill'; killerId: number; victimId: number; x: number; y: number }
  | { type: 'explosion'; x: number; y: number; big: boolean }
  | { type: 'brickBreak'; x: number; y: number }
  | { type: 'gameOver'; winnerId: number | null };
