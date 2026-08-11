export interface ObjectiveData {
  kind: 'attack' | 'defend';
  cellLabel: string;
  isObjective: boolean;
  attackerName: string;
  defenderName: string;
  attackerStrength: number;
  defenderStrength: number;
}

export interface BarData {
  value: number;
  max: number;
  state: 'steady' | 'shaken' | 'pinned' | 'broken';
}

export interface ObjectiveStripResult {
  label: string;
  condition: string;
  friendlyBar: BarData;
  enemyBar: BarData;
}

function barState(alive: number, floor: number): BarData['state'] {
  if (alive <= 0) return 'broken';
  const r = alive / floor;
  if (r >= 2.0) return 'steady';
  if (r >= 1.5) return 'shaken';
  if (r >= 1.0) return 'pinned';
  return 'broken';
}

export function objectiveStripText(
  objective: ObjectiveData | null,
  blueAlive: number,
  redAlive: number,
  blueFloor: number,
  redFloor: number,
): ObjectiveStripResult | null {
  if (!objective) return null;
  const label = `${objective.isObjective ? '★ ' : ''}${objective.kind === 'attack' ? 'ASSAULT' : 'DEFEND'} ${objective.cellLabel}`;
  const condition =
    objective.kind === 'attack'
      ? `Break the defense — reduce enemy below ⌊${redFloor}⌋ while staying at or above ⌊${blueFloor}⌋, or wipe them`
      : `Hold — keep your force at or above ⌊${blueFloor}⌋`;
  return {
    label,
    condition,
    friendlyBar: { value: blueAlive, max: Math.max(blueFloor * 2, 1), state: barState(blueAlive, blueFloor) },
    enemyBar: { value: redAlive, max: Math.max(redFloor * 2, 1), state: barState(redAlive, redFloor) },
  };
}