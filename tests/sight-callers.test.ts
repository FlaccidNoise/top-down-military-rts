// @ts-expect-error no @types/node in this project; node:fs still resolves fine at runtime under vitest
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The recorded lesson (memory: sight-funnel-callers.md): a previous per-shooter
// change through sightBetween/sightToSoldier updated the soldier-vs-soldier
// sites and missed every vehicle-facing one (AT, panzerfaust, tank terror,
// apSolution), so tanks kept sighting, and being sighted, at rifleman height.
//
// This is the structural fix. Every call into the sight funnel must state its
// eye heights explicitly. Defaults are legal only for the entries in DEFAULTS,
// each of which carries a written justification at the call site. Add a new
// call without an eye and this fails; add a new deliberate default and you have
// to come here and say why.

const ROOT = new URL('../src/', import.meta.url);

// name -> the argument count a fully-specified call has.
const FUNNEL: Record<string, { arity: number; method: boolean }> = {
  los: { arity: 9, method: false }, //                 map, x0,y0,x1,y1, l0,l1, e0,e1
  sightBetween: { arity: 9, method: false }, //        sim, x0,y0,x1,y1, l0,l1, e0,e1
  sightToSoldier: { arity: 6, method: false }, //      sim, x0,y0, t, l0, e0  (e1 = eyeOf(t))
  acquireSoldierTarget: { arity: 7, method: true }, // x,y, side, range, arc, l0, e0
  shotPreview: { arity: 8, method: true }, //          fx,fy, weapon, t, moving, aim, l0, e0
  resolveSmallArmsShot: { arity: 8, method: true }, // fx,fy, weapon, t, moving, aim, l0, e0
  apSolution: { arity: 11, method: false }, //         sim, fx,fy, pen, acc, range, target, moving, title, l0, e0
};

// Deliberate eye defaults, keyed by `file::normalized call text`. Each is
// commented in the source with its reason (verticality design §3.4 #22-24).
const DEFAULTS = new Set([
  // H13: blast/frag LOS is stance-neutral, so explosion lethality is unchanged.
  'sim/sim.ts::los(this.map, x, y, s.x, s.y, l, s.level)',
  // A served gun sights at chest height either way.
  'sim/emplacement.ts::sightBetween(sim, e.x, e.y, x, y)',
  // Scores a HYPOTHETICAL position; there is no soldier to take a stance from.
  'sim/ai.ts::sightBetween(sim, p.x, p.y, post.x, post.y)',
]);

// Blank out comments and string bodies, preserving length (so offsets and line
// numbers survive). Without this the scanner would flag the prose in this
// repo's own explanatory comments, several of which quote real call sites.
function blank(src: string): string {
  const out = src.split('');
  let i = 0;
  const wipe = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      wipe(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      wipe(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      let j = i + 1;
      let depth = 0;
      for (; j < src.length; j++) {
        if (src[j] === '\\') j++;
        else if (depth === 0 && src[j] === q) break;
        else if (q === '`' && depth === 0 && src[j] === '$' && src[j + 1] === '{') {
          depth = 1;
          j++; // consume the '{' here, or the next pass double-counts it and the scan runs to EOF
        }
        else if (depth > 0 && src[j] === '{') depth++;
        else if (depth > 0 && src[j] === '}') depth--;
      }
      wipe(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

// Bracket-matched argument split: a regex cannot count `f(g(a, b), c)`.
function topLevelArgCount(src: string, open: number): { count: number; end: number } | null {
  let depth = 0;
  let count = 1;
  let empty = true;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { count: empty ? 0 : count, end: i };
    } else if (c === ',' && depth === 1) count++;
    else if (depth === 1 && !/\s/.test(c)) empty = false;
  }
  return null;
}

function sourceFiles(dir: URL): URL[] {
  const out: URL[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]) {
    if (ent.isDirectory()) out.push(...sourceFiles(new URL(`${ent.name}/`, dir)));
    else if (ent.name.endsWith('.ts')) out.push(new URL(ent.name, dir));
  }
  return out;
}

interface Call {
  file: string;
  name: string;
  text: string;
  args: number;
  line: number;
}

function callsIn(file: URL, rel: string): Call[] {
  const src = blank(readFileSync(file, 'utf8') as string);
  const out: Call[] = [];
  for (const [name, spec] of Object.entries(FUNNEL)) {
    const re = new RegExp(`(^|[^A-Za-z0-9_$${spec.method ? '' : '.'}])${name}\\s*\\(`, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const before = src.slice(lineStart, m.index);
      // the declaration of the funnel function itself, not a call into it
      if (/\b(function|private|public|protected|readonly)\s*$/.test(before)) continue;
      const parsed = topLevelArgCount(src, open);
      if (!parsed) continue;
      out.push({
        file: rel,
        name,
        text: `${name}(${src.slice(open + 1, parsed.end).replace(/\s+/g, ' ').trim()})`,
        args: parsed.count,
        line: src.slice(0, m.index).split('\n').length,
      });
    }
  }
  return out;
}

const files = sourceFiles(ROOT).filter((f) => /\/(sim|ui)\//.test(f.href));
const calls = files.flatMap((f) => callsIn(f, decodeURIComponent(f.href.slice(ROOT.href.length))));

describe('sight funnel: every caller states its eye heights', () => {
  it('finds the funnel at all (guards against a scanner that silently matches nothing)', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(calls.length).toBeGreaterThan(20);
    for (const name of Object.keys(FUNNEL)) {
      expect(calls.some((c) => c.name === name), `no ${name}( call found`).toBe(true);
    }
  });

  it('no bare call slips through — vehicle-facing sites included', () => {
    const bare = calls
      .filter((c) => c.args < FUNNEL[c.name].arity)
      .filter((c) => !DEFAULTS.has(`${c.file}::${c.text}`));
    expect(bare.map((c) => `${c.file}:${c.line} ${c.text} — ${c.args}/${FUNNEL[c.name].arity} args`)).toEqual([]);
  });

  it('every allow-listed default still exists — no stale exemptions', () => {
    const keys = new Set(calls.map((c) => `${c.file}::${c.text}`));
    for (const d of DEFAULTS) expect(keys.has(d), `stale allow-list entry: ${d}`).toBe(true);
  });

  it('the vehicle-facing class the last change missed is covered', () => {
    const named = calls.filter((c) => /\bHULL_VEHICLE\b|\bEYE_VEHICLE\b/.test(c.text));
    expect(named.length).toBeGreaterThanOrEqual(9);
    // and specifically: AT, panzerfaust, tank terror and apSolution
    const has = (needle: string) => calls.some((c) => c.text.includes(needle));
    expect(has('s.level, 0, eyeOf(s), HULL_VEHICLE')).toBe(true); // AT + faust
    expect(has('0, s.level, EYE_VEHICLE, eyeOf(s)')).toBe(true); // tank terror
    expect(has('l0, 0, e0, HULL_VEHICLE')).toBe(true); // apSolution
  });
});
