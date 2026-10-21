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
  /** 道具开关（FR-N3）：false 时无定点刷新、无闪红掉落 */
  powerups?: boolean;
}

export interface Tank extends TankState {
  spawnIndex: number;
  slideTicks: number;
  /** 坦克速度 px/tick（M5：真人 TANK_SPEED，AI 按难度档位） */
  speed: number;
  /** 闪红坦克（M5）：被击毁时原地掉落随机道具 */
  bonus: boolean;
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

  /** 回合剩余 tick（0 = 无限时）；联机大厅下发布局剩余时间用 */
  get remainingTicks(): number {
    return this.ticksLeft;
  }

  private readonly inputs: number[] = [];
  private readonly events: SimEvent[] = [];
  private readonly rng: () => number;
  private readonly scoreCap: number;
  private readonly powerupInterval: number;
  private readonly powerupsEnabled: boolean;
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
    this.powerupsEnabled = opts.powerups ?? true;
    this.baseAlive = this.map.base !== null;

    // P0 修复：出生点唯一分配（地图 spawns 不足时按行优先扫描安全空位兜底），
    // 避免 6/8 人开局时多辆坦克重叠在同一出生点而互相卡死
    const usedSpawns = new Set<number>();
    players.forEach((p, i) => {
      const n = this.map.spawns.length;
      let spawnIndex = -1;
      for (let k = 0; k < n; k++) {
        const idx = (i + k) % n;
        if (!usedSpawns.has(idx)) { spawnIndex = idx; break; }
      }
      let spawn: { x: number; y: number };
      if (spawnIndex >= 0) {
        spawn = this.map.spawns[spawnIndex]!;
      } else {
        spawn = this.findFreeSpot() ?? this.map.spawns[i % n]!;
        spawnIndex = i % n; // 兜底时复用索引；重生 findSpawn 会再做安全位扫描
      }
      usedSpawns.add(spawnIndex);
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
        spawnIndex,
        slideTicks: 0,
        speed: p.speed ?? TANK_SPEED,
        bonus: p.bonus ?? false,
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
        // 转向：原移动轴吸附半格（原版手感关键，见 FR-T1）；吸附前做碰撞校验
        this.trySnap(t);
        t.dir = wantDir;
      }
      this.moveTank(t, t.speed);
    } else if (t.slideTicks > 0) {
      // 冰面滑行惯性（FR-M5）
      t.slideTicks--;
      this.moveTank(t, t.speed);
      if (!t.moving) t.slideTicks = 0;
    } else {
      // 松开：移动轴吸附半格（带碰撞校验）；若在冰面上则开始滑行
      this.trySnap(t);
      if (this.isOnIce(t)) t.slideTicks = ICE_SLIDE_TICKS;
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

  /** 行优先扫描第一个可站位的 2×2 空位（出生点不足时的确定性兜底） */
  private findFreeSpot(): { x: number; y: number } | null {
    for (let cy = 0; cy <= this.map.size - 2; cy++) {
      for (let cx = 0; cx <= this.map.size - 2; cx++) {
        const x = cx * CELL;
        const y = cy * CELL;
        let blocked = false;
        for (const [bx, by] of cellsOfRect(x, y, TANK_SIZE, TANK_SIZE)) {
          const tt = terrainAt(this.map, bx, by);
          if (tt === TerrainType.Brick || tt === TerrainType.Steel || tt === TerrainType.Water) { blocked = true; break; }
        }
        if (blocked) continue;
        if (this.map.base &&
            rectsOverlap(x, y, TANK_SIZE, TANK_SIZE, this.map.base.x, this.map.base.y, TANK_SIZE, TANK_SIZE)) continue;
        if (this.tanks.some((o) => o.alive &&
            x < o.x + TANK_SIZE - 0.01 && x + TANK_SIZE > o.x + 0.01 &&
            y < o.y + TANK_SIZE - 0.01 && y + TANK_SIZE > o.y + 0.01)) continue;
        return { x, y };
      }
    }
    return null;
  }

  /** 吸附半格，但仅当吸附后位置无碰撞时生效（防止吸附把坦克推进另一辆坦克导致永久卡死） */
  private trySnap(t: Tank): void {
    if (isHorizontal(t.dir)) {
      const sx = snap(t.x);
      if (sx !== t.x && this.canOccupy(t, sx, t.y)) t.x = sx;
    } else {
      const sy = snap(t.y);
      if (sy !== t.y && this.canOccupy(t, t.x, sy)) t.y = sy;
    }
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

  /**
   * 砖墙损毁（FR-M1）：
   * - 常规弹：垂直于弹道 32px 宽 × 1 小格深条带；
   * - L3：以实际命中的砖格为锚点，摧毁其所属 2×2 大格（四方向行为一致）。
   */
  private destroyBrickStrip(b: Bullet): void {
    if (b.level >= MAX_LEVEL) {
      const hit = cellsOfRect(b.x, b.y, BULLET_SIZE, BULLET_SIZE)
        .find(([cx, cy]) => terrainAt(this.map, cx, cy) === TerrainType.Brick);
      if (hit) {
        const [hx, hy] = hit;
        const bx = Math.floor(hx / 2) * 2;
        const by = Math.floor(hy / 2) * 2;
        for (let cy = by; cy <= by + 1; cy++) {
          for (let cx = bx; cx <= bx + 1; cx++) {
            if (terrainAt(this.map, cx, cy) === TerrainType.Brick) {
              this.map.terrain[cy * this.map.size + cx] = TerrainType.Empty;
              this.events.push({ type: 'brickBreak', x: cx, y: cy });
            }
          }
        }
      }
      return;
    }

    const vertical = b.dir === Dir.Up || b.dir === Dir.Down;
    const rx = vertical ? b.x + BULLET_SIZE / 2 - CELL : b.x;
    const ry = vertical ? b.y : b.y + BULLET_SIZE / 2 - CELL;
    const rw = vertical ? TANK_SIZE : BULLET_SIZE;
    const rh = vertical ? BULLET_SIZE : TANK_SIZE;

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
      // 联机地形同步：钢墙恢复事件
      this.events.push({ type: 'terrainSet', cells: this.shovelBackup.map(([cx, cy, tt]) => ({ x: cx, y: cy, t: tt })) });
      this.shovelBackup = null;
    }

    // 道具开关（FR-N3）：关闭时不刷新、不拾取（场上不会有道具；铁锹恢复逻辑不受影响）
    if (!this.powerupsEnabled) return;

    // 定点刷新：同时在场 ≤ MAX_POWERUPS，地图需配置点位
    // 冷却恒定流转：满员/点位被占而跳过本轮时也照常重置，避免清空后重新等满一整段间隔（M4 修复）
    if (this.map.powerupSpots.length > 0 && --this.powerupCd <= 0) {
      this.powerupCd = this.powerupInterval;
      if (this.powerups.length < MAX_POWERUPS) {
        const spot = this.map.powerupSpots[Math.floor(this.rng() * this.map.powerupSpots.length)]!;
        const kinds = Object.values(PowerupType).filter((v): v is PowerupType => typeof v === 'number');
        const kind = kinds[Math.floor(this.rng() * kinds.length)]!;
        const occupied = this.tanks.some((t) => t.alive && rectsOverlap(t.x, t.y, TANK_SIZE, TANK_SIZE, spot.x, spot.y, TANK_SIZE, TANK_SIZE));
        if (!occupied) {
          this.powerups.push({ id: this.nextPowerupId++, type: kind, x: spot.x, y: spot.y });
        }
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
      case PowerupType.Bomb: // FR-P4：全图对手击毁，按击杀归属计分（护盾期内免疫，FR-T5/UT-P02）
        for (const o of [...this.tanks]) {
          if (o.id !== t.id && o.alive && o.shieldTicks <= 0) this.killTank(o, t.id);
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
        // 贴边基地：跳出场外的小格（越界索引会回绕破坏地形数组）
        if (cx < 0 || cy < 0 || cx >= this.map.size || cy >= this.map.size) continue;
        if (baseCells.has(`${cx},${cy}`)) continue;
        cells.push([cx, cy, terrainAt(this.map, cx, cy)]);
        this.map.terrain[cy * this.map.size + cx] = TerrainType.Steel;
      }
      this.shovelBackup = cells;
      // 联机地形同步：钢墙设置事件（客户端 TerrainView 应用）
      this.events.push({ type: 'terrainSet', cells: cells.map(([cx, cy]) => ({ x: cx, y: cy, t: TerrainType.Steel })) });
    }
    this.shovelTicks = SHOVEL_TICKS;
  }

  // ---------------------------------------------------------------- 击杀 / 结算

  /** 按 id 查找坦克（不依赖 id === 数组下标的隐式约定，M2 房间玩家进出时安全；M4 起 BotController 也经此寻址） */
  tankById(id: number): Tank | undefined {
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
    this.events.push({ type: 'kill', killerId: killerId, victimId: victim.id, x: cx, y: cy });

    // 闪红坦克掉落（M5，FR-P 适配）：原地掉落随机道具（与既有道具重叠时跳过；道具开关关闭时不掉落）
    if (victim.bonus && this.powerupsEnabled) {
      const overlapped = this.powerups.some((p) =>
        rectsOverlap(victim.x, victim.y, TANK_SIZE, TANK_SIZE, p.x, p.y, TANK_SIZE, TANK_SIZE));
      if (!overlapped) {
        const kinds = Object.values(PowerupType).filter((v): v is PowerupType => typeof v === 'number');
        const kind = kinds[Math.floor(this.rng() * kinds.length)]!;
        this.powerups.push({ id: this.nextPowerupId++, type: kind, x: victim.x, y: victim.y });
      }
    }
  }

  private endGame(winnerId: number | null): void {
    this.gameOver = true;
    this.winnerId = winnerId;
    this.events.push({ type: 'gameOver', winnerId });
  }
}