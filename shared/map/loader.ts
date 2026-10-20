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
  const spawns = def.spawns.map((p: PointDef) => ({ x: p.x * CELL, y: p.y * CELL }));

  // 基地 / 道具点：小格坐标 × CELL 折算像素（占 32×32，需大格对齐）
  const base = def.base ? { x: def.base.x * CELL, y: def.base.y * CELL } : null;
  if (base && (base.x % TANK_SIZE !== 0 || base.y % TANK_SIZE !== 0)) {
    throw new Error(`地图 "${def.name}" 基地点位未按大格对齐`);
  }
  const powerupSpots = (def.powerupSpots ?? []).map((p: PointDef) => ({ x: p.x * CELL, y: p.y * CELL }));
  for (const s of powerupSpots) {
    if (s.x % TANK_SIZE !== 0 || s.y % TANK_SIZE !== 0 || s.x < 0 || s.y < 0 || s.x > FIELD - TANK_SIZE || s.y > FIELD - TANK_SIZE) {
      throw new Error(`地图 "${def.name}" 道具点位非法`);
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
