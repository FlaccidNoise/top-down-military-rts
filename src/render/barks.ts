import { eligible, type Sim, type Soldier, type UnitEvent } from '../sim/sim';
import type { Camera } from './camera';
import { SPRITE_MIN_SCALE } from './dudes';
import { MOBILE } from './view';

// Barks: a word or two over a man at the moment he does something the player
// would otherwise have to infer — the reference game's way of saying what its
// men are up to. Everything here is read off state the sim already has
// (soldier fields, order phases, unit events). Nothing is written back.
//
// BLUE ONLY, like the ticker's casualty and recovery lines and for the same
// reason: a bark is the man's own state. RELOADING over a German is the
// moment to rush him, WON'T GO is his morale, MAN DOWN is a body count. A
// player who can see the German already sees him fall and sees him throw.

export type BarkKind =
  | 'mandown'
  | 'medic'
  | 'grenade'
  | 'balk'
  | 'took-over'
  | 'promoted'
  | 'stabilized'
  | 'recovered'
  | 'resupplied'
  | 'moving'
  | 'covering'
  | 'reloading';

// `rank`: a man says one thing at a time, and a higher rank takes the word
// from a lower one. `quiet`: seconds before the same TEAM says the same thing
// again — a rifle section reloads every few seconds, and without it a
// firefight is a wall of words. `alarm` picks the warmer of the two inks.
export const BARK: Record<BarkKind, { text: string; rank: number; quiet: number; alarm: boolean }> = {
  mandown: { text: 'MAN DOWN', rank: 3, quiet: 8, alarm: true },
  medic: { text: 'MEDIC!', rank: 3, quiet: 6, alarm: true },
  grenade: { text: 'GRENADE!', rank: 3, quiet: 2, alarm: true },
  balk: { text: "WON'T GO", rank: 2, quiet: 8, alarm: true },
  'took-over': { text: 'ON THE GUN', rank: 2, quiet: 4, alarm: false },
  promoted: { text: 'TAKING OVER', rank: 2, quiet: 4, alarm: false },
  stabilized: { text: "HE'S STABLE", rank: 2, quiet: 4, alarm: false },
  recovered: { text: "I'M UP", rank: 2, quiet: 4, alarm: false },
  resupplied: { text: 'AMMO UP', rank: 2, quiet: 4, alarm: false },
  moving: { text: 'MOVING UP', rank: 1, quiet: 10, alarm: false },
  covering: { text: 'COVERING', rank: 1, quiet: 10, alarm: false },
  reloading: { text: 'RELOADING', rank: 0, quiet: 12, alarm: false },
};

export const BARK_MS = 1200;
const FADE_IN_MS = 90;
const FADE_OUT_MS = 300;
// On screen at once. A phone shows a third of the field a desktop does.
export const MAX_BARKS = MOBILE ? 5 : 8;
// A man hit this far from every squadmate has nobody to call it.
const MAN_DOWN_M = 20;

// 0..1 over a bark's life: up fast, held, a quick fade. Zero outside it and
// for an age that is not a number, so a bad clock draws nothing.
export function barkAlpha(age: number): number {
  if (!(age >= 0) || !(age < BARK_MS)) return 0;
  return Math.min(1, age / FADE_IN_MS, (BARK_MS - age) / FADE_OUT_MS);
}

// Type size in CSS px. It follows the zoom so the word stays in scale with
// the man, between a floor that is still legible (higher on a phone, where a
// px is smaller in the hand) and a ceiling that keeps it a caption.
export function barkPx(scale: number, mobile: boolean): number {
  return Math.round(Math.max(mobile ? 11 : 10, Math.min(13, scale * 0.5)));
}

// The setting, stored like the other UI prefs. Default ON: only an explicit
// '0' turns it off, so a profile that has never seen the key gets barks.
export const BARKS_STORAGE_KEY = 'rts.barks.v1';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | undefined => (typeof localStorage !== 'undefined' ? localStorage : undefined);
let on: boolean | null = null;

export function barksOn(storage: Store | undefined = browserStore()): boolean {
  if (on === null) {
    on = true;
    try {
      on = storage?.getItem(BARKS_STORAGE_KEY) !== '0';
    } catch { /* storage blocked: the default stands */ }
  }
  return on;
}

export function setBarksOn(value: boolean, storage: Store | undefined = browserStore()): void {
  on = value;
  try {
    storage?.setItem(BARKS_STORAGE_KEY, value ? '1' : '0');
  } catch { /* quota */ }
}

interface Bark {
  kind: BarkKind;
  t0: number;
}

const afoot = (s: Soldier): boolean => eligible(s) && s.inVehicle < 0;

export class Barks {
  private live = new Map<number, Bark>(); // soldier id -> the one thing he is saying
  private said = new Map<string, number>(); // "team|kind" -> fx time it was last said
  // What each man and team was doing last frame. `undefined` is a man not yet
  // seen: the first look records and says nothing, so a battle that boots
  // mid-reload does not open with a shout from every rifleman.
  private rescuing: boolean[] = [];
  private reloading: boolean[] = [];
  private grenades: number[] = [];
  private phase: string[] = [];

  /** Soldier ids with a live bark, for tests and the harness. */
  get speaking(): ReadonlyMap<number, Readonly<Bark>> {
    return this.live;
  }

  private say(s: Soldier, kind: BarkKind, now: number): void {
    if (s.side !== 'blue' || !afoot(s) || !(now >= 0)) return;
    const spec = BARK[kind];
    const key = `${s.teamId}|${kind}`;
    const last = this.said.get(key);
    if (last !== undefined && now - last < spec.quiet * 1000) return;
    const cur = this.live.get(s.id);
    if (cur && BARK[cur.kind].rank >= spec.rank) return;
    this.live.set(s.id, { kind, t0: now });
    this.said.set(key, now);
  }

