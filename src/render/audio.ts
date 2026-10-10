import type { WeaponKey } from '../sim/data';
import type { Camera } from './camera';
import type { BoomEvent, BoomKind, MeleeEvent, ShotEvent, UnitEvent } from '../sim/sim';
import { ACTIVITY_PER_BOOM, ACTIVITY_PER_SHOT, AIR_OPEN_HZ, airCutoff, arrivalDelay, decayActivity, engineGain, listenDist, rumbleGain, WET_FAR_M } from './audiospace';
import { blastOf } from './fx';
import { MOBILE } from './view';

// Procedural WebAudio combat layer. No assets: every sound is synthesized from
// one shared white-noise buffer + oscillator tones. Render-side only — the sim
// stays headless. Everything no-ops until unlock() runs inside a user gesture.
//
// Spatialization is screen-space: an event's gain/pan derive from where it lands
// relative to the viewport centre, so zoom naturally controls "how close" a shot
// reads. Distant / off-screen fire stays audible but quiet — atmosphere, not a
// fog-of-war leak (tracers already render ungated; audio mirrors them).

// One weapon's report recipe. A ShotEvent is one ABSTRACTED attack, so an
// automatic weapon voices `taps` rounds at its real cyclic spacing — an MG42
// attack has to read as the MG42's rrrip, not as a single click.
export interface Gun {
  freq: number; // bandpass centre of the report
  q: number;
  decay: number; // seconds, per tap
  gain: number;
  body: number; // low thump frequency, 0 = none
  taps?: number; // rounds voiced per event, default 1
  spacing?: number; // seconds between taps (60 / cyclic rpm)
  bolt?: boolean; // delayed 2-tap bolt-cycle clack, close shots only
  tail?: number; // whip-crack tail gain — the long report of a sniper rifle
}

const ROCKET: Gun = { freq: 500, q: 0.5, decay: 0.5, gain: 1.0, body: 55 };
const CANNON: Gun = { freq: 320, q: 0.6, decay: 0.4, gain: 1.0, body: 60 };

// Per weapon, not per class: the point is that a player can name the gun by
// ear. Bolt-actions crack once and cycle; the two scoped rifles sit lower and
// ring longer; the SMGs and MGs differ by cyclic rate as much as by timbre.
export const GUN: Record<WeaponKey, Gun> = {
  garand: { freq: 1350, q: 1.0, decay: 0.15, gain: 0.95, body: 95 },
  carbine: { freq: 1750, q: 1.3, decay: 0.10, gain: 0.65, body: 125 },
  kar98k: { freq: 1150, q: 0.9, decay: 0.17, gain: 0.95, body: 85, bolt: true },
  springfield: { freq: 880, q: 0.8, decay: 0.28, gain: 1.15, body: 68, bolt: true, tail: 0.3 },
  kar98k_scoped: { freq: 980, q: 0.8, decay: 0.26, gain: 1.1, body: 74, bolt: true, tail: 0.26 },
  thompson: { freq: 700, q: 0.7, decay: 0.08, gain: 0.7, body: 65, taps: 4, spacing: 0.086 },
  mp40: { freq: 950, q: 0.8, decay: 0.07, gain: 0.6, body: 80, taps: 3, spacing: 0.111 },
  bar: { freq: 1250, q: 1.0, decay: 0.09, gain: 0.8, body: 90, taps: 3, spacing: 0.109 },
  m1919: { freq: 1450, q: 1.1, decay: 0.08, gain: 0.75, body: 85, taps: 3, spacing: 0.120 },
  mg42: { freq: 1900, q: 1.3, decay: 0.05, gain: 0.62, body: 70, taps: 5, spacing: 0.050 },
  bazooka: ROCKET, schreck: ROCKET, panzerfaust: ROCKET,
  mortar60: CANNON, mortar81: CANNON, at57_gun: CANNON, pak40_gun: CANNON,
};

// One blast's voice: a low-passed body, a sub thump whose pitch drops, and a
// crack front. The kinds differ in which of the three leads. A grenade is
// mostly crack; a bomb is mostly sub and keeps rolling; an AT round rings on
// the plate it hit. `mortar` is the voice every blast had before the sim named
// them, and is what a boom with no kind still gets.
interface BoomVoice {
  body: number; // low-pass corner of the blast body, Hz
  bodyDecay: number; // seconds
  bodyGain: number;
  sub: number; // thump start pitch, Hz — it falls to about half
  subDecay: number;
  subGain: number;
  crack: number; // band-pass centre of the crack front, Hz
  crackGain: number;
  ring?: number; // struck-steel tone, Hz
  roll?: boolean; // a long low tail after the body
}

