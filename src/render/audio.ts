import type { WeaponKey } from '../sim/data';
import type { Camera } from './camera';
import type { MeleeEvent, ShotEvent, UnitEvent } from '../sim/sim';
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

const MAX_TAPS = MOBILE ? 3 : 6;
const TAP_FALL = 0.85; // gain drop across a burst — the first round is the loudest

// Hard concurrent cap — a firefight is hundreds of events/frame. Each voice is
// a BufferSource plus two BiquadFilters; mobile WebAudio clips and drops out
// well below 28, so a phone gets less than half. (Unlock itself already works
// on touch via the pointerdown listener in main.ts — nothing to fix there.)
const MAX_VOICES = MOBILE ? 12 : 28;
const NEW_PER_BATCH = 12; // loudest-first budget per drained frame

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private voices = 0;
  muted = false;

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
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
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
  // Returns [gain, pan, nd] — nd is the normalized distance from viewport centre
  // (0 = dead centre, 1 ≈ screen corner), reused by the near-miss crack gate.
  private place(x: number, y: number, cam: Camera, cw: number, ch: number): [number, number, number] | null {
    const [sx, sy] = cam.worldToScreen(x, y, cw, ch);
    const half = Math.hypot(cw, ch) / 2;
    const nd = Math.hypot(sx - cw / 2, sy - ch / 2) / half;
    if (nd > 2.6) return null;
    const gain = Math.max(0.08, 1 - nd * 0.62);
    const pan = Math.max(-1, Math.min(1, (sx - cw / 2) / (cw / 2)));
    return [gain, pan, nd];
  }

  // One filtered noise burst — the workhorse for guns, explosions, cracks, melee.
  private burst(freq: number, q: number, decay: number, gain: number, pan: number, type: BiquadFilterType = 'bandpass'): void {
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
    const now = ctx.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(filt);
    filt.connect(g);
    g.connect(p);
    p.connect(this.master);
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      filt.disconnect();
      g.disconnect();
      p.disconnect();
    };
    src.start(now);
    src.stop(now + decay + 0.02);
  }

  // Oscillator tone — low body thumps, explosion sub, UI blips. Optional pitch glide.
  private tone(freq: number, decay: number, gain: number, pan: number, freqEnd?: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx;
    if (!ctx || this.voices >= MAX_VOICES) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(freq, now);
    if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    osc.connect(g);
    g.connect(p);
    p.connect(this.master);
    this.voices++;
    osc.onended = () => {
      this.voices--;
      osc.disconnect();
      g.disconnect();
      p.disconnect();
    };
    osc.start(now);
    osc.stop(now + decay + 0.02);
  }

  // One shot = one logical voice: a single Gain→Panner chain, counted once
  // against MAX_VOICES, fed by however many short sources the weapon needs
  // (burst taps, bolt clack, body thump). `near` gates the mechanical detail
  // that only carries when the camera is on top of the shooter.
  private gunshot(w: Gun, level: number, pan: number, near: boolean): void {
    const ctx = this.ctx;
    if (!ctx || this.voices >= MAX_VOICES) return;
    const out = ctx.createGain();
    out.gain.value = level;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    out.connect(p);
    p.connect(this.master);
    this.voices++;
    let open = 0;
    const close = (): void => {
      if (--open === 0) {
        this.voices--;
        out.disconnect();
        p.disconnect();
      }
    };
    const now = ctx.currentTime;
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
    const taps = Math.min(w.taps ?? 1, MAX_TAPS);
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
    const scored: { g: number; pan: number; gun: Gun; near: boolean; miss: boolean; nd: number }[] = [];
    for (const s of shots) {
      const placed = this.place(s.fx, s.fy, cam, cw, ch);
      if (!placed) continue;
      const gun = s.weapon ? GUN[s.weapon] : CANNON; // vehicle main guns carry no weapon key
      // near-miss crack gates on the impact point (where the round snaps past),
      // not the muzzle; 9 = far off-screen (place culled it), so no crack
      const impact = this.place(s.tx, s.ty, cam, cw, ch);
      scored.push({ g: placed[0], pan: placed[1], gun, near: placed[2] < 0.6, miss: !s.hit, nd: impact ? impact[2] : 9 });
    }
    scored.sort((a, b) => b.g - a.g);
    for (let i = 0; i < Math.min(scored.length, NEW_PER_BATCH); i++) {
      const s = scored[i];
      this.gunshot(s.gun, s.g, s.pan, s.near);
      // whip-crack for a round snapping past where the player is looking
      if (s.miss && s.nd < 0.4) this.burst(3000, 6, 0.03, 0.5 * s.g, s.pan, 'bandpass');
    }
  }

  addBooms(booms: { x: number; y: number }[], cam: Camera, cw: number, ch: number): void {
    if (!this.live()) return;
    for (const b of booms) {
      const placed = this.place(b.x, b.y, cam, cw, ch);
      if (!placed) continue;
      const [g, pan] = placed;
      this.burst(200, 0.5, 0.55, 1.1 * g, pan, 'lowpass'); // debris/blast body
      this.tone(64, 0.6, 0.9 * g, pan, 34, 'sine'); // sub thump, pitch drops
      this.burst(1400, 1, 0.08, 0.35 * g, pan, 'bandpass'); // sharp crack front
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
      const [g, pan] = placed;
      this.burst(420, 0.7, 0.35, 0.7 * g, pan, 'lowpass'); // masonry rush
      this.burst(2600, 2, 0.12, 0.22 * g, pan, 'bandpass'); // chips on the cobbles
    }
  }

  addMelee(events: MeleeEvent[], cam: Camera, cw: number, ch: number): void {
    if (!this.live()) return;
    for (const m of events) {
      const placed = this.place(m.x, m.y, cam, cw, ch);
      if (!placed) continue;
      const [g, pan] = placed;
      if (m.hit) {
        this.burst(m.kill ? 240 : 380, 1.2, m.kill ? 0.14 : 0.09, 0.9 * g, pan, 'bandpass'); // wet thud, lower on a kill
        this.tone(m.kill ? 70 : 90, 0.1, 0.5 * g, pan, undefined, 'triangle');
      } else {
        this.burst(2200, 3, 0.05, 0.3 * g, pan, 'bandpass'); // blade swish
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
