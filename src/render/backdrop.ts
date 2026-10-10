import { RedCommander } from '../sim/ai';
import { generateMap } from '../sim/mapgen';
import { makeScenario } from '../sim/scenario';
import { DT, Sim } from '../sim/sim';
import { Camera } from './camera';
import { setSun } from './light';
import { Renderer } from './renderer';
import { MOBILE, view } from './view';

// The battle behind the main menu. The first thing a visitor sees should be
// the game, and the landing page was a title and a button on black. This runs
// the skirmish scenario on a fixed seed with a commander on each side and
// draws it through the ordinary renderer, dimmed, with the camera drifting.
//
// It is scenery, and everything about it is arranged so that it can never get
// in the way of the one thing the page is for, which is pressing Play:
//
//  - It boots AFTER the page has painted and the menu is usable, in slices,
//    each handed back to the event loop before the next. Nothing is shown
//    until all of it is ready, and then it fades up.
//  - It takes no input, makes no sound and has no HUD: it only ever draws to
//    the canvas the menu already sits over.
//  - The moment the menu is not the thing on screen it stops and lets go of
//    its sim and renderer (`want(false)`).
//
// A phone gets a smaller battle and draws it every other frame.
//
// It is deterministic: one seed, the sim's own fixed step, and two commanders
// that are stepped with it (tests/backdrop.test.ts runs the fight twice and
// compares the snapshots). A STILL backdrop is that same fight stopped on one
// tick, which is what a reader who asked for reduced motion gets and what a
// screenshot gate gets by pinning the cosmetic clock (?flicker=0). ?backdrop=0
// turns it off.

export type BackdropMode = 'live' | 'still' | 'off';

export function backdropMode(param: string | null, pinned: boolean, reducedMotion: boolean): BackdropMode {
  if (param === '0') return 'off';
  return pinned || reducedMotion ? 'still' : 'live';
}

export const BACKDROP_SEED = 1944;
// The tick the fight is joined on, for the full battle and for the small one a
// phone gets: the first contact, when the most men on both sides are firing
// (measured: by tick 1500 the full battle has gone quiet). A still backdrop
// is exactly this tick.
export const BACKDROP_TICK = { full: 300, small: 450 };
// The last ticks before that are run with the renderer attached, so the frame
// the backdrop opens on, and the only frame a still one has, has that
// moment's tracers and flashes in it.
const PRELUDE_TICKS = 12;
// A fight ends, or dies down. Past this many ticks, or once a side has won,
// the backdrop fades out and stages the same fight again.
const RUN_TICKS = { full: 2700, small: 1800 };
// How long after the menu first shows before any of this starts. The page has
// painted and settled by then. A phone waits long enough that a visitor who
// came to press Play has pressed it: three pieces of the boot cannot be cut
// up (staging the map, building the renderer, the first frame's sprites), and
// on a slow phone each holds the thread for about a tenth of a second.
const BOOT_DELAY_MS = MOBILE ? 2500 : 350;
// How long a boot slice may run before it hands the thread back. Everything
// that CAN be cut up is: the run-up to the fight and the chunk bakes.
const SLICE_MS = 6;
const FADE_MS = 900;
// A phone draws every other frame. The fight runs at the same speed.
const DRAW_EVERY = MOBILE ? 2 : 1;
const SCALE = MOBILE ? 7 : 11; // px per metre, at least: see aim()
// How dark the battle is held: darker under the title and the buttons, which
// sit in the top of the page, than at the foot of it.
export const DIM_TOP = 0.74;
export const DIM_FOOT = 0.42;

// Where the camera looks: a slow figure of eight round the fight, `t` in
// seconds. Pure, so the still frame and the gate agree on it.
export function drift(t: number): [number, number] {
  return [Math.sin(t * 0.045) * 9, Math.sin(t * 0.09) * 5];
}

// The small battle: two rifle squads and a machine gun against a Gruppe and a
// heavy MG, on a map a third the area of the skirmish's. Everything the boot
// cannot slice scales with the map, so this is the phone's cap.
function smallScenario(): Sim {
  const plan = generateMap(BACKDROP_SEED, 96, 72, 'open', { interiors: true });
  const sim = new Sim(plan.map, BACKDROP_SEED);
  sim.buildings = plan.buildings;
  const { west } = plan.spawns;
  const y = (dy: number): number => Math.min(plan.map.h - 5, Math.max(4, west.y + dy));
  sim.addSquadFromDef('blue', 'us_rifle', west.x + 6, y(-9));
  sim.addSquadFromDef('blue', 'us_rifle', west.x + 6, y(9));
  sim.addSquadFromDef('blue', 'us_m1919', west.x + 9, y(0));
  const [village, woods] = plan.objectives;
  sim.addSquadFromDef('red', 'de_gruppe', village.x, village.y);
  sim.addSquadFromDef('red', 'de_smg42', (woods ?? village).x, (woods ?? village).y + (woods ? 0 : 6));
  return sim;
}

