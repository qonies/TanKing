import {
  BULLET_SIZE,
  BULLET_SPEED_BY_LEVEL,
  CELL,
  Dir,
  DIR_VEC,
  FIELD,
  FREEZE_TICKS,
  GRID,
  HELMET_TICKS,
  ICE_SLIDE_TICKS,
  INPUT_FIRE,
  isHorizontal,
  MAX_BULLETS_BY_LEVEL,
  MAX_LEVEL,
  MAX_POWERUPS,
  POWERUP_INTERVAL_TICKS,
  RESPAWN_TICKS,
  SCORE_BASE,
  SCORE_CAP_DEFAULT,
  SCORE_KILL,
  SCORE_STAR_MAX,
  SCORE_TANK_POWERUP,
  SHIELD_TICKS,
  SHOVEL_TICKS,
  TANK_SIZE,
  TANK_SPEED,
  clamp,
  maskDir,
  snap,
} from '../constants';
import { cellsOfRect, loadMap, terrainAt } from '../map/loader';
import { mulberry32 } from '../rng';
import {
  PowerupType,
  TerrainType,
  type BulletState,
  type LoadedMap,
  type MapDef,
  type PlayerDef,
  type PowerupState,
  type SimEvent,
  type TankState,
} from '../types';

export interface SimOptions {
  seed?: number;
  /** 积分上限（0 = 无上限） */
  scoreCap?: number;
  /** 回合时长 tick（0 = 无限时） */
  timeTicks?: number;
  /** 道具刷新间隔 tick（测试可缩短） */
  powerupInterval?: number;
}

export interface Tank extends TankState {
  spawnIndex: number;
  slideTicks: number;
}

export interface Bullet extends BulletState {}

export interface Powerup extends PowerupState {}

export const PALETTE = ['#e8c838', '#d84040', '#58b858', '#5878d8', '#c868d8', '#d88838', '#40c8b8', '#c8c8c8'];

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * 战斗模拟器（服务器权威逻辑，单机模式在客户端本地跑同一份代码）。
 * 固定步长：外部每 tick 调用一次 step()（1/60s 虚拟时间）。
 * M3：坦克等级 0~3、六种道具、中立基地。
 */
export class BattleSim {
  readonly map: LoadedMap;
  readonly tanks: Tank[] = [];
  bullets: Bullet[] = [];
  powerups: Powerup[] = [];
  baseAlive: boolean;
  tick = 0;
  gameOver = false;
  winnerId: number | null = null;

  private readonly inputs: number[] = [];
  private readonly events: SimEvent[] = [];
  private readonly rng: () => number;
  private readonly scoreCap: number;
  private readonly powerupInterval: number;
  private ticksLeft: number;
  private nextBulletId = 1;
  private nextPowerupId = 1;
  private powerupCd: number;
  private shovelTicks = 0;
  private shovelBackup: [number, number, TerrainType][] | null = null;

  constructor(mapDef: MapDef, players: PlayerDef[], opts: SimOptions = {}) {
    this.map = loadMap(mapDef);
    this.rng = mulberry32(opts.seed ?? 0x2f6e2b1);
    this.scoreCap = opts.scoreCap ?? SCORE_CAP_DEFAULT;
    this.ticksLeft = opts.timeTicks ?? 0;
    this.powerupInterval = opts.powerupInterval ?? POWERUP_INTERVAL_TICKS;
    this.powerupCd = this.powerupInterval;
    this.baseAlive = this.map.base !== null;

    players.forEach((p, i) => {
      const spawn = this.map.spawns[i % this.map.spawns.length]!;
      this.tanks.push({
        id: i,
        name: p.name,
        isBot: p.isBot ?? false,
        color: p.color ?? PALETTE[i % PALETTE.length]!,
        x: spawn.x,
        y: spawn.y,
        dir: Dir.Up,
        moving: false,
        alive: true,
        shieldTicks: SHIELD_TICKS,
        respawnTicks: 0,
        level: 0,
        frozenTicks: 0,
        score: 0,
        kills: 0,
        deaths: 0,
        spawnIndex: i % this.map.spawns.length,
        slideTicks: 0,
      });
      this.inputs.push(0);
    });
  }

  /** 设置某坦克本 tick 的输入位掩码（真人与 AI 走同一通道） */
  setInput(tankId: number, mask: number): void {
    this.inputs[tankId] = mask & 0xff;
  }

  /** 取走事件队列（渲染/网络层消费） */
  drainEvents(): SimEvent[] {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }

  terrainAt(cx: number, cy: number): TerrainType {
    return terrainAt(this.map, cx, cy);
  }

