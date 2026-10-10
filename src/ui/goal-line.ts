// The campaign's goal as one line. It is the whole of what the briefing card
// used to say, drawn over the live map until the first march is ordered
// (src/ui/tutorial.ts, the 'goal' step). Every number comes from the war goals
// the campaign is actually run on.
import type { WarGoals } from '../strategic/goals';

export function goalLine(goals: WarGoals): string | null {
  const control = goals.blue.find((c) => c.kind === 'control');
  if (!control || control.kind !== 'control' || control.nodeIds.length === 0) return null;
  const deadline = goals.red.find((c) => c.kind === 'deadline');
  const towns = control.need < control.nodeIds.length ? `${control.need} of the ${control.nodeIds.length} gold-ringed towns` : 'the gold-ringed towns';
  return `Take ${towns}${deadline && deadline.kind === 'deadline' ? ` before Day ${deadline.day}` : ''}.`;
}
