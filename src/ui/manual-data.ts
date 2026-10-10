// The Field Manual's copy, and the ONLY place it lives. T3 renders this; the
// tutorial driver quotes it. Data and template literals only — no DOM, so the
// text is testable in the node env.
//
// THE RULE: every number in the prose is interpolated from the constant the
// game runs on, or computed by calling the live function. A hand-typed game
// number is a defect — it drifts the moment someone retunes the sim, and the
// player reads a manual that lies. tests/manual-data.test.ts holds a tripwire
// that greps this file for raw literals of the tracked constants.
import { MIN_WAR_DAYS } from '../campaign/spec';
import { FIRST_PRESET, PRESETS } from '../campaign/presets';
import type { OrderKind } from '../sim/orders';
import { CONTACT_TTL, DT, hideFloorOf, SPOT_INTERVAL, SPOT_RANGE, spotCapOf } from '../sim/sim';
import { GARRISON_RADIUS, TRIVIAL_RATIO } from '../strategic/bridge';
import { DEPLOY_ATK_DEPTH, DEPLOY_DEF_DEFAULT, DEPLOY_DEF_LINE } from '../strategic/deploy';
import { REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY } from '../strategic/front';
import { DETECT_FORCE_M, DETECT_NODE_M, STRAT_CONTACT_TTL } from '../strategic/intel';
import { MOVE_MPM, REGION_PACE_MULT } from '../strategic/theater';
import { BRIDGE_DWELL_MIN, CONTACT_M, FORD_CROSS_MIN } from '../strategic/theater/force';
import { NIGHT_MARCH_FATIGUE_MULT } from '../strategic/theater/step';
import { SUPPLY_AMMO_MULT, SUPPLY_LOW_MIN, SUPPLY_OUT_MIN } from '../strategic/theater/supply';
import { battleDuration, INFILTRATE_MIN, RETREAT_SETBACK_M } from '../strategic/theater/war';
import { BREAK_FRACTION } from './battle-goal';
import { BATTLE_SPEEDS } from './battle-speed';
import { DEFAULTS, formatBinding, LABEL, type ActionId, type Binding } from './keymap';
import { ORDER_AFFORDANCE } from './order-data';
import { HOLD_MS, TAP_SLOP, TWO_TAP_MS } from './touch';

export interface ManualEntry {
  heading: string;
  body: string;
  keys?: { desktop: string; touch: string };
}

export interface ManualChapter {
  id: string;
  title: string;
  entries: ManualEntry[];
}

// -- Derived values -------------------------------------------------------
// Everything the prose quotes resolves here first, so a retune moves the text.

type Key = (a: ActionId) => string;
const rate = (a: ActionId): string => LABEL[a].replace('Speed ', '');
const seconds = (ticks: number): number => Math.round(ticks * DT * 10) / 10;
const HOLD = `press-and-hold (${HOLD_MS} ms)`;
// The touch equivalent of a right-click. Sentences name one input each — the
// keys field carries the other column, so the prose never nests a parenthesis.
const HOLD_INSTEAD = `On touch, ${HOLD} instead.`;

// The defence line differs by map kind. Render the table rather than naming
// today's two kinds, so a new kind appears in the manual on its own.
const DEF_LINES = Object.entries(DEPLOY_DEF_LINE)
  .map(([kind, x]) => `${kind} ${x} m`)
  .join(', ');

const PRESET_LIST = PRESETS.map((p) => `${p.name} (${p.campaign.warDays} days)`).join(', ');

// Supply and intel both read in hours on the strategic clock; the constants
// are minutes, so convert here and never in the prose.
const hours = (min: number): number => Math.round((min / 60) * 10) / 10;
const pct = (mult: number): string => `${Math.round(mult * 100)}%`;
const km = (m: number): number => Math.round((m / 1000) * 10) / 10;

// The largest theater and the shortest war it can hold — the example the
// customize screen's feasibility card most often shows.
const THEATER_SIZES = Object.keys(MIN_WAR_DAYS).map(Number).sort((a, b) => a - b);
const BIGGEST_KM = THEATER_SIZES[THEATER_SIZES.length - 1];
const BIGGEST_MIN_DAYS = MIN_WAR_DAYS[BIGGEST_KM as keyof typeof MIN_WAR_DAYS];

// ORDER_AFFORDANCE is declared in the order the keymap binds: its first key is
// order1. Deriving the sequence keeps the manual's keys correct if an order
// moves, and order-data stays the one owner of each order's name and caveat.
const ORDER_SEQ = Object.keys(ORDER_AFFORDANCE) as OrderKind[];

