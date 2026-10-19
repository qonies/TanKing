import type { MapDef } from '../shared/types';
import { BattleSim } from '../shared/sim/sim';

export const EMPTY_ROW = '.'.repeat(26);

export function makeMap(rows: string[], spawns: { x: number; y: number }[]): MapDef {
  const padded = [...rows];
  while (padded.length < 26) padded.push(EMPTY_ROW);
  return { name: 'test', size: 26, terrain: padded, spawns, base: null };
}

export const TWO_SPAWNS = [{ x: 4, y: 24 }, { x: 20, y: 0 }];

export function makeSim(rows: string[] = [], spawns = TWO_SPAWNS, players?: { name: string; isBot?: boolean; color?: string }[]): BattleSim {
  return new BattleSim(
    makeMap(rows, spawns),
    players ?? [{ name: 'A' }, { name: 'B' }],
    { seed: 42 },
  );
}
