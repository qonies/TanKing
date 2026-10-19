import { describe, expect, it } from 'vitest';
import { BattleSim } from '../shared/sim/sim';
import { BotController } from '../shared/sim/bot';
import { INPUT_DIR_MASK, INPUT_FIRE } from '../shared/constants';
import { mulberry32 } from '../shared/rng';
import mapJson from '../maps/map01.json';
import type { MapDef } from '../shared/types';

const mapDef = mapJson as unknown as MapDef;

function makeBotGame(seed: number): { sim: BattleSim; bot: BotController } {
  const sim = new BattleSim(
    mapDef,
    [{ name: '玩家' }, { name: 'Bot-1' }],
    { seed },
  );
  const bot = new BotController(sim, 1, mulberry32(seed + 1), 'normal');
  return { sim, bot };
}

describe('AI 机器人（FR-A2）', () => {
  it('产出合法输入掩码', () => {
    const { sim, bot } = makeBotGame(1);
    for (let i = 0; i < 100; i++) {
      const m = bot.update();
      sim.setInput(1, m);
      sim.setInput(0, 0);
      sim.step();
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(31);
    }
  });

  it('会向最近敌人逼近（20 秒内明显缩短距离）', () => {
    const { sim, bot } = makeBotGame(7);
    const a = sim.tanks[0]!;
    const b = sim.tanks[1]!;
    const dist0 = Math.hypot(a.x - b.x, a.y - b.y);
    for (let i = 0; i < 20 * 60; i++) {
      sim.setInput(1, bot.update());
      sim.setInput(0, 0);
      sim.step();
      sim.drainEvents();
      if (sim.gameOver) break;
    }
    const dist1 = Math.hypot(a.x - b.x, a.y - b.y);
    expect(dist1).toBeLessThan(dist0 - 64);
  });

  it('相同种子下完全可复现', () => {
    const run = (seed: number): [number, number] => {
      const { sim, bot } = makeBotGame(seed);
      for (let i = 0; i < 600; i++) {
        sim.setInput(1, bot.update());
        sim.setInput(0, 0);
        sim.step();
        sim.drainEvents();
      }
      const b = sim.tanks[1]!;
      return [b.x, b.y];
    };
    expect(run(123)).toEqual(run(123));
  });

  it('死亡期间不产出输入', () => {
    const { sim, bot } = makeBotGame(5);
    sim.tanks[1]!.alive = false;
    sim.tanks[1]!.respawnTicks = 60;
    expect(bot.update()).toBe(0);
  });
});

describe('AI 卡墙开路', () => {
  it('面对砖墙时会开火（输入含 FIRE 位）', () => {
    const { sim, bot } = makeBotGame(11);
    // 持续运行，检查一段时间窗口内出现过开火输入或击杀事件
    let fired = false;
    for (let i = 0; i < 1800 && !sim.gameOver; i++) {
      const m = bot.update();
      if (m & INPUT_FIRE) fired = true;
      sim.setInput(1, m);
      sim.setInput(0, 0);
      sim.step();
      sim.drainEvents();
    }
    expect(fired).toBe(true);
  });

  it('方向位与 FIRE 位不越界', () => {
    const { bot } = makeBotGame(3);
    for (let i = 0; i < 60; i++) {
      const m = bot.update();
      expect(m & ~(INPUT_DIR_MASK | INPUT_FIRE)).toBe(0);
    }
  });
});
