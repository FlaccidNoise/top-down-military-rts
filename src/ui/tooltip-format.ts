import type { TerrainDef, TerrainKey } from '../sim/data';

const pct = (v: number) => `${Math.round(v * 100)}%`;

// Where a cover value earns its word. A hedgerow, woods and a wall to fire
// over are good cover; a bank, a railway and clutter are some; a field is none.
export const GOOD_COVER = 0.3;
export const SOME_COVER = 0.1;

/**
 * Ground in one phrase, for a player who has not read the cover model: what it
 * does for a man standing on it or behind it. The numbers behind the word are
 * formatCoverBreakdown's, shown on request.
 */
export function coverWord(key: TerrainKey, t: TerrainDef): string {
  if (key === 'floor') return 'cover at the windows';
  if (!t.passable) return t.coverBehind !== undefined ? 'good cover behind it' : 'impassable';
  const best = Math.max(t.cover, t.coverBehind ?? 0);
  return best >= GOOD_COVER ? 'good cover' : best >= SOME_COVER ? 'some cover' : 'no cover';
}

export function formatCoverBreakdown(t: TerrainDef): string[] {
  const lines: string[] = [];
  lines.push(`Direct cover: ${pct(t.cover)}`);
  if (t.coverBehind !== undefined) {
    lines.push(`Directional lip: ${pct(t.coverBehind)} (within 2m of far side)`);
  }
  lines.push(t.opacity > 0 ? `Concealment: ${pct(t.opacity)} per tile` : 'Concealment: none');
  return lines;
}

export function formatCoverBreakdownForFloor(): string[] {
  return [
    'Direct cover: 0% in the open',
    'Directional lip: 50% at windows (within 2m)',
    'Concealment: none',
  ];
}