export const BOOM: Record<BoomKind, BoomVoice> = {
  grenade: { body: 320, bodyDecay: 0.28, bodyGain: 0.8, sub: 80, subDecay: 0.3, subGain: 0.5, crack: 1800, crackGain: 0.5 },
  mortar: { body: 200, bodyDecay: 0.55, bodyGain: 1.1, sub: 64, subDecay: 0.6, subGain: 0.9, crack: 1400, crackGain: 0.35 },
  shell: { body: 170, bodyDecay: 0.7, bodyGain: 1.2, sub: 55, subDecay: 0.75, subGain: 1, crack: 1200, crackGain: 0.4 },
  at: { body: 260, bodyDecay: 0.3, bodyGain: 0.7, sub: 70, subDecay: 0.35, subGain: 0.6, crack: 2200, crackGain: 0.7, ring: 900 },
  bomb: { body: 130, bodyDecay: 1.1, bodyGain: 1.3, sub: 48, subDecay: 1.2, subGain: 1.1, crack: 1000, crackGain: 0.4, roll: true },
  brewup: { body: 150, bodyDecay: 0.9, bodyGain: 1.2, sub: 50, subDecay: 1, subGain: 1, crack: 1300, crackGain: 0.4, roll: true },
};

const MAX_TAPS = MOBILE ? 3 : 6;
const TAP_FALL = 0.85; // gain drop across a burst — the first round is the loudest

// The burst one ShotEvent stands for. The ear and the eye both read it from
// here: gunshot() voices this many taps `spacing` apart, and the renderer
// strobes one muzzle flash per tap off the same two numbers, so the picture
// cannot drift from the sound.
export function gunOf(weapon: WeaponKey | undefined): Gun {
  return weapon ? GUN[weapon] : CANNON; // vehicle main guns carry no weapon key
}
export function tapsOf(gun: Gun): number {
  return Math.min(gun.taps ?? 1, MAX_TAPS);
}

// Hard concurrent cap — a firefight is hundreds of events/frame. Each voice is
// a BufferSource plus two BiquadFilters; mobile WebAudio clips and drops out
// well below 28, so a phone gets less than half. (Unlock itself already works
// on touch via the pointerdown listener in main.ts — nothing to fix there.)
const MAX_VOICES = MOBILE ? 12 : 28;
const NEW_PER_BATCH = 12; // loudest-first budget per drained frame