  /** 推进一个固定 tick（1/60s） */
  step(): void {
    if (this.gameOver) return;
    this.tick++;

    for (const t of this.tanks) this.stepTank(t);
    this.stepBullets();
    this.stepPowerups();

    // 胜负判定（D1：先达积分上限者胜；限时耗尽按积分最高者胜）
    if (this.scoreCap > 0) {
      const reached = this.tanks.find((t) => t.score >= this.scoreCap);
      if (reached) return this.endGame(reached.id);
    }
    if (this.ticksLeft > 0 && --this.ticksLeft === 0) {
      let best: Tank | null = null;
      let tie = false;
      for (const t of this.tanks) {
        if (!best || t.score > best.score) { best = t; tie = false; }
        else if (t.score === best.score) tie = true;
      }
      this.endGame(tie ? null : best!.id);
    }
  }

  // ---------------------------------------------------------------- 坦克

  private stepTank(t: Tank): void {
    if (!t.alive) {
      if (--t.respawnTicks <= 0) this.respawn(t);
      return;
    }
    if (t.shieldTicks > 0) t.shieldTicks--;
    if (t.frozenTicks > 0) {
      // 定时器冻结（FR-P3）：不可移动 / 开火，滑行中断
      t.frozenTicks--;
      t.slideTicks = 0;
      t.moving = false;
      return;
    }

    const mask = this.inputs[t.id] ?? 0;
    const wantDir = maskDir(mask);

    if (wantDir !== null) {
      t.slideTicks = 0;
      if (wantDir !== t.dir) {
        // 转向：原移动轴吸附半格（原版手感关键，见 FR-T1）
        if (isHorizontal(t.dir)) t.x = snap(t.x);
        else t.y = snap(t.y);
        t.dir = wantDir;
      }
      this.moveTank(t, TANK_SPEED);
    } else if (t.slideTicks > 0) {
      // 冰面滑行惯性（FR-M5）
      t.slideTicks--;
      this.moveTank(t, TANK_SPEED);
      if (!t.moving) t.slideTicks = 0;
    } else {
      // 松开：移动轴吸附半格；若在冰面上则开始滑行
      if (isHorizontal(t.dir)) {
        t.x = snap(t.x);
        if (this.isOnIce(t)) t.slideTicks = ICE_SLIDE_TICKS;
      } else {
        t.y = snap(t.y);
        if (this.isOnIce(t)) t.slideTicks = ICE_SLIDE_TICKS;
      }
      t.moving = false;
    }

    // 射击（同屏弹量按等级，FR-T2/T4）
    if (mask & INPUT_FIRE) {
      const myBullets = this.bullets.reduce((n, b) => n + (b.ownerId === t.id ? 1 : 0), 0);
      if (myBullets < MAX_BULLETS_BY_LEVEL[t.level]!) this.spawnBullet(t);
    }
  }

  private moveTank(t: Tank, dist: number): void {
    const v = DIR_VEC[t.dir]!;
    const nx = clamp(t.x + v.x * dist, 0, FIELD - TANK_SIZE);
    const ny = clamp(t.y + v.y * dist, 0, FIELD - TANK_SIZE);
    if (this.canOccupy(t, nx, ny)) {
      t.x = nx;
      t.y = ny;
      t.moving = v.x !== 0 || v.y !== 0;
    } else {
      t.moving = false;
    }
  }

  /** 坦克 AABB 能否占据 (x,y)：受砖/钢/水/基地阻挡（树/冰不阻挡），坦克互为障碍 */
  private canOccupy(self: Tank, x: number, y: number): boolean {
    for (const [cx, cy] of cellsOfRect(x, y, TANK_SIZE, TANK_SIZE)) {
      const tt = terrainAt(this.map, cx, cy);
      if (tt === TerrainType.Brick || tt === TerrainType.Steel || tt === TerrainType.Water) return false;
    }
    if (this.baseAlive && this.map.base &&
        rectsOverlap(x, y, TANK_SIZE, TANK_SIZE, this.map.base.x, this.map.base.y, TANK_SIZE, TANK_SIZE)) {
      return false; // 基地为实体障碍
    }
    for (const o of this.tanks) {
      if (o === self || !o.alive) continue;
      if (x < o.x + TANK_SIZE - 0.01 && x + TANK_SIZE > o.x + 0.01 &&
          y < o.y + TANK_SIZE - 0.01 && y + TANK_SIZE > o.y + 0.01) return false;
    }
    return true;
  }

