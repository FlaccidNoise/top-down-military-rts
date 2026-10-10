// Unit counters for the theater map (jtbug #782). A force was a 16x10 px
// rectangle with a 9 px number under it, smaller than the village it stood
// on. A counter is the loudest mark on the map: side colour, the company
// letter (or the enemy's role), strength, a strength bar against
// establishment, and pips for supply and fatigue.
//
// A counter HANGS under the point it stands on, joined by a leader, so the
// town, its objective ring and its name stay readable. Counters that share a
// point fan out in a row. The layout is the hit-test: what the player sees is
// what a click lands on.
import type { Side } from '../sim/sim';
import type { ForceRole } from '../strategic/theater/force';
import type { SupplyTier } from '../strategic/theater/supply';

export const COUNTER_W = 34;
export const COUNTER_H = 24;
const GAP = 3;
const STACK_PX = 12; // anchors closer than this share one fan

export interface CounterSpec {
  id: number;
  side: Side;
  // Blue: the company letter. Red: null, the role glyph speaks instead.
  letter: string | null;
  role: ForceRole;
  strength: number;
  frac: number; // strength / establishment, 0..1
  supply: SupplyTier | null; // null = supply rules off, or not known
  fatigue: number;
  selected: boolean;
  engaged: boolean;
  // 1 for a force seen now. Under fog an enemy is a last-seen report: hollow,
  // dashed, fading with the report's age.
  conf: number;
  ghost: boolean;
  ax: number; // the true position on screen
  ay: number;
  drop: number; // clearance below the anchor (an objective ring needs more)
}

export interface PlacedCounter extends CounterSpec {
  x: number; // top-left of the box
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const hits = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
export const counterRect = (c: { x: number; y: number }): Rect => ({ x0: c.x, y0: c.y, x1: c.x + COUNTER_W, y1: c.y + COUNTER_H });

// Fan each stack in a centred row under its anchor, own side first. A row
// that would land on an earlier one drops a line. The selected stack is
// placed first, so selecting a company never moves it.
export function layoutCounters(specs: readonly CounterSpec[]): PlacedCounter[] {
  const stacks: CounterSpec[][] = [];
  for (const s of [...specs].sort((a, b) => a.id - b.id)) {
    const home = stacks.find((g) => Math.hypot(g[0].ax - s.ax, g[0].ay - s.ay) < STACK_PX);
    if (home) home.push(s);
    else stacks.push([s]);
  }
  stacks.sort((a, b) => Number(b.some((s) => s.selected)) - Number(a.some((s) => s.selected)));
  const out: PlacedCounter[] = [];
  for (const g of stacks) {
    g.sort((a, b) => (a.side === b.side ? a.id - b.id : a.side === 'blue' ? -1 : 1));
    const rowW = g.length * COUNTER_W + (g.length - 1) * GAP;
    let y = g[0].ay + Math.max(...g.map((s) => s.drop));
    const row = (): PlacedCounter[] => g.map((s, i) => ({ ...s, x: g[0].ax - rowW / 2 + i * (COUNTER_W + GAP), y }));
    let placed = row();
    for (let tries = 0; tries < 4 && placed.some((p) => out.some((o) => hits(counterRect(p), counterRect(o)))); tries++) {
      y += COUNTER_H + GAP;
      placed = row();
    }
    out.push(...placed);
  }
  return out;
}

const FILL: Record<Side, string> = { blue: '#3f6cc4', red: '#bd4038' };
const EDGE = 'rgba(12, 10, 6, 0.92)';
const TEXT = '#f6f0de';
const HALO = '#ffe9a0';
const ENGAGED = '#f0963c';
const BAR_BG = 'rgba(10, 9, 6, 0.6)';
const PIP: Record<'warn' | 'bad', string> = { warn: '#e8b84a', bad: '#e2543c' };

const barColor = (frac: number): string => (frac > 0.66 ? '#a9cf7a' : frac > 0.33 ? '#e8b84a' : '#e2543c');

// The enemy's role, drawn rather than lettered so it reads at 8 px: a
// garrison is a walled square, a mobile group an arrowhead, the reserve an R.
function roleGlyph(ctx: CanvasRenderingContext2D, role: ForceRole, x: number, cy: number): void {
  ctx.fillStyle = TEXT;
  ctx.strokeStyle = TEXT;
  if (role === 'garrison') {
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, cy - 4, 7.5, 8);
    ctx.fillRect(x + 3, cy - 1.5, 3, 3);
  } else if (role === 'line') {
    ctx.beginPath();
    ctx.moveTo(x, cy - 4.5);
    ctx.lineTo(x + 9, cy);
    ctx.lineTo(x, cy + 4.5);
    ctx.lineTo(x + 2.5, cy);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('R', x + 0.5, cy + 4);
  }
}

export function drawCounter(ctx: CanvasRenderingContext2D, c: PlacedCounter): void {
  const { x, y } = c;
  const cx = x + COUNTER_W / 2;
  ctx.save();
  ctx.globalAlpha = c.ghost ? 0.4 + 0.6 * c.conf : 1;

  // Leader: the counter belongs to THAT point.
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c.ax, c.ay);
  ctx.lineTo(cx, y);
  ctx.stroke();
  ctx.strokeStyle = FILL[c.side];
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = FILL[c.side];
  ctx.beginPath();
  ctx.arc(c.ax, c.ay, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (c.selected) {
    ctx.save();
    ctx.shadowColor = HALO;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x - 3, y - 3, COUNTER_W + 6, COUNTER_H + 6, 5);
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.roundRect(x, y, COUNTER_W, COUNTER_H, 3);
  ctx.fillStyle = c.ghost ? 'rgba(40, 20, 18, 0.55)' : FILL[c.side];
  ctx.fill();
  if (c.ghost) ctx.setLineDash([3, 2]);
  ctx.strokeStyle = c.engaged ? ENGAGED : c.ghost ? FILL[c.side] : EDGE;
  ctx.lineWidth = c.engaged ? 2.5 : 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Top row: who (letter or role), then how many.
  const mid = y + 9.5;
  if (c.letter !== null) {
    ctx.fillStyle = TEXT;
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(c.letter, x + 3.5, mid + 4);
  } else {
    roleGlyph(ctx, c.role, x + 3.5, mid);
  }
  ctx.fillStyle = TEXT;
  ctx.font = `${c.ghost ? '' : 'bold '}10px ui-monospace, monospace`;
  ctx.textAlign = 'right';
  ctx.fillText(String(c.strength), x + COUNTER_W - 3, mid + 3.5);

  // Strength against establishment.
  ctx.fillStyle = BAR_BG;
  ctx.fillRect(x + 3, y + COUNTER_H - 6.5, COUNTER_W - 6, 3.5);
  ctx.fillStyle = barColor(c.frac);
  ctx.fillRect(x + 3, y + COUNTER_H - 6.5, (COUNTER_W - 6) * Math.max(0, Math.min(1, c.frac)), 3.5);

  // Pips ride the top corners: supply on the left, fatigue on the right.
  const pip = (px: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };
  if (c.supply === 'low' || c.supply === 'out') pip(x + 1, PIP[c.supply === 'low' ? 'warn' : 'bad']);
  if (c.fatigue >= 0.33) pip(x + COUNTER_W - 1, PIP[c.fatigue >= 0.66 ? 'bad' : 'warn']);
  ctx.restore();
}
