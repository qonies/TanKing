import {
  BULLET_SIZE,
  CELL,
  Dir,
  FIELD,
  GRID,
  TANK_SIZE,
} from '../shared/constants';
import { PowerupType, TerrainType, type MapDef, type SimEvent } from '../shared/types';
import { loadMap } from '../shared/map/loader';

interface Fx { x: number; y: number; big: boolean; t: number }

/** 渲染视图抽象：单机模式直接传 BattleSim 适配视图，联机模式传插值快照视图 */
export interface RenderTank {
  x: number;
  y: number;
  dir: Dir;
  alive: boolean;
  shieldTicks: number;
  frozenTicks: number;
  color: string;
  /** 闪红坦克（M5）：与普通颜色交替闪烁渲染 */
  bonus?: boolean;
}

export interface RenderPowerup {
  x: number;
  y: number;
  type: number;
}

export interface RenderView {
  tick: number;
  bullets: readonly { x: number; y: number }[];
  tanks: readonly RenderTank[];
  terrainAt(cx: number, cy: number): TerrainType;
  base: { x: number; y: number } | null;
  baseAlive: boolean;
  powerups: readonly RenderPowerup[];
}

const COLORS: Record<TerrainType, string> = {
  [TerrainType.Empty]: '#000000',
  [TerrainType.Brick]: '#b53121',
  [TerrainType.Steel]: '#9c9c9c',
  [TerrainType.Water]: '#1a4fd6',
  [TerrainType.Trees]: '#0a7a0a',
  [TerrainType.Ice]: '#a8d8f0',
};

/** Canvas 分层渲染器（M1 占位色块绘制；图层顺序见技术路线 §6） */
export class Renderer {
  private fx: Fx[] = [];

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  pushEvent(e: SimEvent): void {
    if (e.type === 'explosion') this.fx.push({ x: e.x, y: e.y, big: e.big, t: 0 });
  }

  clearFx(): void {
    this.fx.length = 0;
  }

  render(view: RenderView): void {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;

    // 1. 地面
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FIELD, FIELD);

    // 2. 冰面 / 水面（坦克层之下）
    for (let cy = 0; cy < GRID; cy++) {
      for (let cx = 0; cx < GRID; cx++) {
        const tt = view.terrainAt(cx, cy);
        if (tt === TerrainType.Ice) {
          ctx.fillStyle = COLORS[TerrainType.Ice];
          ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
        } else if (tt === TerrainType.Water) {
          ctx.fillStyle = COLORS[TerrainType.Water];
          ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
          ctx.fillStyle = '#4a8cf0';
          ctx.fillRect(cx * CELL + 2, cy * CELL + 6, 5, 2);
          ctx.fillRect(cx * CELL + 9, cy * CELL + 11, 5, 2);
        }
      }
    }

    // 2.5 基地（FR-M6）与道具（地面层，坦克之下）
    if (view.base) this.drawBase(view.base.x, view.base.y, view.baseAlive);
    for (const p of view.powerups) this.drawPowerup(p.x, p.y, p.type);

    // 3. 子弹 → 坦克（含护盾）
    for (const b of view.bullets) {
      ctx.fillStyle = '#f8f8f8';
      ctx.fillRect(Math.round(b.x), Math.round(b.y), BULLET_SIZE, BULLET_SIZE);
    }
    for (const t of view.tanks) {
      if (!t.alive) continue;
      // 闪红坦克（M5）：红色与本体色交替闪烁（原版掉落道具坦克的视觉提示）
      const color = t.bonus && view.tick % 16 < 8 ? '#f05050' : t.color;
      this.drawTank(t.x, t.y, t.dir, color);
      if (t.shieldTicks > 0) this.drawShield(t.x, t.y, view.tick % 8 < 4);
      if (t.frozenTicks > 0) {
        ctx.fillStyle = 'rgba(140, 210, 255, 0.55)';
        ctx.fillRect(t.x, t.y, TANK_SIZE, TANK_SIZE);
      }
    }

    // 4. 砖 / 钢（坦克层之上）
    for (let cy = 0; cy < GRID; cy++) {
      for (let cx = 0; cx < GRID; cx++) {
        const tt = view.terrainAt(cx, cy);
        if (tt === TerrainType.Brick) {
          ctx.fillStyle = COLORS[TerrainType.Brick];
          ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
          ctx.fillStyle = '#7a1f12';
          ctx.fillRect(cx * CELL, cy * CELL + 7, CELL, 2);
          ctx.fillRect(cx * CELL + (cy % 2 === 0 ? 7 : 0), cy * CELL, 2, 7);
        } else if (tt === TerrainType.Steel) {
          ctx.fillStyle = COLORS[TerrainType.Steel];
          ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
          ctx.fillStyle = '#e0e0e0';
          ctx.fillRect(cx * CELL + 3, cy * CELL + 3, CELL - 6, CELL - 6);
          ctx.fillStyle = '#5a5a5a';
          ctx.fillRect(cx * CELL + 5, cy * CELL + 5, CELL - 10, CELL - 10);
        }
      }
    }