  private isOnIce(t: Tank): boolean {
    const cx = Math.floor((t.x + TANK_SIZE / 2) / CELL);
    const cy = Math.floor((t.y + TANK_SIZE / 2) / CELL);
    return terrainAt(this.map, cx, cy) === TerrainType.Ice;
  }

  private respawn(t: Tank): void {
    const spot = this.findSpawn(t);
    t.x = spot.x;
    t.y = spot.y;
    t.dir = Dir.Up;
    t.alive = true;
    t.moving = false;
    t.shieldTicks = SHIELD_TICKS;
    t.frozenTicks = 0;
    t.slideTicks = 0;
  }

  /** 重生点：优先自己出生点 → 其他出生点 → 随机安全位（PRNG 保证可复现） */
  private findSpawn(t: Tank): { x: number; y: number } {
    const own = this.map.spawns[t.spawnIndex]!;
    if (this.canOccupy(t, own.x, own.y)) return own;
    for (const p of this.map.spawns) {
      if (this.canOccupy(t, p.x, p.y)) return p;
    }
    for (let tries = 0; tries < 200; tries++) {
      const x = Math.floor(this.rng() * (GRID - 1)) * CELL;
      const y = Math.floor(this.rng() * (GRID - 1)) * CELL;
      if (this.canOccupy(t, x, y)) return { x, y };
    }
    // 最终兜底：全场顺序扫描，保证重生点不与其他坦克重叠（确定性，不消耗 PRNG）
    for (let cy = 0; cy <= GRID - 2; cy++) {
      for (let cx = 0; cx <= GRID - 2; cx++) {
        const px = cx * CELL;
        const py = cy * CELL;
        if (this.canOccupy(t, px, py)) return { x: px, y: py };
      }
    }
    return own;
  }

  // ---------------------------------------------------------------- 子弹

  private spawnBullet(t: Tank): void {
    const v = DIR_VEC[t.dir]!;
    const cx = t.x + TANK_SIZE / 2;
    const cy = t.y + TANK_SIZE / 2;
    this.bullets.push({
      id: this.nextBulletId++,
      ownerId: t.id,
      dir: t.dir,
      level: t.level,
      x: cx - BULLET_SIZE / 2 + v.x * (TANK_SIZE / 2),
      y: cy - BULLET_SIZE / 2 + v.y * (TANK_SIZE / 2),
    });
    this.events.push({ type: 'shoot', x: cx, y: cy });
  }

  private stepBullets(): void {
    const alive: Bullet[] = [];
    for (const b of this.bullets) {
      const v = DIR_VEC[b.dir]!;
      const speed = BULLET_SPEED_BY_LEVEL[b.level]!;
      b.x += v.x * speed;
      b.y += v.y * speed;

      // 出界
      if (b.x <= -BULLET_SIZE || b.y <= -BULLET_SIZE || b.x >= FIELD || b.y >= FIELD) {
        this.events.push({ type: 'explosion', x: clamp(b.x + BULLET_SIZE / 2, 0, FIELD), y: clamp(b.y + BULLET_SIZE / 2, 0, FIELD), big: false });
        continue;
      }
      if (this.bulletVsBase(b)) continue;
      if (this.bulletVsTerrain(b)) continue;
      if (this.bulletVsTank(b)) continue;
      alive.push(b);
    }

    // 子弹互消（FR-T2，含擦边；同主 bullets 不互消 —— L2 双发的前提）
    const dead = new Set<number>();
    for (let i = 0; i < alive.length; i++) {
      if (dead.has(i)) continue;
      const a = alive[i]!;
      for (let j = i + 1; j < alive.length; j++) {
        if (dead.has(j)) continue;
        const c = alive[j]!;
        if (a.ownerId === c.ownerId) continue;
        if (a.x <= c.x + BULLET_SIZE && a.x + BULLET_SIZE >= c.x &&
            a.y <= c.y + BULLET_SIZE && a.y + BULLET_SIZE >= c.y) {
          dead.add(i);
          dead.add(j);
          this.events.push({ type: 'explosion', x: (a.x + c.x) / 2 + BULLET_SIZE / 2, y: (a.y + c.y) / 2 + BULLET_SIZE / 2, big: false });
        }
      }
    }
    this.bullets = alive.filter((_, idx) => !dead.has(idx));
  }

  // ---------------------------------------------------------------- 地形 / 基地

