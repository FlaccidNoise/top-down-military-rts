import { chitEtaMinutes, formatClock, minutesToReinforcement, type Chit, type Front } from '../strategic/front';
import { cellIndex, cellXY, type CellTerrain, type SectorMap } from '../strategic/sector';

const TERRAIN_COLORS: Record<CellTerrain, string> = {
  open: '#4e6b3f',
  woods: '#31482b',
  town: '#7a6a55',
  river: '#3b5a72',
  bridge: '#9c7a3f',
  road: '#8a8172',
};

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

const HEADER_H = 34;
const FOOTER_H = 24;
const HINT_TEXT = 'SPACE pause  ·  1/2/3 speed  ·  click select  ·  right-click move  ·  ESC deselect';

export class StrategicView {
  private flashMsg: string | null = null;
  private flashUntil = 0;

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
    ctx.fillStyle = '#1a1c18';
    ctx.fillRect(0, 0, canvasW, canvasH);
    for (let i = 0; i < this.sector.cells.length; i++) {
      const cell = this.sector.cells[i];
      const { x, y } = cellXY(this.sector, i);
      ctx.fillStyle = TERRAIN_COLORS[cell.terrain];
      ctx.fillRect(ox + x * size, oy + y * size, size - 1, size - 1);
      if (cell.owner) {
        ctx.fillStyle = cell.owner === 'blue' ? 'rgba(70,110,180,0.28)' : 'rgba(180,70,70,0.28)';
        ctx.fillRect(ox + x * size, oy + y * size, size - 1, size - 1);
      }
    }
    this.drawObjectives(ctx, front, size, ox, oy);

    const selected = front.chits.find((c) => c.id === selectedChitId);
    if (selected && selected.path.length > 0) this.drawPathPreview(ctx, selected, size, ox, oy);

    for (const chit of front.chits) {
      const { x, y } = cellXY(this.sector, chit.cell);
      const cx = ox + x * size;
      const cy = oy + y * size;
      ctx.fillStyle = chit.side === 'blue' ? '#3a5a9a' : '#9a3a3a';
      ctx.fillRect(cx + 2, cy + 2, size - 5, size - 5);
      if (chit.id === selectedChitId) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx + 1, cy + 1, size - 3, size - 3);
      }
      ctx.fillStyle = CREAM;
      ctx.textBaseline = 'alphabetic';
      ctx.font = `${Math.max(8, size * 0.45)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(chit.name[0], cx + size / 2, cy + size * 0.55);
      ctx.font = '10px monospace';
      ctx.fillText(String(chit.strength), cx + size / 2, cy + size - 2);
    }

    this.drawHeader(ctx, front, paused, speed, canvasW);
    this.drawHintBar(ctx, canvasW, canvasH);
    this.drawLegend(ctx, canvasW, canvasH);
    if (selected) this.drawSelectedPanel(ctx, front, selected, canvasW);
    this.drawFlash(ctx, canvasW);
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
    ctx.fillText(`DAY ${front.day}  ·  ${front.hhmm}`, 12 + titleW + 18, HEADER_H / 2);

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
