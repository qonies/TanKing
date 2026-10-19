import { ROUND_TICKS_DEFAULT, SCORE_CAP_DEFAULT, TICK_MS } from '../shared/constants';
import type { MapDef, SimEvent } from '../shared/types';
import { BattleSim } from '../shared/sim/sim';
import { BotController } from '../shared/sim/bot';
import { mulberry32 } from '../shared/rng';
import type { LobbyPlayer, RoomPhase, S2CMessage, Snapshot } from '../shared/protocol';
import { KeyboardInput } from './input';
import { Renderer } from './renderer';
import { NetClient } from './net';
import { SnapshotBuffer, TerrainView } from './interp';
import mapJson from '../maps/map01.json';

const mapDef = mapJson as unknown as MapDef;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const overlay = document.getElementById('overlay')!;
const overlayTitle = document.getElementById('overlay-title')!;
const overlayText = document.getElementById('overlay-text')!;
const scoresEl = document.getElementById('scores')!;
const feedEl = document.getElementById('feed')!;
const menuEl = document.getElementById('menu')!;
const nickInput = document.getElementById('nick') as HTMLInputElement;
const btnSingle = document.getElementById('btn-single')!;
const btnOnline = document.getElementById('btn-online')!;
const menuMsg = document.getElementById('menu-msg')!;
const lobbyEl = document.getElementById('lobby')!;
const membersEl = document.getElementById('members')!;
const btnStart = document.getElementById('btn-start')!;
const lobbyStatus = document.getElementById('lobby-status')!;

const SEED = 20261019;
const FEED_TICKS = 240; // 播报停留 4 秒
const INTERP_DELAY = 2; // 快照插值延迟帧数（技术路线 §4.3）

interface FeedItem { text: string; until: number }
type Mode = 'menu' | 'single' | 'online';

let mode: Mode = 'menu';
let renderer = new Renderer(ctx);
let feed: FeedItem[] = [];
let scoreRows = new Map<number, { score: HTMLElement; status: HTMLElement }>();

// ---- 单机状态 ----
let sim: BattleSim;
let bot: BotController;

// ---- 联机状态 ----
const net = new NetClient();
const buffer = new SnapshotBuffer();
let terrain = new TerrainView(mapDef);
let playersByTank = new Map<number, LobbyPlayer>();
let myConnId = -1;
let lastSentMask = 0;
let forceSendCd = 0;
let onlineTick = 0;
let onlineHudCd = 0;

function showPanel(el: HTMLElement | null): void {
  for (const p of [menuEl, lobbyEl]) p.classList.toggle('show', p === el);
  overlay.classList.remove('show');
}

function showMenu(msg = ''): void {
  mode = 'menu';
  menuMsg.textContent = msg;
  showPanel(menuEl);
}

function rebuildScoreRows(entries: { tankId: number; name: string; color: string }[]): void {
  scoresEl.replaceChildren();
  scoreRows.clear();
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'score-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = e.color;
    const meta = document.createElement('span');
    meta.className = 'meta';
    row.append(name, meta); // textContent 赋值，昵称不进 innerHTML（NFR-6 防注入）
    scoresEl.appendChild(row);
    scoreRows.set(e.tankId, { score: name, status: meta });
  }
}

function renderFeed(tick: number): void {
  feed = feed.filter((f) => f.until > tick);
  feedEl.replaceChildren(...feed.map((f) => {
    const li = document.createElement('li');
    li.textContent = f.text;
    return li;
  }));
}

/** 单机/联机共用的事件处理（击杀播报 + 结算覆盖层） */
function handleSimEvent(e: SimEvent, tick: number, nameOf: (id: number) => string): void {
  renderer.pushEvent(e);
  if (e.type === 'kill') {
    feed.push({ text: `${nameOf(e.killerId)} 击毁了 ${nameOf(e.victimId)}`, until: tick + FEED_TICKS });
  } else if (e.type === 'gameOver') {
    const winner = e.winnerId !== null ? nameOf(e.winnerId) : null;
    overlayTitle.textContent = winner ? `${winner} 获胜！` : '平局';
    overlayText.textContent = mode === 'single' ? '按 R 重新开始' : '即将返回房间…';
    overlay.classList.add('show');
  }
}

// ---- 单机模式 ----

function startSingle(): void {
  mode = 'single';
  sim = new BattleSim(mapDef, [
    { name: '玩家', isBot: false, color: '#e8c838' },
    { name: 'Bot-1', isBot: true, color: '#d84040' },
  ], { seed: SEED, scoreCap: SCORE_CAP_DEFAULT, timeTicks: ROUND_TICKS_DEFAULT });
  bot = new BotController(sim, 1, mulberry32(99), 'normal');
  renderer = new Renderer(ctx);
  feed = [];
  showPanel(null);
  rebuildScoreRows(sim.tanks.map((t, i) => ({ tankId: i, name: t.name, color: t.color })));
}

function updateSingleHud(): void {
  sim.tanks.forEach((t) => {
    const row = scoreRows.get(t.id)!;
    row.score.textContent = `${t.name}  ${t.score}分 / ${t.kills}杀`;
    row.status.textContent = !t.alive ? '重生中…' : t.shieldTicks > 0 ? '护盾' : '存活';
  });
  renderFeed(sim.tick);
}

