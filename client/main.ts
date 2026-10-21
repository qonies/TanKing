import { BONUS_BOT_PROBABILITY, FIELD, ROUND_TICKS_DEFAULT, SCORE_CAP_DEFAULT, TICK_MS, TICK_RATE } from '../shared/constants';
import type { MapDef, PlayerDef, SimEvent } from '../shared/types';
import { BattleSim, PALETTE } from '../shared/sim/sim';
import { BotController } from '../shared/sim/bot';
import { mulberry32 } from '../shared/rng';
import { MAPS, mapByName } from '../shared/maps';
import type { LobbyPlayer, RoomPhase, RoundResult, S2CMessage, Snapshot } from '../shared/protocol';
import type { BotDifficulty } from '../shared/sim/bot';
import { BOT_SPEED_BY_DIFFICULTY } from '../shared/sim/bot';
import { KeyboardInput, type Action } from './input';
import { Renderer, drawMapPreview } from './renderer';
import { NetClient } from './net';
import { SnapshotBuffer, TerrainView } from './interp';
import { AudioFx } from './audio';

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
const cfgRow = document.getElementById('cfg-row')!;
const cfgTanks = document.getElementById('cfg-tanks') as HTMLSelectElement;
const cfgDiff = document.getElementById('cfg-diff') as HTMLSelectElement;
const chatLog = document.getElementById('chat-log')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const btnChat = document.getElementById('btn-chat')!;
const keysPanel = document.getElementById('keys')!;
const btnKeys = document.getElementById('btn-keys')!;
const btnKeysClose = document.getElementById('btn-keys-close')!;
// M5：地图选择/预览（FR-N3/U2）、Tab 计分板（FR-U3）、音量设置（FR-S2）
const cfgMap = document.getElementById('cfg-map') as HTMLSelectElement;
const mapPreview = document.getElementById('map-preview') as HTMLCanvasElement;
const scoreboardEl = document.getElementById('scoreboard')!;
const scoreboardBody = document.getElementById('scoreboard-body')!;
const volSfx = document.getElementById('vol-sfx') as HTMLInputElement;
const volMusic = document.getElementById('vol-music') as HTMLInputElement;
// 复审修复：单机配置（FR-O1）、回合规则配置（FR-N3）、回合倒计时（FR-U3）
const singleTanks = document.getElementById('single-tanks') as HTMLSelectElement;
const singleDiff = document.getElementById('single-diff') as HTMLSelectElement;
const cfgScore = document.getElementById('cfg-score') as HTMLSelectElement;
const cfgMins = document.getElementById('cfg-mins') as HTMLSelectElement;
const cfgPu = document.getElementById('cfg-pu') as HTMLSelectElement;
const roundTimerEl = document.getElementById('round-timer')!;

const SEED = 20261019;
const FEED_TICKS = 240; // 播报停留 4 秒
const INTERP_DELAY = 2; // 快照插值延迟帧数（技术路线 §4.3）
const QUICK_PHRASES = ['收到！', '小心基地！', '跟我来！', '快抢道具！', '打得漂亮！'];

interface FeedItem { text: string; until: number }
type Mode = 'menu' | 'single' | 'online';

let mode: Mode = 'menu';
let renderer = new Renderer(ctx);
let feed: FeedItem[] = [];
let scoreRows = new Map<number, { score: HTMLElement; status: HTMLElement }>();
const audio = new AudioFx();
const keys = new KeyboardInput(() => { if (mode === 'single') startSingle(); });

// ---- 单机状态 ----
let sim: BattleSim;
let bots: BotController[] = [];

// ---- 联机状态 ----
const net = new NetClient();
const buffer = new SnapshotBuffer();
let onlineMap: MapDef = MAPS[0]!;
let terrain = new TerrainView(MAPS[0]!);
let playersByTank = new Map<number, LobbyPlayer>();
let myConnId = -1;
let myTankId = -1;
let lastSentMask = 0;
let forceSendCd = 0;
let onlineTick = 0;
let onlineHudCd = 0;
let roomPhase: RoomPhase = 'waiting';
let prevPhase: RoomPhase | null = null; // M5：阶段切换检测（音频触发）

function showPanel(el: HTMLElement | null): void {
  for (const p of [menuEl, lobbyEl]) p.classList.toggle('show', p === el);
  keysPanel.classList.remove('show');
  overlay.classList.remove('show');
}

