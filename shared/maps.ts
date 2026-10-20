import map01 from '../maps/map01.json';
import map02 from '../maps/map02.json';
import map03 from '../maps/map03.json';
import map04 from '../maps/map04.json';
import map05 from '../maps/map05.json';
import map06 from '../maps/map06.json';
import type { MapDef } from './types';

/** 内置地图注册表（技术路线 §7：M3 内置 6 张 PvP 对战地图） */
export const MAPS: MapDef[] = [map01, map02, map03, map04, map05, map06].map((m) => m as unknown as MapDef);

export function mapByName(name: string): MapDef | undefined {
  return MAPS.find((m) => m.name === name);
}