import type { Front } from '../strategic/front';
import { cellXY, type CellTerrain, type SectorMap } from '../strategic/sector';

const TERRAIN_COLORS: Record<CellTerrain, string> = {
  open: '#4e6b3f',
  woods: '#31482b',
  town: '#7a6a55',
  river: '#3b5a72',
  bridge: '#8a8172',
  road: '#8a8172',
};

export class StrategicView {
  constructor(readonly sector: SectorMap) {}

  layout(canvasW: number, canvasH: number): { size: number; ox: number; oy: number } {
    const size = Math.max(4, Math.floor(Math.min(canvasW / this.sector.w, (canvasH - 60) / this.sector.h)));
    return { size, ox: Math.floor((canvasW - size * this.sector.w) / 2), oy: 50 };
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
      if (cell.objective) {
        ctx.strokeStyle = '#e8c84a';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox + x * size + 1, oy + y * size + 1, size - 3, size - 3);
      }
    }
    // path preview for the selected chit
    const selected = front.chits.find((c) => c.id === selectedChitId);
    if (selected && selected.path.length > 0) {
      ctx.strokeStyle = 'rgba(230,230,200,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const start = cellXY(this.sector, selected.cell);
      ctx.moveTo(ox + (start.x + 0.5) * size, oy + (start.y + 0.5) * size);
      for (const i of selected.path) {
        const p = cellXY(this.sector, i);
        ctx.lineTo(ox + (p.x + 0.5) * size, oy + (p.y + 0.5) * size);
      }
      ctx.stroke();
    }
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
      ctx.fillStyle = '#e8e4d8';
      ctx.font = `${Math.max(8, size * 0.45)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(chit.name[0], cx + size / 2, cy + size * 0.55);
      ctx.font = '10px monospace';
      ctx.fillText(String(chit.strength), cx + size / 2, cy + size - 2);
    }
    ctx.fillStyle = '#e8e4d8';
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${this.sector.name} — DAY ${front.day} ${front.hhmm} — ${paused ? 'PAUSED' : `${speed} min/s`} — space pause · 1/2/3 speed · click select · right-click move`,
      12,
      28,
    );
  }
}
