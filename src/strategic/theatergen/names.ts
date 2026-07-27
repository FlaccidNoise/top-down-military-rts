// T_NAMES (stage 46, S10): the Norman toponym grammar. Every draw is keyed
// on an imul-hash of the SITE'S GEOMETRY, never an array index (interiors D9:
// keying on order makes a name depend on which site was emitted first).
// Collisions resolve deterministically by redrawing on the site's own stream;
// a lexicon exhaustion is a named throw, never a silent duplicate.
import { mulberry32, type Rng } from '../../sim/rng';
import type { Region, River, TheaterNode } from '../theater';
import { stageBase as deriveBase, stageStream, T_TAG } from './streams';

const ROOTS = [
  'Vireux', 'Marigny', 'Torcy', 'Beuze', 'Cerisy', 'Aunay', 'Balleroy', 'Cahagnes',
  'Dampierre', 'Esquay', 'Fontenay', 'Gavray', 'Hébert', 'Isigny', 'Juvigny', 'Lantheuil',
  'Mestry', 'Noyers', 'Orbois', 'Percy', 'Quettreville', 'Rauray', 'Soulles', 'Tessy',
  'Urville', 'Vassy', 'Yvetot', 'Airel', 'Brémoy', 'Cametours', 'Dangy', 'Écausseville',
  'Feugères', 'Gonfreville', 'Hottot', 'Ifs', 'Jurques', 'Lessay', 'Montmartin', 'Néhou',
] as const;
const SAINTS = [
  'St-Aubin', 'St-Côme', 'St-Denis', 'St-Fromond', 'St-Gilles', 'St-Jean', 'St-Lô-d\'Ourville',
  'St-Manvieu', 'St-Ouen', 'St-Pierre', 'Ste-Croix', 'Ste-Marie', 'St-Vaast', 'St-André',
  'Ste-Honorine', 'St-Georges', 'St-Martin', 'Notre-Dame',
] as const;
const SUFFIXES = ['ville', '-le-Vicomte', '-en-Bessin', '-la-Campagne', '-le-Sec', '-les-Buissons', '-Bocage'] as const;
const RIVER_ROOTS = ['Vire', 'Aure', 'Drôme', 'Seulles', 'Odon', 'Orne', 'Sienne', 'Soulles', 'Taute', 'Douve', 'Sèves', 'Ay'] as const;

// Template ids are FROZEN — the every-template-exercised gate names them.
export const NAME_TEMPLATES = ['saint', 'root-sur-river', 'root-suffix', 'bare-root', 'crossing', 'halt', 'cross'] as const;
type Template = (typeof NAME_TEMPLATES)[number];

const geomHash = (base: number, x: number, y: number): number =>
  (base ^ Math.imul(x, 0x85ebca6b) ^ Math.imul(y, 0xc2b2ae35)) >>> 0;

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[rng.int(arr.length)];

// Draw a candidate name for a node; `attempt` advances the stream past
// earlier collisions deterministically.
function nodeName(rng: Rng, node: TheaterNode, riverName: string | null): { name: string; template: Template } {
  if (node.crossing) {
    const root = pick(rng, ROOTS);
    return {
      name: node.crossing.kind === 'bridge' ? `Pont-${root}` : `Gué-de-${root}`,
      template: 'crossing',
    };
  }
  if (node.kind === 'halt') return { name: `${pick(rng, ROOTS)}-Halte`, template: 'halt' };
  if (node.kind === 'junction' || node.kind === 'crossroads') {
    return { name: `La Croix-${pick(rng, ROOTS)}`, template: 'cross' };
  }
  // Towns and villages walk the settlement grammar.
  const roll = rng.next();
  if (roll < 0.3) return { name: pick(rng, SAINTS), template: 'saint' };
  if (roll < 0.5 && riverName) return { name: `${pick(rng, ROOTS)}-sur-${riverName.replace(/^(La|Le) /, '')}`, template: 'root-sur-river' };
  if (roll < 0.8) return { name: `${pick(rng, ROOTS)}${pick(rng, SUFFIXES)}`, template: 'root-suffix' };
  return { name: pick(rng, ROOTS), template: 'bare-root' };
}

