/**
 * M5 性能验证（测试文档 L5 / NFR-1/2）：
 * - BattleSim 单 tick 耗时（8 坦克 + 6 AI，60s 模拟，6 张内置地图）
 * - 快照 JSON 体积（按 Room.broadcastSnapshot 的字段结构）
 * 运行：npm run perf
 */
import { BattleSim, type Tank } from '../shared/sim/sim';
import { BotController, BOT_SPEED_BY_DIFFICULTY } from '../shared/sim/bot';
import { MAPS } from '../shared/maps';
import { TICK_RATE } from '../shared/constants';
import { mulberry32 } from '../shared/rng';
import type { S2CMessage } from '../shared/protocol';

const TICKS = 60 * TICK_RATE; // 60s 模拟
const SNAPSHOT_SAMPLE_EVERY = 30;

function buildPlayers() {
  return [
    { name: 'P1', isBot: false },
    { name: 'P2', isBot: false },
    { name: 'Bot-2', isBot: true, speed: BOT_SPEED_BY_DIFFICULTY.easy, bonus: true },
    { name: 'Bot-3', isBot: true, speed: BOT_SPEED_BY_DIFFICULTY.normal },
    { name: 'Bot-4', isBot: true, speed: BOT_SPEED_BY_DIFFICULTY.normal },
    { name: 'Bot-5', isBot: true, speed: BOT_SPEED_BY_DIFFICULTY.hard, bonus: true },
    { name: 'Bot-6', isBot: true, speed: BOT_SPEED_BY_DIFFICULTY.hard },
    { name: 'Bot-7', isBot: true, speed: BOT_SPEED_BY_DIFFICULTY.hard },
  ];
}

function snapshotFor(sim: BattleSim): string {
  const msg: S2CMessage = {
    t: 'snapshot',
    tick: sim.tick,
    tanks: sim.tanks.map((t) => ({
      id: t.id, x: t.x, y: t.y, dir: t.dir, moving: t.moving, alive: t.alive,
      shieldTicks: t.shieldTicks, respawnTicks: t.respawnTicks, level: t.level, frozenTicks: t.frozenTicks,
      score: t.score, kills: t.kills, deaths: t.deaths, bonus: t.bonus,
    })),
    bullets: sim.bullets.map((b) => ({ id: b.id, ownerId: b.ownerId, dir: b.dir, x: b.x, y: b.y })),
    powerups: sim.powerups.map((p) => ({ id: p.id, type: p.type, x: p.x, y: p.y })),
    baseAlive: sim.baseAlive,
  };
  return JSON.stringify(msg);
}

let globalWorst = 0;
let globalSum = 0;
let globalCount = 0;
let snapshotTotal = 0;
let snapshotCount = 0;

for (const mapDef of MAPS) {
  const sim = new BattleSim(mapDef, buildPlayers(), { seed: 12345, scoreCap: 0, timeTicks: 0 });
  const bots = new Map<number, BotController>();
  const difficulties = ['easy', 'normal', 'hard'] as const;
  let d = 0;
  for (const t of sim.tanks as Tank[]) {
    if (t.isBot) bots.set(t.id, new BotController(sim, t.id, mulberry32(1 + t.id), difficulties[d++ % 3]!));
  }
  let mapWorst = 0;
  let mapSum = 0;
  for (let i = 0; i < TICKS; i++) {
    for (const [tankId, bot] of bots) sim.setInput(tankId, bot.update());
    const t0 = performance.now();
    sim.step();
    const dt = performance.now() - t0;
    mapWorst = Math.max(mapWorst, dt);
    mapSum += dt;
    if (i % SNAPSHOT_SAMPLE_EVERY === 0) {
      snapshotTotal += snapshotFor(sim).length;
      snapshotCount++;
    }
  }
  globalWorst = Math.max(globalWorst, mapWorst);
  globalSum += mapSum;
  globalCount += TICKS;
  console.log(`${mapDef.name.padEnd(8)} avg tick=${(mapSum / TICKS).toFixed(4)}ms  max tick=${mapWorst.toFixed(3)}ms  gameOver=${sim.gameOver}`);
}

console.log('---- 汇总 ----');
console.log(`平均 tick 耗时: ${(globalSum / globalCount).toFixed(4)} ms（预算 16.67 ms，NFR-1）`);
console.log(`最大 tick 耗时: ${globalWorst.toFixed(3)} ms`);
console.log(`快照平均体积: ${(snapshotTotal / snapshotCount).toFixed(0)} bytes ≈ ${((snapshotTotal / snapshotCount) / 1024).toFixed(2)} KB × 60/s × 8 连接 = ${(((snapshotTotal / snapshotCount) * 60 * 8) / 1024 / 1024).toFixed(2)} MB/s（NFR-2）`);
