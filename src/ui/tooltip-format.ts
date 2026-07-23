import type { TerrainDef, TerrainKey } from '../sim/data';

const pct = (v: number) => `${Math.round(v * 100)}%`;

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