import { SCORE_CAP_DEFAULT, TICK_MS } from '../shared/constants';
import type { MapDef } from '../shared/types';
import { BattleSim } from '../shared/sim/sim';
import { BotController } from '../shared/sim/bot';
import { mulberry32 } from '../shared/rng';
import { KeyboardInput } from './input';
import { Renderer } from './renderer';
import mapJson from '../maps/map01.json';

const mapDef = mapJson as unknown as MapDef;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const overlay = document.getElementById('overlay')!;
const overlayTitle = document.getElementById('overlay-title')!;
const overlayText = document.getElementById('overlay-text')!;
const scoresEl = document.getElementById('scores')!;
const feedEl = document.getElementById('feed')!;

const SEED = 20261019;
const FEED_TICKS = 240; // 播报停留 4 秒

interface FeedItem { text: string; until: number }

let sim: BattleSim;
let bot: BotController;
let renderer: Renderer;
let feed: FeedItem[] = [];
let scoreRows: { score: HTMLElement; status: HTMLElement }[] = [];

function start(): void {
  sim = new BattleSim(mapDef, [
    { name: '玩家', isBot: false, color: '#e8c838' },
    { name: 'Bot-1', isBot: true, color: '#d84040' },
  ], { seed: SEED, scoreCap: SCORE_CAP_DEFAULT });
  bot = new BotController(sim, 1, mulberry32(99), 'normal');
  renderer = new Renderer(ctx);
  feed = [];
  overlay.classList.remove('show');

  // 重建计分板行
  scoresEl.innerHTML = '';
  scoreRows = sim.tanks.map((t) => {
    const row = document.createElement('div');
    row.className = 'score-row';
    row.innerHTML = `<span class="name" style="color:${t.color}"></span><span class="meta"></span>`;
    scoresEl.appendChild(row);
    return {
      score: row.querySelector('.name')!,
      status: row.querySelector('.meta')!,
    };
  });
}

function handleEvents(): void {
  for (const e of sim.drainEvents()) {
    renderer.pushEvent(e);
    if (e.type === 'kill') {
      const killer = sim.tanks[e.killerId];
      const victim = sim.tanks[e.victimId];
      feed.push({
        text: `${killer?.name ?? '?'} 击毁了 ${victim?.name ?? '?'}`,
        until: sim.tick + FEED_TICKS,
      });
    } else if (e.type === 'gameOver') {
      const winner = e.winnerId !== null ? sim.tanks[e.winnerId] : null;
      overlayTitle.textContent = winner ? `${winner.name} 获胜！` : '平局';
      overlayText.textContent = '按 R 重新开始';
      overlay.classList.add('show');
    }
  }
}

function updateHud(): void {
  sim.tanks.forEach((t, i) => {
    const row = scoreRows[i]!;
    row.score.textContent = `${t.name}  ${t.score}分 / ${t.kills}杀`;
    row.status.textContent = !t.alive ? '重生中…' : t.shieldTicks > 0 ? '护盾' : '存活';
  });
  feed = feed.filter((f) => f.until > sim.tick);
  feedEl.innerHTML = feed.map((f) => `<li>${f.text}</li>`).join('');
}

const keys = new KeyboardInput(start);
start();

let last = performance.now();
let acc = 0;
let hudCd = 0;

function frame(now: number): void {
  acc += now - last;
  last = now;
  if (acc > 250) acc = 250; // 防雪崩（切后台回来不追帧）

  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    if (!sim.gameOver) {
      sim.setInput(0, keys.getMask());
      sim.setInput(1, bot.update());
      sim.step();
      handleEvents();
    }
  }

  renderer.render(sim);
  if (--hudCd <= 0) {
    updateHud();
    hudCd = 10;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