function showMenu(msg = ''): void {
  mode = 'menu';
  net.close(); // 回菜单即断开：避免残留连接继续接收广播（误触音效/结算覆盖层）
  audio.stopBgm(); // M5：BGM 随对局结束
  audio.engine(false); // 履带声同步停止
  menuMsg.textContent = msg;
  showPanel(menuEl);
}

/** 回合剩余时间（FR-U3）：mm:ss；null = 不限时 */
function fmtTime(ticks: number | null): string {
  if (ticks === null || ticks <= 0) return '不限时';
  const s = Math.ceil(ticks / TICK_RATE);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 排名文本（FR-U4）：按积分排名，末尾标注 MVP（击杀最高，其次积分） */
function rankLines(ranks: { name: string; score: number; kills: number; deaths: number }[]): string {
  const sorted = [...ranks].sort((a, b) => b.score - a.score);
  const mvp = [...ranks].sort((a, b) => b.kills - a.kills || b.score - a.score)[0];
  const lines = sorted.map((t, i) => `${i + 1}. ${t.name}  ${t.score}分/${t.kills}杀/${t.deaths}死`);
  if (mvp) lines.push(`MVP：${mvp.name}`);
  return lines.join('\n');
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

/** 单机/联机共用的事件处理（音效 + 击杀播报 + 结算覆盖层） */
function handleSimEvent(e: SimEvent, tick: number, nameOf: (id: number) => string): void {
  renderer.pushEvent(e);
  switch (e.type) {
    case 'shoot':
      audio.shoot();
      break;
    case 'explosion':
      audio.explosion(e.big);
      break;
    case 'powerupPickup':
      if (e.kind === 0) audio.upgrade(); else audio.pickup(); // 0 = Star
      break;
    case 'baseDestroyed':
      audio.baseDestroyed();
      feed.push({ text: `${nameOf(e.byId)} 摧毁了中立基地（+500分）`, until: tick + FEED_TICKS });
      break;
    case 'kill':
      feed.push({ text: `${nameOf(e.killerId)} 击毁了 ${nameOf(e.victimId)}`, until: tick + FEED_TICKS });
      break;
    case 'gameOver': {
      const winner = e.winnerId !== null ? nameOf(e.winnerId) : null;
      overlayTitle.textContent = winner ? `${winner} 获胜！` : '平局';
      overlayText.textContent = mode === 'single'
        ? `${rankLines(sim.tanks.map((t) => ({ name: t.name, score: t.score, kills: t.kills, deaths: t.deaths })))}\n按 R 重新开始`
        : '即将返回房间…';
      overlay.classList.add('show');
      if (mode === 'single') {
        audio.stopBgm();
        audio.engine(false);
        audio.jingle('gameOver'); // M5：结算旋律（联机由房间阶段切换触发，避免重复）
      }
      break;
    }
  }
}

// ---- 单机模式 ----

function startSingle(): void {
  mode = 'single';
  const total = Math.min(8, Math.max(2, Number(singleTanks.value) || 6));
  const diff = (singleDiff.value as BotDifficulty) || 'normal';
  const mapDef = MAPS[Math.floor(Math.random() * MAPS.length)]!; // 单机随机地图
  const players: PlayerDef[] = [{ name: '玩家', isBot: false, color: '#e8c838' }];
  const bonusRng = mulberry32(SEED + 7777); // 闪红标记与联机同规则（确定性）
  for (let i = 1; i < total; i++) {
    players.push({
      name: `Bot-${i}`,
      isBot: true,
      color: PALETTE[i % PALETTE.length]!,
      speed: BOT_SPEED_BY_DIFFICULTY[diff], // FR-O1：单机 AI 难度（含速度档位）
      bonus: bonusRng() < BONUS_BOT_PROBABILITY,
    });
  }
  sim = new BattleSim(mapDef, players, { seed: SEED, scoreCap: SCORE_CAP_DEFAULT, timeTicks: ROUND_TICKS_DEFAULT });
  bots = [];
  for (let i = 1; i < players.length; i++) {
    bots.push(new BotController(sim, i, mulberry32(SEED + i * 104729), diff));
  }
  renderer = new Renderer(ctx);
  feed = [];
  audio.engine(false);
  showPanel(null);
  rebuildScoreRows(sim.tanks.map((t) => ({ tankId: t.id, name: t.name, color: t.color })));
  audio.jingle('start'); // M5：开场旋律
  audio.startBgm();      // M5：对局 BGM
}

function updateSingleHud(): void {
  sim.tanks.forEach((t) => {
    const row = scoreRows.get(t.id)!;
    row.score.textContent = `${t.name}  ${t.score}分 / ${t.kills}杀/${t.deaths}死 / ★${t.level}`;
    row.status.textContent = !t.alive ? '重生中…' : t.frozenTicks > 0 ? '冻结' : t.shieldTicks > 0 ? '护盾' : '存活';
  });
  roundTimerEl.textContent = sim.gameOver ? '回合结束' : fmtTime(sim.remainingTicks > 0 ? sim.remainingTicks : null);
  renderFeed(sim.tick);
}

// ---- 联机模式 ----

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function goOnline(): void {
  mode = 'online';
  onlineMap = MAPS[0]!;
  terrain = new TerrainView(onlineMap);
  buffer.clear();
  feed = [];
  playersByTank.clear();
  myConnId = -1;
  myTankId = -1;
  lastSentMask = 0;
  roomPhase = 'waiting';
  prevPhase = null;
  audio.engine(false);
  chatLog.replaceChildren();
  net.onOpen = () => net.send({ t: 'join', name: nickInput.value });
  net.onMessage = handleNetMessage;
  net.onClose = () => showMenu('与服务器断开连接');
  lobbyStatus.textContent = '连接中…';
  showPanel(lobbyEl);
  net.connect(wsUrl());
}

function handleNetMessage(msg: S2CMessage): void {
  if (mode !== 'online') return; // 已回菜单/进入单机：忽略残留网络消息
  switch (msg.t) {
    case 'welcome':
      myConnId = msg.connId;
      break;
    case 'start': {
      // 开局：按服务器指定地图重建本地地形视图
      window.clearTimeout(resultTimer);
      overlay.classList.remove('show');
      onlineMap = mapByName(msg.map) ?? MAPS[0]!;
      terrain = new TerrainView(onlineMap);
      buffer.clear();
      feed = [];
      break;
    }
    case 'lobbyState': {
      // 重连/换图同步：以服务器下发的地图与地形重建本地视图（含已破坏砖墙/铁锹钢墙）
      if (msg.map && msg.map !== onlineMap.name) {
        onlineMap = mapByName(msg.map) ?? MAPS[0]!;
        terrain = new TerrainView(onlineMap);
        buffer.clear();
      }
      if (msg.terrain) terrain.applyTerrain(msg.terrain);
      applyLobbyState(msg.phase, msg.ownerConnId, msg.secondsLeft, msg.players, msg.maxTanks, msg.botDifficulty,
        msg.scoreCap, msg.roundMinutes, msg.powerups, msg.roundResult ?? null, msg.selectedMap ?? null);
      break;
    }
    case 'snapshot':
      buffer.push({ tick: msg.tick, tanks: msg.tanks, bullets: msg.bullets, powerups: msg.powerups, baseAlive: msg.baseAlive, ticksLeft: msg.ticksLeft });
      onlineTick = msg.tick;
      break;
    case 'event':
      if (msg.event.type === 'brickBreak') terrain.breakBrick(msg.event.x, msg.event.y);
      if (msg.event.type === 'terrainSet') terrain.setCells(msg.event.cells);
      handleSimEvent(msg.event, onlineTick, (id) => playersByTank.get(id)?.name ?? `P${id}`);
      break;
    case 'chat': {
      appendChat(msg.from, msg.color, msg.text);
      if (roomPhase === 'playing' || roomPhase === 'countdown') {
        feed.push({ text: `${msg.from}: ${msg.text}`, until: onlineTick + FEED_TICKS });
      }
      break;
    }
    case 'error':
      net.close(); // 被拒绝（房间满/对局中）：断开连接再回菜单
      showMenu(msg.message);
      break;
  }
}

function appendChat(from: string, color: string, text: string): void {
  const div = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = `${from}: `;
  name.style.color = color;
  const body = document.createElement('span');
  body.textContent = text;
  div.append(name, body);
  chatLog.appendChild(div);
  while (chatLog.childElementCount > 50) chatLog.firstElementChild?.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat(): void {
  const text = chatInput.value.trim();
  if (!text || !net.connected) return;
  net.send({ t: 'chat', text });
  chatInput.value = '';
}

/** 结算覆盖层（FR-U4）：显示胜者、完整排名与 MVP，5 秒后自动隐藏露出大厅 */
let resultTimer = 0;
function showRoundResult(r: RoundResult): void {
  const nameOf = (tankId: number) => playersByTank.get(tankId)?.name ?? `P${tankId}`;
  const winner = r.winnerId !== null ? nameOf(r.winnerId) : null;
  overlayTitle.textContent = winner ? `${winner} 获胜！` : '平局';
  overlayText.textContent = rankLines(r.ranks.map((t) => ({
    name: nameOf(t.tankId), score: t.score, kills: t.kills, deaths: t.deaths,
  })));
  overlay.classList.add('show');
  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(() => overlay.classList.remove('show'), 5000);
}

function applyLobbyState(
  phase: RoomPhase,
  ownerConnId: number,
  secondsLeft: number | null,
  players: LobbyPlayer[],
  maxTanks: number,
  botDifficulty: BotDifficulty,
  scoreCap: number,
  roundMinutes: number,
  powerups: boolean,
  roundResult: RoundResult | null,
  selectedMap: string | null,
): void {
  roomPhase = phase;
  playersByTank = new Map(players.filter((p) => p.tankId >= 0).map((p) => [p.tankId, p]));
  myTankId = players.find((p) => p.connId === myConnId && p.tankId >= 0)?.tankId ?? -1;
  rebuildScoreRows([...playersByTank.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tankId, p]) => ({ tankId, name: p.name, color: p.color })));
  btnStart.classList.toggle('hidden', myConnId !== ownerConnId);
  const isLobbyPhase = phase === 'waiting' || phase === 'roundEnd';
  cfgRow.classList.toggle('hidden', !(isLobbyPhase && myConnId === ownerConnId));
  if (cfgTanks.value !== String(maxTanks)) cfgTanks.value = String(maxTanks);
  if (cfgDiff.value !== botDifficulty) cfgDiff.value = botDifficulty;
  if (cfgMap.value !== (selectedMap ?? '')) cfgMap.value = selectedMap ?? '';
  if (cfgScore.value !== String(scoreCap)) cfgScore.value = String(scoreCap);
  if (cfgMins.value !== String(roundMinutes)) cfgMins.value = String(roundMinutes);
  cfgPu.value = powerups ? 'on' : 'off';
  updateMapPreview(selectedMap);

  // M5：阶段切换音频（开场旋律 → BGM → 结算旋律）
  if (phase !== prevPhase) {
    if (phase === 'countdown') {
      audio.stopBgm();
      audio.jingle('start');
    } else if (phase === 'playing') {
      audio.startBgm();
    } else if (phase === 'roundEnd') {
      audio.stopBgm();
      audio.jingle('gameOver');
    } else {
      audio.stopBgm();
    }
    prevPhase = phase;
  }

  if (isLobbyPhase) {
    showPanel(lobbyEl);
    membersEl.replaceChildren(...players.map((p) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      const n = document.createElement('span');
      n.textContent = p.isBot && !p.online ? `${p.name}（托管）` : p.name;
      n.style.color = p.color;
      const tag = document.createElement('span');
      tag.textContent = p.isBot ? 'AI' : !p.online ? '离线' : p.connId === ownerConnId ? '房主' : '玩家';
      row.append(n, tag);
      return row;
    }));
    lobbyStatus.textContent = phase === 'roundEnd'
      ? '本局结束，房主可开始下一局'
      : `房间内 ${players.length}/${maxTanks} 坦克（真人 ${players.filter((p) => !p.isBot).length}）· 人数不足由 AI 补位`;
    if (phase === 'roundEnd' && roundResult) showRoundResult(roundResult);
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
  // 履带声（PRD §4）：本地坦克移动时持续低鸣
  const latestSnap = buffer.latest;
  if (latestSnap) {
    const mine = myTankId >= 0 ? latestSnap.tanks.find((t) => t.id === myTankId) : undefined;
    audio.engine(roomPhase === 'playing' && mine !== undefined && mine.alive && mine.moving);
  }

  const s: Snapshot | null = buffer.sample(INTERP_DELAY);
  if (s) {
    renderer.render({
      tick: s.tick,
      bullets: s.bullets,
      terrainAt: (cx, cy) => terrain.terrainAt(cx, cy),
      tanks: s.tanks.map((t) => ({ ...t, color: playersByTank.get(t.id)?.color ?? '#ffffff' })),
      base: onlineMap.base ?? null,
      baseAlive: s.baseAlive,
      powerups: s.powerups,
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
        row.score.textContent = `${name}  ${t.score}分 / ${t.kills}杀/${t.deaths}死 / ★${t.level}`;
        row.status.textContent = !t.alive ? '重生中…' : t.frozenTicks > 0 ? '冻结' : t.shieldTicks > 0 ? '护盾' : '存活';
      });
      roundTimerEl.textContent = roomPhase === 'playing' || roomPhase === 'countdown'
        ? fmtTime(latest.ticksLeft)
        : '—';
      renderFeed(onlineTick);
      refreshScoreboard();
    }
  }
}