// One line of teaching per order. The chip's own card supplies what the order
// is and when men refuse it (order-data.ts). This supplies the judgment.
const ORDER_TEACHING: Record<OrderKind, string> = {
  move: 'The default. The men keep formation and watch their arcs.',
  fast: 'For ground you cannot cover. Tired men shoot worse for a while.',
  sneak: `Concealment on the sightline hides the team past ${hideFloorOf(1)} m.`,
  fire: 'Men with their heads down stop shooting back.',
  smoke: 'Smoke buys a crossing. It does not stop a bullet.',
  defend: 'Drag the order to set the arc.',
  ambush: 'Use it on a road the enemy must walk.',
  assault: 'Fire or smoke first, every time.',
};

const orderEntries = (key: Key): ManualEntry[] =>
  ORDER_SEQ.map((kind, i) => {
    const a = ORDER_AFFORDANCE[kind];
    return {
      heading: a.name,
      body: `${a.when}. ${ORDER_TEACHING[kind]} ${a.complianceNote}.`,
      keys: {
        desktop: `${key(`order${i + 1}` as ActionId)}, then right-click`,
        touch: `Tap the ${a.name} chip, then ${HOLD} on the ground`,
      },
    };
  });

// -- The manual -----------------------------------------------------------

/**
 * The manual for a set of key bindings. Every key the prose and the key tables
 * name is read from `bindings`, so a player who has rebound a key reads the key
 * they bound, in the manual and in the controls card alike.
 */
