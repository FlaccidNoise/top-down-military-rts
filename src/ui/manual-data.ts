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
import { PRESETS } from '../campaign/presets';
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
import { DEFAULTS, formatBinding, LABEL, type ActionId } from './keymap';
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

const key = (a: ActionId): string => formatBinding(DEFAULTS[a]);
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

// One line of teaching per order — WHEN a player reaches for it. The shipped
// affordance card supplies the mechanical claim, this supplies the judgment.
const ORDER_TEACHING: Record<OrderKind, string> = {
  move: 'Use Move as the default. The men keep formation and watch their arcs.',
  fast: 'Use Fast to cross ground you cannot cover. Tired men shoot worse for a while.',
  sneak: `Use Sneak to reach a firing position unseen. Concealment on the sightline hides the team past ${hideFloorOf(1)} m.`,
  fire: 'Use Fire to pin a position you cannot flank. Suppressed men stop shooting back.',
  smoke: 'Use Smoke to blind one sightline. Smoke buys a crossing, it does not stop a bullet.',
  defend: 'Use Defend to hold ground you have taken. Drag the order to set the firing arc.',
  ambush: 'Use Ambush on a road the enemy must walk. The first volley is free.',
  assault: 'Use Assault only after fire or smoke lands. Men who charge an unsuppressed gun die.',
};

const orderEntries = (): ManualEntry[] =>
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

