import { chitEtaMinutes, formatClock, minutesToReinforcement, type Chit, type Front } from '../strategic/front';
import { cellIndex, cellXY, type CellTerrain, type SectorMap } from '../strategic/sector';

const TERRAIN_COLORS: Record<CellTerrain, string> = {
  open: '#5a6b4c',
  woods: '#384630',
  town: '#7d6f5c',
  river: '#46647a',
  bridge: '#8f7550',
  road: '#8c8371',
};

const MAP_BG = '#211d16';
const GRID_LINE = 'rgba(18, 20, 14, 0.22)';
const FRONT_LINE = '#c2a67c';
const OWNER_TINT: Record<'blue' | 'red', string> = {
  blue: 'rgba(70, 110, 180, 0.16)',
  red: 'rgba(180, 70, 70, 0.16)',
};

// Deterministic per-cell texture hash (cell index + salt) -> [0,1). Never
// Math.random in the per-frame draw path — this view redraws every frame.
function cellHash(i: number, salt: number): number {
  let h = (i * 374761393 + salt * 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const TERRAIN_LABELS: Record<CellTerrain, string> = {
  open: 'Open ground',
  woods: 'Woods',
  town: 'Town',
  river: 'River',
  bridge: 'Bridge',
  road: 'Road',
};
const TERRAIN_ORDER: CellTerrain[] = ['open', 'woods', 'town', 'river', 'bridge', 'road'];

const PANEL_BG = 'rgba(18, 22, 15, 0.88)';
const PANEL_BORDER = '#4a5240';
const CREAM = '#e8e4d8';
const MUTED = '#8a8a74';
const AMBER = '#ffca6a';
const AMBER_BRIGHT = '#ffe9a0';
const BLUE = '#5b9bd5';
const RED = '#d05c50';

const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Angle on the header 24h ring for a minutes-of-day value: noon at top,
// midnight at bottom, 06:00/18:00 on the horizon ends. Marker position:
// x = cx + r*sin(a), y = cy - r*cos(a).
export function timeOfDayAngle(minOfDay: number): number {
  return ((((minOfDay % 1440) + 1440) % 1440) - 720) / 1440 * Math.PI * 2;
}

const HEADER_H = 34;
const FOOTER_H = 24;
const HINT_TEXT = 'SPACE pause  ·  1/2/3 speed  ·  click select  ·  right-click move  ·  ESC deselect';

export class StrategicView {
  private flashMsg: string | null = null;
  private flashUntil = 0;
  stagedCell = -1; // engagement-staging highlight; -1 = none

  constructor(readonly sector: SectorMap) {}

  // Transient banner (e.g. reinforcement arrivals); replaces any flash in progress.
  flash(msg: string): void {
    this.flashMsg = msg;
    this.flashUntil = performance.now() + 6000;
  }

  layout(canvasW: number, canvasH: number): { size: number; ox: number; oy: number } {
    const size = Math.max(4, Math.floor(Math.min(canvasW / this.sector.w, (canvasH - HEADER_H - FOOTER_H) / this.sector.h)));
    return { size, ox: Math.floor((canvasW - size * this.sector.w) / 2), oy: HEADER_H };
  }

  cellAtScreen(px: number, py: number, canvasW: number, canvasH: number): number {
    const { size, ox, oy } = this.layout(canvasW, canvasH);
    const x = Math.floor((px - ox) / size);
    const y = Math.floor((py - oy) / size);
    if (x < 0 || y < 0 || x >= this.sector.w || y >= this.sector.h) return -1;
    return y * this.sector.w + x;
  }

  draw(ctx: CanvasRenderingContext2D, front: Front, selectedChitId: number, paused: boolean, speed: number, canvasW: number, canvasH: number): void {
    const { size, ox, oy } = this.layout(canvasW, canvasH);
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, canvasW, canvasH);
    for (let i = 0; i < this.sector.cells.length; i++) {
      const cell = this.sector.cells[i];
      const { x, y } = cellXY(this.sector, i);
      const gx = ox + x * size;
      const gy = oy + y * size;
      ctx.fillStyle = TERRAIN_COLORS[cell.terrain];
      ctx.fillRect(gx, gy, size, size);
      this.drawCellTexture(ctx, i, cell.terrain, gx, gy, size);
      if (cell.owner) {
        ctx.fillStyle = OWNER_TINT[cell.owner];
        ctx.fillRect(gx, gy, size, size);
      }
    }
    this.drawGridAndFrontLine(ctx, size, ox, oy);
    this.drawObjectives(ctx, front, size, ox, oy);
    if (this.stagedCell >= 0 && this.stagedCell < this.sector.cells.length) this.drawStagedCell(ctx, front, size, ox, oy);

    const selected = front.chits.find((c) => c.id === selectedChitId);
    if (selected && selected.path.length > 0) this.drawPathPreview(ctx, selected, size, ox, oy);

    for (const chit of front.chits) {
      const { x, y } = cellXY(this.sector, chit.cell);
      const cx = ox + x * size;
      const cy = oy + y * size;
      const bx = cx + 2;
      const by = cy + 2;
      const bw = size - 5;
      const bh = size - 5;
      ctx.fillStyle = chit.side === 'blue' ? '#3a5a9a' : '#9a3a3a';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = 'rgba(232, 228, 216, 0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

      ctx.fillStyle = CREAM;
      ctx.textBaseline = 'alphabetic';
      ctx.font = `${Math.max(8, size * 0.45)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(chit.name[0], cx + size / 2, cy + size * 0.5);

      const barH = 3;
      const barW = Math.max(0, bw - 4);
      const barX = bx + 2;
      const barY = by + bh - barH - 2;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(barX, barY, barW, barH);
      const frac = Math.max(0, Math.min(1, chit.strength / 27));
      ctx.fillStyle = chit.side === 'blue' ? BLUE : RED;
      ctx.fillRect(barX, barY, barW * frac, barH);

      if (chit.id === selectedChitId) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, cy + 1, size - 3, size - 3);
      }
    }

    this.drawHeader(ctx, front, paused, speed, canvasW);
    this.drawHintBar(ctx, canvasW, canvasH);
    this.drawLegend(ctx, canvasW, canvasH);
    if (selected) this.drawSelectedPanel(ctx, front, selected, canvasW);
    this.drawFlash(ctx, canvasW);
  }

  // Cheap per-cell stipple from the deterministic hash — a few fills/strokes
  // max, since this redraws every frame. Road/open keep their flat tint.
  private drawCellTexture(ctx: CanvasRenderingContext2D, i: number, terrain: CellTerrain, gx: number, gy: number, size: number): void {
    switch (terrain) {
      case 'woods': {
        const n = 3 + Math.floor(cellHash(i, 1) * 3); // 3-5 tree dots
        ctx.fillStyle = 'rgba(20, 28, 16, 0.55)';
        const r = Math.max(1, size * 0.07);
        for (let k = 0; k < n; k++) {
          const dx = 3 + cellHash(i, 10 + k * 2) * Math.max(1, size - 6);
          const dy = 3 + cellHash(i, 11 + k * 2) * Math.max(1, size - 6);
          ctx.beginPath();
          ctx.arc(gx + dx, gy + dy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'town': {
        const n = 3 + Math.floor(cellHash(i, 2) * 2); // 3-4 roof specks
        ctx.fillStyle = '#a06a4a';
        const s = Math.max(1, size * 0.1);
        for (let k = 0; k < n; k++) {
          const dx = 3 + cellHash(i, 20 + k * 2) * Math.max(1, size - 7);
          const dy = 3 + cellHash(i, 21 + k * 2) * Math.max(1, size - 7);
          ctx.fillRect(gx + dx, gy + dy, s, s);
        }
        break;
      }
      case 'river': {
        ctx.strokeStyle = 'rgba(200, 220, 230, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k < 2; k++) {
          const dy = size * (0.3 + k * 0.4) + (cellHash(i, 30 + k) - 0.5) * size * 0.15;
          ctx.moveTo(gx + size * 0.15, gy + dy);
          ctx.lineTo(gx + size * 0.55, gy + dy);
        }
        ctx.stroke();
        break;
      }
      case 'bridge': {
        // Two parallel deck rails in the river hue, so the crossing still reads as "over water".
        ctx.strokeStyle = 'rgba(111, 147, 171, 0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gx + size * 0.15, gy + size * 0.3);
        ctx.lineTo(gx + size * 0.85, gy + size * 0.3);
        ctx.moveTo(gx + size * 0.15, gy + size * 0.7);
        ctx.lineTo(gx + size * 0.85, gy + size * 0.7);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
  }

  // Hairline low-alpha grid on ownership boundaries; no seam at all between
  // same-owner neighbors (reads as one continuous holding). Blue/red contact
  // edges get the thicker contested front-line stroke instead.
  private drawGridAndFrontLine(ctx: CanvasRenderingContext2D, size: number, ox: number, oy: number): void {
    const { w, h } = this.sector;
    const frontEdges: [number, number, number, number][] = [];
    ctx.beginPath();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const owner = this.sector.cells[cellIndex(this.sector, x, y)].owner;
        if (x + 1 < w) {
          const rOwner = this.sector.cells[cellIndex(this.sector, x + 1, y)].owner;
          if (owner !== rOwner) {
            const gx = ox + (x + 1) * size;
            const gy0 = oy + y * size;
            const gy1 = oy + (y + 1) * size;
            if (owner && rOwner) frontEdges.push([gx, gy0, gx, gy1]);
            else {
              ctx.moveTo(gx, gy0);
              ctx.lineTo(gx, gy1);
            }
          }
        }
        if (y + 1 < h) {
          const dOwner = this.sector.cells[cellIndex(this.sector, x, y + 1)].owner;
          if (owner !== dOwner) {
            const gx0 = ox + x * size;
            const gx1 = ox + (x + 1) * size;
            const gy = oy + (y + 1) * size;
            if (owner && dOwner) frontEdges.push([gx0, gy, gx1, gy]);
            else {
              ctx.moveTo(gx0, gy);
              ctx.lineTo(gx1, gy);
            }
          }
        }
      }
    }
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (frontEdges.length > 0) {
      ctx.beginPath();
      for (const [x0, y0, x1, y1] of frontEdges) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.strokeStyle = FRONT_LINE;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  private drawObjectives(ctx: CanvasRenderingContext2D, front: Front, size: number, ox: number, oy: number): void {
    const isObjective = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < this.sector.w && y < this.sector.h && this.sector.cells[cellIndex(this.sector, x, y)].objective;
    const pulse = REDUCED_MOTION ? 0.7 : 0.55 + 0.35 * Math.sin(front.clockMin * 0.05);
    for (let i = 0; i < this.sector.cells.length; i++) {
      if (!this.sector.cells[i].objective) continue;
      const { x, y } = cellXY(this.sector, i);
      const gx = ox + x * size;
      const gy = oy + y * size;
      ctx.fillStyle = `rgba(232, 200, 74, ${0.14 * pulse})`;
      ctx.fillRect(gx, gy, size - 1, size - 1);
    }
    ctx.strokeStyle = `rgba(232, 200, 74, ${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < this.sector.cells.length; i++) {
      if (!this.sector.cells[i].objective) continue;
      const { x, y } = cellXY(this.sector, i);
      const gx = ox + x * size;
      const gy = oy + y * size;
      if (!isObjective(x, y - 1)) {
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx + size - 1, gy);
      }
      if (!isObjective(x, y + 1)) {
        ctx.moveTo(gx, gy + size - 1);
        ctx.lineTo(gx + size - 1, gy + size - 1);
      }
      if (!isObjective(x - 1, y)) {
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx, gy + size - 1);
      }
      if (!isObjective(x + 1, y)) {
        ctx.moveTo(gx + size - 1, gy);
        ctx.lineTo(gx + size - 1, gy + size - 1);
      }
    }
    ctx.stroke();
  }

  // Pulsing amber dashed border on the cell an engagement is staged on.
  private drawStagedCell(ctx: CanvasRenderingContext2D, front: Front, size: number, ox: number, oy: number): void {
    const { x, y } = cellXY(this.sector, this.stagedCell);
    const gx = ox + x * size;
    const gy = oy + y * size;
    const pulse = REDUCED_MOTION ? 0.8 : 0.55 + 0.35 * Math.sin(front.clockMin * 0.12);
    ctx.strokeStyle = `rgba(255, 202, 106, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(gx + 1.5, gy + 1.5, size - 4, size - 4);
    ctx.setLineDash([]);
  }

  private drawPathPreview(ctx: CanvasRenderingContext2D, selected: Chit, size: number, ox: number, oy: number): void {
    ctx.strokeStyle = 'rgba(230,230,200,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const start = cellXY(this.sector, selected.cell);
    ctx.moveTo(ox + (start.x + 0.5) * size, oy + (start.y + 0.5) * size);
    for (const i of selected.path) {
      const p = cellXY(this.sector, i);
      ctx.lineTo(ox + (p.x + 0.5) * size, oy + (p.y + 0.5) * size);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const dest = cellXY(this.sector, selected.path[selected.path.length - 1]);
    const dx = ox + (dest.x + 0.5) * size;
    const dy = oy + (dest.y + 0.5) * size;
    const r = Math.max(4, size * 0.28);
    ctx.fillStyle = 'rgba(18, 22, 15, 0.75)';
    ctx.beginPath();
    ctx.moveTo(dx, dy - r);
    ctx.lineTo(dx + r, dy);
    ctx.lineTo(dx, dy + r);
    ctx.lineTo(dx - r, dy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = CREAM;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawHeader(ctx: CanvasRenderingContext2D, front: Front, paused: boolean, speed: number, canvasW: number): void {
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(0, 0, canvasW, HEADER_H);
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H - 0.5);
    ctx.lineTo(canvasW, HEADER_H - 0.5);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = AMBER_BRIGHT;
    ctx.fillText(this.sector.name.toUpperCase(), 12, HEADER_H / 2);
    const titleW = ctx.measureText(this.sector.name.toUpperCase()).width;
    ctx.fillStyle = CREAM;
    const clockText = `DAY ${front.day}  ·  ${front.hhmm}`;
    ctx.fillText(clockText, 12 + titleW + 18, HEADER_H / 2);
    const clockW = ctx.measureText(clockText).width;
    this.drawTimeRing(ctx, front, 12 + titleW + 18 + clockW + 26, HEADER_H / 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = paused ? AMBER : MUTED;
    const speedText = paused ? 'PAUSED' : `×${speed} MIN/S`;
    ctx.fillText(speedText, canvasW - 12, HEADER_H / 2);
    const speedW = ctx.measureText(speedText).width;

    const hours = minutesToReinforcement(front) / 60;
    const reinforceText = hours < 1 ? 'Reinforcements <1h' : `Reinforcements in ${Math.round(hours)}h`;
    ctx.fillStyle = MUTED;
    ctx.fillText(reinforceText, canvasW - 12 - speedW - 24, HEADER_H / 2);
  }

  // 24h time-of-day ring: static (sim-clock-driven, not animated), so
  // REDUCED_MOTION-safe by construction. Upper semicircle = day.
  private drawTimeRing(ctx: CanvasRenderingContext2D, front: Front, cx: number, cy: number): void {
    const r = 11;
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r, cy + 0.5);
    ctx.lineTo(cx + r, cy + 0.5);
    ctx.stroke();
    const tod = front.clockMin % 1440;
    const a = timeOfDayAngle(tod);
    const mx = cx + (r - 3.5) * Math.sin(a);
    const my = cy - (r - 3.5) * Math.cos(a);
    if (tod >= 6 * 60 && tod < 18 * 60) {
      ctx.fillStyle = AMBER;
      ctx.beginPath();
      ctx.arc(mx, my, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = MUTED;
      ctx.beginPath();
      ctx.arc(mx, my, 2.2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawFlash(ctx: CanvasRenderingContext2D, canvasW: number): void {
    if (!this.flashMsg || performance.now() >= this.flashUntil) {
      this.flashMsg = null;
      return;
    }
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(this.flashMsg).width + 32;
    const h = 30;
    const x = (canvasW - w) / 2;
    const y = HEADER_H + 10;
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = AMBER_BRIGHT;
    ctx.fillText(this.flashMsg, canvasW / 2, y + h / 2 + 1);
  }

  private drawHintBar(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number): void {
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const barH = FOOTER_H - 6;
    const w = ctx.measureText(HINT_TEXT).width + 24;
    const x = (canvasW - w) / 2;
    const y = canvasH - barH - 6;
    ctx.fillStyle = 'rgba(18, 22, 15, 0.72)';
    ctx.fillRect(x, y, w, barH);
    ctx.fillStyle = 'rgba(216, 212, 196, 0.6)';
    ctx.fillText(HINT_TEXT, canvasW / 2, y + barH / 2 + 1);
  }

  private drawLegend(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number): void {
    const pad = 10;
    const rowH = 15;
    const colW = 98;
    const w = pad * 2 + colW * 2;
    const h = pad * 2 + rowH * 5 + 6;
    const x = 12;
    const y = Math.max(HEADER_H + 4, canvasH - FOOTER_H - 12 - h);

    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    ctx.font = '10px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const swatch = (sx: number, sy: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.fillRect(sx, sy - 5, 10, 10);
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy - 4.5, 9, 9);
    };

    let ty = y + pad + rowH / 2;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        const terrain = TERRAIN_ORDER[r + c * 3];
        const sx = x + pad + c * colW;
        swatch(sx, ty, TERRAIN_COLORS[terrain]);
        ctx.fillStyle = MUTED;
        ctx.fillText(TERRAIN_LABELS[terrain], sx + 15, ty);
      }
      ty += rowH;
    }

    ty += 6;
    ctx.strokeStyle = PANEL_BORDER;
    ctx.beginPath();
    ctx.moveTo(x + pad, ty - rowH / 2 - 3);
    ctx.lineTo(x + w - pad, ty - rowH / 2 - 3);
    ctx.stroke();

    swatch(x + pad, ty, 'rgba(70,110,180,0.55)');
    ctx.fillStyle = MUTED;
    ctx.fillText('Friendly', x + pad + 15, ty);
    swatch(x + pad + colW, ty, 'rgba(180,70,70,0.55)');
    ctx.fillStyle = MUTED;
    ctx.fillText('Enemy', x + pad + colW + 15, ty);
    ty += rowH;

    ctx.fillStyle = 'rgba(232, 200, 74, 0.25)';
    ctx.fillRect(x + pad, ty - 5, 10, 10);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + pad + 1, ty - 4, 8, 8);
    ctx.fillStyle = MUTED;
    ctx.fillText('Objective', x + pad + 15, ty);
  }

  private drawSelectedPanel(ctx: CanvasRenderingContext2D, front: Front, chit: Chit, canvasW: number): void {
    const w = 220;
    const h = 78;
    const x = Math.max(4, canvasW - w - 12);
    const y = HEADER_H + 12;

    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = chit.side === 'blue' ? BLUE : RED;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = '13px monospace';
    ctx.fillStyle = chit.side === 'blue' ? BLUE : RED;
    ctx.fillText(chit.name, x + 10, y + 20);
    ctx.textAlign = 'right';
    ctx.font = '11px monospace';
    ctx.fillStyle = MUTED;
    ctx.fillText(`${chit.strength} men`, x + w - 10, y + 20);

    ctx.textAlign = 'left';
    ctx.font = '11px monospace';
    ctx.fillStyle = MUTED;
    if (chit.path.length === 0) {
      ctx.fillStyle = CREAM;
      ctx.fillText('Holding position', x + 10, y + 40);
    } else {
      const eta = chitEtaMinutes(front, chit);
      const arrival = formatClock(front.clockMin + eta);
      ctx.fillStyle = CREAM;
      ctx.fillText(`Marching — ${chit.path.length} cell${chit.path.length === 1 ? '' : 's'} to go`, x + 10, y + 40);
      ctx.fillStyle = AMBER;
      const dayNote = arrival.day > front.day ? `D${arrival.day} ` : '';
      ctx.fillText(`ETA ${dayNote}${arrival.hhmm}`, x + 10, y + 58);
    }
  }
}
