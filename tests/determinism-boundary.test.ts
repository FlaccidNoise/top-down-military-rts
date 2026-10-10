// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESET, PRESETS, presetSpec } from '../src/campaign/presets';
import { GEN_VERSION, MIN_WAR_DAYS, SPEC_TAG, specSeed, specStream, type SpecTag } from '../src/campaign/spec';
import { parseSeed } from '../src/ui/seed';

// The determinism boundary: a campaign is a seed plus a config, and nothing
// else. This file pins the three seams that could break that — the seed
// helpers, the sub-stream tags, and the grep ratchet that keeps wall-clock and
// unseeded randomness out of the deterministic layer.

const SRC = new URL('../src/', import.meta.url);
// Identifier match, not call match: prose naming either symbol inside the
// deterministic layer trips the ratchet too. That is deliberate — the gate
// stays a grep anyone can run by hand.
const NONDET = /Math\.random|Date\.now/;
// src/render is excluded by design: scorch smears, audio jitter and renderer
// noise are unpinned and legitimate (§9.3).
const DETERMINISTIC = /^(sim|strategic|campaign)\//;

function tsFiles(dir: URL): URL[] {
  const out: URL[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]) {
    if (ent.isDirectory()) out.push(...tsFiles(new URL(`${ent.name}/`, dir)));
    else if (ent.name.endsWith('.ts')) out.push(new URL(ent.name, dir));
  }
  return out;
}

const rel = (f: URL): string => decodeURIComponent(f.href.slice(SRC.href.length));
const read = (f: URL): string => readFileSync(f, 'utf8') as string;

function nondetHits(f: URL): string[] {
  return read(f)
    .split('\n')
    .flatMap((line, i) => (NONDET.test(line) ? [`${rel(f)}:${i + 1} ${line.trim()}`] : []));
}

const deterministic = tsFiles(SRC).filter((f) => DETERMINISTIC.test(rel(f)));

describe('determinism ratchet', () => {
  it('scans a real file set (a scanner matching nothing would pass every gate below)', () => {
    expect(deterministic.length).toBeGreaterThan(20);
    for (const dir of ['sim/', 'strategic/', 'campaign/']) {
      expect(deterministic.some((f) => rel(f).startsWith(dir)), `no files under src/${dir}`).toBe(true);
    }
    // Positive control: the scanner finds the one call the design allows.
    expect(nondetHits(new URL('ui/seed.ts', SRC)).length).toBe(1);
  });

  it('src/sim, src/strategic and src/campaign hold no wall clock and no unseeded rng', () => {
    expect(deterministic.flatMap(nondetHits)).toEqual([]);
  });

  it('src/ui/seed.ts holds exactly one Math.random — the [Roll] affordance, nothing more', () => {
    const src = read(new URL('ui/seed.ts', SRC));
    expect((src.match(/Math\.random/g) ?? []).length).toBe(1);
    expect(src.match(/Date\.now/g)).toBe(null);
  });

  it('nothing in the deterministic layer imports the seed module', () => {
    const importers = deterministic.filter((f) => /from '[^']*ui\/seed'/.test(read(f))).map(rel);
    expect(importers).toEqual([]);
  });
});

describe('parseSeed', () => {
  // Pinned literals, not round-trips: stability across RUNS is what the campaign
  // depends on, and only a literal can fail when the hash changes.
  it('is stable — the same text always names the same campaign', () => {
    expect(parseSeed('OMAHA')).toBe(1841327331);
    expect(parseSeed('Caen')).toBe(271507774);
    expect(parseSeed('operation cobra')).toBe(2605806195);
    expect(parseSeed('')).toBe(2166136261);
    expect(parseSeed('12345')).toBe(12345);
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed('4294967295')).toBe(4294967295);
  });

  it('normalizes to a uint32 that re-enters as itself', () => {
    for (const text of ['OMAHA', 'Caen', 'bocage', '77', 'Seed 12']) {
      const seed = parseSeed(text);
      expect(seed >>> 0).toBe(seed);
      expect(parseSeed(String(seed))).toBe(seed);
    }
    expect(parseSeed('4294967296')).toBe(0); // wraps rather than throwing
    expect(parseSeed('007')).toBe(7);
    expect(parseSeed('  OMAHA  ')).toBe(parseSeed('OMAHA'));
  });

  it('is collision-distinct over the inputs a player would type', () => {
    const corpus = [
      'OMAHA', 'omaha', 'Omaha', 'UTAH', 'GOLD', 'JUNO', 'SWORD',
      'Caen', 'Carentan', 'Saint-Lô', 'Villers-Bocage', 'bocage', 'Bocage', 'BOCAGE',
      'a', 'b', 'ab', 'ba', 'aa', '', 'operation cobra', 'Operation Cobra', 'operation-cobra',
      ...Array.from({ length: 500 }, (_, i) => `op-${i}`),
      ...Array.from({ length: 500 }, (_, i) => `Seed ${i}`),
    ];
    const bySeed = new Map<number, string>();
    const collisions: string[] = [];
    for (const text of corpus) {
      const seed = parseSeed(text);
      const prev = bySeed.get(seed);
      if (prev !== undefined) collisions.push(`${JSON.stringify(prev)} and ${JSON.stringify(text)} → ${seed}`);
      else bySeed.set(seed, text);
    }
    expect(collisions).toEqual([]);
    expect(bySeed.size).toBe(corpus.length);

    // Digits name themselves, so they cannot collide either.
    const digits = new Set(Array.from({ length: 1000 }, (_, i) => parseSeed(String(i))));
    expect(digits.size).toBe(1000);
  });
});