// ---- 主循环 ----

btnSingle.addEventListener('click', () => { audio.unlock(); startSingle(); });
btnOnline.addEventListener('click', () => { audio.unlock(); goOnline(); });
btnStart.addEventListener('click', () => net.send({ t: 'start' }));
// 输入昵称时阻止游戏键位捕获（Space/方向键）
nickInput.addEventListener('keydown', (e) => e.stopPropagation());
nickInput.addEventListener('keyup', (e) => e.stopPropagation());

// ---- M5：地图选择/预览（FR-N3/U2）----
function updateMapPreview(selectedMap: string | null): void {
  const def = selectedMap ? mapByName(selectedMap) : undefined;
  mapPreview.classList.toggle('hidden', !def);
  if (def) drawMapPreview(mapPreview.getContext('2d')!, def, 5); // 26 小格 × 5px = 130
}
for (const [value, label] of [['', '随机轮换'], ...MAPS.map((m) => [m.name, m.name] as [string, string])]) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  cfgMap.appendChild(opt);
}
cfgMap.addEventListener('change', () => net.send({ t: 'config', map: cfgMap.value || null }));

// ---- M5：Tab 计分板（FR-U3）----
let scoreboardVisible = false;

interface ScoreRow { name: string; color: string; score: number; kills: number; deaths: number; level: number; status: string }