// The fight itself: a scenario on the backdrop's seed, the garrison holding
// where it stands and the attack briefed onto it. No canvas and no clock in
// it, so the same call is the same battle, tick for tick.
export function stageBackdrop(small: boolean): { sim: Sim; commanders: RedCommander[] } {
  const sim = small ? smallScenario() : makeScenario(BACKDROP_SEED);
  sim.fowDisabled = true; // nobody is playing a side: show the fight
  const held: Record<number, { x: number; y: number }> = {};
  for (const sq of sim.squads) {
    if (sq.side !== 'red') continue;
    const lead = sim.soldiers[sq.soldierIds[0]];
    held[sq.id] = { x: lead.x, y: lead.y };
  }
  const onto = Object.values(held);
  const attack: Record<number, { x: number; y: number }> = {};
  sim.squads.filter((sq) => sq.side === 'blue').forEach((sq, i) => (attack[sq.id] = onto[i % onto.length]));
  return {
    sim,
    commanders: [new RedCommander({ side: 'red', stance: 'defend', posts: held }), new RedCommander({ side: 'blue', stance: 'attack', posts: attack, objectives: onto })],
  };
}

type Stage = 'idle' | 'waiting' | 'booting' | 'ready';

export class MenuBackdrop {
  private stage: Stage = 'idle';
  private timer = 0;
  private sim: Sim | null = null;
  private renderer: Renderer | null = null;
  private commanders: RedCommander[] = [];
  private cam = new Camera(0, 0);
  private focus: [number, number] = [0, 0];
  private acc = 0;
  private now = 0; // the backdrop's own fx clock, ms
  private fade = 0; // 0 hidden .. 1 shown
  private frames = 0;
  private drawn = ''; // the view a still frame was last drawn for
  private until = 0; // the tick this boot is running the fight up to

  constructor(readonly mode: BackdropMode) {}

  /** True while a backdrop is on the canvas (the menu then drops its own black). */
  get shown(): boolean {
    return this.stage === 'ready';
  }

  /** The sim, for the harness. Null whenever the backdrop is not running. */
  get battle(): Sim | null {
    return this.sim;
  }

  // Called every menu frame with whether the menu is the thing on screen.
  want(on: boolean): void {
    if (this.mode === 'off') return;
    if (!on) {
      if (this.stage !== 'idle') this.stop();
      return;
    }
    if (this.stage !== 'idle') return;
    this.stage = 'waiting';
    this.timer = window.setTimeout(() => this.boot(), BOOT_DELAY_MS);
  }

  private stop(): void {
    window.clearTimeout(this.timer);
    this.stage = 'idle';
    this.sim = null;
    this.renderer = null;
    this.commanders = [];
    this.fade = 0;
    this.drawn = '';
  }

  // One slice of the boot, then back to the event loop. `stage` is checked on
  // the way in: a stop() between slices ends the chain.
  private next(step: () => void): void {
    this.timer = window.setTimeout(() => {
      if (this.stage === 'booting') step();
    }, 0);
  }

  private boot(): void {
    this.stage = 'booting';
    const { sim, commanders } = stageBackdrop(MOBILE);
    this.until = MOBILE ? BACKDROP_TICK.small : BACKDROP_TICK.full;
    this.sim = sim;
    this.commanders = commanders;
    this.next(() => this.advance());
  }

  private step(): void {
    const sim = this.sim!;
    for (const c of this.commanders) c.update(sim);
    sim.step();
  }

  // What the sim reported since it was last asked, handed to the renderer.
  private pump(): void {
    const sim = this.sim!;
    const R = this.renderer!;
    R.addEvents(sim.takeEvents(), this.now);
    R.addMeleeEvents(sim.takeMeleeEvents(), this.now);
    R.addBooms(sim.takeBooms(), this.now);
    R.addBreaches(sim.takeBreaches(), this.now);
    R.addPlanes(sim.takePlanes(), this.now);
    R.addUnitEvents(sim.takeUnitEvents(), this.now);
  }

