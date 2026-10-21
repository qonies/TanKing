import { GRID, CELL, TANK_SIZE, FIELD } from '../constants';
import { TerrainType, type MapDef, type LoadedMap, type PointDef } from '../types';

const CHAR_MAP: Record<string, TerrainType> = {
  '.': TerrainType.Empty,
  ' ': TerrainType.Empty,
  B: TerrainType.Brick,
  S: TerrainType.Steel,
  W: TerrainType.Water,
  T: TerrainType.Trees,
  I: TerrainType.Ice,
};

export function charToTerrain(ch: string): TerrainType {
  const t = CHAR_MAP[ch];
  if (t === undefined) throw new Error(`未知地形字符: "${ch}"`);
  return t;
}

/**
 * 加载并校验地图。
 * terrain 矩阵应为 size×size（26×26）字符；兼容 13×13 大格矩阵（自动 ×2 展开）。
 */
export function loadMap(def: MapDef): LoadedMap {
  if (def.size !== undefined && def.size !== GRID && def.size !== GRID / 2) {
    throw new Error(`地图 "${def.name}" size 字段非法: ${def.size}（应为 ${GRID} 或 ${GRID / 2}）`);
  }
  const rows = def.terrain;
  if (rows.length !== GRID && rows.length !== GRID / 2) {
    throw new Error(`地图 "${def.name}" 行数非法: ${rows.length}（应为 ${GRID} 或 ${GRID / 2}）`);
  }
  const large = rows.length === GRID / 2;
  const n = large ? GRID / 2 : GRID;

  const terrain = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    const src = rows[large ? y >> 1 : y]!;
    if (src.length !== (large ? n : GRID)) {
      throw new Error(`地图 "${def.name}" 第 ${y} 行长度非法: ${src.length}`);
    }
    for (let x = 0; x < GRID; x++) {
      terrain[y * GRID + x] = charToTerrain(src[large ? x >> 1 : x]!);
    }
  }

  if (!def.spawns || def.spawns.length === 0) {
    throw new Error(`地图 "${def.name}" 缺少出生点`);
  }
  // 出生点越界校验（坦克占 2×2 小格，左上角最大为 GRID-2）
  for (const p of def.spawns) {
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) ||
        p.x < 0 || p.y < 0 || p.x > GRID - 2 || p.y > GRID - 2) {
      throw new Error(`地图 "${def.name}" 出生点越界: (${p.x}, ${p.y})`);
    }
  }
  const spawns = def.spawns.map((p: PointDef) => ({ x: p.x * CELL, y: p.y * CELL }));

  // 基地 / 道具点：小格坐标 × CELL 折算像素（占 32×32，需大格对齐）
  const base = def.base ? { x: def.base.x * CELL, y: def.base.y * CELL } : null;
  if (base && (base.x % TANK_SIZE !== 0 || base.y % TANK_SIZE !== 0 ||
      base.x < 0 || base.y < 0 || base.x > FIELD - TANK_SIZE || base.y > FIELD - TANK_SIZE)) {
    throw new Error(`地图 "${def.name}" 基地点位非法（需大格对齐且在场地内）`);
  }
  const powerupSpots = (def.powerupSpots ?? []).map((p: PointDef) => ({ x: p.x * CELL, y: p.y * CELL }));
  for (const s of powerupSpots) {
    if (s.x % TANK_SIZE !== 0 || s.y % TANK_SIZE !== 0 || s.x < 0 || s.y < 0 || s.x > FIELD - TANK_SIZE || s.y > FIELD - TANK_SIZE) {
      throw new Error(`地图 "${def.name}" 道具点位非法`);
    }
  }

  // 出生点：不允许重复，且 2×2 范围不得落在实体地形（砖/钢/水）上
  const seenSpawns = new Set<string>();
  for (const p of def.spawns) {
    const key = `${p.x},${p.y}`;
    if (seenSpawns.has(key)) {
      throw new Error(`地图 "${def.name}" 出生点重复: (${p.x}, ${p.y})`);
    }
    seenSpawns.add(key);
    for (let y = p.y; y < p.y + 2; y++) {
      for (let x = p.x; x < p.x + 2; x++) {
        const tt = terrain[y * GRID + x]!;
        if (tt === TerrainType.Brick || tt === TerrainType.Steel || tt === TerrainType.Water) {
          throw new Error(`地图 "${def.name}" 出生点 (${p.x}, ${p.y}) 落在实体地形上`);
        }
      }
    }
  }

  // 出生点 2×2 矩形之间不得重叠（否则开局多辆坦克互相卡死）
  const spawnRects = def.spawns.map((p) => ({ x0: p.x, y0: p.y, x1: p.x + 1, y1: p.y + 1 }));
  for (let i = 0; i < spawnRects.length; i++) {
    for (let j = i + 1; j < spawnRects.length; j++) {
      const a = spawnRects[i]!;
      const b = spawnRects[j]!;
      if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
        throw new Error(`地图 "${def.name}" 出生点矩形重叠: (${a.x0}, ${a.y0}) 与 (${b.x0}, ${b.y0})`);
      }
    }
  }

  // 出生点不得与基地 2×2 重叠
  if (def.base) {
    for (const p of def.spawns) {
      if (p.x <= def.base.x + 1 && def.base.x <= p.x + 1 &&
          p.y <= def.base.y + 1 && def.base.y <= p.y + 1) {
        throw new Error(`地图 "${def.name}" 出生点 (${p.x}, ${p.y}) 与基地重叠`);
      }
    }
  }

  // 基地：2×2 范围不得被实体地形或树林覆盖（否则渲染与碰撞语义冲突）
  if (base && def.base) {
    for (let y = def.base.y; y < def.base.y + 2; y++) {
      for (let x = def.base.x; x < def.base.x + 2; x++) {
        const tt = terrain[y * GRID + x]!;
        if (tt !== TerrainType.Empty && tt !== TerrainType.Ice) {
          throw new Error(`地图 "${def.name}" 基地格 (${x}, ${y}) 被地形覆盖`);
        }
      }
    }
  }

  // 道具点：不得落在实体地形（砖/钢/水）上
  for (const p of def.powerupSpots ?? []) {
    for (let y = p.y; y < p.y + 2; y++) {
      for (let x = p.x; x < p.x + 2; x++) {
        const tt = terrain[y * GRID + x]!;
        if (tt === TerrainType.Brick || tt === TerrainType.Steel || tt === TerrainType.Water) {
          throw new Error(`地图 "${def.name}" 道具点 (${p.x}, ${p.y}) 落在实体地形上`);
        }
      }
    }
  }

  return { name: def.name, size: GRID, terrain, spawns, base, powerupSpots };
}

/** 读取小格地形 */
export function terrainAt(map: LoadedMap, cx: number, cy: number): TerrainType {
  if (cx < 0 || cy < 0 || cx >= map.size || cy >= map.size) return TerrainType.Steel;
  return map.terrain[cy * map.size + cx]! as TerrainType;
}

/** 矩形覆盖的小格列表（内缩 0.01px 防边界误判） */
export function cellsOfRect(x: number, y: number, w: number, h: number): [number, number][] {
  const EPS = 0.01;
  const x0 = Math.floor((x + EPS) / CELL);
  const x1 = Math.floor((x + w - EPS) / CELL);
  const y0 = Math.floor((y + EPS) / CELL);
  const y1 = Math.floor((y + h - EPS) / CELL);
  const out: [number, number][] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) out.push([cx, cy]);
  }
  return out;
}