function collectScoreRows(): ScoreRow[] {
  if (mode === 'single') {
    return sim.tanks.map((t) => ({
      name: t.name, color: t.color, score: t.score, kills: t.kills, deaths: t.deaths, level: t.level,
      status: !t.alive ? '重生中' : t.frozenTicks > 0 ? '冻结' : t.shieldTicks > 0 ? '护盾' : '存活',
    }));
  }
  const latest = buffer.latest;
  if (!latest) return [];
  return latest.tanks.map((t) => ({
    name: playersByTank.get(t.id)?.name ?? `P${t.id}`,
    color: playersByTank.get(t.id)?.color ?? '#ffffff',
    score: t.score, kills: t.kills, deaths: t.deaths, level: t.level,
    status: !t.alive ? '重生中' : t.frozenTicks > 0 ? '冻结' : t.shieldTicks > 0 ? '护盾' : '存活',
  }));
}

function refreshScoreboard(): void {
  if (!scoreboardVisible) return;
  const rows = collectScoreRows().sort((a, b) => b.score - a.score);
  scoreboardBody.replaceChildren(...rows.map((r, i) => {
    const tr = document.createElement('tr');
    for (const text of [String(i + 1), r.name, `${r.score}`, String(r.kills), String(r.deaths), `★${r.level}`, r.status]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (text === r.name) td.style.color = r.color;
      tr.appendChild(td);
    }
    return tr;
  }));
}