  /** 子弹 vs 地形：砖按小格损毁（32px 宽条带；L3 整大格），钢挡弹（L3 可毁） */
  private bulletVsTerrain(b: Bullet): boolean {
    let hitBrick = false;
    let hitSteel = false;
    for (const [cx, cy] of cellsOfRect(b.x, b.y, BULLET_SIZE, BULLET_SIZE)) {
      const tt = terrainAt(this.map, cx, cy);
      if (tt === TerrainType.Brick) hitBrick = true;
      else if (tt === TerrainType.Steel) hitSteel = true;
    }
    if (!hitBrick && !hitSteel) return false;

    if (hitBrick) this.destroyBrickStrip(b);
    if (b.level >= MAX_LEVEL && hitSteel) this.destroySteel(b);
    this.events.push({
      type: 'explosion',
      x: clamp(b.x + BULLET_SIZE / 2, 0, FIELD),
      y: clamp(b.y + BULLET_SIZE / 2, 0, FIELD),
      big: false,
    });
    return true;
  }

  /** 砖墙损毁条带：垂直于飞行方向 32px 宽；L3 深度扩展为整大格（FR-M1） */
  private destroyBrickStrip(b: Bullet): void {
    const vertical = b.dir === Dir.Up || b.dir === Dir.Down;
    let rx = vertical ? b.x + BULLET_SIZE / 2 - CELL : b.x;
    let ry = vertical ? b.y : b.y + BULLET_SIZE / 2 - CELL;
    let rw = vertical ? TANK_SIZE : BULLET_SIZE;
    let rh = vertical ? BULLET_SIZE : TANK_SIZE;
    if (b.level >= MAX_LEVEL) {
      // L3：深度扩展为完整大格（2×2 小格）
      if (vertical) { ry = Math.floor(ry / TANK_SIZE) * TANK_SIZE; rh = TANK_SIZE; }
      else { rx = Math.floor(rx / TANK_SIZE) * TANK_SIZE; rw = TANK_SIZE; }
    }

    for (const [cx, cy] of cellsOfRect(rx, ry, rw, rh)) {
      if (terrainAt(this.map, cx, cy) === TerrainType.Brick) {
        this.map.terrain[cy * this.map.size + cx] = TerrainType.Empty;
        this.events.push({ type: 'brickBreak', x: cx, y: cy });
      }
    }
  }

  /** L3 破钢：摧毁子弹接触的钢墙小格（FR-M2） */
  private destroySteel(b: Bullet): void {
    for (const [cx, cy] of cellsOfRect(b.x, b.y, BULLET_SIZE, BULLET_SIZE)) {
      if (terrainAt(this.map, cx, cy) === TerrainType.Steel) {
        this.map.terrain[cy * this.map.size + cx] = TerrainType.Empty;
        this.events.push({ type: 'brickBreak', x: cx, y: cy });
      }
    }
  }

  /** 子弹 vs 基地：摧毁 +500 分，回合不结束（FR-M6/D2） */
  private bulletVsBase(b: Bullet): boolean {
    if (!this.baseAlive || !this.map.base) return false;
    const base = this.map.base;
    if (!rectsOverlap(b.x, b.y, BULLET_SIZE, BULLET_SIZE, base.x, base.y, TANK_SIZE, TANK_SIZE)) return false;

    this.baseAlive = false;
    const killer = this.tankById(b.ownerId);
    if (killer) killer.score += SCORE_BASE;
    this.events.push({ type: 'explosion', x: base.x + TANK_SIZE / 2, y: base.y + TANK_SIZE / 2, big: true });
    this.events.push({ type: 'baseDestroyed', byId: b.ownerId, x: base.x + TANK_SIZE / 2, y: base.y + TANK_SIZE / 2 });
    return true;
  }