  /** Once a battle frame, after the sim has stepped. `now` is the fx clock. */
  observe(sim: Sim, now: number): void {
    for (const [id, b] of this.live) {
      if (!(now - b.t0 < BARK_MS) || !afoot(sim.soldiers[id])) this.live.delete(id);
    }
    for (const s of sim.soldiers) {
      const rescuing = s.task?.kind === 'rescue';
      const reloading = s.reloading > 0 && !s.pickingUp;
      if (this.grenades[s.id] !== undefined) {
        if (rescuing && !this.rescuing[s.id]) this.say(s, 'medic', now);
        else if (s.grenadesLeft < this.grenades[s.id]) this.say(s, 'grenade', now);
        else if (reloading && !this.reloading[s.id]) this.say(s, 'reloading', now);
      }
      this.rescuing[s.id] = rescuing;
      this.reloading[s.id] = reloading;
      this.grenades[s.id] = s.grenadesLeft;
    }
    for (const team of sim.teams) {
      const phase = team.orderState.phase;
      const was = this.phase[team.id];
      this.phase[team.id] = phase;
      if (was === undefined || was === phase) continue;
      const men = team.soldierIds.map((id) => sim.soldiers[id]);
      if (phase === 'balked') {
        const lead = men.find(afoot);
        if (lead) this.say(lead, 'balk', now);
      } else if (phase === 'bounding_a' || phase === 'bounding_b') {
        // Sim.teamHalves: the first half of the roster is 'a', and the phase
        // names the half that is rushing.
        const mid = Math.ceil(men.length / 2);
        const a = men.slice(0, mid).find(afoot);
        const b = men.slice(mid).find(afoot);
        const [mover, cover] = phase === 'bounding_a' ? [a, b] : [b, a];
        if (mover) this.say(mover, 'moving', now);
        if (cover) this.say(cover, 'covering', now);
      }
    }
  }

  addUnitEvents(events: UnitEvent[], sim: Sim, now: number): void {
    for (const e of events) {
      if (e.id === undefined) continue;
      const man = sim.soldiers[e.id];
      if (e.kind === 'downed' || e.kind === 'kia') {
        // Called by the nearest squadmate still on his feet, never by the man
        // it happened to.
        let best: Soldier | null = null;
        let bestD = MAN_DOWN_M;
        for (const o of sim.soldiers) {
          if (o.squadId !== man.squadId || o.id === man.id || !afoot(o)) continue;
          const d = Math.hypot(o.x - man.x, o.y - man.y);
          if (d < bestD) {
            best = o;
            bestD = d;
          }
        }
        if (best) this.say(best, 'mandown', now);
      } else if (e.kind === 'took-over' || e.kind === 'promoted' || e.kind === 'stabilized' || e.kind === 'recovered' || e.kind === 'resupplied') {
        this.say(man, e.kind, now);
      }
    }
  }

  // The barks in view, at most `max` of them: the ones that matter most first,
  // then the newest. The cap is on what is SHOWN — counting the men speaking
  // on the far side of the map would let them silence the ones in front of
  // the player.
  shown(cam: Camera, sim: Sim, now: number, cw: number, ch: number, max = MAX_BARKS): { s: Soldier; kind: BarkKind; age: number; sx: number; sy: number }[] {
    const out: { s: Soldier; kind: BarkKind; age: number; sx: number; sy: number }[] = [];
    for (const [id, b] of this.live) {
      const s = sim.soldiers[id];
      const [sx, sy] = cam.worldToScreen(s.x, s.y, cw, ch);
      if (barkAlpha(now - b.t0) <= 0 || sx < 0 || sx > cw || sy < 0 || sy > ch) continue;
      out.push({ s, kind: b.kind, age: now - b.t0, sx, sy });
    }
    out.sort((p, q) => BARK[q.kind].rank - BARK[p.kind].rank || p.age - q.age || p.s.id - q.s.id);
    return out.slice(0, max);
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, sim: Sim, now: number, cw: number, ch: number): void {
    // Below the zoom where a man is a dot there is nobody to hang a word on.
    if (!barksOn() || cam.scale < SPRITE_MIN_SCALE || this.live.size === 0) return;
    const px = barkPx(cam.scale, MOBILE);
    ctx.save();
    ctx.font = `600 ${px}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    const placed: [number, number, number][] = []; // x, y, half-width of the words already down
    for (const b of this.shown(cam, sim, now, cw, ch)) {
      const spec = BARK[b.kind];
      const half = ctx.measureText(spec.text).width / 2 + 2;
      // above his head, drifting up a little as it ages
      let sy = b.sy - cam.scale * 0.9 - 5 - (b.age / BARK_MS) * 5;
      // two men a metre apart both speaking: the later word steps up a line
      for (const [ox, oy, oh] of placed) {
        if (Math.abs(b.sx - ox) < half + oh && Math.abs(sy - oy) < px) sy = oy - px - 1;
      }
      placed.push([b.sx, sy, half]);
      ctx.globalAlpha = barkAlpha(b.age);
      // the halo is what lets it read on wheat, on a pale road and at night
      ctx.strokeStyle = 'rgba(12,12,9,0.85)';
      ctx.strokeText(spec.text, b.sx, sy);
      ctx.fillStyle = spec.alarm ? '#f0b060' : '#e8e2c8';
      ctx.fillText(spec.text, b.sx, sy);
    }
    ctx.restore();
  }
}