// Names everything in place and returns the theater name. Deterministic under
// ANY iteration order of the inputs: each site draws on its own geometry-
// keyed stream, and collision resolution scans sites in a POSITION-sorted
// order, not array order.
export function nameAll(base: number, nodes: TheaterNode[], regions: Region[], rivers: River[]): string {
  const nameBase = deriveBase(stageStream(base, T_TAG.NAMES));

  // Rivers first (settlement grammar reads them): main gets a feminine
  // article, streams a diminutive chance.
  const riversSorted = [...rivers].sort((a, b) => a.polyline[0].x - b.polyline[0].x || a.polyline[0].y - b.polyline[0].y);
  const usedRivers = new Set<string>();
  for (const r of riversSorted) {
    const rng = mulberry32(geomHash(nameBase, r.polyline[0].x, r.polyline[0].y));
    for (let attempt = 0; ; attempt++) {
      if (attempt > RIVER_ROOTS.length * 4) throw new Error(`nameAll: river lexicon exhausted at river ${r.id}`);
      const root = pick(rng, RIVER_ROOTS);
      const name = r.widthClass === 'river' ? `La ${root}` : rng.next() < 0.4 ? `Le ${root}lon` : `La ${root}tte`;
      if (usedRivers.has(name)) continue;
      usedRivers.add(name);
      r.name = name;
      break;
    }
  }

  // Nodes in position-sorted order so collision fallback never depends on
  // emission order (the reorder gate).
  const nodesSorted = [...nodes].sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y);
  const used = new Set<string>();
  for (const n of nodesSorted) {
    const rng = mulberry32(geomHash(nameBase, n.pos.x, n.pos.y));
    const riverName = n.crossing !== null ? rivers.find((r) => r.id === n.crossing!.riverId)?.name ?? null : rivers[0]?.name ?? null;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 200) throw new Error(`nameAll: settlement lexicon exhausted at node ${n.id}`);
      const { name } = nodeName(rng, n, riverName);
      if (used.has(name)) continue;
      used.add(name);
      n.name = name;
      break;
    }
  }

  // Regions: named from their seat, else their class feature + nearest root.
  const regionsSorted = [...regions].sort((a, b) => a.centroid.x - b.centroid.x || a.centroid.y - b.centroid.y);
  const usedRegions = new Set<string>();
  for (const r of regionsSorted) {
    const rng = mulberry32(geomHash(nameBase, r.centroid.x, r.centroid.y));
    const seat = r.seatNodeId === null ? null : nodes.find((n) => n.id === r.seatNodeId)!;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 200) throw new Error(`nameAll: region lexicon exhausted at region ${r.id}`);
      const stem = seat ? seat.name.replace(/^(La|Le) /, '') : pick(rng, ROOTS);
      const name =
        r.terrainClass === 'forest' ? `Bois de ${stem}` :
        r.terrainClass === 'marsh' ? `Marais de ${stem}` :
        r.terrainClass === 'settlement' ? stem :
        rng.next() < 0.5 ? `Campagne de ${stem}` : `Plaine de ${stem}`;
      if (usedRegions.has(name)) {
        if (seat) {
          // A seated name must keep its stem — disambiguate by compass.
          const alt = `${name}${r.centroid.y < 9000 ? '-le-Haut' : '-le-Bas'}`;
          if (!usedRegions.has(alt)) {
            usedRegions.add(alt);
            r.name = alt;
            break;
          }
        }
        continue;
      }
      usedRegions.add(name);
      r.name = name;
      break;
    }
  }

  // Theater: the principal town (rank 0, lowest id — generation order is
  // frozen, so this is stable).
  const principal = nodes.filter((n) => n.kind === 'town').sort((a, b) => a.id - b.id)[0];
  if (!principal) throw new Error('nameAll: theater has no town to name itself after');
  return `${principal.name} sector`;
}