  /** 子弹 vs 坦克：命中护盾/冻结坦克弹消失；命中普通坦克击毁（击杀者 +100 分，D6 降 1 级） */
  private bulletVsTank(b: Bullet): boolean {
    for (const t of this.tanks) {
      if (!t.alive || t.id === b.ownerId) continue;
      if (b.x < t.x + TANK_SIZE && b.x + BULLET_SIZE > t.x &&
          b.y < t.y + TANK_SIZE && b.y + BULLET_SIZE > t.y) {
        if (t.shieldTicks <= 0) this.killTank(t, b.ownerId);
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- 道具

  private stepPowerups(): void {
    // 铁锹到期恢复原状（FR-P5）
    if (this.shovelTicks > 0 && --this.shovelTicks === 0 && this.shovelBackup) {
      for (const [cx, cy, tt] of this.shovelBackup) {
        this.map.terrain[cy * this.map.size + cx] = tt;
      }
      this.shovelBackup = null;
    }

    // 定点刷新：同时在场 ≤ MAX_POWERUPS，地图需配置点位
    if (this.powerups.length < MAX_POWERUPS && this.map.powerupSpots.length > 0 && --this.powerupCd <= 0) {
      this.powerupCd = this.powerupInterval;
      const spot = this.map.powerupSpots[Math.floor(this.rng() * this.map.powerupSpots.length)]!;
      const kinds = Object.values(PowerupType).filter((v): v is PowerupType => typeof v === 'number');
      const kind = kinds[Math.floor(this.rng() * kinds.length)]!;
      const occupied = this.tanks.some((t) => t.alive && rectsOverlap(t.x, t.y, TANK_SIZE, TANK_SIZE, spot.x, spot.y, TANK_SIZE, TANK_SIZE));
      if (!occupied) {
        this.powerups.push({ id: this.nextPowerupId++, type: kind, x: spot.x, y: spot.y });
      }
    }

    // 拾取（AABB 重叠；冻结坦克不能拾取）
    for (const t of this.tanks) {
      if (!t.alive || t.frozenTicks > 0) continue;
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i]!;
        if (rectsOverlap(t.x, t.y, TANK_SIZE, TANK_SIZE, p.x, p.y, TANK_SIZE, TANK_SIZE)) {
          this.powerups.splice(i, 1);
          this.applyPowerup(t, p.type, p.x + TANK_SIZE / 2, p.y + TANK_SIZE / 2);
        }
      }
    }
  }

  private applyPowerup(t: Tank, kind: PowerupType, x: number, y: number): void {
    switch (kind) {
      case PowerupType.Star: // FR-P1
        if (t.level < MAX_LEVEL) t.level++;
        else t.score += SCORE_STAR_MAX; // 满级星星改 +100 分
        break;
      case PowerupType.Helmet: // FR-P2
        t.shieldTicks = HELMET_TICKS;
        break;
      case PowerupType.Timer: // FR-P3：冻结所有对手
        for (const o of this.tanks) {
          if (o.id !== t.id && o.alive) o.frozenTicks = FREEZE_TICKS;
        }
        break;
      case PowerupType.Bomb: // FR-P4：全图对手击毁，按击杀归属计分
        for (const o of [...this.tanks]) {
          if (o.id !== t.id && o.alive) this.killTank(o, t.id);
        }
        break;
      case PowerupType.Shovel: // FR-P5
        this.activateShovel();
        break;
      case PowerupType.Tank: // FR-P6
        t.score += SCORE_TANK_POWERUP;
        break;
    }
    this.events.push({ type: 'powerupPickup', tankId: t.id, kind, x, y });
  }

  /** 铁锹：基地周围一圈变钢墙，到期恢复原状（首次激活时备份） */
  private activateShovel(): void {
    const base = this.map.base;
    if (!base) return;
    if (this.shovelTicks <= 0) {
      const cells: [number, number, TerrainType][] = [];
      const baseCells = new Set(cellsOfRect(base.x, base.y, TANK_SIZE, TANK_SIZE).map(([x, y]) => `${x},${y}`));
      for (const [cx, cy] of cellsOfRect(base.x - CELL, base.y - CELL, TANK_SIZE + 2 * CELL, TANK_SIZE + 2 * CELL)) {
        if (baseCells.has(`${cx},${cy}`)) continue;
        cells.push([cx, cy, terrainAt(this.map, cx, cy)]);
        this.map.terrain[cy * this.map.size + cx] = TerrainType.Steel;
      }
      this.shovelBackup = cells;
    }
    this.shovelTicks = SHOVEL_TICKS;
  }

  // ---------------------------------------------------------------- 击杀 / 结算

  /** 按 id 查找坦克（不依赖 id === 数组下标的隐式约定，M2 房间玩家进出时安全） */
  private tankById(id: number): Tank | undefined {
    return this.tanks.find((t) => t.id === id);
  }

  private killTank(victim: Tank, killerId: number): void {
    victim.alive = false;
    victim.moving = false;
    victim.slideTicks = 0;
    victim.respawnTicks = RESPAWN_TICKS;
    victim.deaths++;
    victim.level = Math.max(0, victim.level - 1); // D6：被击毁降 1 级

    const killer = this.tankById(killerId);
    if (killer) {
      killer.score += SCORE_KILL;
      killer.kills++;
    }
    const cx = victim.x + TANK_SIZE / 2;
    const cy = victim.y + TANK_SIZE / 2;
    this.events.push({ type: 'explosion', x: cx, y: cy, big: true });
    this.events.push({ type: 'kill', killerId, victimId: victim.id, x: cx, y: cy });
  }

  private endGame(winnerId: number | null): void {
    this.gameOver = true;
    this.winnerId = winnerId;
    this.events.push({ type: 'gameOver', winnerId });
  }
}