function scoreboardAvailable(): boolean {
  if (mode === 'single') return !sim.gameOver;
  if (mode === 'online') return roomPhase === 'playing' || roomPhase === 'countdown';
  return false;
}

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab') return;
  if (!scoreboardAvailable()) return;
  e.preventDefault();
  scoreboardVisible = true;
  scoreboardEl.classList.add('show');
  refreshScoreboard();
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Tab') return;
  scoreboardVisible = false;
  scoreboardEl.classList.remove('show');
});

// ---- M5：音量设置（FR-S2，localStorage 持久化于 AudioFx 内）----
volSfx.value = String(Math.round(audio.sfxVolume * 100));
volMusic.value = String(Math.round(audio.musicVolume * 100));
volSfx.addEventListener('input', () => audio.setSfxVolume(Number(volSfx.value) / 100));
volMusic.addEventListener('input', () => audio.setMusicVolume(Number(volMusic.value) / 100));

// ---- M5：像素渲染整数缩放（FR-S2，1x~3x 自适应窗口）----
function applyScale(): void {
  // 画布旁有 240px HUD 侧栏，预留其宽度与边框/边距
  const availW = window.innerWidth - 264;
  const availH = window.innerHeight - 48;
  const scale = Math.max(1, Math.min(3, Math.floor(Math.min(availW, availH) / FIELD)));
  canvas.style.width = `${FIELD * scale}px`;
  canvas.style.height = `${FIELD * scale}px`;
}
window.addEventListener('resize', applyScale);
applyScale();