// Where a voice is, as the three things the graph does about it (audiospace.ts
// has the arithmetic): the corner of the low-pass the air puts on it, how long
// after its flash it starts, and which reverb send it feeds.
interface Space {
  cutoff: number; // Hz
  delay: number; // s
  send: 0 | 1 | 2; // none, the near send, the far send
}
// A readout, not a world sound: full range, at once, dry.
const DRY: Space = { cutoff: AIR_OPEN_HZ, delay: 0, send: 0 };
// Below this the air filter is worth a node. Above it there is nothing to hear.
const AIR_AUDIBLE_HZ = AIR_OPEN_HZ * 0.8;
// A bed level is re-targeted only when it has moved this far: a steady field
// makes no AudioParam calls at all, and nothing queues an event a frame.
const BED_STEP = 0.003;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private voices = 0;
  muted = false;
  // Space and bed: built once in unlock(), never per frame. Two sends into
  // one feedback-delay reverb; a wind bed that is always there; a far rumble
  // and one engine voice whose gains ambience() steers.
  private send!: GainNode;
  private sendFar!: GainNode;
  private rumble!: GainNode;
  private engine!: GainNode;
  private enginePan!: StereoPannerNode;
  private activity = 0; // how much firing there has been lately (audiospace.ts decayActivity)
  private bedAt = 0; // ctx time of the last ambience()
  private bedSet = [0, 0, 0]; // the rumble, engine and pan targets last sent

  // Must be called from a user-gesture handler (WebAudio autoplay policy).
  // Idempotent: creates the graph once, resumes a suspended context after.
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // no WebAudio — degrade to silence
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      const comp = this.ctx.createDynamicsCompressor(); // tames a full firefight from clipping
      comp.threshold.value = -18;
      comp.ratio.value = 12;
      comp.attack.value = 0.002;
      comp.release.value = 0.15;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      this.noise = this.makeNoise(this.ctx, 1);
      this.buildSpace(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // The reverb and the bed. Every node here is made once and lives as long as
  // the context: nothing below is ever created from the frame loop.
  private buildSpace(ctx: AudioContext): void {
    // Reverb from two feedback delays, not a convolver: an impulse response
    // is an asset and a convolver is the dearest node WebAudio has. Two
    // incommensurate taps with a low-pass in the longer loop are enough for
    // "this happened outdoors, in a valley" — a slap and a darker tail.
    this.send = ctx.createGain();
    this.send.gain.value = 0.16;
    this.sendFar = ctx.createGain();
    this.sendFar.gain.value = 0.42;
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    wet.connect(this.master);
    for (const [time, feedback, damp] of [
      [0.083, 0.34, 3200],
      [0.137, 0.42, 1800],
    ]) {
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = time;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = damp;
      const fb = ctx.createGain();
      fb.gain.value = feedback; // under 1: the loop always dies away
      this.send.connect(delay);
      this.sendFar.connect(delay);
      delay.connect(lp);
      lp.connect(fb);
      fb.connect(delay);
      lp.connect(wet);
    }
    // The bed plays one long noise buffer on a loop: at one second the loop
    // itself is audible once the top is filtered off.
    const bed = this.makeNoise(ctx, 5);
    const loop = (rate: number, hz: number, into: AudioNode): void => {
      const src = ctx.createBufferSource();
      src.buffer = bed;
      src.loop = true;
      src.playbackRate.value = rate;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = hz;
      lp.Q.value = 0.4;
      src.connect(lp);
      lp.connect(into);
      src.start();
    };
    // Wind: quiet, always there, breathing on a slow oscillator.
    const wind = ctx.createGain();
    wind.gain.value = 0.018;
    wind.connect(this.master);
    loop(1, 420, wind);
    const gust = ctx.createOscillator();
    gust.frequency.value = 0.09;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 0.008;
    gust.connect(gustDepth);
    gustDepth.connect(wind.gain);
    gust.start();
    // The far rumble: the same noise an octave and more down, silent until
    // ambience() hears firing.
    this.rumble = ctx.createGain();
    this.rumble.gain.value = 0;
    this.rumble.connect(this.master);
    loop(0.4, 80, this.rumble);
    // One engine for every hull in view: two detuned saws through a low-pass
    // that a 9 Hz oscillator opens and shuts, which is the idle's chug.
    this.engine = ctx.createGain();
    this.engine.gain.value = 0;
    this.enginePan = ctx.createStereoPanner();
    this.engine.connect(this.enginePan);
    this.enginePan.connect(this.master);
    const block = ctx.createBiquadFilter();
    block.type = 'lowpass';
    block.frequency.value = 170;
    block.connect(this.engine);
    for (const hz of [43, 64.5]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz;
      osc.connect(block);
      osc.start();
    }
    const chug = ctx.createOscillator();
    chug.frequency.value = 9;
    const chugDepth = ctx.createGain();
    chugDepth.gain.value = 45;
    chug.connect(chugDepth);
    chugDepth.connect(block.frequency);
    chug.start();
  }

  // Once a frame. Steers the bed: the far rumble by how much firing there has
  // been in the last few seconds, the engine by the live hulls in view (the
  // caller passes only the ones the player can see). `quiet` is a paused
  // battle, or no battle at all: wind only. It makes no nodes, and no
  // AudioParam call either unless a level has actually moved.
  ambience(hulls: readonly { x: number; y: number }[], cam: Camera, cw: number, ch: number, quiet: boolean): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (!(now >= 0)) return; // the one input below that goes to a param unexamined
    this.activity = decayActivity(this.activity, now - this.bedAt);
    this.bedAt = now;
    let sum = 0;
    let panned = 0;
    if (!quiet) {
      for (const h of hulls) {
        const placed = this.place(h.x, h.y, cam, cw, ch);
        if (!placed) continue;
        sum += placed[0];
        panned += placed[0] * placed[1];
      }
    }
    const want = [quiet ? 0 : rumbleGain(this.activity), quiet ? 0 : engineGain(sum), sum > 0 ? panned / sum : 0];
    const params = [this.rumble.gain, this.engine.gain, this.enginePan.pan];
    const tau = [0.4, 0.25, 0.25];
    for (let i = 0; i < 3; i++) {
      // NaN fails the first test, so it is never sent
      if (!(Math.abs(want[i] - this.bedSet[i]) >= BED_STEP) || !(Math.abs(want[i]) <= 1)) continue;
      this.bedSet[i] = want[i];
      params[i].setTargetAtTime(want[i], now, tau[i]);
    }
  }

  // The two sounds the interface makes for itself: a tick when a unit is
  // picked, and two rising notes when an order goes out. Dry and centred,
  // like the unit-event readouts below.
  uiSelect(): void {
    if (!this.live()) return;
    this.tone(1320, 0.05, 0.05, 0, 990, 'triangle');
  }

  uiOrder(): void {
    if (!this.live()) return;
    this.tone(620, 0.07, 0.07, 0, undefined, 'triangle');
    this.tone(930, 0.1, 0.06, 0, undefined, 'triangle', { cutoff: AIR_OPEN_HZ, delay: 0.07, send: 0 });
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private live(): boolean {
    return this.ctx !== null && this.ctx.state === 'running' && !this.muted;
  }

  // Screen-space placement: [gain multiplier, stereo pan]. gain falls off with
  // distance from viewport centre; culls only when far off-screen (nd > 2.6).
  // Returns [gain, pan, nd, space] — nd is the normalized distance from viewport
  // centre (0 = dead centre, 1 ≈ screen corner), reused by the near-miss crack
  // gate; space is what the air between the event and the camera does to it.
  private place(x: number, y: number, cam: Camera, cw: number, ch: number): [number, number, number, Space] | null {
    // A zero-area viewport is real: `view` starts {w:0,h:0} and a frame can run
    // before the first resize measures the canvas. Then `half` is 0, nd is 0/0
    // = NaN, and — this is the bug that crashed the game — `nd > 2.6` is FALSE
    // for NaN, so the cull passed it through and a NaN gain reached
    // AudioParam.value, which throws. An exception here aborts the rest of the
    // frame (addShots runs before renderer.draw), so it also cost the frame its
    // drawing and its HUD update: the reported "flickering at high speed".
    // Every comparison below is written so NaN fails it and culls.
    if (!(cw > 0) || !(ch > 0)) return null;
    const [sx, sy] = cam.worldToScreen(x, y, cw, ch);
    const half = Math.hypot(cw, ch) / 2;
    const nd = Math.hypot(sx - cw / 2, sy - ch / 2) / half;
    if (!(nd <= 2.6)) return null;
    const gain = Math.max(0.08, 1 - nd * 0.62);
    const pan = Math.max(-1, Math.min(1, (sx - cw / 2) / (cw / 2)));
    if (!Number.isFinite(gain) || !Number.isFinite(pan)) return null;
    // Metres along the ground from where the player is looking, and the
    // camera's height over that point. A zero or NaN scale gives a NaN height,
    // which every function in audiospace.ts turns into its safe value.
    const dm = Math.hypot(x - cam.x, y - cam.y);
    const d = listenDist(dm, ch / 2 / cam.scale);
    return [gain, pan, nd, { cutoff: airCutoff(d), delay: arrivalDelay(dm), send: d > WET_FAR_M ? 2 : 1 }];
  }

  // Out of a voice's last node: through the air (a low-pass, when there is
  // enough of it to hear) to the master and to its reverb send. Returns the
  // air filter if it made one, for the voice to disconnect with the rest.
  private route(ctx: AudioContext, from: AudioNode, sp: Space): BiquadFilterNode | null {
    let tail = from;
    let air: BiquadFilterNode | null = null;
    if (sp.cutoff < AIR_AUDIBLE_HZ) {
      air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = sp.cutoff;
      from.connect(air);
      tail = air;
    }
    tail.connect(this.master);
    if (sp.send !== 0) tail.connect(sp.send === 2 ? this.sendFar : this.send);
    return air;
  }

  // One filtered noise burst — the workhorse for guns, explosions, cracks, melee.
  private burst(freq: number, q: number, decay: number, gain: number, pan: number, type: BiquadFilterType = 'bandpass', sp: Space = DRY): void {
    const ctx = this.ctx;
    if (!ctx || this.voices >= MAX_VOICES) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6; // per-shot variety, no two identical
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    const now = ctx.currentTime + sp.delay;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(filt);
    filt.connect(g);
    g.connect(p);
    const air = this.route(ctx, p, sp);
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      filt.disconnect();
      g.disconnect();
      p.disconnect();
      air?.disconnect();
    };
    src.start(now);
    src.stop(now + decay + 0.02);
  }

  // Oscillator tone — low body thumps, explosion sub, UI blips. Optional pitch glide.
  private tone(freq: number, decay: number, gain: number, pan: number, freqEnd?: number, type: OscillatorType = 'sine', sp: Space = DRY): void {
    const ctx = this.ctx;
    if (!ctx || this.voices >= MAX_VOICES) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    const now = ctx.currentTime + sp.delay;
    osc.frequency.setValueAtTime(freq, now);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    osc.connect(g);
    g.connect(p);
    const air = this.route(ctx, p, sp);
    this.voices++;
    osc.onended = () => {
      this.voices--;
      osc.disconnect();
      g.disconnect();
      p.disconnect();
      air?.disconnect();
    };
    osc.start(now);
    osc.stop(now + decay + 0.02);
  }

  // One shot = one logical voice: a single Gain→Panner chain, counted once
  // against MAX_VOICES, fed by however many short sources the weapon needs
  // (burst taps, bolt clack, body thump). `near` gates the mechanical detail
  // that only carries when the camera is on top of the shooter.
  private gunshot(w: Gun, level: number, pan: number, near: boolean, sp: Space): void {
    const ctx = this.ctx;
    if (!ctx || this.voices >= MAX_VOICES) return;
    // Belt and braces behind place()'s cull: sound is cosmetic and must never
    // be able to throw inside the frame loop, whatever a caller hands it.
    if (!Number.isFinite(level) || !Number.isFinite(pan)) return;
    const out = ctx.createGain();
    out.gain.value = level;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    out.connect(p);
    const air = this.route(ctx, p, sp);
    this.voices++;
    let open = 0;
    const close = (): void => {
      if (--open === 0) {
        this.voices--;
        out.disconnect();
        p.disconnect();
        air?.disconnect();
      }
    };
    const now = ctx.currentTime + sp.delay;
    const tap = (at: number, freq: number, q: number, decay: number, gain: number): void => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.7 + Math.random() * 0.6; // per-tap variety, no two identical
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = freq;
      filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, at);
      g.gain.exponentialRampToValueAtTime(0.0008, at + decay);
      src.connect(filt);
      filt.connect(g);
      g.connect(out);
      open++;
      src.onended = () => {
        src.disconnect();
        filt.disconnect();
        g.disconnect();
        close();
      };
      src.start(at);
      src.stop(at + decay + 0.02);
    };
    const taps = tapsOf(w);
    for (let i = 0; i < taps; i++) tap(now + i * (w.spacing ?? 0), w.freq, w.q, w.decay, w.gain * TAP_FALL ** i);
    if (w.tail) tap(now + 0.02, 2600, 5, w.decay * 1.6, w.tail); // whip-crack over the report
    if (w.bolt && near) {
      tap(now + 0.25, 3200, 9, 0.03, 0.09); // bolt back
      tap(now + 0.4, 2400, 9, 0.04, 0.08); // bolt home
    }
    if (w.body) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const decay = w.decay * 1.4;
      osc.frequency.setValueAtTime(w.body, now);
      osc.frequency.exponentialRampToValueAtTime(w.body * 0.6, now + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 * w.gain, now);
      g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
      osc.connect(g);
      g.connect(out);
      open++;
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
        close();
      };
      osc.start(now);
      osc.stop(now + decay + 0.02);
    }
  }

  // Gunfire batch: place each shot, keep the loudest NEW_PER_BATCH, synth them.
  // Near-miss cracks only for incoming rounds landing near the viewport centre.
  addShots(shots: ShotEvent[], cam: Camera, cw: number, ch: number): void {
    if (!this.live() || shots.length === 0) return;
    this.activity += shots.length * ACTIVITY_PER_SHOT;
    const scored: { g: number; pan: number; gun: Gun; near: boolean; miss: boolean; nd: number; sp: Space }[] = [];
    for (const s of shots) {
      const placed = this.place(s.fx, s.fy, cam, cw, ch);
      if (!placed) continue;
      const gun = gunOf(s.weapon);
      // near-miss crack gates on the impact point (where the round snaps past),
      // not the muzzle; 9 = far off-screen (place culled it), so no crack
      const impact = this.place(s.tx, s.ty, cam, cw, ch);
      scored.push({ g: placed[0], pan: placed[1], gun, near: placed[2] < 0.6, miss: !s.hit, nd: impact ? impact[2] : 9, sp: placed[3] });
    }
    scored.sort((a, b) => b.g - a.g);
    for (let i = 0; i < Math.min(scored.length, NEW_PER_BATCH); i++) {
      const s = scored[i];
      this.gunshot(s.gun, s.g, s.pan, s.near, s.sp);
      // whip-crack for a round snapping past where the player is looking:
      // close by definition, so it is neither dulled nor late
      if (s.miss && s.nd < 0.4) this.burst(3000, 6, 0.03, 0.5 * s.g, s.pan, 'bandpass');
    }
  }

  addBooms(booms: BoomEvent[], cam: Camera, cw: number, ch: number): void {
    if (!this.live()) return;
    this.activity += booms.length * ACTIVITY_PER_BOOM;
    for (const b of booms) {
      const placed = this.place(b.x, b.y, cam, cw, ch);
      if (!placed) continue;
      const [g, pan, , sp] = placed;
      // The same size the renderer draws the blast at: a round bigger than
      // its kind's reference is louder and rings longer, never a new sound.
      const { kind, k } = blastOf(b);
      const v = BOOM[kind];
      const long = Math.sqrt(k);
      const loud = g * (0.7 + 0.3 * k);
      this.burst(v.body, 0.5, v.bodyDecay * long, v.bodyGain * loud, pan, 'lowpass', sp); // debris/blast body
      this.tone(v.sub, v.subDecay * long, v.subGain * loud, pan, v.sub * 0.53, 'sine', sp); // sub thump, pitch drops
      this.burst(v.crack, 1, 0.08, v.crackGain * loud, pan, 'bandpass', sp); // sharp crack front
      if (v.ring) this.tone(v.ring, 0.18, 0.22 * loud, pan, v.ring * 0.66, 'triangle', sp); // the plate it hit
      // A fourth long voice per blast is what a phone's 12-voice cap cannot
      // spare in a barrage.
      if (v.roll && !MOBILE) this.burst(90, 0.5, 1.2 * long, 0.55 * loud, pan, 'lowpass', sp);
    }
  }

  // A wall going down. No crack front and no sub thump — those are the blast,
  // and the blast has already been voiced through addBooms. This is only the
  // collapse: a short rush of falling stone on top of it.
  addBreaches(list: { x: number; y: number; horiz: boolean }[], cam: Camera, cw: number, ch: number): void {
    if (!this.live()) return;
    for (const b of list) {
      const placed = this.place(b.horiz ? b.x + 0.5 : b.x, b.horiz ? b.y : b.y + 0.5, cam, cw, ch);
      if (!placed) continue;
      const [g, pan, , sp] = placed;
      this.burst(420, 0.7, 0.35, 0.7 * g, pan, 'lowpass', sp); // masonry rush
      this.burst(2600, 2, 0.12, 0.22 * g, pan, 'bandpass', sp); // chips on the cobbles
    }
  }

  addMelee(events: MeleeEvent[], cam: Camera, cw: number, ch: number): void {
    if (!this.live()) return;
    for (const m of events) {
      const placed = this.place(m.x, m.y, cam, cw, ch);
      if (!placed) continue;
      const [g, pan, , sp] = placed;
      if (m.hit) {
        this.burst(m.kill ? 240 : 380, 1.2, m.kill ? 0.14 : 0.09, 0.9 * g, pan, 'bandpass', sp); // wet thud, lower on a kill
        this.tone(m.kill ? 70 : 90, 0.1, 0.5 * g, pan, undefined, 'triangle', sp);
      } else {
        this.burst(2200, 3, 0.05, 0.3 * g, pan, 'bandpass', sp); // blade swish
      }
    }
  }

  // Discrete UI events. Centre-panned, fixed modest gain — these are readouts,
  // not world sounds. The Garand out-of-clip 'ping' gets its iconic ring.
  addUnitEvents(events: UnitEvent[]): void {
    if (!this.live()) return;
    for (const e of events) {
      const friendly = e.side === 'blue';
      switch (e.kind) {
        case 'ping': // en-bloc clip ejection — the beloved *PING*
          this.tone(2100, 0.35, 0.14, 0, 2100, 'triangle');
          break;
        case 'kia':
          this.tone(friendly ? 170 : 300, 0.4, friendly ? 0.16 : 0.07, friendly ? -0.05 : 0.05, friendly ? 120 : 300, 'sine');
          break;
        case 'vehicle-destroyed':
          this.tone(90, 0.7, 0.2, 0, 45, 'sawtooth');
          break;
        case 'broken': // morale snap — a brief anxious dyad, only for the player's men
        case 'surrendered': // captured at melee contact — same treatment as broken
          if (friendly) this.tone(520, 0.18, 0.1, 0, 390, 'sine');
          break;
        // 'downed' is covered by the gunfire that caused it — no extra blip
      }
    }
  }
}