// ---- 联机模式 ----

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function goOnline(): void {
  mode = 'online';
  terrain = new TerrainView(mapDef);
  buffer.clear();
  feed = [];
  playersByTank.clear();
  myConnId = -1;
  lastSentMask = 0;
  net.onOpen = () => net.send({ t: 'join', name: nickInput.value });
  net.onMessage = handleNetMessage;
  net.onClose = () => showMenu('与服务器断开连接');
  lobbyStatus.textContent = '连接中…';
  showPanel(lobbyEl);
  net.connect(wsUrl());
}

function handleNetMessage(msg: S2CMessage): void {
  switch (msg.t) {
    case 'welcome':
      myConnId = msg.connId;
      break;
    case 'lobbyState':
      applyLobbyState(msg.phase, msg.ownerConnId, msg.secondsLeft, msg.players);
      break;
    case 'snapshot':
      buffer.push({ tick: msg.tick, tanks: msg.tanks, bullets: msg.bullets });
      onlineTick = msg.tick;
      break;
    case 'event':
      if (msg.event.type === 'brickBreak') terrain.breakBrick(msg.event.x, msg.event.y);
      handleSimEvent(msg.event, onlineTick, (id) => playersByTank.get(id)?.name ?? `P${id}`);
      break;
    case 'error':
      showMenu(msg.message);
      break;
  }
}

function applyLobbyState(
  phase: RoomPhase,
  ownerConnId: number,
  secondsLeft: number | null,
  players: LobbyPlayer[],
): void {
  playersByTank = new Map(players.filter((p) => p.tankId >= 0).map((p) => [p.tankId, p]));
  rebuildScoreRows([...playersByTank.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tankId, p]) => ({ tankId, name: p.name, color: p.color })));
  btnStart.classList.toggle('hidden', myConnId !== ownerConnId);

  if (phase === 'waiting' || phase === 'roundEnd') {
    showPanel(lobbyEl);
    membersEl.replaceChildren(...players.map((p) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      const n = document.createElement('span');
      n.textContent = p.name;
      n.style.color = p.color;
      const tag = document.createElement('span');
      tag.textContent = p.connId === ownerConnId ? '房主' : p.isBot ? 'AI' : '玩家';
      row.append(n, tag);
      return row;
    }));
    lobbyStatus.textContent = phase === 'roundEnd'
      ? '本局结束，房主可开始下一局'
      : `房间内 ${players.length} 人（真人 ${players.filter((p) => !p.isBot).length}）· 人数不足由 AI 补位`;
  } else if (phase === 'countdown') {
    showPanel(null);
    overlayTitle.textContent = '准备';
    overlayText.textContent = `${secondsLeft ?? ''} 秒后开始`;
    overlay.classList.add('show');
  } else {
    showPanel(null); // playing：隐藏面板，等待快照渲染
  }
}

function renderOnline(): void {
  const s: Snapshot | null = buffer.sample(INTERP_DELAY);
  if (s) {
    renderer.render({
      tick: s.tick,
      bullets: s.bullets,
      terrainAt: (cx, cy) => terrain.terrainAt(cx, cy),
      tanks: s.tanks.map((t) => ({ ...t, color: playersByTank.get(t.id)?.color ?? '#ffffff' })),
    });
  }
  if (--onlineHudCd <= 0) {
    onlineHudCd = 10;
    const latest = buffer.latest;
    if (latest) {
      latest.tanks.forEach((t) => {
        const row = scoreRows.get(t.id);
        if (!row) return;
        const name = playersByTank.get(t.id)?.name ?? `P${t.id}`;
        row.score.textContent = `${name}  ${t.score}分 / ${t.kills}杀`;
        row.status.textContent = !t.alive ? '重生中…' : t.shieldTicks > 0 ? '护盾' : '存活';
      });
      renderFeed(onlineTick);
    }
  }
}

// ---- 主循环 ----

const keys = new KeyboardInput(() => { if (mode === 'single') startSingle(); });

btnSingle.addEventListener('click', () => startSingle());
btnOnline.addEventListener('click', () => goOnline());
btnStart.addEventListener('click', () => net.send({ t: 'start' }));
// 输入昵称时阻止游戏键位捕获（Space/方向键）
nickInput.addEventListener('keydown', (e) => e.stopPropagation());
nickInput.addEventListener('keyup', (e) => e.stopPropagation());

let last = performance.now();
let acc = 0;
let hudCd = 0;

function frame(now: number): void {
  acc += now - last;
  last = now;
  if (acc > 250) acc = 250; // 防雪崩（切后台回来不追帧）

  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    if (mode === 'single') {
      if (!sim.gameOver) {
        sim.setInput(0, keys.getMask());
        sim.setInput(1, bot.update());
        sim.step();
        for (const e of sim.drainEvents()) {
          handleSimEvent(e, sim.tick, (id) => sim.tanks[id]?.name ?? '?');
        }
      }
    } else if (mode === 'online') {
      // 输入上行：变化时发送 + 心跳兜底（技术路线 §4.2）
      const mask = keys.getMask();
      if (mask !== lastSentMask || --forceSendCd <= 0) {
        net.send({ t: 'input', mask });
        lastSentMask = mask;
        forceSendCd = 15;
      }
    }
  }

  if (mode === 'single') {
    renderer.render(sim);
    if (--hudCd <= 0) { updateSingleHud(); hudCd = 10; }
  } else if (mode === 'online') {
    renderOnline();
  }
  requestAnimationFrame(frame);
}

showMenu();
requestAnimationFrame(frame);