// ---- 房主配置（FR-N3）----
cfgTanks.addEventListener('change', () => net.send({ t: 'config', maxTanks: Number(cfgTanks.value) }));
cfgDiff.addEventListener('change', () => net.send({ t: 'config', botDifficulty: cfgDiff.value as BotDifficulty }));
cfgScore.addEventListener('change', () => net.send({ t: 'config', scoreCap: Number(cfgScore.value) }));
cfgMins.addEventListener('change', () => net.send({ t: 'config', roundMinutes: Number(cfgMins.value) }));
cfgPu.addEventListener('change', () => net.send({ t: 'config', powerups: cfgPu.value === 'on' }));

// ---- 大厅聊天 / 游戏内快捷短语（D4）----
btnChat.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') sendChat();
});
chatInput.addEventListener('keyup', (e) => e.stopPropagation());
window.addEventListener('keydown', (e) => {
  if (mode !== 'online' || (roomPhase !== 'playing' && roomPhase !== 'countdown')) return;
  const m = /^Digit([1-5])$/.exec(e.code);
  if (!m) return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return;
  net.send({ t: 'chat', text: QUICK_PHRASES[Number(m[1]) - 1]! });
});

// ---- 键位设置（FR-S1）----
function refreshBindButtons(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.bind-btn')) {
    btn.textContent = keys.getBind(btn.dataset.action as Action);
  }
}
btnKeys.addEventListener('click', () => {
  audio.unlock();
  menuEl.classList.remove('show');
  keysPanel.classList.add('show');
  refreshBindButtons();
});
btnKeysClose.addEventListener('click', () => {
  keysPanel.classList.remove('show');
  menuEl.classList.add('show');
});
for (const btn of document.querySelectorAll<HTMLButtonElement>('.bind-btn')) {
  btn.addEventListener('click', () => {
    keys.capturing = btn.dataset.action as Action;
    btn.textContent = '按任意键…';
  });
}
keys.onBindChange = refreshBindButtons;

// ---- 切后台/离开页面：立即清零输入，防止服务器保留最后一次输入导致坦克幽灵移动 ----
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'online' && lastSentMask !== 0) {
    net.send({ t: 'input', mask: 0 });
    lastSentMask = 0;
  }
});
window.addEventListener('pagehide', () => {
  if (mode === 'online') net.send({ t: 'input', mask: 0 });
});

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
        for (const b of bots) sim.setInput(b.tankId, b.update());
        sim.step();
        for (const e of sim.drainEvents()) {
          handleSimEvent(e, sim.tick, (id) => sim.tanks[id]?.name ?? '?');
        }
      }
      audio.engine(!sim.gameOver && (sim.tanks[0]?.moving ?? false)); // 履带声随移动开关
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
    renderer.render({
      tick: sim.tick,
      bullets: sim.bullets,
      tanks: sim.tanks,
      terrainAt: (cx, cy) => sim.terrainAt(cx, cy),
      base: sim.map.base,
      baseAlive: sim.baseAlive,
      powerups: sim.powerups,
    });
    if (--hudCd <= 0) { updateSingleHud(); refreshScoreboard(); hudCd = 10; }
  } else if (mode === 'online') {
    renderOnline();
  }
  requestAnimationFrame(frame);
}

showMenu();
requestAnimationFrame(frame);