  // Run the fight up to its tick. Nothing is drawn yet, so what the sim
  // reports on the way is dropped, up to the prelude.
  private advance(): void {
    const sim = this.sim!;
    const to = this.until - PRELUDE_TICKS;
    for (const t0 = performance.now(); sim.tick < to && performance.now() - t0 < SLICE_MS; ) this.step();
    sim.takeEvents();
    sim.takeBooms();
    sim.takeBreaches();
    sim.takePlanes();
    sim.takeMeleeEvents();
    sim.takeUnitEvents();
    if (sim.tick < to) return this.next(() => this.advance());
    this.next(() => {
      this.renderer = new Renderer(sim);
      this.renderer.flickerOn = this.mode === 'live';
      this.next(() => {
        while (sim.tick < this.until) {
          this.step();
          this.now = sim.tick * DT * 1000;
          this.pump();
        }
        this.focus = this.action();
        this.aim(0);
        this.next(() => this.bake());
      });
    });
  }

  // Every chunk of the map at the band the backdrop is drawn at, a few a
  // slice. Left to the first draw, a desktop bakes the whole view in one frame.
  private bake(): void {
    const map = this.sim!.map;
    const whole = new Camera(map.w / 2, map.h / 2);
    whole.scale = this.cam.scale;
    setSun(this.sim!.clockMin);
    // one chunk a slice: a chunk is a millisecond or two, and a slice is not much more
    if (this.renderer!.warm(whole, map.w * whole.scale, map.h * whole.scale, 1) > 0) return this.next(() => this.bake());
    this.stage = 'ready';
  }

  // The middle of the fighting: the men with a target, or failing that everyone.
  private action(): [number, number] {
    const sim = this.sim!;
    let x = 0;
    let y = 0;
    let n = 0;
    for (const pass of [true, false]) {
      for (const s of sim.soldiers) {
        if (!s.alive || s.inVehicle >= 0 || (pass && s.targetId < 0)) continue;
        x += s.x;
        y += s.y;
        n++;
      }
      if (n > 0) break;
    }
    return n > 0 ? [x / n, y / n] : [sim.map.w / 2, sim.map.h / 2];
  }

  private aim(dtMs: number): void {
    const map = this.sim!.map;
    const [ax, ay] = this.action();
    // the fight moves; the camera follows it over seconds, not frames
    const k = Math.min(1, dtMs / 4000);
    this.focus[0] += (ax - this.focus[0]) * k;
    this.focus[1] += (ay - this.focus[1]) * k;
    const [dx, dy] = drift(this.now / 1000);
    // Never off the map. Close enough that the map covers the page whichever
    // way it is turned (the small battle's is 72 m tall and a phone is not),
    // then half a view in from every edge.
    const scale = Math.max(SCALE, view.w / map.w, view.h / map.h);
    this.cam.scale = scale;
    const hw = view.w / 2 / scale;
    const hh = view.h / 2 / scale;
    this.cam.x = Math.min(map.w - hw, Math.max(hw, this.focus[0] + dx));
    this.cam.y = Math.min(map.h - hh, Math.max(hh, this.focus[1] + dy));
  }

  /** Draw one menu frame. Does nothing until the boot has finished. */
  frame(ctx: CanvasRenderingContext2D, dtMs: number): void {
    if (this.stage !== 'ready') return;
    const sim = this.sim!;
    const R = this.renderer!;
    if (this.mode === 'still') {
      // one frame, drawn again only when the canvas it was drawn on has changed
      const key = `${view.w}x${view.h}@${view.dpr}`;
      if (key === this.drawn) return;
      this.drawn = key;
      this.fade = 1;
      this.aim(0);
    } else {
      this.acc += Math.min(dtMs, 100);
      let steps = 0;
      while (this.acc >= DT * 1000 && steps++ < 3) {
        this.acc -= DT * 1000;
        this.step();
      }
      if (steps > 3) this.acc = 0; // behind: run slow, never catch up in a burst
      this.now += dtMs;
      this.pump();
      // over, or gone quiet: down to black, and the next frame's want() stages it again
      const done = sim.winner !== null || sim.tick > this.until + (MOBILE ? RUN_TICKS.small : RUN_TICKS.full);
      this.fade = Math.max(0, Math.min(1, this.fade + (done ? -dtMs : dtMs) / FADE_MS));
      if (done && this.fade === 0) return this.stop();
      this.aim(dtMs);
      if (this.frames++ % DRAW_EVERY !== 0) return;
    }
    setSun(sim.clockMin);
    R.draw(ctx, this.cam, [], this.now);
    // the dim, and under it the black the menu had, until the fade is done
    const g = ctx.createLinearGradient(0, 0, 0, view.h);
    g.addColorStop(0, `rgba(13,15,11,${DIM_TOP + (1 - DIM_TOP) * (1 - this.fade)})`);
    g.addColorStop(1, `rgba(13,15,11,${DIM_FOOT + (1 - DIM_FOOT) * (1 - this.fade)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
  }
}
