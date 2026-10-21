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
  base: { x: number; y: number } | null;      // 基地左上角像素（32×32）
  powerupSpots: { x: number; y: number }[];   // 道具点位像素（左上角，32×32）
}

// ---- 玩家 / 实体 ----
export interface PlayerDef {
  name: string;
  isBot?: boolean;
  color?: string;
  /** 坦克速度 px/tick（缺省 TANK_SPEED；M5 AI 速度档位由 Room 按 botDifficulty 传入） */
  speed?: number;
  /** 闪红坦克（M5）：被击毁时原地掉落随机道具 */
  bonus?: boolean;
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
  level: number;          // 0~3（FR-T3）
  frozenTicks: number;    // >0 被定时器冻结（FR-P3）
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
  level: number;          // 发射者等级（决定弹速与破坏力，FR-T4）
}

// ---- 道具（FR-P1~P6）----
export const PowerupType = {
  Star: 0,    // 星星：升 1 级（L3 满级改 +100 分）
  Helmet: 1,  // 头盔：10s 护盾
  Timer: 2,   // 定时器：冻结所有对手 8s
  Bomb: 3,    // 炸弹：消灭全图所有对手（按击杀归属计分）
  Shovel: 4,  // 铁锹：基地周围钢墙 15s
  Tank: 5,    // 坦克：+200 分
} as const;
export type PowerupType = (typeof PowerupType)[keyof typeof PowerupType];

export interface PowerupState {
  id: number;
  type: PowerupType;
  x: number;  // 左上角像素（32×32）
  y: number;
}

// ---- 事件（下行播报，M2 起经 WS 转发）----
export type SimEvent =
  | { type: 'kill'; killerId: number; victimId: number; x: number; y: number }
  | { type: 'explosion'; x: number; y: number; big: boolean }
  | { type: 'brickBreak'; x: number; y: number }
  | { type: 'shoot'; x: number; y: number }
  | { type: 'powerupPickup'; tankId: number; kind: PowerupType; x: number; y: number }
  | { type: 'terrainSet'; cells: { x: number; y: number; t: TerrainType }[] } // 铁锹钢墙设置/恢复（联机地形同步）
  | { type: 'baseDestroyed'; byId: number; x: number; y: number }
  | { type: 'gameOver'; winnerId: number | null };