export function buildManual(bindings: Record<ActionId, Binding> = DEFAULTS): ManualChapter[] {
  const key: Key = (a) => formatBinding(bindings[a]);
  return [
    {
      id: 'goal',
      title: 'The Objective',
      entries: [
        {
          heading: 'How you win',
          body:
            'Take the gold-ringed towns before the deadline day. A blue ring marks a town you hold. ' +
            'Some operations ask for every town, others for a majority.',
        },
        {
          heading: 'How you lose',
          body: 'The deadline passes with the towns still short, or the enemy destroys your companies.',
        },
        {
          heading: 'The enemy is not waiting',
          body: 'Red attacks, and retakes towns you leave thin. Garrison what you take.',
        },
        {
          heading: 'Losses are not forever',
          body: `Every ${REINFORCE_CYCLE_DAYS} days each company gets up to ${REINFORCE_PER_COMPANY} replacements. A destroyed company does not come back.`,
        },
      ],
    },
    {
      id: 'operation',
      title: 'Starting an Operation',
      entries: [
        {
          heading: 'The menu',
          body: `New campaign starts at once on the ${FIRST_PRESET.name} preset. Custom operation opens the setup screen. Training replays the drill.`,
        },
        {
          heading: 'The seed',
          body: 'The seed names the map. The same seed and settings rebuild the same theater. Type a word or a number, or press Roll.',
        },
        {
          heading: 'Presets',
          body: `A preset sets every setting at once: ${PRESET_LIST}. Enemy strength decides the fight.`,
        },
        {
          heading: 'Supply lines',
          body:
            `On, a force cut off for ${hours(SUPPLY_LOW_MIN)} hours fights on ${pct(SUPPLY_AMMO_MULT.low)} ammunition, and after ${hours(SUPPLY_OUT_MIN)} hours on ${pct(SUPPLY_AMMO_MULT.out)}. ` +
            'The map marks the cut. Off, every force is fully supplied.',
        },
        {
          heading: 'Enemy intel',
          body:
            'Omniscient shows both sides everything. ' +
            `Contacts fogs both: a force shows within ${km(DETECT_FORCE_M)} km of an enemy force or ${km(DETECT_NODE_M)} km of an enemy town, and fades over ${hours(STRAT_CONTACT_TTL)} hours.`,
        },
        {
          heading: 'Night tempo',
          body:
            'On, marches slow in the dark. Off, a company marches at one pace around the clock. ' +
            `Either way a night march tires men ${NIGHT_MARCH_FATIGUE_MULT}× faster.`,
        },
        {
          heading: 'Size and war length',
          body: `A ${BIGGEST_KM} km theater asks for at least ${BIGGEST_MIN_DAYS} days. The setup screen names the setting to change.`,
        },
      ],
    },
    {
      id: 'theater',
      title: 'The Theater Map',
      entries: [
        {
          heading: 'Reading the ground',
          body: 'The Key button on the map names every mark. Bocage and forest slow a march. Marsh keeps you on the roads.',
        },
        {
          heading: 'Roads and pace',
          body: `A highway runs ${MOVE_MPM.highway} m/min, a road ${MOVE_MPM.road}, a track ${MOVE_MPM.track}. Forest multiplies the pace by ${REGION_PACE_MULT.forest}.`,
        },
        {
          heading: 'Rivers, bridges and fords',
          body: `Only bridges and fords cross a river. A bridge costs ${BRIDGE_DWELL_MIN} minutes. A ford costs ${FORD_CROSS_MIN} and lands the men wet and tired.`,
        },
        {
          heading: 'The rail line',
          body: 'Dashed lines are railway. No column can march on them.',
        },
        {
          heading: 'Giving a march order',
          body: `Select a company, then right-click a town. ${HOLD_INSTEAD} Point at a town first and the map draws the route and its arrival time.`,
          keys: { desktop: 'Click, then right-click', touch: `Tap, then ${HOLD} the destination` },
        },
        {
          heading: 'Halting and turning back',
          body: 'Halt stops a marching company where it stands. A company turned round on a road walks back only the ground it covered.',
          keys: { desktop: 'Halt on the company panel', touch: 'Halt on the company panel' },
        },
        {
          heading: 'The clock',
          body:
            `Pause with ${key('pause')}. ${key('speed1')}, ${key('speed2')} and ${key('speed3')} set ${rate('speed1')}, ${rate('speed2')} and ${rate('speed3')}. ` +
            'Run fast between decisions.',
          keys: {
            desktop: `${key('pause')} pauses, ${key('speed1')}/${key('speed2')}/${key('speed3')} set speed`,
            touch: 'Play and the speed buttons on the top bar',
          },
        },
        {
          heading: 'Contact',
          body: `Forces within ${CONTACT_M} m of each other on the same road or town halt, and a battle opens. Nobody slips past.`,
        },
        {
          heading: 'The contact choice',
          body: `Attack fights it. Stand down withdraws, and only an attacker may. Auto-resolve is offered at ${TRIVIAL_RATIO}:1 odds.`,
        },
        {
          heading: 'How long a battle takes',
          body:
            'Battles cost theater time. ' +
            `Two full companies fight for about ${battleDuration(100, 100, false)} minutes, a one-sided fight ${battleDuration(100, 100, true)}, and none runs past ${battleDuration(10000, 10000, false)}.`,
        },
        {
          heading: 'Losing a battle on the map',
          body:
            `A beaten force falls back ${RETREAT_SETBACK_M} m. ` +
            `A surrounded US force slips out to a friendly town within ${INFILTRATE_MIN} minutes' march. With no way out it is destroyed.`,
        },
        {
          heading: 'Saving',
          body: 'The campaign saves itself. Continue picks it up.',
        },
      ],
    },
    {
      id: 'deployment',
      title: 'Deployment',
      entries: [
        {
          heading: 'The battle opens paused',
          body: 'Every battle opens paused. Nothing moves and nobody shoots until you press Play.',
        },
        {
          heading: 'Your zone when attacking',
          body: `The green strip, ${DEPLOY_ATK_DEPTH} m deep on the west edge. Place squads inside it.`,
        },
        {
          heading: 'Your zone when defending',
          body: `Everything behind the green line, usually ${DEPLOY_DEF_DEFAULT} m from the west edge (${DEF_LINES}).`,
        },
        {
          heading: 'Repositioning',
          body: `Select squads, then right-click inside your zone. ${HOLD_INSTEAD} An order outside the zone is refused.`,
          keys: { desktop: 'Select, then right-click', touch: `Tap to select, then ${HOLD} the ground` },
        },
        {
          heading: 'Guns do not move',
          body: 'Machine guns, mortars and anti-tank guns deploy where they stand.',
        },
        {
          heading: 'Where the defenders are',
          body: `Defenders garrison the buildings and woods within ${GARRISON_RADIUS} m of each objective. Look for the approach they cannot see.`,
        },
        {
          heading: 'Play commits',
          body: 'Play starts the battle. Deployment does not come back.',
          keys: { desktop: `${key('pause')}, or the Play button`, touch: 'Tap Play' },
        },
      ],
    },
    {
      id: 'battle',
      title: 'The Battle',
      entries: [
        {
          heading: 'How a battle is won',
          body:
            `A side breaks when it falls under ${pct(BREAK_FRACTION)} of the men it started with. ` +
            'Break them before they break you. The top bar shows both sides.',
        },
        {
          heading: 'Selecting men',
          body: 'Click a man to select his squad. Click him again for his team. Drag a box to select several.',
          keys: {
            desktop: `Click, drag a box, ${key('squad1')}–${key('squad9')} for squads, Shift to add`,
            touch: 'Tap a man. ⋯ then Select for a box, Add to keep adding',
          },
        },
        {
          heading: 'Giving an order',
          body: `Choose an order, then right-click the ground. ${HOLD_INSTEAD} The dots show where each man will go.`,
          keys: { desktop: 'Order key, then right-click', touch: `Order chip, then ${HOLD}` },
        },
        {
          heading: 'Cancelling',
          body: `${key('cancel')} steps back one thing at a time: the aiming cursor, the inspected man, the chosen order, the selection modes, the team, then the selection.`,
          keys: { desktop: key('cancel'), touch: 'Two-finger tap, or ⋯, Cancel' },
        },
        ...orderEntries(key),
        {
          heading: 'Formation, width and facing',
          body: 'Drag the order. The length of the drag sets the width of the line, and its direction sets the facing.',
          keys: { desktop: 'Right-drag', touch: 'Hold, then drag without lifting' },
        },
        {
          heading: 'Cover',
          body: 'Cover stops bullets: walls, banks and hedgerows. Green dots in the order preview are cover.',
        },
        {
          heading: 'Concealment',
          body:
            'Concealment stops eyes, not bullets: crops, smoke and woods. ' +
            `A sneaking or ambushing team is unseen past ${hideFloorOf(1)} m by day and ${hideFloorOf(0)} m at night.`,
        },
        {
          heading: 'Line of sight',
          body: 'Men shoot what they can see from where they stand. Walls, hedges, smoke and floors block it. NO LOS means move.',
        },
        {
          heading: 'Buildings and floors',
          body:
            `${key('floorFocus')} shows one storey at a time. Alt and right-click picks the floor for an order. ` +
            'Defend and Ambush take the top storey, every other order the ground floor.',
          keys: { desktop: `${key('floorFocus')} cycles floors, Alt+right-click picks a floor`, touch: `Floor chip cycles, ${HOLD} on a tall building picks` },
        },
        {
          heading: 'Ammunition',
          body: 'Ammunition is finite. The roster says AMMO LOW when a squad runs short. Fire to keep heads down is what spends it.',
        },
        {
          heading: 'Suppression, morale and rout',
          body: 'Men under fire go from steady to shaken, pinned, then broken. Pinned men hug the ground. Broken men run and take no orders.',
        },
        {
          heading: 'Weapon teams',
          body: 'A machine gun suppresses a wide arc. A mortar hits a point another squad can see. A bazooka is for armour.',
        },
        {
          heading: 'Emplacements',
          body: 'Crewed guns fire on a wide arc and do not move. Suppress the crew and the gun goes quiet.',
        },
        {
          heading: 'Barrage and airstrike',
          body: `${key('barrage')} calls a barrage and ${key('airstrike')} an airstrike. Then click the target. Both are few and slow to arrive. Keep your own men clear.`,
          keys: { desktop: `${key('barrage')} barrage, ${key('airstrike')} airstrike`, touch: 'Tap the barrage or airstrike chip, then tap the target' },
        },
        {
          heading: 'Fog of war',
          body:
            `You see what your men see, out to ${SPOT_RANGE} m, checked every ${seconds(SPOT_INTERVAL)} seconds. ` +
            `A lost enemy leaves a ghost for ${seconds(CONTACT_TTL)} seconds. Darkness cuts the range to ${Math.round(spotCapOf(0))} m.`,
        },
        {
          heading: 'Assault, melee and surrender',
          body: 'Men who reach each other lock into melee. A man beaten alone surrenders. Assault a position that has stopped shooting.',
        },
        {
          heading: 'The debrief, and what carries',
          body: 'Wounds and deaths are permanent and follow the roster into the next battle.',
        },
      ],
    },
    {
      // The one table of bindings: the controls card (the ? control) renders
      // these rows, so a key is stated here and nowhere else in the HUD.
      id: 'touch',
      title: 'Controls',
      entries: [
        {
          heading: 'Select',
          body: 'Pick a man to select his squad. Pick him again to narrow to his team.',
          keys: { desktop: 'Left-click', touch: 'Tap' },
        },
        {
          heading: 'Select several',
          body: 'Drag a box around the squads you want. On touch the mode lasts one box.',
          keys: { desktop: 'Left-drag', touch: '⋯, Select, then drag' },
        },
        {
          heading: 'Add to selection',
          body: 'Keep what is selected and add to it. On touch Add stays on until you tap it again.',
          keys: { desktop: 'Shift+click', touch: '⋯, Add' },
        },
        {
          heading: 'Squad by number',
          body: 'Jump straight to a squad without finding it on the map.',
          keys: { desktop: `${key('squad1')}–${key('squad9')}`, touch: '☰ Roster' },
        },
        {
          heading: 'Choose an order',
          body: 'The order bar sets how the next order is carried out. With none chosen the squad moves.',
          keys: { desktop: `${key('order1')}–${key('order8')}, or the order bar`, touch: 'The order bar' },
        },
        {
          heading: 'Give an order',
          body: `Point at the ground or the enemy. The dots show where each man will go. A touch hold arms after ${HOLD_MS} ms.`,
          keys: { desktop: 'Right-click', touch: 'Press and hold, then lift' },
        },
        {
          heading: 'Set a line',
          body: 'Drag the order. The length sets the width of the line and the direction sets its facing.',
          keys: { desktop: 'Right-drag', touch: 'Hold, then drag' },
        },
        {
          heading: 'Cancel',
          body: `Steps back one thing at a time: aiming, the chosen order, the team, the selection. Both fingers land and lift inside ${TWO_TAP_MS} ms.`,
          keys: { desktop: key('cancel'), touch: 'Two-finger tap, or ⋯, Cancel' },
        },
        {
          heading: 'Pan',
          body: `Move the camera. A finger that wanders under ${TAP_SLOP} px still counts as a tap.`,
          keys: { desktop: `${key('panUp')} ${key('panLeft')} ${key('panDown')} ${key('panRight')}`, touch: 'One-finger drag' },
        },
        {
          heading: 'Zoom',
          body: 'The point under the cursor, or between your fingers, stays put.',
          keys: { desktop: 'Mouse wheel', touch: 'Pinch' },
        },
        {
          heading: 'Floors',
          body: 'Show one storey at a time, or send an order to a floor you pick.',
          keys: { desktop: `${key('floorFocus')}, or Alt+right-click`, touch: '⋯, Floors, or hold on a tall building' },
        },
        {
          heading: 'Pause',
          body: 'Orders given while paused are carried out when the battle runs again.',
          keys: { desktop: key('pause'), touch: 'Play / Pause' },
        },
        {
          heading: 'Battle speed',
          body: `The battle clock runs at ${BATTLE_SPEEDS.map((s) => `${s}×`).join(', ')}. The fight is the same fight at every speed.`,
          keys: { desktop: key('battleSpeed'), touch: 'The speed chip beside Play' },
        },
        {
          heading: 'Barrage and airstrike',
          body: 'Pick the support, then pick the target. Both are few and slow to arrive.',
          keys: { desktop: `${key('barrage')} or ${key('airstrike')}, then click`, touch: '⋯, the chip, then tap' },
        },
        {
          heading: 'The roster',
          body: 'Every squad and man by name, with a word for what is wrong with him.',
          keys: { desktop: 'Always visible', touch: '☰ Roster' },
        },
        {
          heading: 'Menu',
          body: 'The Field Manual, sound and the tutorial switch.',
          keys: { desktop: key('menu'), touch: '⚙' },
        },
        {
          heading: 'Sound',
          body: 'Turns every sound off or on.',
          keys: { desktop: key('mute'), touch: '⚙, Sound' },
        },
      ],
    },
  ];
}

/** The manual with the default bindings: what the tests and the tutorial quote. */
export const MANUAL: ManualChapter[] = buildManual();

export interface ControlRow {
  action: string;
  desktop: string;
  touch: string;
}

/** The controls card: the Controls chapter as a two-column table. */
export function controlRows(bindings?: Record<ActionId, Binding>): ControlRow[] {
  const chapter = buildManual(bindings).find((c) => c.id === 'touch');
  if (!chapter) throw new Error("controlRows: MANUAL has no 'touch' chapter — the controls card reads its key tables");
  return chapter.entries.flatMap((e) => (e.keys ? [{ action: e.heading, ...e.keys }] : []));
}

/** Flat text of the whole manual — the search index, and what the tests read. */
export function manualText(): string {
  return MANUAL.flatMap((c) => [
    c.title,
    ...c.entries.flatMap((e) => [e.heading, e.body, e.keys ? `${e.keys.desktop} ${e.keys.touch}` : '']),
  ]).join('\n');
}