export const MANUAL: ManualChapter[] = [
  {
    id: 'goal',
    title: 'The Objective',
    entries: [
      {
        heading: 'How you win',
        body:
          'You command a US battalion in Normandy. The map carries a handful of objective towns. ' +
          'A gold ring marks a town you must take. A blue ring marks one you already hold. ' +
          'Take the ringed towns before the deadline day and the war is yours. ' +
          'Some operations ask for every objective. Others ask for a majority — the top bar names the count you need.',
      },
      {
        heading: 'How you lose',
        body:
          'You lose two ways. The deadline day passes with the objectives still short. ' +
          'Or the enemy destroys your companies and you have no fighting strength left. ' +
          'Time is the enemy you cannot shoot. Every day you spend marching is a day off the clock.',
      },
      {
        heading: 'The enemy is not waiting',
        body:
          'Red plans its own war. It masses on an axis, it counterattacks, and it retakes towns you leave thin. ' +
          'A captured objective is not a finished objective. Garrison what you take, or you will take it twice.',
      },
      {
        heading: 'Read the top bar',
        body:
          'The strategic top bar answers both questions at a glance. ' +
          'Objectives held over total sits on the left. The day and the deadline sit beside it. ' +
          'Hover either one for the win condition in full.',
      },
      {
        heading: 'Losses are not forever',
        body:
          `Replacements arrive on a cycle. Every ${REINFORCE_CYCLE_DAYS} days each company receives up to ${REINFORCE_PER_COMPANY} men. ` +
          'A mauled company recovers if you pull it out of the line. A destroyed company does not come back. ' +
          'Spend men to win ground, not to hold a schedule.',
      },
    ],
  },
  {
    id: 'operation',
    title: 'Starting an Operation',
    entries: [
      {
        heading: 'The main menu',
        body:
          'New Operation builds a fresh war. Continue resumes the saved one. ' +
          'Continue stays visible when no save exists, and tells you why it is disabled. ' +
          'A save from an older generator cannot rebuild its map. The menu then offers to carry your veterans into a new war instead.',
      },
      {
        heading: 'The seed',
        body:
          'The seed names the map. Type a word — OMAHA works — or type the number the screen shows. ' +
          'The same seed and the same knobs always rebuild the same theater. ' +
          'Press Roll for a fresh one. Share the seed and a friend fights your ground.',
      },
      {
        heading: 'Presets',
        body:
          `Four presets set every knob at once: ${PRESET_LIST}. ` +
          'Start with the first one. Edit any knob and the label reads Custom, but the preset itself never changes.',
      },
      {
        heading: 'Knobs',
        body:
          'The basic knobs set theater size, rivers, roads, towns, war length and enemy strength. ' +
          'Advanced opens the rest — crossing scarcity, rail, town spacing, terrain mix, woods share, victory rule, companies, enemy doctrine, and the three realism toggles below. ' +
          'Bigger and longer is not harder. Enemy strength is the knob that decides the fight.',
      },
      {
        heading: 'Supply lines',
        body:
          'On, every force traces a route back to its own supply source. ' +
          `Untraced for ${hours(SUPPLY_LOW_MIN)} hours it drops to low and fights on ${pct(SUPPLY_AMMO_MULT.low)} ammunition. ` +
          `Untraced for ${hours(SUPPLY_OUT_MIN)} hours it is out, on ${pct(SUPPLY_AMMO_MULT.out)}, and it hits softer in every battle. ` +
          'The map hatches a cut line and the force card tags the tier, so you can see the trouble before the battle. ' +
          'Off, every force fights fully supplied wherever it stands.',
      },
      {
        heading: 'Enemy intel',
        body:
          'Omniscient lets the enemy commander plan against your true positions, and shows you his. ' +
          `Contacts fogs both sides: a force is seen within ${km(DETECT_FORCE_M)} km of a live enemy force or ${km(DETECT_NODE_M)} km of a node they hold, ` +
          `and the mark it leaves fades over ${hours(STRAT_CONTACT_TTL)} hours. ` +
          'What you see of red is then a ghost — where it was, not where it is. With nothing in contact the map says NO CONTACT.',
      },
      {
        heading: 'Night tempo',
        body:
          'On, marches slow in the dark and recover their pace at first light, so an attack timed for dawn arrives with the light. ' +
          'Off, a company marches at one pace around the clock. ' +
          `Fatigue is not part of this toggle: marching in the dark always wears men ${NIGHT_MARCH_FATIGUE_MULT}× faster, and only rest recovers it.`,
      },
      {
        heading: 'The preview is the real map',
        body:
          'The preview runs the production generator, not a sketch. What you see is the theater you will fight over. ' +
          'Change a knob and it redraws. Study the road net and the rivers before you commit.',
      },
      {
        heading: 'When a combination is refused',
        body:
          `Some settings cannot produce a map. The screen names the reason and the knob to change, and Generate & Play greys out. ` +
          `A large theater needs a long war — a ${BIGGEST_KM} km theater asks for at least ${BIGGEST_MIN_DAYS} days. ` +
          'Fix the named knob and the button returns.',
      },
    ],
  },
  {
    id: 'theater',
    title: 'The Theater Map',
    entries: [
      {
        heading: 'The map is the war',
        body:
          'The strategic map is not a menu. It is the war. ' +
          'You march companies over a real road network, and where they meet the enemy, a battle opens. ' +
          'Everything you do in a battle started with a decision you made here.',
      },
      {
        heading: 'Reading the ground',
        body:
          'Region tints name the country: farmland, bocage, forest, marsh and settlement. ' +
          'Bocage and forest hide movement and slow it. Marsh channels you onto the roads. ' +
          'Towns carry Norman names, so the event log reads like a report.',
      },
      {
        heading: 'Roads and pace',
        body:
          `Road weight sets march speed. A highway runs ${MOVE_MPM.highway} m/min, a road ${MOVE_MPM.road} m/min, a track ${MOVE_MPM.track} m/min. ` +
          `Forest multiplies that pace by ${REGION_PACE_MULT.forest}. ` +
          'A track through woods is the slowest ground in the theater. Route around it when the clock is tight.',
      },
      {
        heading: 'Rivers, bridges and fords',
        body:
          `Rivers cut the map, and only crossing nodes pass. A bridge holds you ${BRIDGE_DWELL_MIN} minutes as the column files over. ` +
          `A ford holds you ${FORD_CROSS_MIN} minutes and lands your men wet, shaken and tired. ` +
          'Take the bridge if the detour is short. A river is transit, never a destination.',
      },
      {
        heading: 'The rail line',
        body:
          'Dashed lines are railway. They carry no columns. Read them as terrain and as a landmark, not as a route.',
      },
      {
        heading: 'Giving a march order',
        body:
          `Click a company to select it. Right-click a town to march there. ${HOLD_INSTEAD} ` +
          'The route follows the fastest road chain, and the panel shows the arrival time before you commit.',
        keys: { desktop: 'Click, then right-click', touch: `Tap, then ${HOLD} the destination` },
      },
      {
        heading: 'When an order is refused',
        body:
          'A refused order flashes its reason and never fails silently. ' +
          'A company already fighting cannot march. A company queued at a bridge must wait its turn. ' +
          'A town with no road to it has no route. Open water cannot be held.',
      },
      {
        heading: 'The clock',
        body:
          `The war runs on its own clock. Pause with ${key('pause')}, then pick a speed. ` +
          `Press ${key('speed1')} for ${rate('speed1')}, ${key('speed2')} for ${rate('speed2')}, or ${key('speed3')} for ${rate('speed3')}. ` +
          'Run fast between decisions. Drop to pause the moment a contact opens.',
        keys: {
          desktop: `${key('pause')} pauses, ${key('speed1')}/${key('speed2')}/${key('speed3')} set speed`,
          touch: 'Tap the pause and speed buttons on the top bar',
        },
      },
      {
        heading: 'Contact',
        body:
          `Two forces make contact within ${CONTACT_M} m of each other on the same road or node. ` +
          'Both halt and a battle opens. You cannot slip past an enemy on the same road. ' +
          'Watch the event log — it scrolls the whole war, contact by contact.',
      },
      {
        heading: 'The contact choice',
        body:
          'A contact stops the clock and asks what you want. Attack fights it out. ' +
          `Auto-resolve appears only when the odds reach ${TRIVIAL_RATIO}:1 or worse, because the outcome is not in doubt. ` +
          'Stand down withdraws — but only when you are the attacker. A defender cannot refuse a fight the enemy chose.',
      },
      {
        heading: 'How long a battle takes',
        body:
          `Battles burn theater time. Two full companies fight for about ${battleDuration(100, 100, false)} minutes. ` +
          `A one-sided fight collapses to ${battleDuration(100, 100, true)} minutes. No battle runs past ${battleDuration(10000, 10000, false)} minutes. ` +
          'Every fight you pick is time the deadline keeps.',
      },
      {
        heading: 'Losing a battle on the map',
        body:
          `A beaten force falls back ${RETREAT_SETBACK_M} m down a road away from the enemy. ` +
          `A surrounded US force infiltrates instead, to the nearest friendly town within ${INFILTRATE_MIN} minutes of marching. ` +
          'A force with no way out is destroyed. Leave your companies a road home.',
      },
      {
        heading: 'Saving',
        body:
          'The campaign saves itself as you play. There is no save button and no save slot. ' +
          'Close the tab and Continue picks the war up where you left it.',
      },
    ],
  },
  {
    id: 'deployment',
    title: 'Deployment',
    entries: [
      {
        heading: 'The battle opens paused',
        body:
          'Every battle starts in deployment, paused. Your men stand where the staging placed them. ' +
          'Nothing moves and nobody shoots until you press Play. Use the time — this is the only free look you get.',
      },
      {
        heading: 'Your zone when attacking',
        body:
          `An attacker owns the western strip of the map, ${DEPLOY_ATK_DEPTH} m deep. ` +
          'Reposition inside it to pick your approach. Weight the flank with cover, not the open middle.',
      },
      {
        heading: 'Your zone when defending',
        body:
          `A defender owns everything behind the line, usually ${DEPLOY_DEF_DEFAULT} m from the west edge (${DEF_LINES}). ` +
          'Depth is yours to spend. Put a squad where it can see the road, and one where it cannot be seen.',
      },
      {
        heading: 'Repositioning',
        body:
          `Select the squads you want to move. Right-click inside your zone to send them there. ${HOLD_INSTEAD} ` +
          'An order outside the zone is refused and tells you the boundary. Men placed by staging are legal wherever they already stand.',
        keys: { desktop: 'Select, then right-click', touch: `Tap to select, then ${HOLD} the ground` },
      },
      {
        heading: 'Guns do not move',
        body:
          'Machine guns, mortars and anti-tank guns deploy where they stand. ' +
          'A gun is sited before the battle, not during it. Plan the rest of the position around them.',
      },
      {
        heading: 'Where the defenders are',
        body:
          `A defending force garrisons the buildings and woods within ${GARRISON_RADIUS} m of each objective. ` +
          'Expect the strongest position on the objective itself. Look for the approach it cannot see.',
      },
      {
        heading: 'Play commits',
        body:
          'Play starts the battle. Deployment does not come back. ' +
          'Check every squad before you press it.',
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
          'Break them before they break you. The top bar shows both sides and each break line.',
      },
      {
        heading: 'Battle speed',
        body: `The battle clock runs at ${BATTLE_SPEEDS.map((s) => `${s}×`).join(', ')}. The fight is the same fight at every speed.`,
        keys: { desktop: `${key('battleSpeed')} cycles the speed`, touch: 'Tap the speed chip beside Play' },
      },
      {
        heading: 'Selecting men',
        body:
          'Click a man to select his squad. Drag a box to select several. ' +
          'The chips along the bottom select the whole force or one team. ' +
          'Hold shift to add to the selection instead of replacing it.',
        keys: {
          desktop: 'Click, drag a box, digits 1-9 for squads, shift to add',
          touch: 'Tap a man, SELECT chip for one box-select, ADD chip for sticky add',
        },
      },
      {
        heading: 'Giving an order',
        body:
          `Arm an order, then right-click the ground to issue it. ${HOLD_INSTEAD} ` +
          'The preview shows exactly where each man will go before you commit. ' +
          `${key('cancel')} steps back down the ladder: the aiming cursor, the inspected man, the armed order, the selection modes, the team, then the selection.`,
        keys: { desktop: `Order key, then right-click. ${key('cancel')} cancels`, touch: `Order chip, then ${HOLD}. Two-finger tap cancels` },
      },
      ...orderEntries(),
      {
        heading: 'Formation, width and facing',
        body:
          'Drag the order instead of clicking it. The length of the drag sets the width of the formation. ' +
          'The direction sets the axis the men spread along. ' +
          'A line across a hedgerow covers more ground than a clump in a field.',
        keys: { desktop: 'Right-drag', touch: 'Hold, then drag without lifting' },
      },
      {
        heading: 'Cover',
        body:
          'Cover stops bullets. Walls, banks and hedgerows are cover. ' +
          'A man behind cover is harder to kill and knows it, so he keeps firing. Cover is the difference between a fight and a slaughter.',
      },
      {
        heading: 'Concealment',
        body:
          'Concealment stops eyes, not bullets. Crops, smoke and woods conceal. ' +
          'A sneaking or ambushing team with enough concealment on the sightline is unseen past a short range. ' +
          `That range is ${hideFloorOf(1)} m by day and ${hideFloorOf(0)} m at night.`,
      },
      {
        heading: 'Line of sight',
        body:
          'Your men shoot what they can see, from where they are, at their own eye height. ' +
          'The game traces the real sightline through walls, hedges, smoke and floors. ' +
          'If the tooltip says NO LOS, no order will fix it. Move.',
      },
      {
        heading: 'Buildings and floors',
        body:
          `Buildings have floors, and floors matter. ${key('floorFocus')} cycles the floor focus so you can see one storey at a time. ` +
          'Alt and right-click opens the floor picker and sends the order upstairs. ' +
          'Defend and ambush garrison the top storey on their own. Every other order goes to the ground floor. ' +
          'The preview dots always show the floor the order will land on.',
        keys: { desktop: `${key('floorFocus')} cycles floors, Alt+right-click picks a floor`, touch: `Floor chip cycles, ${HOLD} on a tall building picks` },
      },
      {
        heading: 'Ammunition',
        body:
          'Ammunition is finite and the squad panel shows what is left. ' +
          'Suppressive fire is expensive. A squad that shoots at everything has nothing left for the assault. ' +
          'Runners resupply from the squad pool when they can.',
      },
      {
        heading: 'Suppression, morale and rout',
        body:
          'Men under fire go down a ladder. Steady men fight. Shaken men shoot badly. ' +
          'Pinned men stop moving and hug the ground. Broken men run and take no orders. ' +
          'Pull a broken squad out of contact and it recovers. Suppression is how you win a firefight without killing anyone.',
      },
      {
        heading: 'Weapon teams',
        body:
          'Machine gun, mortar and bazooka teams are not riflemen. ' +
          'A machine gun suppresses a wide arc and holds ground on its own. ' +
          "A mortar drops fire on a point it cannot see, through another squad's eyes. A bazooka is your answer to armour and nothing else.",
      },
      {
        heading: 'Emplacements',
        body:
          'Crewed guns sit in prepared positions and carry a deep ammunition stock. ' +
          'They fire on a wide arc and they do not move. ' +
          'A crew under fire serves the gun slowly. Suppress the crew and the gun goes quiet without a single kill.',
      },
      {
        heading: 'Barrage and airstrike',
        body:
          `Call a barrage with ${key('barrage')} and an airstrike with ${key('airstrike')}, then click the target. ` +
          'Both are limited and both are slow to arrive. ' +
          'Fire them at a position you know is held, not at a suspicion. Keep your own men clear.',
        keys: { desktop: `${key('barrage')} barrage, ${key('airstrike')} airstrike`, touch: 'Tap the barrage or airstrike chip, then tap the target' },
      },
      {
        heading: 'Fog of war',
        body:
          `You see what your men see. A spotting sweep runs every ${seconds(SPOT_INTERVAL)} seconds out to ${SPOT_RANGE} m, through the real sightlines. ` +
          `An enemy you lose leaves a ghost marker that fades after ${seconds(CONTACT_TTL)} seconds. ` +
          `Darkness closes the range down to ${Math.round(spotCapOf(0))} m. A ghost is where he was, not where he is.`,
      },
      {
        heading: 'Assault, melee and surrender',
        body:
          'An assault ends at bayonet range. Men who reach each other lock into melee and neither can leave. ' +
          'A man who is caught alone and beaten surrenders and leaves the fight alive. ' +
          'Assault a position you have already suppressed. Assault a fresh one and you feed it your squad.',
      },
      {
        heading: 'The debrief, and what carries',
        body:
          'The debrief names every man. Wounds and deaths are permanent and follow the roster into the next battle. ' +
          'A veteran with a bad leg is still your veteran. The roster is the campaign — it is the one thing you cannot regenerate from a seed.',
      },
    ],
  },
  {
    id: 'touch',
    title: 'Touch Controls',
    entries: [
      {
        heading: 'Select',
        body: 'Tap a man to select his squad. Tap a chip to select a team or the whole force.',
        keys: { desktop: 'Left-click', touch: 'Tap' },
      },
      {
        heading: 'Pan',
        body: `Drag one finger to move the camera. A finger that wanders under ${TAP_SLOP} px still counts as a tap.`,
        keys: { desktop: 'WASD or edge scroll', touch: 'One-finger drag' },
      },
      {
        heading: 'Zoom',
        body: 'Pinch two fingers to zoom. The midpoint between your fingers stays put.',
        keys: { desktop: 'Mouse wheel', touch: 'Pinch' },
      },
      {
        heading: 'Give an order',
        body: `Hold one finger on the ground for ${HOLD_MS} ms. That is the right-click. Lift to issue the order.`,
        keys: { desktop: 'Right-click', touch: `Press-and-hold (${HOLD_MS} ms)` },
      },
      {
        heading: 'Set formation width',
        body: 'Hold until the ring closes, then drag without lifting. The drag sets width and facing exactly like a right-drag.',
        keys: { desktop: 'Right-drag', touch: 'Hold, then drag' },
      },
      {
        heading: 'Cancel',
        body: `Tap two fingers together to cancel. Both fingers must land and lift inside ${TWO_TAP_MS} ms. It walks the same ladder as ${key('cancel')}.`,
        keys: { desktop: key('cancel'), touch: 'Two-finger tap' },
      },
      {
        heading: 'Box select',
        body: 'Tap the SELECT chip, then drag a box. The mode lasts one box and turns itself off.',
        keys: { desktop: 'Left-drag', touch: 'SELECT chip, then drag' },
      },
      {
        heading: 'Add to selection',
        body: 'Tap the ADD chip to hold shift down. It stays on until you tap it again.',
        keys: { desktop: 'Hold shift', touch: 'ADD chip' },
      },
      {
        heading: 'Floors',
        body: 'Tap the floor chip to cycle the floor focus. Holding on a building of two storeys or more opens the floor picker.',
        keys: { desktop: `${key('floorFocus')}, or Alt+right-click`, touch: `Floor chip, or ${HOLD} a tall building` },
      },
      {
        heading: 'The roster',
        body: 'Tap the ☰ chip for the roster sheet. It is the only way in or out of the roster on a phone.',
        keys: { desktop: 'Always visible', touch: '☰ chip' },
      },
    ],
  },
];

/** Flat text of the whole manual — the search index, and what the tests read. */
export function manualText(): string {
  return MANUAL.flatMap((c) => [
    c.title,
    ...c.entries.flatMap((e) => [e.heading, e.body, e.keys ? `${e.keys.desktop} ${e.keys.touch}` : '']),
  ]).join('\n');
}
