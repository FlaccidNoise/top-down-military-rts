// After-action highlights: what a few of the player's men did in the battle
// just fought, by name, for the debrief. A recorder and nothing more: it is fed
// the unit events the ticker is fed, reads sim state the way barks.ts does, and
// writes nothing back. It lives for one battle and is never saved.
//
// One thing the events do not carry: who helped a casualty. 'stabilized' names
// the man who was saved. The helper is read off the rescue task while it runs
// (observe), which is also how a drag to cover is told from first aid given
// where the man fell.
import type { Sim, UnitEvent } from '../sim/sim';

export type HighlightKind = 'dragged' | 'tank-killed' | 'took-over' | 'promoted' | 'stabilized' | 'recovered' | 'rallied' | 'grenade' | 'tank-lost' | 'surrendered';

/** Shown on the debrief at most. */
export const HIGHLIGHTS_SHOWN = 3;

// Drama, highest first: what a player would retell. A man carried out of the
// fire beats a tank, a tank beats a promotion, and a surrender is told last.
const SCORE: Record<HighlightKind, number> = {
  dragged: 100,
  'tank-killed': 90,
  'took-over': 80,
  promoted: 70,
  stabilized: 65,
  recovered: 55,
  rallied: 45,
  grenade: 40,
  'tank-lost': 35,
  surrendered: 30,
};

interface Highlight {
  kind: HighlightKind;
  /** The man, or the vehicle, it is about: one line per kind and subject. */
  who: string;
  /** The rest of the line, after the name. */
  text: string;
  tick: number;
  count: number;
}

export class Highlights {
  private items: Highlight[] = [];
  /** Casualty id -> who went to him, and whether he was carried. */
  private rescues = new Map<number, { by: number; dragged: boolean }>();

  reset(): void {
    this.items = [];
    this.rescues.clear();
  }

  /** Once a battle frame. Remembers who is helping whom while the task lasts. */
  observe(sim: Sim): void {
    for (const s of sim.soldiers) {
      if (s.side !== 'blue' || s.task?.kind !== 'rescue') continue;
      const c = sim.soldiers[s.task.casualtyId];
      // The second bearer of a two-man carry is the helper, not the one to name.
      if (c.helperId === s.id) continue;
      const was = this.rescues.get(c.id);
      this.rescues.set(c.id, { by: s.id, dragged: (was?.by === s.id && was.dragged) || s.task.phase === 'drag' });
    }
  }

  /** The events of one frame: the list the ticker gets, so nothing the fog hides. */
  add(events: readonly UnitEvent[], sim: Sim): void {
    for (const e of events) {
      if (e.kind === 'vehicle-destroyed') {
        if (e.side === 'red') this.note('tank-killed', `An enemy ${e.name}`, 'brewed up.', sim.tick);
        else this.note('tank-lost', `Your ${e.name}`, 'brewed up.', sim.tick);
        continue;
      }
      if (e.side !== 'blue' || e.id === undefined) continue;
      switch (e.kind) {
        case 'stabilized': {
          const r = this.rescues.get(e.id);
          this.rescues.delete(e.id);
          const helper = r && sim.soldiers[r.by];
          if (!helper) break;
          if (r.dragged) this.note('dragged', helper.name, `dragged ${e.name} to cover.`, sim.tick);
          else this.note('stabilized', helper.name, `stopped ${e.name}'s bleeding.`, sim.tick);
          break;
        }
        case 'took-over':
          this.note('took-over', e.name, 'took over the gun.', sim.tick);
          break;
        case 'promoted':
          this.note('promoted', e.name, `took command of ${sim.squads[sim.soldiers[e.id].squadId].name}.`, sim.tick);
          break;
        case 'recovered':
          this.note('recovered', e.name, 'got back on his feet.', sim.tick);
          break;
        case 'rallied':
          this.note('rallied', e.name, 'rallied under fire.', sim.tick);
          break;
        case 'grenade':
          this.note('grenade', e.name, 'threw a grenade.', sim.tick);
          break;
        case 'surrendered':
          this.note('surrendered', e.name, 'surrendered.', sim.tick);
          break;
      }
    }
  }

  // One line per kind and subject: a man who throws four grenades is one line
  // that says four, not four lines.
  private note(kind: HighlightKind, who: string, text: string, tick: number): void {
    const seen = this.items.find((h) => h.kind === kind && h.who === who);
    if (seen) {
      seen.count++;
      seen.tick = tick;
      if (kind === 'grenade') seen.text = `threw ${seen.count} grenades.`;
      return;
    }
    this.items.push({ kind, who, text, tick, count: 1 });
  }

  /**
   * The lines for the debrief, best first. Different kinds of thing before a
   * second of the same kind: three men who each rallied are one story told
   * three times. Within a kind the latest wins, the end of a fight being what
   * is remembered.
   */
  top(n = HIGHLIGHTS_SHOWN): string[] {
    const ranked = [...this.items].sort((a, b) => SCORE[b.kind] - SCORE[a.kind] || b.tick - a.tick);
    const picked: Highlight[] = [];
    for (const h of ranked) if (picked.length < n && !picked.some((p) => p.kind === h.kind)) picked.push(h);
    for (const h of ranked) if (picked.length < n && !picked.includes(h)) picked.push(h);
    return picked.sort((a, b) => SCORE[b.kind] - SCORE[a.kind] || b.tick - a.tick).map((h) => `${h.who} ${h.text}`);
  }
}