    // 5. 树林（最上层遮挡，FR-M4）
    for (let cy = 0; cy < GRID; cy++) {
      for (let cx = 0; cx < GRID; cx++) {
        if (view.terrainAt(cx, cy) === TerrainType.Trees) {
          ctx.fillStyle = COLORS[TerrainType.Trees];
          ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
          ctx.fillStyle = '#0c9c0c';
          ctx.fillRect(cx * CELL + 2, cy * CELL + 2, 5, 5);
          ctx.fillRect(cx * CELL + 9, cy * CELL + 8, 5, 5);
        }
      }
    }

    // 6. 爆炸特效
    this.drawFx();
  }

  private drawBase(x: number, y: number, alive: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = alive ? '#caa53d' : '#3a3a3a';
    ctx.fillRect(x + 2, y + 2, TANK_SIZE - 4, TANK_SIZE - 4);
    ctx.strokeStyle = '#6b5410';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 4, y + 4, TANK_SIZE - 8, TANK_SIZE - 8);
    ctx.fillStyle = alive ? '#6b5410' : '#191919';
    ctx.font = '14px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(alive ? '鹰' : '×', x + TANK_SIZE / 2, y + TANK_SIZE / 2 + 1);
  }

  private static readonly POWERUP_STYLE: Record<number, { bg: string; ch: string }> = {
    [PowerupType.Star]: { bg: '#e8c838', ch: '★' },
    [PowerupType.Helmet]: { bg: '#5878d8', ch: '盔' },
    [PowerupType.Timer]: { bg: '#58b858', ch: '钟' },
    [PowerupType.Bomb]: { bg: '#d84040', ch: '爆' },
    [PowerupType.Shovel]: { bg: '#c868d8', ch: '锹' },
    [PowerupType.Tank]: { bg: '#40c8b8', ch: '坦' },
  };

  private drawPowerup(x: number, y: number, type: number): void {
    const ctx = this.ctx;
    const style = Renderer.POWERUP_STYLE[type] ?? { bg: '#c8c8c8', ch: '?' };
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(x, y, TANK_SIZE, TANK_SIZE);
    ctx.fillStyle = style.bg;
    ctx.fillRect(x + 3, y + 3, TANK_SIZE - 6, TANK_SIZE - 6);
    ctx.fillStyle = '#111';
    ctx.font = '16px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.ch, x + TANK_SIZE / 2, y + TANK_SIZE / 2 + 1);
  }

  private drawTank(x: number, y: number, dir: Dir, color: string): void {
    const ctx = this.ctx;
    const cx = x + TANK_SIZE / 2;
    const cy = y + TANK_SIZE / 2;
    ctx.save();
    ctx.translate(Math.round(cx), Math.round(cy));
    ctx.rotate(dir * Math.PI / 2);
    // 履带
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(-13, -14, 7, 28);
    ctx.fillRect(6, -14, 7, 28);
    // 车体
    ctx.fillStyle = color;
    ctx.fillRect(-6, -10, 12, 20);
    // 炮管
    ctx.fillRect(-2, -16, 4, 12);
    ctx.restore();
  }

  private drawShield(x: number, y: number, blinkOn: boolean): void {
    if (!blinkOn) return;
    const ctx = this.ctx;
    ctx.strokeStyle = '#f8f8f8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + TANK_SIZE / 2, y + TANK_SIZE / 2, TANK_SIZE / 2 + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawFx(): void {
    const ctx = this.ctx;
    for (const f of this.fx) {
      const max = f.big ? 24 : 12;
      const p = f.t / max;
      if (f.big) {
        const r = 6 + p * 14;
        ctx.fillStyle = p < 0.4 ? '#f8f8f8' : p < 0.75 ? '#e87818' : '#7a3a0a';
        ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
        ctx.fillStyle = '#f8d838';
        ctx.fillRect(f.x - r / 2, f.y - r / 2, r, r);
      } else {
        const r = 3 + p * 5;
        ctx.fillStyle = p < 0.5 ? '#f8f8f8' : '#e87818';
        ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      }
    }
    this.fx = this.fx.filter((f) => ++f.t < (f.big ? 24 : 12));
  }
}

/** 大厅地图预览（M5，FR-U2）：按 cellPx 像素/小格绘制地图初始地形与基地位置 */
export function drawMapPreview(ctx: CanvasRenderingContext2D, mapDef: MapDef, cellPx: number): void {
  const loaded = loadMap(mapDef);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, loaded.size * cellPx, loaded.size * cellPx);
  for (let cy = 0; cy < loaded.size; cy++) {
    for (let cx = 0; cx < loaded.size; cx++) {
      const tt = loaded.terrain[cy * loaded.size + cx]! as TerrainType;
      if (tt === TerrainType.Empty) continue;
      ctx.fillStyle = COLORS[tt];
      ctx.fillRect(cx * cellPx, cy * cellPx, cellPx, cellPx);
    }
  }
  if (loaded.base) {
    ctx.fillStyle = '#caa53d';
    ctx.fillRect(loaded.base.x / CELL * cellPx, loaded.base.y / CELL * cellPx, 2 * cellPx, 2 * cellPx);
  }
}