describe('spec sub-streams', () => {
  const TAGS = Object.entries(SPEC_TAG) as [string, SpecTag][];
  const draws = (seed: number, tag: SpecTag): string => {
    const rng = specStream(presetSpec(DEFAULT_PRESET, seed), tag);
    return Array.from({ length: 8 }, () => rng.next()).join(',');
  };

  it('tags are frozen and append-only', () => {
    expect(SPEC_TAG).toEqual({ THEATER: 1, ROSTER: 2, DISPOSITION: 3, AI_SALT: 4 });
  });

  it('no two tags share a stream, over 1000 seeds', () => {
    const seeds = [0, 0xffffffff, ...Array.from({ length: 1000 }, (_, i) => i + 1)];
    const clashes: string[] = [];
    for (const seed of seeds) {
      const spec = presetSpec(DEFAULT_PRESET, seed);
      const streams = new Map<string, string>();
      const bases = new Map<number, string>();
      for (const [name, tag] of TAGS) {
        const key = draws(seed, tag);
        const prevStream = streams.get(key);
        if (prevStream !== undefined) clashes.push(`seed ${seed}: ${prevStream} and ${name} draw identically`);
        else streams.set(key, name);
        // Distinct bases as well as distinct draws: two stages sharing a base
        // would collide the moment either changed how many numbers it takes.
        const base = specSeed(spec, tag);
        const prevBase = bases.get(base);
        if (prevBase !== undefined) clashes.push(`seed ${seed}: ${prevBase} and ${name} share base ${base}`);
        else bases.set(base, name);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('the same tag and seed replay exactly', () => {
    for (const [, tag] of TAGS) expect(draws(4242, tag)).toBe(draws(4242, tag));
  });

  it('changing the war never moves the map — CampaignConfig cannot reach a stream', () => {
    const a = presetSpec(DEFAULT_PRESET, 99);
    const b = presetSpec(DEFAULT_PRESET, 99);
    b.campaign.warDays = 30;
    b.campaign.redStrength = 4;
    expect(specSeed(b, SPEC_TAG.THEATER)).toBe(specSeed(a, SPEC_TAG.THEATER));
  });
});

describe('presets', () => {
  // 16 since jtbug #782: the 'Enemy doctrine' knob was read by nothing (red
  // always got RED_V2) and is gone. A knob comes back with the doctrine it sets.
  it('ship 16 knobs — the surface the customize screen and the share codec build against', () => {
    expect(Object.keys(DEFAULT_PRESET.theater).length).toBe(9);
    expect(Object.keys(DEFAULT_PRESET.campaign).length).toBe(7);
    expect(PRESETS.map((p) => p.name)).toEqual(['Normandy Bocage', 'River Line', 'Open Country', 'Skirmish']);
  });

  it('are all feasible — no preset ships a combination every seed rejects', () => {
    for (const p of PRESETS) {
      const { sizeKm, townDensity, townSpacingMinKm } = p.theater;
      expect(p.campaign.warDays, `${p.name} war length`).toBeGreaterThanOrEqual(MIN_WAR_DAYS[sizeKm]);
      // Hexagonal packing: a town needs (√3/2)·d² km² of its own. S11 owns the
      // production form (feasible(cfg)); this asserts the shipped values sit
      // inside it with room to spare.
      const areaKm2 = sizeKm * (sizeKm * 0.75);
      const towns = (townDensity * areaKm2) / 100;
      const needed = towns * 0.866 * townSpacingMinKm ** 2;
      expect(needed, `${p.name} town packing`).toBeLessThan(areaKm2);
      expect(towns, `${p.name} town count`).toBeGreaterThanOrEqual(3);
    }
  });

  it('presetSpec stamps the generator version and copies the configs', () => {
    const spec = presetSpec(DEFAULT_PRESET, parseSeed('OMAHA'), 'OMAHA');
    expect(spec.genVersion).toBe(GEN_VERSION);
    expect(parseSeed(spec.seedText)).toBe(spec.seed);
    spec.theater.sizeKm = 32;
    expect(DEFAULT_PRESET.theater.sizeKm).toBe(24);
    expect(presetSpec(DEFAULT_PRESET, 7).seedText).toBe('7');
  });
});
