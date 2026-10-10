import { advanceDays, fillReplacements, newCampaign, squadMembers, type BattleRecord, type Campaign } from './campaign/campaign';
import { AudioEngine } from './render/audio';
import { backdropMode, MenuBackdrop } from './render/backdrop';
import { Barks, barksOn, setBarksOn } from './render/barks';
import { Camera } from './render/camera';
import type { GrenadeThrow } from './render/fx';
import { Renderer } from './render/renderer';
import { setSun } from './render/light';
import { StrategicView, TERRAIN_LABELS } from './render/strategic';
import { bootCamera as bootCameraFor } from './render/framing';
import { MOBILE, view, viewSize } from './render/view';
import type { RedCommander } from './sim/ai';
import { WEAPONS } from './sim/data';
import { MOVE_FAMILY, type OrderKind, type TeamOrder } from './sim/orders';
import { DT, fanOffsets, squadClumpOffsets, type Side, type Sim, type Soldier } from './sim/sim';
import { resolveDeployment } from './sim/spots';
import { applyEngagementOutcome, makeStrategicBattle, newFront, resolveCoarse, syncStrengths, trivialMismatchWinner } from './strategic/bridge';
import { StrategicCommander, RED_DEFENDER, BLUE_ATTACKER } from './strategic/command';
import { operationStatus, REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY, type Chit, type Engagement, type Front } from './strategic/front';
import { saveGame } from './strategic/save';
import { makeDefaultSector } from './strategic/sector';
import { emplacementOf, Hud, infantrySquads } from './ui/hud';
import { drawEnemyPointer, enemyPointer, type Pointer, QUIET_PROMPT_S, quietPrompt } from './ui/battle-goal';
import { debriefHtml, drillEndHtml } from './ui/debrief';
import { frameSteps, nextSpeed, type BattleSpeed } from './ui/battle-speed';
import { StratHud } from './ui/strat-hud';
import { drawOverlays, EventPings, type TeamPulse } from './ui/overlays';
import { computeShot, pickAt, Tooltip } from './ui/tooltip';
import { HealthPanel } from './ui/health-panel';
import { actionForEvent, loadKeymap, type Keymap } from './ui/keymap';
import { PauseMenu } from './ui/menu';
import { Coach } from './ui/coach';
import { showFloorMenu } from './ui/floormenu';
import { MainMenu, type SaveProbe } from './ui/mainmenu';
import { ManualScreen } from './ui/manual';
import { drawMarkRing, Tutorial, type Circle, type Step, type WorldMark } from './ui/tutorial';
import { enemiesInSight, hasRefused, houseIsQuiet, makeDrill, type Drill } from './drill';
import { TheaterView } from './render/theater-view';
import { TheaterHud } from './ui/theater-hud';
import { contactBrief } from './ui/contact-brief';
import { fmtEta, type MarchPreview, type ViewInset } from './render/theater-view';
import { CustomizeScreen } from './ui/customize';
import { DEFAULT_PRESET, FIRST_PRESET, presetSpec } from './campaign/presets';
import { goalLine } from './ui/goal-line';
import { Highlights } from './ui/highlights';
import { SPEC_TAG, specStream, type CampaignConfig, type TheaterConfig } from './campaign/spec';
import { makeTheater, TheaterGenError } from './strategic/theatergen';
import { DispositionError, makeDisposition } from './strategic/theatergen/disposition';
import { makeWarGoals, warStatus, type WarGoals } from './strategic/goals';
import { DEPLOY_ATK_DEPTH, DEPLOY_DEF_LINE, DEPLOY_DEF_DEFAULT } from './strategic/deploy';
import { ContactIntel, OmniscientIntel, type IntelView } from './strategic/intel';
import { Commander2, RED_V2 } from './strategic/planner';
import { addForce, pushEvent, type CoarseBattle, type FrontV2, type MoveReject } from './strategic/theater/force';
import { firstContactOnMarch, orderHalt, orderMove, previewMove, setPosture } from './strategic/theater/step';
import { applyRequisition, requisitionDue, requisitionOffer, type RequisitionCard } from './strategic/requisition';
import { resultOfWin, resultTarget } from './strategic/result';
import { battleCatchUpMin, openBattle, retreatForce, stepWar } from './strategic/theater/war';
import { syncStrengthsV2 } from './strategic/theater/sync';
import type { Contact } from './strategic/theater/contact';
import { BATTLE_CLASS_TO_MAPKIND } from './strategic/theater';
import { applyTheaterOutcome, makeTheaterBattle, type TheaterBattle } from './strategic/bridge2';
import { adoptLegacyRoster, discardSaves, loadGameV2, saveGameV2, type AiSave } from './strategic/save2';
import { TRIVIAL_RATIO } from './strategic/bridge';
import { bindTouch, classify as classifyGesture, drawHoldRing, type TouchHandlers } from './ui/touch';
import './ui/ui.css';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
// Both modes clear the whole canvas every frame, so an opaque context is
// behavior-neutral and drops a per-frame compositing blend.
const ctx = canvas.getContext('2d', { alpha: false })!;
if (MOBILE) document.documentElement.classList.add('mobile');
// The backing store carries the DPR; the base transform puts every draw call
// back in CSS pixels, so cam.scale, PAN_PX_PER_SEC and every pick radius keep
// the meaning they had before retina existed.
let resizePending = false;
const resize = (): void => {
  resizePending = false;
  const w = Math.round(window.visualViewport?.width ?? window.innerWidth);
  const h = Math.round(window.visualViewport?.height ?? window.innerHeight);
  const v = viewSize(w, h, window.devicePixelRatio || 1);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * v.dpr);
  canvas.height = Math.round(h * v.dpr);
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  view.w = v.w;
  view.h = v.h;
  view.dpr = v.dpr;
};
// iOS fires resize repeatedly while the URL bar collapses — coalesce every
// source through one rAF-pending flag.
const queueResize = (): void => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(resize);
};
resize();
window.addEventListener('resize', queueResize);
window.visualViewport?.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', queueResize);
// WebKit-only, inert elsewhere: stops iOS Safari page zoom from stealing the
// two-finger pinch the battle camera needs.
document.addEventListener('gesturestart', (e) => e.preventDefault());

const debriefEl = document.createElement('div');
debriefEl.id = 'debrief';
document.body.appendChild(debriefEl);

// Portrait guidance. Visibility is pure CSS (@media (orientation: portrait)
// under html.mobile), so there is no resize plumbing to get wrong; the only
// state is the dismissal, which persists so a player who chose portrait is
// never nagged again.
const ROTATE_KEY = 'rts.portrait.dismissed';
const rotateEl = document.createElement('div');
rotateEl.id = 'rotate';
rotateEl.innerHTML =
  '<div class="rot-glyph">⟳</div>' +
  '<h2>Turn your phone for a wider view.</h2>' +
  '<button id="rotate-anyway">Stay in portrait</button>';
document.body.appendChild(rotateEl);
try {
  if (localStorage.getItem(ROTATE_KEY) === '1') rotateEl.classList.add('dismissed');
} catch { /* private mode */ }
document.getElementById('rotate-anyway')!.addEventListener('click', () => {
  rotateEl.classList.add('dismissed');
  try { localStorage.setItem(ROTATE_KEY, '1'); } catch { /* quota */ }
});

// debug: ?camp=N pins the campaign seed and disables saving (screenshot
// harness reproducibility — a pinned campaign must never clobber a real save)
const urlCamp = new URLSearchParams(location.search).get('camp');
const campPinned = urlCamp !== null && Number.isFinite(Number(urlCamp));
const campSeed = (): number => (campPinned ? Number(urlCamp) : Date.now() % 100000);

// §9.1: the module-level campaign/front lets collapse into Session behind S().
// Pre-session access is a NAMED error, never an unassigned-binding TypeError.
interface SessionV2 {
  seed: number;
  theaterCfg: TheaterConfig;
  campaignCfg: CampaignConfig;
  front: FrontV2;
  goals: WarGoals;
  red: Commander2;
  redIntel: IntelView; // OQ6: the AI plays under the campaign's OWN fog
  view: TheaterView;
  battle: { b: CoarseBattle; tb: TheaterBattle } | null;
  pending: Contact | null;
  selectedForce: number;
  // Frame the player's sector once the theater HUD is laid out: the boot
  // camera measures the panels, and they do not exist until the first frame.
  needsFrame: boolean;
  // Centre the map here on the next frame, once the HUD has laid out the
  // panel that made the request (the contact card changes the clear rectangle).
  centerNext: { x: number; y: number } | null;
  shownForce: number; // the selection the camera last made room for
}
interface Session {
  campaign: Campaign;
  front: Front;
  stratView: StrategicView;
  v2: SessionV2 | null;
}

// A V2 campaign has no grid front: any legacy read is a leaked V1 code path
// and must fail LOUDLY, not silently operate on stale state.
function v1Trap<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      throw new Error(`${what}.${String(prop)} read during a V2 campaign — a V1 code path leaked`);
    },
  });
}
let session: Session | null = null;
function S(): Session {
  if (!session) throw new Error('S(): no active session — the menu is up and startCampaign() has not run');
  return session;
}
const save = () => {
  if (campPinned) return;
  const s = S();
  if (s.v2) {
    // §4.8: the red plan rides the save — a reloaded commander keeps its axes.
    const ai = { red: { lastEvalMin: s.v2.red.lastEvalMin, plan: s.v2.red.plan } };
    if (!saveGameV2(s.v2.seed, s.v2.theaterCfg, s.v2.campaignCfg, s.campaign, s.v2.front, ai)) {
      mainMenu.setStorageWritable(false);
    }
  } else {
    saveGame(s.campaign, s.front);
  }
};

const aiParam = new URLSearchParams(location.search).get('ai'); // ?ai=red|blue|both
const aiSides = new Set<Side>();
if (aiParam === 'red') aiSides.add('red');
else if (aiParam === 'blue') aiSides.add('blue');
else if (aiParam === 'both') { aiSides.add('red'); aiSides.add('blue'); }

const commanders: StrategicCommander[] = [];
function buildCommanders() {
  commanders.length = 0;
  if (aiSides.has('red')) commanders.push(new StrategicCommander('red', RED_DEFENDER));
  if (aiSides.has('blue')) commanders.push(new StrategicCommander('blue', BLUE_ATTACKER));
}
buildCommanders();

const ORDER_KINDS: OrderKind[] = ['move', 'fast', 'sneak', 'fire', 'smoke', 'defend', 'ambush', 'assault'];

let mode: 'menu' | 'strategic' | 'battle' = 'menu';
let selectedChit = -1;
const SPEEDS = [1, 10, 60]; // strategic minutes per real second
let speedIdx = 1;
let stratPaused = true;
let stratAcc = 0;
let prevDay = 0;
let pendingEngagement: Engagement | null = null;
let opEnded = false;

// battle state
let sim: Sim;
// Whoever gives a side its orders each tick. The drill's garrison has nobody:
// its whole plan is the one order it was staged with.
type BattleAi = Pick<RedCommander, 'update'>;
const NO_COMMANDER: BattleAi = { update: () => {} };
let commander: BattleAi;
let blueCommander: BattleAi | undefined;
// The drill (src/drill.ts), while it is the battle on screen. null in every
// campaign battle. `shooter` is the squad the player gave Fire to, `asked` the
// refusals already reported, so one refused order is one recovery step.
let drill: (Drill & { shooter: number; asked: WeakSet<object> }) | null = null;
// The step on screen holds the battle: Play is not the player's to press yet.
let heldByStep = false;
let aiControl = false;
let renderer: Renderer;
let barks = new Barks();
let battleCompany = -1;
let battleTitle = '';
const cam = new Camera(60, 60);
const audio = new AudioEngine();
// WebAudio autoplay policy: the context can only start inside a user gesture.
const unlockAudio = () => audio.unlock();
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);
let paused = true;
let selectedSquads: number[] = [];
// Primary = last element of selectedSquads. Kept for existing call sites.
function getPrimary(): number { return selectedSquads.length > 0 ? selectedSquads[selectedSquads.length - 1] : -1; }
let selectedTeam = -1; // -1 = whole squad; narrowed to one team within selectedSquad
let inspectedSoldier = -1; // health panel target; independent of selection, never affects orders
let selectedVehicle = -1;
let lastTeamId = -1; // most recently selected team, survives a later vehicle selection (Mount reads this)
let armedOrder: OrderKind | null = null; // order kind armed via ⇧1-8 / order bar, issued by right-click
let targetMode: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke' | 'breach' = '';
let floorFocus = -1; // -1 = all floors; 0..maxStories-1 = only that floor, others dimmed (F key)
// The open floor menu: its world target pins the order preview (the pointer is
// off the canvas, on the menu), and `level` is the row under the pointer — so
// hovering "Floor 2" moves the ghost dots upstairs before anything is issued.
let floorMenu: { wx: number; wy: number; level: number | null } | null = null;
// Deployment phase (V2 campaign battles only — the pinned harness never sees
// it): battle boots paused in DEPLOY; select + right-click REPOSITIONS inside
// your zone instead of ordering; the first unpause commits and begins.
let deployPhase = false;
let deployMsg = '';
let deployMsgUntil = 0;
const deployOverride = new URLSearchParams(location.search).get('deploy'); // ?deploy=atk,defLine — OQ19 tuning
let winnerAt = -1; // ms timestamp when winner appeared
let lastOrderTick = 0; // sim tick of the player's last order — the quiet-minute prompt counts from it
let battleSpeed: BattleSpeed = 1;
let debriefShown = false;
let needsBootFrame = false; // re-run bootCamera once the battle HUD is laid out
const mouse = { x: 0, y: 0, onCanvas: false, alt: false };
// The terrain card is one line; the numbers behind it are asked for: Alt on a
// keyboard, and on touch a hold kept this long past the point it arms.
const DETAIL_HOLD_MS = 1500;
const trackAlt = (e: KeyboardEvent | MouseEvent): void => { mouse.alt = e.altKey; };
window.addEventListener('keydown', trackAlt);
window.addEventListener('keyup', trackAlt);
const pings = new EventPings();
// What the player's men did in this battle, by name, for the debrief. One battle, never saved.
const highlights = new Highlights();
// Touch-only sticky modes. A phone has no shift key and no second mouse
// button, so the two modifiers the desktop path reads off the keyboard become
// latched chips in the touch bar. Both stay false on desktop, where the
// keyboard still supplies them per-event.
let boxMode = false;
let addMode = false;
/** shift-equivalent: the real key on desktop, the latched ADD chip on touch. */
const additiveWith = (shift: boolean): boolean => shift || addMode;

function selectSquad(id: number): void {
  if (id >= 0) audio.uiSelect();
  selectedSquads = id < 0 ? [] : [id];
  selectedTeam = -1;
  selectedVehicle = -1;
  if (renderer) renderer.selectedVehicle = -1;
  armedOrder = null;
  if (id >= 0) lastTeamId = sim.squads[id].teamIds[0];
  noteSelection();
}

// Deployment has its own step on screen: a squad picked there is reported
// when the fight starts, not before.
function noteSelection(): void {
  if (selectedSquads.length === 0 || deployPhase) return;
  tutorial?.notify('squad-selected');
  if (drill && drill.shooter >= 0 && getPrimary() !== drill.shooter) tutorial?.notify('squad-switched');
}

function toggleSquadSelection(id: number): void {
  if (id < 0) return;
  const idx = selectedSquads.indexOf(id);
  if (idx >= 0) selectedSquads.splice(idx, 1);
  else selectedSquads.push(id);
  selectedTeam = -1;
  selectedVehicle = -1;
  if (renderer) renderer.selectedVehicle = -1;
  armedOrder = null;
  noteSelection();
}

/** Arm an order kind (toggle). */
function doArmOrder(kind: OrderKind): void {
  armedOrder = armedOrder === kind ? null : kind;
  if (armedOrder === 'fire') tutorial?.notify('fire-armed');
}

function selectVehicle(id: number): void {
  if (id >= 0) audio.uiSelect();
  selectedVehicle = id;
  selectedSquads = [];
  selectedTeam = -1;
  if (renderer) renderer.selectedVehicle = id;
}

function setTargetMode(m: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke' | 'breach'): void {
  targetMode = m;
  canvas.style.cursor = m ? 'crosshair' : '';
}

const urlSeed = new URLSearchParams(location.search).get('seed'); // debug: ?seed=N pins the map
if (urlSeed !== null && !Number.isFinite(Number(urlSeed))) console.warn(`?seed=${urlSeed} is not a number; ignoring`);
const fowOff = new URLSearchParams(location.search).get('fow') === '0'; // debug: ?fow=0 disables fog of war (render-only; never touches sim outcomes)
const hazeOff = new URLSearchParams(location.search).get('haze') === '0'; // debug: ?haze=0 drops the ambient haze bands so the art sweep can shoot both
const flickerOff = new URLSearchParams(location.search).get('flicker') === '0'; // debug: ?flicker=0 pins the hearth-glow clock so the art sweep's settle loop can converge
// debug: ?hour=HHMM sets the campaign clock at boot (day 1), so a battle can be
// staged at any sun. Same contract as ?fow: a boot-time staging switch, never
// read by step() — the clock it sets flows through the normal startMin path.
const urlHour = new URLSearchParams(location.search).get('hour');
const urlHourMin = ((): number | null => {
  if (urlHour === null) return null;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(urlHour);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return Number(m[1]) * 60 + Number(m[2]);
  console.warn(`?hour=${urlHour} is not HHMM; ignoring`);
  return null;
})();
const hud = new Hud({
  selectSquad: pickSquad,
  selectVehicle,
  panToSoldier: (id) => {
    const s = sim.soldiers[id];
    cam.x = s.x;
    cam.y = s.y;
  },
  inspectSoldier: (id) => {
    inspectedSoldier = id;
  },
  callBarrage: () => {
    if (!aiControl && sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  },
  callAirstrike: () => {
    if (!aiControl && sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
  },
  togglePause: () => {
    if (mode === 'strategic') toggleStratPause();
    else paused = !paused;
  },
  cycleSpeed: () => { battleSpeed = nextSpeed(battleSpeed); },
  armOrder: (kind) => {
    doArmOrder(kind);
  },
  deployEmplacement: () => {
    const e = emplacementOf(sim, getPrimary());
    if (e) sim.orderDeploy(e.id);
  },
  packEmplacement: () => {
    const e = emplacementOf(sim, getPrimary());
    if (e) sim.orderPack(e.id);
  },
  wheelEmplacement: () => setTargetMode(targetMode === 'wheel' ? '' : 'wheel'),
  fireEmplacement: () => setTargetMode(targetMode === 'empfire' ? '' : 'empfire'),
  smokeEmplacement: () => setTargetMode(targetMode === 'empsmoke' ? '' : 'empsmoke'),
  breachTarget: () => setTargetMode(targetMode === 'breach' ? '' : 'breach'),
  mountVehicle: () => {
    if (selectedVehicle >= 0 && lastTeamId >= 0) sim.orderMount(lastTeamId, selectedVehicle);
  },
  dismountVehicle: () => {
    if (selectedVehicle >= 0) sim.orderDismount(selectedVehicle);
  },
  hitchVehicle: () => {
    const v = sim.vehicles[selectedVehicle];
    if (!v) return;
    const near = sim.emplacements.find((e) => e.side === v.side && e.state === 'packed' && e.towedBy < 0 && Math.hypot(e.x - v.x, e.y - v.y) <= 4);
    if (near) sim.orderHitch(v.id, near.id);
  },
  unhitchVehicle: () => {
    const e = sim.emplacements.find((e) => e.towedBy === selectedVehicle);
    if (e) sim.orderUnhitch(e.id);
  },
  toggleBoxMode: () => { boxMode = !boxMode; },
  toggleAddMode: () => { addMode = !addMode; },
  selectAll: () => {
    selectedSquads = infantrySquads(sim).map((q) => q.id);
    selectedTeam = -1;
    selectedVehicle = -1;
    if (renderer) renderer.selectedVehicle = -1;
    armedOrder = null;
    noteSelection();
  },
  cancel: () => { escapeLadder(); },
  cycleFloor: () => { cycleFloorFocus(); },
  openMenu: () => { openPauseMenu(); },
  openControls: () => { openPauseMenu('controls'); },
});
// Two stacked fixed bottom layers (touch bar + roster sheet) have to agree on
// one height, and the bar's own height changes when the order-chip row comes
// and goes. Publish the measured value rather than hard-coding it twice.
const touchbarEl = document.getElementById('touchbar');
const topbarEl = document.getElementById('topbar');
if (touchbarEl && topbarEl && typeof ResizeObserver === 'function') {
  // The landscape roster column hangs between the two bars, so it needs the
  // top bar's bottom edge as well.
  const publishBars = (): void => {
    const css = document.documentElement.style;
    css.setProperty('--touchbar-h', `${Math.round(touchbarEl.getBoundingClientRect().height)}px`);
    css.setProperty('--topbar-b', `${Math.round(topbarEl.getBoundingClientRect().bottom)}px`);
  };
  const watch = new ResizeObserver(publishBars);
  watch.observe(touchbarEl);
  watch.observe(topbarEl);
  publishBars();
}
// The theater clock's Play and Pause, from the button, the key and the touch
// bar alike. A contact or a requisition holds the clock until it is answered
// (the frame loop), so while one waits the control stays on Play and says what
// is in the way: a label that flipped to Pause over a stopped clock was a lie.
function toggleStratPause(): void {
  const v2 = S().v2;
  if (v2 && !opEnded) {
    if (v2.pending) return v2.view.flash('Answer the contact first');
    if (requisitionDue(v2.front)) return v2.view.flash('Pick a requisition first');
  }
  stratPaused = !stratPaused;
}
const stratHud = new StratHud({
  togglePause: toggleStratPause,
  setSpeed: (i) => { speedIdx = i; },
});
const theaterHud = new TheaterHud({
  togglePause: toggleStratPause,
  setSpeed: (i) => { speedIdx = i; },
  openMenu: () => { openPauseMenu(); },
  fitAll: () => { S().v2?.view.fitAll(view.w, view.h); },
  focusNode: (n) => {
    const v2 = S().v2;
    if (v2) v2.view.centerOn(v2.front.theater.nodes[n].pos, view.w, view.h);
  },
  focus: (e) => {
    const v2 = S().v2;
    if (!v2) return;
    // The place, else one of OUR forces in it: never the enemy's true position.
    const own = v2.front.forces.find((f) => f.side === 'blue' && e.forceIds.includes(f.id));
    const at = e.nodeId !== undefined ? v2.front.theater.nodes[e.nodeId].pos : own ? v2.view.forceXY(own) : null;
    if (at) v2.view.centerOn(at, view.w, view.h);
  },
  halt: () => {
    const v2 = S().v2;
    if (!v2) return;
    const r = orderHalt(v2.front, v2.selectedForce);
    v2.view.flash(r.ok ? `${v2.front.forces.find((f) => f.id === v2.selectedForce)!.name} halts` : MOVE_REJECT_TEXT[r.reason]);
  },
  posture: (p) => {
    const v2 = S().v2;
    if (!v2) return;
    const r = setPosture(v2.front, v2.selectedForce, p);
    if (!r.ok) v2.view.flash(MOVE_REJECT_TEXT[r.reason]);
    else tutorial?.notify('posture-set');
  },
});
const tooltip = new Tooltip(hud.root);
const healthPanel = new HealthPanel(hud.root, () => { inspectedSoldier = -1; });
let pauseBeforeMenu: boolean | null = null;
// Renders only when opened, and only the main menu, the pause menu or the
// tutorial opens it. Nothing on the ?camp= art path can reach it.
const manual = new ManualScreen();
const menu = new PauseMenu({
  onResume: () => {
    if (pauseBeforeMenu === null) return;
    if (mode === 'strategic') stratPaused = pauseBeforeMenu;
    else paused = pauseBeforeMenu;
    pauseBeforeMenu = null;
  },
  onKeymapChanged: (km: Keymap) => { hud.setKeymap(km); },
  onFieldManual: () => { manual.open(); },
  muted: () => audio.muted,
  onMuteToggle: () => { audio.toggleMute(); },
  // Gated on campPinned (declared above) rather than on `tutorial` itself,
  // which is constructed below: the arrows only READ it and run long after
  // module init, but the presence test has to be answerable right here. On the
  // pinned art path there is no tutorial, so the control does not render.
  tutorialEnabled: campPinned ? undefined : () => (tutorial ? !tutorial.isSkipped : false),
  onTutorialToggle: campPinned ? undefined : (on) => tutorial?.setEnabled(on),
  barksOn: () => barksOn(),
  onBarksToggle: (on) => setBarksOn(on),
  // The drill belongs to no campaign, so there is nothing to lose by leaving it.
  inTraining: () => drill !== null,
  onLeaveTraining: () => {
    pauseBeforeMenu = null;
    drill = null;
    tutorial?.endDrill();
    openMainMenu();
  },
});
menu.setKeymap(loadKeymap(localStorage));

/**
 * The one door to the pause menu. The battle ⚙, the theater ⚙ and Esc with
 * nothing left to cancel all come through here, and each stops the clock it
 * found running — the theater's, or the battle's.
 */
function openPauseMenu(view: 'menu' | 'controls' = 'menu'): void {
  if (menu.isOpen) { menu.close(); return; }
  pauseBeforeMenu = mode === 'strategic' ? stratPaused : paused;
  if (mode === 'strategic') stratPaused = true;
  else paused = true;
  menu.setKeymap(loadKeymap(localStorage));
  menu.open(view);
}

// The tutorial driver teaches over the live game. It does not exist at all on
// the pinned art path: ?camp= must render byte-identical frames forever.
const tutorial = campPinned
  ? null
  : new Tutorial(new Coach(), MOBILE, {
      storage: typeof localStorage !== 'undefined' ? localStorage : undefined,
      world: tutorialMark,
      stage: stageRect,
      goal: () => {
        const v2 = mode === 'strategic' && !opEnded ? S().v2 : null;
        // The view's flash line is drawn where this line sits. A flash is news and lasts seconds.
        const text = v2 && !v2.view.flashing && goalLine(v2.goals);
        return text ? { text, over: stageRect() } : null;
      },
      onStep: onTutorialStep,
    });

// The map as the player sees it: the screen less the opaque HUD around it.
function stageRect(): { left: number; top: number; right: number; bottom: number } {
  if (mode === 'strategic') {
    const inset = theaterInset();
    return { left: inset.left, top: inset.top, right: view.w - inset.right, bottom: view.h - inset.bottom };
  }
  const inset = viewportInset();
  const bar = document.getElementById('topbar')?.getBoundingClientRect();
  return { left: inset.left, top: Math.max(inset.top, bar ? bar.bottom : 0), right: view.w, bottom: view.h - inset.bottom };
}

// The step on screen changed. A step that holds the battle stops it until the
// player has done the step, and the battle goes on by itself afterwards: the
// player was never asked to press Play. A step that rings a place brings the
// place into view, which on a phone is most of the time.
function onTutorialStep(step: Step | null): void {
  if (step?.holds) {
    paused = true;
    heldByStep = true;
  } else if (heldByStep) {
    paused = false;
    heldByStep = false;
  }
  if (step?.mark && mode === 'battle') revealMark(step.mark, step.anchor !== undefined);
  // On the theater a mark off the map is brought in by showing all of it.
  if (step?.mark && mode === 'strategic') {
    const c = theaterMark(step.mark);
    if (c && !onStage(c, stageRect())) S().v2?.view.fitAll(view.w, view.h);
  }
}

const MARK_MARGIN_PX = 24;
// Half the width of the enemy pointer with its label: how near a step's bubble or ring it may come.
const POINTER_REACH_PX = 56;
// The ENEMY pointer as drawn on the last battle frame, for the gates. null = none drawn.
let foeShown: Pointer | null = null;
// A bubble that points at a chip in the order bar sits in this band above it.
const CHIP_BUBBLE_BAND_PX = 84;

// Pan the least that puts the mark's ring inside the map. The zoom is the
// player's and stays. `underBubble`: the step's bubble points at the order
// bar, so the ring is also kept out of the band that bubble takes. The ring is
// what the player presses next, and nothing may sit on it.
function revealMark(mark: WorldMark, underBubble: boolean): void {
  const c = tutorialMark(mark);
  if (!c) return;
  const st = stageRect();
  if (underBubble) st.bottom -= CHIP_BUBBLE_BAND_PX;
  const pad = Math.min(c.r + MARK_MARGIN_PX, (st.right - st.left) / 2, (st.bottom - st.top) / 2);
  const dx = c.x < st.left + pad ? c.x - (st.left + pad) : c.x > st.right - pad ? c.x - (st.right - pad) : 0;
  const dy = c.y < st.top + pad ? c.y - (st.top + pad) : c.y > st.bottom - pad ? c.y - (st.bottom - pad) : 0;
  cam.x += dx / cam.scale;
  cam.y += dy / cam.scale;
}

const worldCircle = (x: number, y: number, radiusM: number): Circle => {
  const [sx, sy] = cam.worldToScreen(x, y, view.w, view.h);
  return { x: sx, y: sy, r: Math.max(22, radiusM * cam.scale) };
};

// The squad the drill's "another squad" step rings: a rifle squad that did not
// do the shooting, still on its feet.
function drillOther(d: Drill & { shooter: number }): number {
  return d.rifles.find((q) => q !== d.shooter && squadCircle(q) !== null) ?? d.lead;
}

// Where a tutorial step's world mark is on screen.
function tutorialMark(mark: WorldMark): Circle | null {
  if (mode === 'strategic') return theaterMark(mark);
  if (mode !== 'battle') return null;
  switch (mark) {
    case 'lead':
      return drill && squadCircle(drill.lead);
    case 'other':
      return drill && squadCircle(drillOther(drill));
    case 'hedge':
      return drill && worldCircle(drill.hedge.x, drill.hedge.y, drill.hedge.r);
    case 'house':
      return drill && worldCircle(drill.house.x, drill.house.y, drill.house.r);
    // A defender the player can see, else the house they are in.
    case 'enemy': {
      if (!drill) return null;
      const [seen] = enemiesInSight(sim);
      return seen ? worldCircle(seen.x, seen.y, 2.5) : worldCircle(drill.house.x, drill.house.y, drill.house.r);
    }
    case 'company':
    case 'town':
    case 'holder':
      return null; // theater marks: theaterMark
    // The squad the player has picked. Before any pick, the one nearest the
    // middle of the map on screen: the ring must be somewhere they can see.
    case 'squad': {
      if (getPrimary() >= 0) return squadCircle(getPrimary());
      const st = stageRect();
      const cx = (st.left + st.right) / 2;
      const cy = (st.top + st.bottom) / 2;
      let best: Circle | null = null;
      for (const q of infantrySquads(sim)) {
        const c = squadCircle(q.id);
        if (c && (!best || Math.hypot(c.x - cx, c.y - cy) < Math.hypot(best.x - cx, best.y - cy))) best = c;
      }
      return best;
    }
  }
}

const onStage = (c: Circle, st: { left: number; top: number; right: number; bottom: number }): boolean =>
  c.x - c.r >= st.left && c.x + c.r <= st.right && c.y - c.r >= st.top && c.y + c.r <= st.bottom;

// Where the march step's ring goes: the objectives the selected company can be
// ordered onto, the weakest garrison first and the nearest first among equals.
// The first battle a new player fights is the one this ring walks them into:
// on the first preset the nearest objective lost 1 first battle in 12 and left
// 1 undecided, the weakest lost none (scripts/firstcontact.mjs --pick). Garrison
// strength is what the player is shown, the objective strip's own numbers:
// last-seen reports under fog. Asked of previewMove, so the ring is never on a
// town the order would refuse. Cached per company and theater minute.
let marchTargetsKey = '';
let marchTargetsCached: number[] = [];
function marchTargets(v2: SessionV2): number[] {
  const key = `${v2.selectedForce}:${v2.front.clockMin}`;
  if (key === marchTargetsKey) return marchTargetsCached;
  marchTargetsKey = key;
  const fog = v2.campaignCfg.recon === 'contacts';
  const garrison = (n: number): number =>
    fog
      ? (v2.front.intel?.blue ?? []).filter((c) => c.pos.kind === 'node' && c.pos.nodeId === n).reduce((a, c) => a + c.strength, 0)
      : v2.front.forces.filter((f) => f.side === 'red' && f.strength > 0 && f.pos.kind === 'node' && f.pos.nodeId === n).reduce((a, f) => a + f.strength, 0);
  marchTargetsCached = v2.front.theater.objectiveNodes
    .filter((n) => v2.front.controlByNode[n] !== 'blue')
    .flatMap((n) => {
      const p = previewMove(v2.front, v2.selectedForce, n, { nightTempo: v2.campaignCfg.nightTempo });
      return p.ok ? [{ n, red: garrison(n), eta: p.etaMin }] : [];
    })
    .sort((a, b) => a.red - b.red || a.eta - b.eta)
    .map((t) => t.n);
  return marchTargetsCached;
}

// The objective the player took last and still holds, from the war's own
// event log. null = he has taken none yet.
function capturedObjective(v2: SessionV2): number | null {
  const objectives = v2.front.theater.objectiveNodes;
  for (let i = v2.front.events.length - 1; i >= 0; i--) {
    const e = v2.front.events[i];
    if (e.kind === 'capture' && e.nodeId !== undefined && objectives.includes(e.nodeId) && v2.front.controlByNode[e.nodeId] === 'blue') return e.nodeId;
  }
  return null;
}

// The theater's two marks. 'company' is one of the player's counters as it is
// drawn: the strongest that is whole on the map. 'town' is where the selected
// company should march (marchTargets). Each prefers a place the player can
// see now.
function theaterMark(mark: WorldMark): Circle | null {
  const v2 = S().v2;
  if (!v2) return null;
  const st = stageRect();
  const pick = (cs: Circle[]): Circle | null => cs.find((c) => onStage(c, st)) ?? cs[0] ?? null;
  if (mark === 'company') {
    return pick(
      v2.front.forces
        .filter((f) => f.side === 'blue' && f.strength > 0 && f.engagedIn === null)
        .sort((a, b) => b.strength - a.strength)
        .flatMap((f) => {
          const r = v2.view.counterOf(f.id);
          return r ? [{ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, r: Math.hypot(r.x1 - r.x0, r.y1 - r.y0) / 2 + 4 }] : [];
        }),
    );
  }
  if (mark === 'holder') {
    // The company standing on the objective the player took last, as drawn.
    const n = capturedObjective(v2);
    if (n === null) return null;
    const on = v2.front.forces.find((f) => f.side === 'blue' && f.strength > 0 && f.pos.kind === 'node' && f.pos.nodeId === n);
    // Selected: its card is up and the bubble is on the button. The ring has done its work.
    if (on && on.id === v2.selectedForce) return null;
    const r = on && v2.view.counterOf(on.id);
    if (r) return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, r: Math.hypot(r.x1 - r.x0, r.y1 - r.y0) / 2 + 4 };
    const at = v2.front.theater.nodes[n].pos;
    const [x, y] = v2.view.toScreen(at.x, at.y, view.w, view.h);
    return { x, y, r: 22 };
  }
  if (mark === 'town') {
    if (v2.selectedForce < 0) return null;
    // The best town, wherever it is: a ring off the map is brought in by
    // showing the whole theater (onTutorialStep), not by ringing a worse town.
    const [n] = marchTargets(v2);
    if (n === undefined) return null;
    const at = v2.front.theater.nodes[n].pos;
    const [x, y] = v2.view.toScreen(at.x, at.y, view.w, view.h);
    // The ring takes in the counters standing on the town: who holds it and how
    // strong is the other half of what the player is being pointed at, and the
    // bubble keeps off whatever the ring holds.
    let r = 22;
    for (const f of v2.front.forces) {
      if (f.strength <= 0 || f.pos.kind !== 'node' || f.pos.nodeId !== n) continue;
      const c = v2.view.counterOf(f.id);
      if (c) r = Math.max(r, ...[c.x0, c.x1].flatMap((cx) => [c.y0, c.y1].map((cy) => Math.hypot(cx - x, cy - y) + 3)));
    }
    return { x, y, r: Math.min(r, 64) };
  }
  return null;
}

// A squad picked by name (the roster, a number key) may be off screen: the
// battle opens on part of the company, not all of it. Bring it into view.
function pickSquad(id: number): void {
  selectSquad(id);
  const c = squadCircle(id);
  if (!c) return;
  const st = stageRect();
  if (c.x >= st.left && c.x <= st.right && c.y >= st.top && c.y <= st.bottom) return;
  cam.x += (c.x - (st.left + st.right) / 2) / cam.scale;
  cam.y += (c.y - (st.top + st.bottom) / 2) / cam.scale;
}

function squadCircle(id: number): Circle | null {
  const squad = sim.squads[id];
  if (!squad) return null;
  const men = squad.soldierIds.map((sid) => sim.soldiers[sid]).filter((s) => s.alive && s.inVehicle < 0);
  if (men.length === 0) return null;
  const wx = men.reduce((a, s) => a + s.x, 0) / men.length;
  const wy = men.reduce((a, s) => a + s.y, 0) / men.length;
  const spread = Math.max(...men.map((s) => Math.hypot(s.x - wx, s.y - wy)));
  const [x, y] = cam.worldToScreen(wx, wy, view.w, view.h);
  return { x, y, r: Math.max(22, (spread + 1.5) * cam.scale) };
}

function probeSave(): SaveProbe {
  if (campPinned) return { status: 'none' };
  const g = loadGameV2();
  if (g.status !== 'ok') {
    if (g.status === 'corrupt') return { status: 'corrupt', detail: g.detail };
    return { status: g.status };
  }
  const fit = Object.values(g.campaign.soldiers).filter((s) => s.status === 'fit').length;
  const hh = Math.floor((g.front.clockMin % 1440) / 60);
  const mm = (g.front.clockMin % 60).toString().padStart(2, '0');
  return { status: 'ok', day: g.front.day, clock: `${hh.toString().padStart(2, '0')}${mm}`, theaterName: g.front.theater.name, menFit: fit };
}
const customize = new CustomizeScreen({
  onGenerate: (seed, theaterCfg, campaignCfg) => {
    customize.close();
    startCampaignV2({ kind: 'fresh', seed, theaterCfg, campaignCfg });
  },
  onBack: () => {
    customize.close();
    mainMenu.setSaveProbe(probeSave());
    mainMenu.open();
  },
});
const mainMenu = new MainMenu({
  // Read live, never cached: the pause menu can flip the same switch.
  tutorialEnabled: tutorial ? () => !tutorial.isSkipped : undefined,
  onTutorialToggle: tutorial ? (on) => tutorial.setEnabled(on) : undefined,
  barksOn: () => barksOn(),
  onBarksToggle: (on) => setBarksOn(on),
  firstRun: () => tutorial !== null && !tutorial.isSkipped && !tutorial.drilled && probeSave().status === 'none',
  onPlay: () => startDrill(campSeed()),
  onTraining: () => startDrill(campSeed()),
  onNewCampaign: () => startFirstCampaign(),
  onCustom: () => {
    mainMenu.close();
    customize.open();
  },
  onContinue: () => {
    const g = loadGameV2();
    if (g.status !== 'ok') throw new Error(`Continue: probe said ok but load returned '${g.status}'`);
    startCampaignV2({ kind: 'loaded', seed: g.seed, theaterCfg: g.cfg, campaignCfg: g.campaignCfg ?? DEFAULT_PRESET.campaign, campaign: g.campaign, front: g.front, ai: g.ai });
  },
  // OQ1 roster carry-over: the v3 grid save cannot migrate, the named men can.
  onContinueLegacy: () => {
    const roster = adoptLegacyRoster();
    if (!roster) throw new Error('onContinueLegacy: probe said legacy but no v3 roster was readable');
    discardSaves();
    startCampaignV2({ kind: 'fresh', seed: campSeed(), roster });
  },
  onDiscardSave: () => {
    discardSaves();
    mainMenu.setSaveProbe(probeSave());
  },
  onFieldManual: () => { manual.open(); },
});

function showContactModal(e: Engagement): void {
  const attacker = S().front.chits.find((c) => c.id === e.attackerId)!;
  const defender = S().front.chits.find((c) => c.id === e.defenderId)!;
  const cell = S().front.sector.cells[e.cell];
  const terrain = TERRAIN_LABELS[cell.terrain].toLowerCase();
  const forceCol = (c: Chit): string => {
    const cls = c.side === 'blue' ? 'us' : 'ge';
    let str = `~${c.strength} men`;
    let comp = 'enemy — composition unknown';
    if (c.companyIndex >= 0) {
      const squads = S().campaign.companies[c.companyIndex].squads.map((si) => S().campaign.squads[si]);
      const fit = squads.flatMap(squadMembers).map((pid) => S().campaign.soldiers[pid]).filter((s) => s.status !== 'kia');
      const tally = new Map<string, number>();
      for (const s of fit) tally.set(s.weapon, (tally.get(s.weapon) ?? 0) + 1);
      const weapons = [...tally].map(([w, n]) => `${n} ${WEAPONS[w as keyof typeof WEAPONS].name}`).join(' · ');
      str = `${c.strength} men`;
      comp = `${squads.length} squads · ${fit.length} fit<br>${weapons}`;
    }
    return `<div class="fc-col ${cls}"><h4>${c.name}</h4><p class="fc-str">${str}</p><p class="fc-comp">${comp}</p></div>`;
  };
  const objectives = S().front.sector.cells.filter((c) => c.objective);
  const held = objectives.filter((c) => c.owner === 'blue').length;
  const stakes = cell.objective
    ? `Objective — ${held}/${objectives.length} held toward victory`
    : 'Front cell — losing shifts the front line';
  const forced = trivialMismatchWinner(attacker, defender);
  // Standing down calls off the chit's own approach (front.step() halted it
  // with path=[]) — correct when the player IS that chit's side, but on the
  // AI-attacker-vs-player-defender path it would let the player veto every
  // attack for free while the AI re-paths its whole approach. Defenders only
  // get Attack and (when it qualifies) Auto-resolve.
  const defending = aiSides.has(attacker.side);
  showCard(`<div class="db-scroll"><div class="db">
    <h1>CONTACT</h1>
    <p class="sub">${attacker.name} has met ${defender.name}.</p>
    <div class="fc">${forceCol(attacker)}<div class="fc-vs">VS</div>${forceCol(defender)}</div>
    <p class="intel">Terrain: <b>${terrain}</b>${cell.objective ? ' <span class="obj">— objective</span>' : ''}</p>
    <p class="stakes">Stakes: ${stakes}</p>
    </div></div>
    <div class="db-actions">
      <button id="fight" class="primary">Attack</button>
      ${forced ? '<button id="autoresolve">Auto-resolve</button>' : ''}
      ${defending ? '' : '<button id="standdown">Stand down</button>'}
    </div>`, false);
  document.getElementById('fight')!.onclick = () => startEngagementBattle(e);
  if (forced) {
    document.getElementById('autoresolve')!.onclick = () => {
      const result = resolveCoarse(S().campaign, S().front, e, forced);
      S().stratView.flash(`${attacker.name} vs ${defender.name}: ${result.attackerWon ? 'attacker wins' : 'defender holds'}`);
      debriefEl.style.display = 'none';
      pendingEngagement = null;
      stratPaused = !(aiSides.has('red') && aiSides.has('blue'));
      save();
    };
  }
  if (!defending) {
    document.getElementById('standdown')!.onclick = () => {
      debriefEl.style.display = 'none';
      pendingEngagement = null;
    };
  }
}

// The HUD chrome is opaque DOM sitting on top of the canvas, so the canvas
// center is NOT the center of what the player can actually see. Measured, not
// assumed: the roster panel is ~266px of the left edge, which is exactly where
// blue spawns on a west-attack map.
function viewportInset(): { left: number; top: number; bottom: number } {
  // Zero-area rects mean the element is hidden — during strategic mode the
  // battle HUD is still in the DOM but collapsed, and a hidden bottom layer
  // would otherwise read as an 800px bottom inset and collapse the viewport
  // to nothing. Only elements that actually occupy space may inset the view.
  const box = (id: string) => {
    const r = document.getElementById(id)?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? r : null;
  };
  // The roster is a column on a desktop and on a phone in landscape, and a
  // sheet across the bottom on a phone in portrait.
  const roster = box('squads');
  const squads = roster && roster.width < view.w * 0.6 ? roster : null;
  const strip = box('obj-strip');
  // Both bottom-edge layers, whichever exists: the order bar on desktop (only
  // with a squad selected), #touchbar on a phone, which holds its own order
  // rows. Taking the max means the map the player is told about never runs
  // under whichever one is actually on screen.
  const bottoms = [box('orderbar'), box('touchbar'), squads ? null : roster].filter((r) => r !== null);
  return {
    left: squads ? squads.right : 0,
    top: strip ? strip.bottom : 0,
    bottom: bottoms.length ? Math.max(...bottoms.map((r) => view.h - r.top)) : 0,
  };
}

// The theater's counterpart: which borders of the canvas the theater HUD
// covers, measured from its blocks. On a desktop the side column takes the
// left edge and the bar the top. On a phone in portrait there is no column:
// the bar and the strip stack on top, the card and the log at the bottom. On
// a short screen the bar sits IN the column and takes nothing from the top.
function theaterInset(): ViewInset {
  const out: ViewInset = { left: 0, top: 0, right: 0, bottom: 0 };
  // A panel that is narrow and stands against the left edge is part of a side
  // column and takes width. Any other panel is a strip across the top or the
  // bottom and takes height. Asked of each panel by itself: the test used to
  // be "is the side column at least half the screen high", and on a phone on
  // its side one more line in the bar took the column under that, so every
  // panel in it was read as a strip and the map was framed into a stamp.
  for (const sel of ['.th-head', '.th-strip', '.th-force', '.th-log', '.th-contact']) {
    const r = theaterHud.root.querySelector(sel)?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) continue;
    if (r.left < 24 && r.width < view.w * 0.5) out.left = Math.max(out.left, r.right);
    else if (r.top + r.height / 2 < view.h / 2) out.top = Math.max(out.top, r.bottom);
    else out.bottom = Math.max(out.bottom, view.h - r.top);
  }
  return out;
}

const MOBILE_CAP_FRAC = 0.35;

function bootCamera(s: Sim, cw: number, ch: number): { x: number; y: number; scale: number } {
  return bootCameraFor(s.map, s.soldiers.filter((sd) => sd.side === 'blue'), cw, ch, viewportInset(), {
    // Desktop insets are borders and must keep insetting at every window
    // width; only the phone's full-width sheets are drawers worth ignoring.
    capFrac: MOBILE ? MOBILE_CAP_FRAC : undefined,
    maxScale: cam.maxScale,
    minScale: 2,
  });
}

function bootBattle(staged: { sim: Sim; commander: BattleAi; blueCommander: BattleAi; companyIndex: number }, title: string): void {
  drill = null;
  heldByStep = false;
  sim = staged.sim;
  sim.fowDisabled = fowOff;
  commander = staged.commander;
  blueCommander = staged.blueCommander;
  aiControl = false;
  battleCompany = staged.companyIndex;
  renderer = new Renderer(sim);
  barks = new Barks();
  renderer.hazeOn = !hazeOff;
  renderer.flickerOn = !flickerOff;
  battleTitle = title;
  if (MOBILE) {
    // Pinching out to the whole 320m map needs ~1.2 px/m, which the desktop
    // floor of 2 forbids; clampCenter (touch pan/pinch only) keeps the map
    // from being flung off-screen down there.
    cam.minScale = Math.min(2, Math.min(view.w / sim.map.w, view.h / sim.map.h));
    cam.maxScale = 32;
  }
  const boot = bootCamera(sim, view.w, view.h);
  cam.x = boot.x;
  cam.y = boot.y;
  cam.scale = boot.scale;
  zoomGoal = 0; // a wheel zoom still in flight belongs to the last battle's camera
  needsBootFrame = true;
  mode = 'battle';
  paused = true;
  floorFocus = -1;
  selectedSquads = [];
  selectedVehicle = -1;
  inspectedSoldier = -1;
  setTargetMode('');
  winnerAt = -1;
  debriefShown = false;
  debriefEl.style.display = 'none';
  boxRect = null;
  boxMode = false;
  addMode = false;
  pings.reset();
  highlights.reset();
  tooltip.clear();
  lastOrderTick = 0;
  battleSpeed = 1;
}

function startEngagementBattle(e: Engagement): void {
  pendingEngagement = e;
  const seed = urlSeed !== null && Number.isFinite(Number(urlSeed)) ? Number(urlSeed) : S().front.clockMin * 7919 + e.cell;
  const battle = makeStrategicBattle(S().campaign, S().front, e, seed);
  bootBattle(battle, `Day ${S().front.day} ${S().front.hhmm} — ${battle.name}`);
}

// The drill: one small fixed battle, staged from src/drill.ts. It is not part
// of any campaign, so nothing here reads or writes the session.
const urlDrill = new URLSearchParams(location.search).get('drill'); // ?drill=N boots straight into the drill on seed N (gates, screenshots)

function startDrill(seed: number): void {
  const d = makeDrill(seed);
  bootBattle({ sim: d.sim, commander: NO_COMMANDER, blueCommander: NO_COMMANDER, companyIndex: -1 }, 'Training: take the farmhouse');
  drill = { ...d, shooter: -1, asked: new WeakSet() };
  deployPhase = false;
  mainMenu.close();
  tutorial?.startDrill();
  // 'drill-start' waits for the battle HUD to exist: see needsBootFrame.
}

// The drill's conditions, asked once a frame and only while a step would act
// on the answer. Each is the sim's own state (src/drill.ts), never a clock.
function pollDrill(d: NonNullable<typeof drill>): void {
  if (!tutorial || sim.winner) return;
  // A step that waits on an order needs somebody to give it to.
  if (tutorial.step && selectedSquads.length === 0 && !tutorial.awaits('squad-selected') && !tutorial.awaits('squad-switched')) selectSquad(d.shooter >= 0 && tutorial.step.id !== 'drill-assault' ? d.shooter : d.lead);
  if (tutorial.awaits('fire-armed') && armedOrder === 'fire') tutorial.notify('fire-armed');
  if (tutorial.wants('enemy-seen') && enemiesInSight(sim).length > 0) tutorial.notify('enemy-seen');
  if (tutorial.wants('house-quiet') && houseIsQuiet(d, drillOther(d))) tutorial.notify('house-quiet');
  // A refusal while the step on screen already says to fire needs no line of
  // its own. Raised there it took the screen for one frame, gave it back to
  // "Enemy seen", and stopped a battle the player had just pressed Play on
  // (the squad sent to the hedge can refuse that march once it is shot at).
  const firing = tutorial.awaits('fire-armed') || tutorial.awaits('fire-ordered');
  if (firing || tutorial.wants('team-balked')) {
    for (const q of d.rifles) {
      if (!hasRefused(sim, q)) continue;
      const refused = sim.squads[q].teamIds.map((t) => sim.teams[t].orderState.order).find((o) => o !== null);
      if (!refused || d.asked.has(refused)) continue;
      d.asked.add(refused);
      if (firing) continue;
      tutorial.notify('team-balked');
      break;
    }
  }
}

// A campaign with nothing to set up: the preset a first battle is reliably
// winnable on (FIRST_PRESET, measured by scripts/firstcontact.mjs).
const urlWar = new URLSearchParams(location.search).get('war'); // ?war=N pins that campaign's seed, so a gate run can be replayed
function startFirstCampaign(): void {
  const seed = urlWar !== null && Number.isFinite(Number(urlWar)) && urlWar !== '' ? Number(urlWar) : campSeed();
  startCampaignV2({ kind: 'fresh', seed, theaterCfg: FIRST_PRESET.theater, campaignCfg: FIRST_PRESET.campaign });
}

function showDrillEnd(): void {
  debriefShown = true;
  const won = sim.winner === 'blue';
  const hasCampaign = probeSave().status === 'ok';
  showResultCard(drillEndHtml(won, hasCampaign ? 'Back to the menu' : 'Start the campaign'));
  const leave = (): void => {
    debriefEl.style.display = 'none';
    drill = null;
    tutorial?.endDrill();
  };
  document.getElementById('next')!.onclick = () => {
    leave();
    if (hasCampaign) openMainMenu();
    else startFirstCampaign();
  };
  document.getElementById('db-again')!.onclick = () => {
    leave();
    startDrill(campSeed());
  };
}

// ?backdrop=0 turns the menu's battle off; ?flicker=0 or a reduced-motion
// preference holds it on one frame.
const backdrop = new MenuBackdrop(
  backdropMode(new URLSearchParams(location.search).get('backdrop'), flickerOff, window.matchMedia('(prefers-reduced-motion: reduce)').matches),
);

function openMainMenu(): void {
  mode = 'menu';
  mainMenu.setSaveProbe(probeSave());
  mainMenu.open();
}

// V2: a pending theater contact becomes a fought battle.
function startTheaterBattle(c: Contact): void {
  const v2 = S().v2!;
  const b = openBattle(v2.front, c);
  const tb = makeTheaterBattle(S().campaign, v2.front, b);
  v2.battle = { b, tb };
  v2.pending = null;
  bootBattle(tb, tb.name);
  deployPhase = true;
  deployMsg = '';
  // 'deploy-start' waits for the battle HUD to exist — see needsBootFrame.
}

const MOVE_REJECT_TEXT: Record<MoveReject, string> = {
  'unknown-force': 'No such force',
  engaged: 'Engaged — they fight where they stand',
  'queued-at-defile': 'Queued at the bridge — wait for the crossing',
  'already-there': 'Already holding that ground',
  'not-moving': 'Already halted',
  'no-route': 'No road reaches there',
  'destination-unholdable': "Can't hold open water — take the bridge or the bank",
};

// The player's deploy zone in map-x: attackers own the western entry strip,
// defenders own everything past the line (kind-adjusted). AUTO-PLACED units
// are legal wherever staging put them — the zone constrains REPOSITIONING.
function deployZone(): { x0: number; x1: number } {
  const v2 = S().v2;
  const b = v2?.battle;
  if (!b) return { x0: 0, x1: sim.map.w };
  const atkF = v2!.front.forces.find((f) => f.id === b.b.attackerId)!;
  const kind = BATTLE_CLASS_TO_MAPKIND[b.tb.battleClass];
  let atkDepth = DEPLOY_ATK_DEPTH;
  let defLine = DEPLOY_DEF_LINE[kind] ?? DEPLOY_DEF_DEFAULT;
  if (deployOverride) {
    const [a, d] = deployOverride.split(',').map(Number);
    if (Number.isFinite(a)) atkDepth = a;
    if (Number.isFinite(d)) defLine = d;
  }
  return atkF.side === 'blue' ? { x0: 0, x1: atkDepth } : { x0: defLine, x1: sim.map.w };
}

function deployFlash(text: string): void {
  deployMsg = text;
  deployMsgUntil = performance.now() + 3000;
}

// The direction the deployment faces: staging already knows the attacker
// enters from the west (sim.threatAxis, set in makeStrategicBattle), so your
// enemy is east when you attack and west when you defend — known before a
// single contact exists.
function deployBearing(): number {
  return sim.threatAxis.blue;
}

// Reposition the selected squads around (wx, wy): the SAME resolver chain the
// preview runs (resolveDeployment → resolveMoveSpots), so the warp lands on
// the tiles the ghost dots promised — dug in facing the enemy, prone (ambush)
// where the ground pays prone, crouched (defend) otherwise. No rng, no
// compliance ladder: deployment is administrative. Guns refuse — emplacements
// deploy where they stand.
function deployPlace(wx: number, wy: number): void {
  const zone = deployZone();
  if (wx < zone.x0 || wx > zone.x1) {
    deployFlash('Stay inside the green zone');
    return;
  }
  if (selectedSquads.length === 0) {
    deployFlash(MOBILE ? 'Tap a squad first' : 'Click a squad first');
    return;
  }
  const squadIds: number[] = [];
  for (const id of selectedSquads) {
    const squad = sim.squads[id];
    if (!squad) continue;
    if (emplacementOf(sim, id)) {
      deployFlash(`${squad.name}: guns stay where they are`);
      continue;
    }
    squadIds.push(id);
  }
  const plans = resolveDeployment(sim, squadIds, wx, wy, zone, deployBearing());
  for (const p of plans) {
    for (const sp of p.spots) {
      const s = sim.soldiers[sp.sid];
      s.x = sp.x + 0.5;
      s.y = sp.y + 0.5;
      s.level = sp.l;
      s.path = null;
    }
    // Direct write, not orderTeam: the ladder must not balk a pre-battle
    // reposition, and stanceOf derives crouch/prone from this order state —
    // without it every deployed man stands.
    sim.teams[p.teamId].orderState = { order: { kind: p.kind, x: p.x, y: p.y, arc: p.arc, l: p.level }, phase: 'executing', reason: '' };
  }
  for (const id of squadIds) {
    sim.squadWaypoints[id] = [];
    sim.squadDest[id] = null;
  }
}

// V2 contact modal (OQ2 pin+queue: the theater is paused by the caller; the
// defender path NEVER offers Stand down — an AI attack cannot be vetoed).
// One strategic minute of the V2 war — the SAME body the frame loop and the
// OQ3 debrief catch-up run, so a fought battle and a coarse battle cost the
// theater identically and every event lands in the ring either way. Sets
// v2.pending + pauses on a player contact; the CALLER decides when the modal
// is safe to show (the debrief queues it behind its own overlay).
function stepTheaterMinuteV2(v2: SessionV2): void {
  v2.red.evaluate(v2.front, v2.redIntel);
  const r = stepWar(v2.front, S().campaign, {
    autoBattle: () => false,
    supply: v2.campaignCfg.supply,
    recon: v2.campaignCfg.recon,
    nightTempo: v2.campaignCfg.nightTempo,
  });
  if (v2.front.day > prevDay) {
    advanceDays(S().campaign, v2.front.day - prevDay);
    if (v2.front.day % REINFORCE_CYCLE_DAYS === 0) {
      // The cycle no longer fills by itself: it raises a choice, and the
      // clock holds until the player has made it (showRequisitionV2).
      v2.front.requisition = { barrageUntilDay: 0, ...v2.front.requisition, due: true };
      stratPaused = true;
    }
    syncStrengthsV2(S().campaign, v2.front);
    prevDay = v2.front.day;
    save();
  }
  for (const c of r.pendingContacts) {
    // OQ2 pin+queue: contact pauses the theater; the modal owns the
    // player's answer. One at a time — the rest re-detect next minute.
    v2.pending = c;
    stratPaused = true;
    break;
  }
}

// The contact decision. A card in the theater HUD, not a screen over it: the
// map stays up and is centred on the fight, because where the fight is, what
// stands near it and what ground it is on are the decision.
// The requisition sheet: one card in place of the even fill. It shares the
// contact card's panel, so it is a side card on a desktop and a bottom sheet
// on a phone. Cards that go to a company go to the one picked in the row.
function showRequisitionV2(forceId = -1): void {
  const v2 = S().v2!;
  const fog = v2.campaignCfg.recon === 'contacts';
  const companies = v2.front.forces.filter((f) => f.side === 'blue' && f.strength > 0);
  const chosen = companies.find((f) => f.id === forceId) ?? companies.find((f) => f.id === v2.selectedForce) ?? companies[0];
  const cards = requisitionOffer(v2.front, S().campaign, chosen?.id ?? -1, fog);
  theaterHud.showContact(`
    <h1>REQUISITION <span class="fc-place">Day ${v2.front.day}</span></h1>
    <p class="fc-kind" id="req">Pick one.</p>
    ${companies.length > 0 ? `<div class="rq-for">${companies.map((f) => `<button class="hbtn rq-co${f === chosen ? ' active' : ''}" data-co="${f.id}">${f.name}</button>`).join('')}</div>` : ''}
    <div class="rq-cards">${cards
      .map((o) => `<button class="hbtn rq-card" data-card="${o.id}"${o.blocked ? ' disabled' : ''}><i>${o.glyph}</i><b>${o.name}</b><span>${o.blocked ?? o.effect}</span></button>`)
      .join('')}</div>`);
  theaterHud.contact.querySelectorAll<HTMLElement>('[data-co]').forEach((b) => {
    b.onclick = () => showRequisitionV2(Number(b.dataset.co));
  });
  theaterHud.contact.querySelectorAll<HTMLElement>('[data-card]').forEach((b) => {
    b.onclick = () => {
      const r = applyRequisition(v2.front, S().campaign, b.dataset.card as RequisitionCard, chosen?.id ?? -1, fog);
      if (!r.ok) return v2.view.flash(r.reason);
      syncStrengthsV2(S().campaign, v2.front);
      v2.view.flash(r.text);
      pushEvent(v2.front, { min: v2.front.clockMin, kind: 'replacements', text: r.text, forceIds: chosen ? [chosen.id] : [] });
      theaterHud.hideContact();
      save();
    };
  });
}

function showContactModalV2(c: Contact): void {
  const v2 = S().v2!;
  const atk = v2.front.forces.find((f) => f.id === c.attackerId)!;
  const def = v2.front.forces.find((f) => f.id === c.defenderId)!;
  const b = contactBrief(v2.front, c, { supply: v2.campaignCfg.supply, fog: v2.campaignCfg.recon === 'contacts', nightTempo: v2.campaignCfg.nightTempo });
  const { playerAttacks, trivial } = b;
  const col = (s: (typeof b.sides)[number]): string =>
    `<div class="fc-col ${s.side === 'blue' ? 'us' : 'ge'}"><h4>${s.name}</h4><p class="fc-str">${s.men}</p><p class="fc-state">${s.state}</p></div>`;
  theaterHud.showContact(`
    <h1>CONTACT <span class="fc-place">${b.title}</span></h1>
    <p class="fc-kind">${b.kind}</p>
    <div class="fc">${col(b.sides[0])}<div class="fc-vs">VS</div>${col(b.sides[1])}</div>
    <p class="fc-odds">${b.odds}</p>
    ${b.forced ? `<p class="fc-odds fc-forced">${b.forced}</p>` : ''}
    <p class="fc-facts">${b.facts.join(' ')}</p>
    <div class="fc-actions">
      <button id="fight" class="hbtn primary">${playerAttacks ? 'Attack' : 'Defend'}</button>
      ${trivial ? '<button id="autoresolve" class="hbtn">Auto-resolve</button>' : ''}
      ${playerAttacks ? '<button id="standdown" class="hbtn">Stand down</button>' : ''}
    </div>`);
  v2.selectedForce = -1;
  v2.centerNext = c.site.kind === 'node' ? v2.front.theater.nodes[c.site.nodeId].pos : v2.view.forceXY(def);
  const close = (): void => {
    theaterHud.hideContact();
    tutorial?.notify('contact-closed');
  };
  document.getElementById('fight')!.onclick = () => {
    close();
    startTheaterBattle(c);
  };
  if (trivial) {
    document.getElementById('autoresolve')!.onclick = () => {
      // OQ3 honesty: an accepted walkover is a TIMED battle like any other —
      // openBattle pins both forces and the war clock resolves it (trivial =
      // 15 min) with the forced winner. Resolving it here instantly would
      // make Auto-resolve FREE while fighting costs catch-up time — the
      // exact dominance OQ3 exists to kill, mirrored.
      openBattle(v2.front, c);
      v2.view.flash(`${atk.name} engages ${def.name} — outcome shortly`);
      v2.pending = null;
      close();
      save();
    };
  }
  if (playerAttacks) {
    document.getElementById('standdown')!.onclick = () => {
      // Breaking contact is a MOVE, not a wish: a force left halted inside
      // CONTACT_M re-contacts every minute and the modal never stops. The
      // §3.6 retreat parks it beyond threat range; trapped = hold (a
      // voluntary order never annihilates its own force).
      retreatForce(v2.front, atk, null, { trapped: 'stay' });
      v2.pending = null;
      save();
      close();
    };
  }
  tutorial?.notify('contact-open');
}

function debriefRows(): string {
  const deployedPids = new Set(sim.soldiers.filter((s) => s.side === 'blue').map((s) => s.pid));
  return S().campaign.companies[battleCompany].squads
    .map((si) => S().campaign.squads[si])
    .map((sq) => {
      const men = squadMembers(sq)
        .map((pid) => S().campaign.soldiers[pid])
        .map((cs) => {
          const scars = cs.bodyDamage.some((d) => d > 0) && cs.status === 'fit' ? ' <span class="scar">permanent injury</span>' : '';
          const deployed = deployedPids.has(cs.pid);
          const st = cs.status === 'kia' ? 'KIA' : cs.status === 'recovering' ? `recovering (${cs.recoveryDays}d)` : deployed ? 'fit' : 'reserve';
          const cls = cs.status === 'kia' ? ' class="kia"' : cs.status === 'recovering' ? ' class="rec"' : deployed ? '' : ' class="res"';
          return `<tr${cls}><td>${cs.name}</td><td>${WEAPONS[cs.weapon].name}</td><td>${cs.battles}</td><td>${st}${scars}</td></tr>`;
        })
        .join('');
      return `<h3>${sq.name}</h3><table><tr><th>NAME</th><th>WEAPON</th><th>BATTLES</th><th>STATUS</th></tr>${men}</table>`;
    })
    .join('');
}

// Every card in #debrief comes through here. `overBattle`: a card over the
// battlefield the player just fought on (ui.css, #debrief.over-battle), where
// the others are a page of their own.
function showCard(html: string, overBattle: boolean): void {
  debriefEl.innerHTML = html;
  debriefEl.classList.toggle('over-battle', overBattle);
  debriefEl.style.display = 'flex';
}

// A battle's result, over the battle. The fight stops where it ended, so the
// ground, the smoke and the bodies are still there behind the card, and the
// HUD and the selection step aside (frame() hides the HUD while debriefShown).
function showResultCard(html: string): void {
  paused = true;
  selectedSquads = [];
  selectedTeam = -1;
  selectedVehicle = -1;
  renderer.selectedVehicle = -1;
  armedOrder = null;
  setTargetMode('');
  inspectedSoldier = -1;
  tooltip.clear();
  showCard(html, true);
}

// The result first, the roster on request: a company's full table is 150 rows.
function renderDebrief(record: BattleRecord, redLosses: number, groundLine: string, onNext: () => void): void {
  showResultCard(debriefHtml(
    { won: record.won, outcome: groundLine, kia: record.kia, wounded: record.wounded.length, enemyLosses: redLosses, highlights: highlights.top() },
    [{ id: 'next', label: 'Return to the front', primary: true }, { id: 'db-show-roster', label: 'Show roster' }],
  ));
  document.getElementById('next')!.onclick = onNext;
  const toggle = document.getElementById('db-show-roster')!;
  toggle.onclick = () => {
    const mount = document.getElementById('db-roster')!;
    const open = mount.innerHTML === '';
    mount.innerHTML = open ? debriefRows() : '';
    toggle.textContent = open ? 'Hide roster' : 'Show roster';
    if (open) mount.scrollIntoView({ block: 'start' });
  };
}

function showDebrief(): void {
  debriefShown = true;
  const v2 = S().v2;
  if (v2?.battle) {
    const { b, tb } = v2.battle;
    const atk = v2.front.forces.find((f) => f.id === b.attackerId)!;
    const blueAttacked = atk.side === 'blue';
    const out = applyTheaterOutcome(S().campaign, v2.front, b, tb.battleClass, sim);
    v2.battle = null;
    v2.pending = null;
    pendingEngagement = null;
    // OQ3 (B): the fight cost theater time. Step the same bounded duration
    // the coarse resolver would have charged (≤ 240 min) through the SAME
    // per-minute body the live tick runs — the rest of the front marches,
    // battles resolve, and every event reaches the ring. A new player
    // contact stops the catch-up; its modal queues behind the debrief.
    const catchUp = battleCatchUpMin(b);
    for (let i = 0; i < catchUp && !v2.pending && !opEnded; i++) {
      stepTheaterMinuteV2(v2);
      // A war decided mid-catch-up ENDS there. Stepping on could ERASE the
      // decision — control goals re-evaluate, so red retaking one objective
      // at minute 200 would silently undo the win the player just fought
      // for at minute 10.
      if (warStatus(v2.front, v2.goals).state === 'decided') break;
    }
    save();
    const groundLine = out.nodeTaken !== null
      ? blueAttacked ? 'The ground is ours.' : 'The position is lost.'
      : blueAttacked ? 'The attack failed; the line is unchanged.' : 'The line held.';
    renderDebrief(out.record, out.redLosses, groundLine, () => {
      debriefEl.style.display = 'none';
      mode = 'strategic';
      stratPaused = true;
      inspectedSoldier = -1;
      tooltip.clear();
      tutorial?.notify('debrief-closed');
      // The frame loop's warStatus check only runs UNPAUSED — a war the
      // battle (or its catch-up) decided must not hide behind the pause.
      const st = warStatus(v2.front, v2.goals);
      if (st.state === 'decided') {
        showOperationEnd(st.winner === 'blue' ? 'won' : 'lost');
        return;
      }
      if (v2.pending) showContactModalV2(v2.pending);
    });
    tutorial?.notify('debrief-open');
    return;
  }
  const e = pendingEngagement;
  if (!e) throw new Error('showDebrief: pendingEngagement is null — startEngagementBattle must set it');
  const blueAttacked = S().front.chits.find((ch) => ch.id === e.attackerId)!.side === 'blue';
  const out = applyEngagementOutcome(S().campaign, S().front, e, sim);
  pendingEngagement = null;
  save();

  const groundLine = out.cellTaken
    ? blueAttacked ? 'The ground is ours.' : 'The position is lost.'
    : blueAttacked ? 'The attack failed; the line is unchanged.' : 'The line held.';
  renderDebrief(out.record, out.redLosses, groundLine, () => {
    debriefEl.style.display = 'none';
    mode = 'strategic';
    stratPaused = !(aiSides.has('red') && aiSides.has('blue'));
    inspectedSoldier = -1;
    tooltip.clear();
  });
}

// On a phone the fit-only sector layout solves to ~9px cells — unreadable and
// untappable. Zoom until a chit is a real target and centre on the friendly
// chits; desktop keeps the fit-only defaults.
function frameStrategic(): void {
  if (S().v2) return; // the theater view fits itself
  if (!MOBILE) return;
  S().stratView.frameFor(view.w, view.h, S().front.chits.filter((c) => c.side === 'blue' && c.strength > 0).map((c) => c.cell));
}

function startCampaign(load: { campaign: Campaign; front: Front } | null, seedOverride?: number): void {
  // The PINNED path stays the V1 grid war — the entire art/battle harness
  // stages through it (?camp=42, stage.mjs). Menu campaigns are V2.
  const cg = load ? load.campaign : newCampaign(seedOverride ?? campSeed());
  const fr = load ? load.front : newFront(cg, makeDefaultSector());
  if (urlHourMin !== null) fr.clockMin = urlHourMin;
  session = { campaign: cg, front: fr, stratView: new StrategicView(fr.sector), v2: null };
  mode = 'strategic';
  mainMenu.close();
  frameStrategic();
  selectedChit = -1;
  pendingEngagement = null;
  opEnded = false;
  prevDay = fr.day;
  stratPaused = true;
  stratAcc = 0;
  if (!load) save();
  buildCommanders();
}

function bootError(message: string): void {
  console.error(message);
  let el = document.getElementById('boot-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'boot-error';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.display = 'block';
}

// The V2 campaign: procedural theater, disposition, goal-driven red.
function startCampaignV2(
  source:
    | { kind: 'fresh'; seed: number; theaterCfg?: TheaterConfig; campaignCfg?: CampaignConfig; roster?: Campaign }
    | { kind: 'loaded'; seed: number; theaterCfg: TheaterConfig; campaignCfg: CampaignConfig; campaign: Campaign; front: FrontV2; ai?: AiSave },
): void {
  const theaterCfg = source.kind === 'fresh' ? source.theaterCfg ?? DEFAULT_PRESET.theater : source.theaterCfg;
  const camp = source.kind === 'fresh' ? source.campaignCfg ?? DEFAULT_PRESET.campaign : source.campaignCfg;
  try {
    let campaign: Campaign;
    let front: FrontV2;
    let seed: number;
    if (source.kind === 'loaded') {
      ({ seed, campaign, front } = source);
    } else {
      seed = source.seed;
      const { theater, initialControlByNode } = makeTheater(seed, theaterCfg);
      campaign = source.roster ?? newCampaign(seed, camp.blueCompanies);
      const spec = presetSpec(DEFAULT_PRESET, seed);
      spec.theater = { ...theaterCfg };
      spec.campaign = { ...camp };
      const d = makeDisposition(theater, camp, campaign, initialControlByNode, specStream(spec, SPEC_TAG.DISPOSITION));
      front = {
        theater,
        clockMin: 360,
        day: 1,
        nextForceId: 0,
        nextBattleId: 0,
        forces: [],
        controlByNode: [...initialControlByNode],
        battles: [],
        events: [],
        defileQueues: {},
      };
      for (const f of d.forces) addForce(front, f);
    }
    const goals = makeWarGoals(front.theater, camp);
    session = {
      campaign,
      front: v1Trap<Front>('front'),
      stratView: v1Trap<StrategicView>('stratView'),
      v2: {
        seed,
        theaterCfg,
        campaignCfg: camp,
        front,
        goals,
        red: new Commander2('red', RED_V2, goals, camp.warDays, { nightTempo: camp.nightTempo, fog: camp.recon === 'contacts' }),
        // OQ6 (A): identical fog and detection — red reads ghosts when the
        // campaign runs contacts, exactly as the player's map does.
        redIntel: camp.recon === 'contacts' ? new ContactIntel(front, 'red') : new OmniscientIntel(front, 'red'),
        view: Object.assign(new TheaterView(front.theater), { supplyOn: camp.supply, recon: camp.recon }),
        battle: null,
        pending: null,
        selectedForce: -1,
        needsFrame: true,
        centerNext: null,
        shownForce: -1,
      },
    };
    // §4.8: a reloaded red keeps its axes — restore the persisted plan.
    // Missing field (a save written before persistence) = fresh commander,
    // which replans on its next eval exactly as before.
    if (source.kind === 'loaded' && source.ai?.red) {
      session.v2!.red.plan = source.ai.red.plan;
      session.v2!.red.lastEvalMin = source.ai.red.lastEvalMin ?? -Infinity;
    }
    mode = 'strategic';
    mainMenu.close();
    selectedChit = -1;
    pendingEngagement = null;
    opEnded = false;
    prevDay = front.day;
    stratPaused = true;
    stratAcc = 0;
    if (source.kind === 'fresh') save();
    // One frame late on purpose: the theater HUD the resumed steps anchor to
    // is built by the first strategic frame, which has not run yet.
    requestAnimationFrame(() => tutorial?.notify('campaign-start'));
  } catch (e) {
    // Generation and disposition rejects surface VISIBLY and leave the menu
    // up — never a silent fallback theater.
    if (e instanceof TheaterGenError || e instanceof DispositionError) {
      bootError(`Campaign generation failed: ${e.message}`);
      mainMenu.open();
      return;
    }
    throw e;
  }
}

function showOperationEnd(status: 'won' | 'lost'): void {
  opEnded = true;
  const sess = S();
  const day = sess.v2 ? sess.v2.front.day : sess.front.day;
  const kia = Object.values(S().campaign.soldiers).filter((s) => s.status === 'kia').length;
  // A win is graded (result.ts): the grade, then the numbers that decided it.
  // A loss says how far it got. Neither changes who won.
  const v2 = sess.v2;
  const grade = v2 && status === 'won' ? resultOfWin(v2.front, sess.campaign, v2.campaignCfg.warDays) : null;
  const held = v2 ? v2.front.theater.objectiveNodes.filter((n) => v2.front.controlByNode[n] === 'blue').length : 0;
  const verdict = grade
    ? `<p class="db-tier db-tier-${grade.tier}">${grade.title}</p><p class="sub">${grade.why}</p>`
    : v2
      ? `<p class="sub">${held} of ${v2.front.theater.objectiveNodes.length} objectives held on Day ${day}.</p>`
      : '';
  showCard(`<div class="db-scroll"><div class="db">
    <h1 class="${status === 'won' ? 'win' : 'loss'}">OPERATION ${status === 'won' ? 'ACCOMPLISHED' : 'FAILED'}</h1>
    ${verdict}
    <p class="sub">${grade ? `${S().campaign.log.length} battles fought.` : `${S().campaign.log.length} battles fought over ${day} days · ${kia} men killed.`}</p>
    </div></div>
    <div class="db-actions"><button id="next" class="primary">Main menu</button><button id="same">Same theater again</button></div>`, false);
  document.getElementById('next')!.onclick = () => {
    debriefEl.style.display = 'none';
    openMainMenu();
  };
  document.getElementById('same')!.onclick = () => {
    debriefEl.style.display = 'none';
    const v2 = S().v2;
    if (v2) startCampaignV2({ kind: 'fresh', seed: v2.seed, theaterCfg: v2.theaterCfg, campaignCfg: v2.campaignCfg });
    else startCampaign(null, S().campaign.seed);
  };
}

let dragStart: { x: number; y: number } | null = null;
let dragged = false;
let boxRect: { x: number; y: number; w: number; h: number } | null = null;
let rmbDown = false;
let rmbAnchor: { sx: number; sy: number; wx: number; wy: number } | null = null;

// ── Input intents ─────────────────────────────────────────────────────────
// The bodies below used to live inline in the mouse listeners. They are named
// so the touch layer (src/ui/touch.ts) drives the same state machine instead
// of forking it — `additive`/`squadForce`/`floors` are the modifier keys the
// desktop path still passes verbatim.

function beginBox(sx: number, sy: number): void {
  dragStart = { x: sx, y: sy };
  dragged = false;
  boxRect = null;
}

function updateBox(sx: number, sy: number): void {
  if (!dragStart) return;
  const dx = sx - dragStart.x;
  const dy = sy - dragStart.y;
  if (dragged || Math.hypot(dx, dy) > 5) {
    if (!dragged) { dragged = true; boxRect = null; }
    const x0 = dragStart.x;
    const y0 = dragStart.y;
    boxRect = { x: Math.min(x0, sx), y: Math.min(y0, sy), w: Math.abs(sx - x0), h: Math.abs(sy - y0) };
  }
}

function commitBox(additive: boolean): void {
  if (!boxRect) return;
  const [wx0, wy0] = cam.screenToWorld(boxRect.x, boxRect.y, view.w, view.h);
  const [wx1, wy1] = cam.screenToWorld(boxRect.x + boxRect.w, boxRect.y + boxRect.h, view.w, view.h);
  const minX = Math.min(wx0, wx1), maxX = Math.max(wx0, wx1);
  const minY = Math.min(wy0, wy1), maxY = Math.max(wy0, wy1);
  const found: number[] = [];
  for (const sq of infantrySquads(sim)) {
    const any = sq.soldierIds.some((id) => {
      const s = sim.soldiers[id];
      return s.alive && !s.downed && s.inVehicle < 0 && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
    });
    if (any) found.push(sq.id);
  }
  if (additive) {
    for (const id of found) { if (!selectedSquads.includes(id)) selectedSquads.push(id); }
  } else {
    selectedSquads = found;
  }
  selectedTeam = -1;
  dragStart = null;
  boxRect = null;
  noteSelection();
}

// Every order to a squad comes through here once, whichever gesture gave it:
// the acknowledge sound, the quiet-minute clock and the tutorial all hang on it.
function noteOrder(kind: OrderKind): void {
  audio.uiOrder();
  lastOrderTick = sim.tick;
  tutorial?.notify('order-issued');
  if (kind === 'fire') {
    if (drill) drill.shooter = getPrimary();
    tutorial?.notify('fire-ordered');
  } else if (kind === 'assault') tutorial?.notify('assault-ordered');
}

function tapSelect(sx: number, sy: number, additive: boolean): void {
  const [wx, wy] = cam.screenToWorld(sx, sy, view.w, view.h);
  if (targetMode) lastOrderTick = sim.tick;
  if (targetMode === 'barrage' && !aiControl) {
    if (sim.callBarrage('blue', wx, wy)) {
      setTargetMode('');
      renderer.markBarrage(wx, wy);
    }
  } else if (targetMode === 'air' && !aiControl) {
    if (sim.callAirstrike('blue', wx, wy)) {
      setTargetMode('');
      renderer.markStrafe(wx, wy);
    }
  } else if (targetMode === 'wheel') {
    const e = emplacementOf(sim, getPrimary());
    if (e) sim.orderWheel(e.id, wx, wy);
    setTargetMode('');
  } else if (targetMode === 'empfire') {
    const e = emplacementOf(sim, getPrimary());
    if (e) sim.orderFire(e.id, wx, wy);
    setTargetMode('');
  } else if (targetMode === 'empsmoke') {
    const e = emplacementOf(sim, getPrimary());
    if (e) sim.orderSmoke(e.id, wx, wy);
    setTargetMode('');
  } else if (targetMode === 'breach') {
    orderBreach(wx, wy);
    setTargetMode('');
  } else {
    // vehicles first, then emplacement glyphs, then soldiers
    let vehicle = -1;
    for (const v of sim.vehicles) {
      if (v.alive && v.side === 'blue' && Math.hypot(v.x - wx, v.y - wy) < 3.5) vehicle = v.id;
    }
    if (vehicle >= 0) {
      selectVehicle(vehicle);
    } else {
      let empSquad = -1;
      for (const e of sim.emplacements) {
        if (e.side === 'blue' && Math.hypot(e.x - wx, e.y - wy) < 2.5) empSquad = sim.teams[e.crewTeamId].squadId;
      }
      if (empSquad >= 0) {
        if (additive) toggleSquadSelection(empSquad);
        else selectSquad(empSquad);
      } else {
        let best: Soldier | null = null;
        let bestD = 15 / cam.scale;
        for (const s of sim.soldiers) {
          if (!s.alive || s.side !== 'blue' || s.inVehicle >= 0) continue;
          const d = Math.hypot(s.x - wx, s.y - wy);
          if (d < bestD || (d === bestD && best !== null && s.level > best.level)) {
            bestD = d;
            best = s;
          }
        }
        if (best && best.squadId === getPrimary() && selectedSquads.length === 1) {
          // Third rung: his team is already the narrowed one, so the click can
          // only mean "show me this man".
          if (selectedTeam === best.teamId) {
            inspectedSoldier = best.id;
          } else {
            selectedTeam = best.teamId;
            lastTeamId = best.teamId;
          }
        } else if (best) {
          if (additive) toggleSquadSelection(best.squadId);
          else selectSquad(best.squadId);
        } else if (!additive) {
          selectSquad(-1);
        }
      }
    }
  }
}

// D5: point the current selection's gun at a wall. Precedence mirrors
// tapSelect's own pick order — the vehicle, then the crew-served gun, then the
// squad's own AT men — so "what is selected" answers "who takes the shot"
// exactly once, in one place. Each sim call re-checks that its firer can
// actually do it and returns null otherwise, so a mis-click is a no-op.
function orderBreach(wx: number, wy: number): void {
  if (selectedVehicle >= 0) {
    sim.orderVehicleBreach(selectedVehicle, wx, wy);
    return;
  }
  const emp = emplacementOf(sim, getPrimary());
  if (emp) {
    sim.orderEmplacementBreach(emp.id, wx, wy);
    return;
  }
  if (selectedTeam >= 0) sim.orderTeamBreach(selectedTeam, wx, wy);
  else if (getPrimary() >= 0) sim.orderSquadBreach(getPrimary(), wx, wy);
}

function beginOrderAnchor(sx: number, sy: number): void {
  rmbDown = true;
  const [wx, wy] = cam.screenToWorld(sx, sy, view.w, view.h);
  rmbAnchor = { sx, sy, wx, wy };
}

// The plain right-click: every selected squad, clumped round the click point
// (squadClumpOffsets — the long line is the right-drag's job), narrowed to one
// team only where commitOrder's rule says so. The floor menu issues through
// here too (with `l` set), so "which units move" is one rule shared by both
// paths — and the same one previewMoveSpots mirrors. One `used` set spans the
// whole commit so clumped squads never resolve two men onto one tile.
function issueShortClick(wx: number, wy: number, squadForce: boolean, l?: number): void {
  const K = selectedSquads.length;
  // EVERY armed kind issues — MOVE_FAMILY is the formation-capability list,
  // not an issuability gate. Reusing it here silently turned an armed Smoke or
  // Fire into a plain move (the men walked to the point they should have
  // screened) from M4b until now.
  const kind: OrderKind = armedOrder ?? 'move';
  const formation = armedOrder === null || MOVE_FAMILY.includes(armedOrder);
  // The clump spreads squads so they do not pile onto one tile — right for a
  // DESTINATION, wrong for a TARGET. For smoke and fire the order point is the
  // aim point (deploySmoke throws at order.x±1 and range-checks 30 m from the
  // team; area fire suppresses there), so displacing squad i by ~10·√i m would
  // scatter one call across three places and could balk the far squads as
  // out of range. Point tools aim exactly where the player clicked.
  const offs = formation ? squadClumpOffsets(K) : null;
  const used = new Set<number>();
  const primary = getPrimary();
  for (let i = 0; i < K; i++) {
    const id = selectedSquads[i];
    const order: TeamOrder = { kind, x: wx + (offs?.[i][0] ?? 0), y: wy + (offs?.[i][1] ?? 0), l };
    // A formation kind orders the whole squad; a point tool (smoke, fire)
    // respects team narrowing — one team's smoke charge, not the squad's.
    if ((armedOrder !== null && formation) || squadForce) {
      sim.orderSquad(id, order, used);
    } else if (selectedTeam >= 0 && id === primary) {
      sim.orderTeam(selectedTeam, order, used);
    } else {
      sim.orderSquad(id, order, used);
    }
  }
  if (K > 0) noteOrder(kind);
}

function commitOrder(sx: number, sy: number, opts: { squadForce: boolean; floors: boolean }): void {
  if (!rmbAnchor) return;
  if (mode === 'strategic') {
    rmbAnchor = null;
    return;
  }
  if (targetMode !== '') { rmbAnchor = null; return; }
  if (aiControl) { rmbAnchor = null; return; }
  const [wx, wy] = cam.screenToWorld(sx, sy, view.w, view.h);
  if (deployPhase) {
    deployPlace(wx, wy);
    rmbAnchor = null;
    return;
  }
  // A point tool aims; it never picks a floor. Checked BEFORE the floor menu,
  // or arming Smoke and clicking a two-storey building opens the floor picker
  // instead of throwing the grenade.
  if (armedOrder && !MOVE_FAMILY.includes(armedOrder) && selectedSquads.length > 0) {
    issueShortClick(wx, wy, opts.squadForce);
    armedOrder = null;
    rmbAnchor = null;
    return;
  }
  if (opts.floors && selectedSquads.length > 0 && sim.map.storiesAt(Math.floor(wx), Math.floor(wy)) >= 2) {
    floorMenu = { wx, wy, level: null };
    showFloorMenu(document.body, sim, wx, wy, sx, sy, {
      pick: (level) => {
        issueShortClick(wx, wy, opts.squadForce, level);
        armedOrder = null;
      },
      hover: (level) => { if (floorMenu) floorMenu.level = level; },
      close: () => { floorMenu = null; },
    });
    rmbAnchor = null;
    return;
  }
  const wdx = wx - rmbAnchor.wx;
  const wdy = wy - rmbAnchor.wy;
  const len = Math.hypot(wdx, wdy);
  const K = selectedSquads.length;

  if (selectedVehicle >= 0) {
    audio.uiOrder();
    sim.orderVehicleMove(selectedVehicle, wx, wy);
    lastOrderTick = sim.tick;
    rmbAnchor = null;
    return;
  }

  if (K === 0) { rmbAnchor = null; return; }

  // Move-family kinds that support formation orders (shared with the preview)
  const useArmed = armedOrder !== null && MOVE_FAMILY.includes(armedOrder);
  const kind: OrderKind = useArmed ? armedOrder! : 'move';

  if (len < 2) {
    issueShortClick(wx, wy, opts.squadForce);
    if (useArmed) armedOrder = null;
  } else {
    // Right-drag: formation order
    const facing = Math.atan2(wdy, wdx);
    const width = Math.max(3, Math.min(60, len));
    const seg = width / K;
    const offs = fanOffsets(K, seg);
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const used = new Set<number>();
    for (let i = 0; i < K; i++) {
      const id = selectedSquads[i];
      const ax = rmbAnchor.wx + cos * offs[i];
      const ay = rmbAnchor.wy + sin * offs[i];
      const order: TeamOrder = { kind, x: ax, y: ay, facing, width: seg };
      sim.orderSquad(id, order, used);
    }
    noteOrder(kind);
    if (useArmed) armedOrder = null;
  }

  rmbAnchor = null;
}

function stratTapSelect(sx: number, sy: number): void {
  const v2 = S().v2;
  if (v2) {
    if (v2.pending) return; // a contact waits for its answer: the map is for looking
    v2.selectedForce = v2.view.forceAtScreen(v2.front, 'blue', sx, sy, view.w, view.h);
    if (v2.selectedForce >= 0) tutorial?.notify('force-selected');
    return;
  }
  const cell = S().stratView.cellAtScreen(sx, sy, view.w, view.h);
  const chit = cell >= 0 ? S().front.chitAt(cell, 'blue') : undefined;
  selectedChit = chit ? chit.id : -1;
}

// The march the player is pointing at: the cursor on desktop, the held finger
// on touch. Asked of previewMove, so what is drawn is what the order will do.
// Cached per minute: the ETA is a shadow march, and the pointer sits still
// for many frames.
let stratHoldAt: { x: number; y: number } | null = null;
let previewKey = '';
let previewCached: MarchPreview | null = null;
function theaterPreview(v2: SessionV2): MarchPreview | null {
  const at = stratHoldAt ?? (mouse.onCanvas && !stratDrag?.panning ? mouse : null);
  if (!at || v2.selectedForce < 0 || v2.pending || menu.isOpen) return null;
  const n = v2.view.nodeAtScreen(at.x, at.y, view.w, view.h);
  if (n < 0) return null;
  const f = v2.front.forces.find((x) => x.id === v2.selectedForce);
  const key = `${v2.selectedForce}:${n}:${v2.front.clockMin}:${f?.path.join(',')}`;
  if (key !== previewKey) {
    previewKey = key;
    const p = previewMove(v2.front, v2.selectedForce, n, { nightTempo: v2.campaignCfg.nightTempo });
    // What the player knows of the enemy: last-seen reports under fog, the
    // forces themselves otherwise.
    const enemies = v2.campaignCfg.recon === 'contacts'
      ? (v2.front.intel?.blue ?? []).map((c) => c.pos)
      : v2.front.forces.filter((x) => x.side === 'red' && x.strength > 0).map((x) => x.pos);
    previewCached = !p.ok
      ? p.reason === 'already-there' ? null : { ok: false, nodeId: n }
      : { ok: true, pos: p.pos, path: p.path, etaMin: p.etaMin, contact: f ? firstContactOnMarch(v2.front, f, p, enemies, { nightTempo: v2.campaignCfg.nightTempo }) : null };
  }
  return previewCached;
}

function stratOrderMove(sx: number, sy: number): void {
  const v2 = S().v2;
  if (v2) {
    if (v2.selectedForce < 0 || v2.pending) return;
    const n = v2.view.nodeAtScreen(sx, sy, view.w, view.h);
    if (n < 0) return;
    const r = orderMove(v2.front, v2.selectedForce, n, { nightTempo: v2.campaignCfg.nightTempo });
    if (!r.ok) v2.view.flash(MOVE_REJECT_TEXT[r.reason]);
    else {
      v2.view.flash(`${v2.front.forces.find((f) => f.id === v2.selectedForce)!.name} moving — ETA ${fmtEta(r.etaMin)}`);
      tutorial?.notify('move-ordered');
    }
    return;
  }
  if (selectedChit < 0) return;
  const cell = S().stratView.cellAtScreen(sx, sy, view.w, view.h);
  if (cell >= 0 && !S().front.orderMove(selectedChit, cell) && S().front.sector.cells[cell].terrain === 'river')
    S().stratView.flash("Can't hold open water — ford across to the far bank");
}

/** Esc's cancel ladder: targetMode → inspect → armedOrder → selection modes → team → selection (squads or a vehicle). */
function escapeLadder(): boolean {
  if (mode === 'strategic') {
    const v2 = S().v2;
    if (v2) {
      if (v2.selectedForce >= 0) { v2.selectedForce = -1; return true; }
      return false;
    }
    if (selectedChit >= 0) { selectedChit = -1; return true; }
    return false;
  }
  // targetMode first: an armed barrage/airstrike cursor is the hazardous
  // state — Esc must never leave it live while merely closing a panel.
  if (targetMode) { setTargetMode(''); return true; }
  if (inspectedSoldier >= 0) { inspectedSoldier = -1; return true; }
  if (armedOrder) { armedOrder = null; return true; }
  if (boxMode || addMode) { boxMode = false; addMode = false; boxRect = null; return true; }
  if (selectedTeam >= 0) { selectedTeam = -1; return true; }
  if (selectedSquads.length > 0) { selectSquad(-1); return true; }
  if (selectedVehicle >= 0) { selectVehicle(-1); return true; }
  return false;
}

// Theater drag-pan: a left press that travels past the slop is a pan, and its
// release does not select.
const STRAT_DRAG_SLOP = 4;
let stratDrag: { x: number; y: number; panning: boolean } | null = null;
canvas.addEventListener('mousedown', (e) => {
  if (mode === 'menu') return;
  if (e.button === 0 && mode === 'strategic' && S().v2) stratDrag = { x: e.clientX, y: e.clientY, panning: false };
  if (e.button === 0) beginBox(e.clientX, e.clientY);
  if (e.button === 2) beginOrderAnchor(e.clientX, e.clientY);
});
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.onCanvas = e.target === canvas;
  trackAlt(e);
  if (stratDrag && e.buttons & 1 && mode === 'strategic') {
    const v2 = S().v2;
    if (!stratDrag.panning && Math.hypot(e.clientX - stratDrag.x, e.clientY - stratDrag.y) > STRAT_DRAG_SLOP) stratDrag.panning = true;
    if (v2 && stratDrag.panning) {
      v2.view.panX += e.clientX - stratDrag.x;
      v2.view.panY += e.clientY - stratDrag.y;
      v2.view.clampPan(view.w, view.h);
      stratDrag.x = e.clientX;
      stratDrag.y = e.clientY;
    }
  }
  if (mode !== 'battle') return;
  if (dragStart && e.buttons & 1) updateBox(e.clientX, e.clientY);
});
canvas.addEventListener('mouseleave', () => {
  // window 'mousemove' only updates mouse.onCanvas on movement, so a cursor
  // that exits the canvas and stops (e.g. leaves the browser window) would
  // otherwise leave the tooltip frozen on stale content forever.
  mouse.onCanvas = false;
});
canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || mode === 'menu') return;

  if (mode === 'strategic') {
    if (!stratDrag?.panning) stratTapSelect(e.clientX, e.clientY);
    dragStart = null;
    boxRect = null;
    return;
  }

  if (boxRect && dragged) {
    commitBox(additiveWith(e.shiftKey));
    return;
  }

  if (!dragged) tapSelect(e.clientX, e.clientY, additiveWith(e.shiftKey));
  dragStart = null;
  boxRect = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode === 'menu') return;
  if (mode === 'strategic') {
    stratOrderMove(e.clientX, e.clientY);
    return;
  }
  // Right-click in battle: handling moved to mouseup on button 2 via a
  // separate listener below.
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) stratDrag = null; // after the canvas handler has read it
  if (e.button !== 2) return;
  if (!rmbDown || !rmbAnchor) { rmbDown = false; rmbAnchor = null; return; }
  rmbDown = false;
  commitOrder(e.clientX, e.clientY, { squadForce: additiveWith(e.shiftKey), floors: e.altKey });
});

// ── Touch ─────────────────────────────────────────────────────────────────
// Gestures drive the intent functions above; the desktop listeners are
// untouched. `press` state is render-only (the growing hold ring).
let touchHold: { x: number; y: number; t0: number } | null = null;
// touch.ts reports pan as a delta; the box intents want an absolute point.
// Seeding from `press` and accumulating is exact — the first delta is measured
// from the landing point, so nothing is lost to the slop threshold.
let touchAt = { x: 0, y: 0 };

const battleTouch: TouchHandlers = {
  press: (x, y) => {
    touchHold = { x, y, t0: performance.now() };
    touchAt = { x, y };
    if (boxMode) beginBox(x, y);
  },
  // The only callback touch.ts fires at the end of every gesture, whatever it
  // turned out to be — so it is where a box drag has to be committed. SELECT
  // is one-shot: leaving it latched would leave the player unable to pan.
  release: () => {
    touchHold = null;
    if (boxMode && boxRect) {
      commitBox(addMode);
      boxMode = false;
    }
  },
  tap: (x, y) => tapSelect(x, y, addMode),
  pan: (dx, dy) => {
    touchAt.x += dx;
    touchAt.y += dy;
    if (boxMode) {
      updateBox(touchAt.x, touchAt.y);
      return;
    }
    cam.x -= dx / cam.scale;
    cam.y -= dy / cam.scale;
    cam.clampCenter(sim.map.w, sim.map.h, view.w, view.h);
  },
  // Three assignments solve hover emulation: pickAt, the tooltip and the
  // order-affordance cursor all resolve to the finger for free.
  holdStart: (x, y) => {
    if (boxMode) return; // a slow box drag must not turn into an order
    beginOrderAnchor(x, y);
    mouse.x = x;
    mouse.y = y;
    mouse.onCanvas = true;
  },
  holdMove: (x, y) => {
    if (boxMode) { updateBox(x, y); return; }
    mouse.x = x;
    mouse.y = y;
    mouse.onCanvas = true;
  },
  holdEnd: (x, y) => {
    if (boxMode) { rmbDown = false; return; }
    const [wx, wy] = cam.screenToWorld(x, y, view.w, view.h);
    rmbDown = false;
    // No Alt key on a phone: a multi-story footprint always offers the floor menu.
    commitOrder(x, y, { squadForce: addMode, floors: sim.map.storiesAt(Math.floor(wx), Math.floor(wy)) >= 2 });
    mouse.onCanvas = false;
  },
  holdCancel: () => {
    rmbDown = false;
    rmbAnchor = null;
    mouse.onCanvas = false;
  },
  pinch: (factor, mx, my, dmx, dmy) => {
    cam.x -= dmx / cam.scale;
    cam.y -= dmy / cam.scale;
    cam.zoom(factor, mx, my, view.w, view.h);
    cam.clampCenter(sim.map.w, sim.map.h, view.w, view.h);
  },
  // Deliberately not Esc's full ladder: a stray two-finger tap must never
  // open the pause menu mid-battle.
  twoTap: () => { escapeLadder(); },
};

const STRAT_ZOOM = [1, 4] as const;
// Both strat cameras (grid V1, theater V2) expose the same pan/zoom fields —
// the touch grammar drives whichever is live.
function stratCam(): { panX: number; panY: number; zoomMul: number; clampPan(w: number, h: number): void } {
  const s = S();
  return s.v2 ? s.v2.view : s.stratView;
}

const stratTouch: TouchHandlers = {
  press: (x, y) => { touchHold = { x, y, t0: performance.now() }; },
  release: () => { touchHold = null; },
  tap: (x, y) => stratTapSelect(x, y),
  pan: (dx, dy) => {
    const cam2 = stratCam();
    cam2.panX += dx;
    cam2.panY += dy;
    cam2.clampPan(view.w, view.h);
  },
  holdStart: (x, y) => { stratHoldAt = { x, y }; },
  holdMove: (x, y) => { stratHoldAt = { x, y }; },
  holdEnd: (x, y) => { stratHoldAt = null; stratOrderMove(x, y); },
  holdCancel: () => { stratHoldAt = null; },
  pinch: (factor, mx, my, dmx, dmy) => {
    const v2 = S().v2;
    if (v2) {
      v2.view.panX += dmx;
      v2.view.panY += dmy;
      v2.view.zoomAt(factor, mx, my, view.w, view.h);
      return;
    }
    const cam2 = stratCam();
    const before = cam2.zoomMul;
    cam2.zoomMul = Math.max(STRAT_ZOOM[0], Math.min(STRAT_ZOOM[1], before * factor));
    // keep the map point under the pinch midpoint fixed
    const k = cam2.zoomMul / before;
    cam2.panX = mx - k * (mx - cam2.panX) + dmx;
    cam2.panY = my - k * (my - cam2.panY) + dmy;
    cam2.clampPan(view.w, view.h);
  },
  twoTap: () => {
    const v2 = S().v2;
    if (v2) v2.selectedForce = -1;
    else selectedChit = -1;
  },
};

bindTouch(canvas, () => (mode === 'battle' ? battleTouch : stratTouch));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // scroll = zoom (trackpad two-finger scroll, pinch, and mouse wheel alike);
  // ~1.003^px: a trackpad flick ramps fast, a mouse notch (dy≈100) ≈1.35×
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const factor = Math.pow(1.003, -dy);
  // Two cameras, one wheel. The theater zooms about the cursor at once
  // (TheaterView.zoomAt owns its own clamps). The battle camera is eased.
  if (mode === 'strategic') S().v2?.view.zoomAt(factor, e.clientX, e.clientY, view.w, view.h);
  if (mode !== 'battle') return;
  // The wheel sets where the zoom is GOING; the frame loop eases the camera
  // there (easeCamera). A notch applied in one step is a jump cut.
  zoomGoal = Math.min(cam.maxScale, Math.max(cam.minScale, (zoomGoal || cam.scale) * factor));
  zoomAtX = e.clientX;
  zoomAtY = e.clientY;
});

// Camera feel: eased wheel zoom and pan inertia. Wall-clock on purpose — this
// is about the player's hand, not the battle, so it runs the same paused.
// Nothing here is in play unless the player is driving it: a zoom is only in
// flight after a wheel event and a pan only has velocity after a key, so code
// that sets cam.x / cam.scale directly (boot framing, touch, the harness) is
// never fought over the camera.
let zoomGoal = 0; // px/m the wheel is asking for; 0 = no zoom in flight
let zoomAtX = 0; // the screen point the zoom holds still
let zoomAtY = 0;
let panVx = 0; // px/s
let panVy = 0;
const ZOOM_EASE_MS = 70;
const PAN_RISE_MS = 60; // to speed
const PAN_COAST_MS = 110; // to rest

function easeCamera(dtReal: number): void {
  if (zoomGoal > 0) {
    // Geometric, so a zoom-in and the zoom-out that undoes it feel alike.
    const k = 1 - Math.exp(-dtReal / ZOOM_EASE_MS);
    const next = Math.abs(zoomGoal / cam.scale - 1) < 0.002 ? zoomGoal : cam.scale * Math.pow(zoomGoal / cam.scale, k);
    cam.zoom(next / cam.scale, zoomAtX, zoomAtY, view.w, view.h);
    if (next === zoomGoal) zoomGoal = 0;
  }
  let tx = 0;
  let ty = 0;
  if (panHeld.size > 0 && !menu.isOpen) {
    for (const [dx, dy] of panHeld.values()) { tx += dx; ty += dy; }
    const mag = Math.hypot(tx, ty);
    if (mag > 0) {
      tx = (tx / mag) * PAN_PX_PER_SEC;
      ty = (ty / mag) * PAN_PX_PER_SEC;
    }
  }
  const k = 1 - Math.exp(-dtReal / (tx !== 0 || ty !== 0 ? PAN_RISE_MS : PAN_COAST_MS));
  panVx += (tx - panVx) * k;
  panVy += (ty - panVy) * k;
  if (tx === 0 && ty === 0 && Math.hypot(panVx, panVy) < 4) panVx = panVy = 0;
  cam.x += (panVx / cam.scale) * (dtReal / 1000);
  cam.y += (panVy / cam.scale) * (dtReal / 1000);
}

// WASD camera pan: held-key set keyed by event.code so a keyup always clears
// (actionForEvent's shift-exactness would miss shift-state changes mid-hold).
const PAN_DIRS: Record<string, [number, number]> = { panUp: [0, -1], panDown: [0, 1], panLeft: [-1, 0], panRight: [1, 0] };
const panHeld = new Map<string, [number, number]>();
const PAN_PX_PER_SEC = 550;
window.addEventListener('keyup', (e) => panHeld.delete(e.code));
window.addEventListener('blur', () => panHeld.clear());
window.addEventListener('keydown', (e) => {
  if (menu.isOpen) {
    // rebind capture handles keys first (capture phase); menu/cancel closes
    const action = actionForEvent(e, loadKeymap(localStorage));
    if (action === 'menu' || action === 'cancel') { e.preventDefault(); menu.close(); }
    return;
  }
  if (mode === 'menu') return;
  // A result card owns the screen: the battle behind it is over and stays stopped.
  if (mode === 'battle' && debriefShown) return;

  const km = loadKeymap(localStorage);
  const action = actionForEvent(e, km);
  if (!action) return;

  if (action in PAN_DIRS) {
    if (mode === 'battle') panHeld.set(e.code, PAN_DIRS[action]);
    return;
  }

  e.preventDefault();
  
  // Global actions
  if (action === 'pause') {
    if (mode === 'strategic') toggleStratPause();
    else paused = !paused;
    return;
  }
  if (action === 'mute') { audio.toggleMute(); return; }
  if (action === 'menu' || action === 'cancel') {
    if (!escapeLadder()) openPauseMenu();
    return;
  }
  
  if (mode === 'strategic') {
    if (action === 'speed1') speedIdx = 0;
    if (action === 'speed2') speedIdx = 1;
    if (action === 'speed3') speedIdx = 2;
    return;
  }
  
  // Battle mode
  if (action === 'battleSpeed') { battleSpeed = nextSpeed(battleSpeed); return; }
  if (action === 'aiControl') { aiControl = !aiControl; if (aiControl) { armedOrder = null; setTargetMode(''); } return; }
  if (action === 'floorFocus') { cycleFloorFocus(); return; }
  if (action === 'barrage' && !aiControl && sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  if (action === 'airstrike' && !aiControl && sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
  
  if (action.startsWith('squad')) {
    const n = Number(action.slice(5)) - 1;
    const list = infantrySquads(sim);
    if (n >= 0 && n < list.length) pickSquad(list[n].id);
  }
  
  if (action.startsWith('order')) {
    const n = Number(action.slice(5)) - 1;
    if (n >= 0 && n < ORDER_KINDS.length) doArmOrder(ORDER_KINDS[n]);
  }
});

// Floor-focus filter (Height E2): All → Ground → Floor 2 → … → All. The
// rebindable floorFocus action drives it on desktop and the touch bar's ⬒ chip
// on a phone — one function, so the two surfaces cannot drift.
// One row per team for the ticker's aggregate lines. Built here rather than in
// the UI because this is where `sim` lives, and `seen` reuses the same fog test
// the unit-event filter applies — the ticker must not become a way to watch
// unseen Germans break.
function teamPulses(s: Sim): TeamPulse[] {
  const out: TeamPulse[] = [];
  for (const t of s.teams) {
    if (t.soldierIds.length === 0) continue;
    let live = 0;
    let pinned = 0;
    // Seen if ANY man of the team is seen — the same predicate the sprite gate
    // uses, so the ticker never names a team the player has no man drawn for.
    // A centroid + sideSeesPoint would both leak a concealed team (sightBetween
    // skips the concealment rule sightToSoldier enforces) and put the test on a
    // point no man is standing on when the team is split or behind a wall.
    let seen = s.fowDisabled;
    for (const id of t.soldierIds) {
      const m = s.soldiers[id];
      if (!m.alive || m.downed || m.captured) continue;
      live++;
      if (m.mental === 'pinned') pinned++;
      if (!seen && s.soldierVisibleTo('blue', m)) seen = true;
    }
    const side = s.soldiers[t.soldierIds[0]].side;
    if (side === 'blue' || live === 0) seen = true;
    out.push({ id: t.id, side, name: t.name, live, pinned, balked: t.orderState.phase === 'balked', seen });
  }
  return out;
}

function cycleFloorFocus(): void {
  const maxStories = sim.map.maxStories;
  if (maxStories <= 0) return;
  floorFocus = floorFocus >= maxStories - 1 ? -1 : floorFocus + 1;
}

// debug/automation handle
(window as unknown as { __game: object }).__game = {
  get sim() {
    return sim;
  },
  get front() {
    return S().front;
  },
  get renderer() {
    return renderer;
  },
  // The battle ticker. Exposed for the same reason `renderer` is: what the
  // player was just told is otherwise unreadable from outside the frame loop,
  // and a feed that fires once every thirty seconds cannot be caught by
  // screenshotting and hoping.
  get pings() {
    return pings;
  },
  get barks() {
    return barks;
  },
  backdrop,
  commanders,
  cam,
  audio,
  view,
  MOBILE,
  // The gesture classifier is pure; exposing it lets scripts/mobile.mjs assert
  // classification without synthesising timing-sensitive touch sequences.
  classify: classifyGesture,
  stratView: () => S().stratView,
  getSelection: () => ({ mode, squads: [...selectedSquads], team: selectedTeam, vehicle: selectedVehicle, chit: selectedChit, targetMode, armedOrder }),
  setPaused: (p: boolean) => {
    stratPaused = p;
    paused = p;
  },
  // Step the render clock by hand. fxNow stops with the sim, and every staged
  // harness scene is paused so nothing in it moves — which also meant a staged
  // transient never aged and the VFX gate only ever shot the age-0 frame
  // (#780). Stepping it here ages the effects and nothing else: the sim does
  // not tick, and a capture lands on an exact age instead of a wall-clock guess.
  advanceFx: (ms: number) => {
    fxNow += ms;
  },
  selectSquad: (i: number) => selectSquad(i),
  selectVehicle: (i: number) => selectVehicle(i),
  getCampaign: () => S().campaign,
  getV2: () => S().v2,
  // Advance the theater by exact minutes through the SAME tick the frame loop
  // runs (red planner, war step, day roll). scripts/stratsweep.mjs stages its
  // states with this: a wall-clock run at 60x never stops on the same minute
  // twice. Returns the minutes stepped; stops at a contact.
  // Freeze (or with null, release) the theater's render clock, so a mark that
  // animates is the same frame on every run of the sweep.
  freezeFx: (t: number | null) => {
    const v2 = S().v2;
    if (v2) v2.view.frozenAt = t;
  },
  stepTheater: (minutes: number): number => {
    const v2 = S().v2;
    let n = 0;
    while (v2 && n < minutes && !v2.pending) {
      stepTheaterMinuteV2(v2);
      n++;
    }
    if (v2?.pending) showContactModalV2(v2.pending); // as the frame loop does
    return n;
  },
  startEngagementBattle,
  showDebrief,
  // The map clear of the HUD, in CSS px: a gate script clicks only what a player could.
  stage: stageRect,
  // The tutorial as the player sees it, and the drill it is teaching: scripts/drill.mjs
  // finds its targets here, the way a player finds them from the ring.
  enemyPointer: () => foeShown,
  tutorialView: () => (tutorial ? { step: tutorial.step?.id ?? null, ring: tutorial.ring(), occupied: tutorial.occupied() } : null),
  getDrill: () => (drill ? { lead: drill.lead, rifles: drill.rifles, shooter: drill.shooter, hedge: drill.hedge, house: drill.house } : null),
  setFow: (on: boolean) => {
    sim.fowDisabled = !on;
  },
};

let last = performance.now();
let acc = 0;
const DT_MS = DT * 1000;
// The RENDER clock. Effects that must look alive between sim ticks run on wall
// time — flame flicker, muzzle flashes, melee hits — because 30 Hz sampling
// makes a flame visibly step. Wall time does not stop when the battle does,
// so a paused game sat there with its fires still guttering. This clock is
// wall time that STOPS with the sim: everything cosmetic reads it instead of
// performance.now(), and pause freezes the picture the way the player expects.
// Real `now` still drives the things that are about the player and not the
// battle — the hold ring, the debrief delay, coachmarks.
let fxNow = 0;
const hullsHeard: { x: number; y: number }[] = []; // reused every frame: the hulls audio.ambience() hears

// The hold: on the biggest events — a tank kill, an air strike or a heavy
// shell inside the view — the battle stops for three frames on the flash. The
// sim is not stepped and the fx clock does not run, so the frame is held; then
// both carry on from where they were. It delays sim.step() calls and changes
// no sim result. Skipped when the frame that would start it is already late:
// a hold on top of a hitch is a stall.
const HOLD_MS = 55; // three frames at 60 Hz
const HOLD_COOLDOWN_MS = 4000; // a barrage is twelve rounds — one beat, not twelve
const HOLD_LATE_MS = 20; // a frame longer than this is already behind
let holdUntil = 0;
let heldAt = -1e9;

function frame(now: number): void {
  const dtReal = Math.min(now - last, 250);
  last = now;
  // A requisition card is a decision the tutorial does not explain: while it is
  // up the bubble, the goal line and the ring stand down, and come back after.
  const requisition = mode === 'strategic' && document.getElementById('req') !== null;
  tutorial?.frame(menu.isOpen || manual.isOpen || requisition);
  const held = mode === 'battle' && now < holdUntil;
  if (!(mode === 'battle' ? paused : stratPaused) && !held) fxNow += dtReal;
  if (mode === 'battle') easeCamera(dtReal);
  // Under a result card the battle HUD is gone: what is left is the battlefield.
  hud.root.style.display = mode === 'battle' && !debriefShown ? '' : 'none';
  // Gates the portrait guidance (ui.css). Not the drill: its map is a third as
  // wide as a campaign battle's and plays whole in portrait.
  document.documentElement.classList.toggle('in-battle', mode === 'battle' && drill === null);
  stratHud.root.style.display = mode === 'strategic' && !S().v2 ? '' : 'none';
  theaterHud.root.style.display = mode === 'strategic' && S().v2 ? '' : 'none';
  // Off the battle map there are no engines and no guns to rumble: wind only.
  if (mode !== 'battle') audio.ambience(hullsHeard, cam, view.w, view.h, true);
  // The battle behind the main menu (render/backdrop.ts): wanted only while
  // the menu itself is the thing on screen. Play, a sub-screen or any other
  // mode stops it and frees its sim. The class drops the menu's own black.
  backdrop.want(mode === 'menu' && mainMenu.isOpen && !customize.isOpen && !manual.isOpen);
  document.documentElement.classList.toggle('menu-backdrop', backdrop.shown);
  if (mode === 'menu') {
    backdrop.frame(ctx, dtReal);
    requestAnimationFrame(frame);
    return;
  }
  if (mode === 'strategic' && S().v2) {
    const v2 = S().v2!;
    hud.updateIdle(v2.selectedForce >= 0 || stratPaused);
    // A requisition waits behind a contact and behind nothing else: the
    // clock holds until it is answered, and a loaded save shows it again.
    const reqDue = requisitionDue(v2.front) && !v2.pending && !opEnded;
    if (reqDue && !document.getElementById('req')) showRequisitionV2();
    if (!stratPaused && !v2.pending && !reqDue && !opEnded) {
      stratAcc += (dtReal / 1000) * SPEEDS[speedIdx];
      while (stratAcc >= 1 && !v2.pending && !requisitionDue(v2.front)) {
        stratAcc -= 1;
        stepTheaterMinuteV2(v2);
        // The clock moved: the one thing the Play step was waiting to see.
        tutorial?.notify('clock-advanced');
        if (v2.pending) showContactModalV2(v2.pending);
      }
      const st = warStatus(v2.front, v2.goals);
      if (st.state === 'decided') showOperationEnd(st.winner === 'blue' ? 'won' : 'lost');
    }
    theaterHud.update(v2.front, v2.goals, v2.selectedForce, stratPaused, speedIdx, v2.campaignCfg.supply, v2.campaignCfg.recon === 'contacts', v2.campaignCfg.nightTempo, resultTarget(v2.front, S().campaign, v2.campaignCfg.warDays));
    // The first objective taken, by a battle or by walking in: one step, once.
    if (tutorial?.wants('objective-captured') && !v2.pending && capturedObjective(v2) !== null) tutorial.notify('objective-captured');
    // One thing talks at a time: while a tutorial step is on screen the
    // theater's own "what next" line is quiet (ui.css, .coached).
    theaterHud.root.classList.toggle('coached', (tutorial?.isShowing ?? false) && !requisition);
    v2.view.inset = theaterInset();
    if (v2.needsFrame) {
      v2.needsFrame = false;
      v2.view.frameStart(v2.front, view.w, view.h);
    }
    if (v2.centerNext) {
      v2.view.centerOn(v2.centerNext, view.w, view.h);
      v2.centerNext = null;
    }
    // A new selection opens the force card. Keep the company it describes
    // clear of it. Once, so the player's own pan is not fought afterwards.
    if (v2.selectedForce !== v2.shownForce) {
      v2.shownForce = v2.selectedForce;
      const sel = v2.front.forces.find((f) => f.id === v2.selectedForce);
      if (sel) v2.view.keepInView(v2.view.forceXY(sel), view.w, view.h);
    }
    v2.view.clampPan(view.w, view.h);
    v2.view.preview = theaterPreview(v2);
    v2.view.draw(ctx, v2.front, v2.selectedForce, stratPaused, SPEEDS[speedIdx], view.w, view.h);
    const ring = requisition ? null : tutorial?.ring();
    if (ring) drawMarkRing(ctx, ring, now);
    if (touchHold) drawHoldRing(ctx, touchHold, now);
  } else if (mode === 'strategic') {
    hud.updateIdle(selectedChit >= 0 || stratPaused);
    if (!stratPaused && !pendingEngagement && !opEnded) {
      stratAcc += (dtReal / 1000) * SPEEDS[speedIdx];
      while (stratAcc >= 1 && !pendingEngagement) {
        stratAcc -= 1;
        for (const cmd of commanders) cmd.evaluate(S().front);
        const e = S().front.step();
        if (S().front.day > prevDay) {
          advanceDays(S().campaign, S().front.day - prevDay);
          if (S().front.day % REINFORCE_CYCLE_DAYS === 0) {
            const arrived = fillReplacements(S().campaign, S().front.day * 31 + 7, REINFORCE_PER_COMPANY);
            if (arrived > 0) S().stratView.flash(`+${arrived} replacements arrived`);
          }
          syncStrengths(S().campaign, S().front);
          prevDay = S().front.day;
          save();
        }
        if (e) {
          const attacker = S().front.chits.find((c) => c.id === e.attackerId)!;
          const defender = S().front.chits.find((c) => c.id === e.defenderId)!;
          const attackerIsAI = aiSides.has(attacker.side);
          const defenderIsAI = aiSides.has(defender.side);
          
          if (attackerIsAI && defenderIsAI) {
            const result = resolveCoarse(S().campaign, S().front, e);
            S().stratView.flash(`${attacker.name} vs ${defender.name}: ${result.attackerWon ? 'attacker wins' : 'defender holds'}`);
            save();
          } else if (attackerIsAI && !defenderIsAI) {
            pendingEngagement = e;
            stratPaused = true;
            if (trivialMismatchWinner(attacker, defender)) showContactModal(e);
            else startEngagementBattle(e);
          } else {
            pendingEngagement = e;
            stratPaused = true;
            showContactModal(e);
          }
        }
      }
      const status = operationStatus(S().front);
      if (status !== 'ongoing') showOperationEnd(status);
    }
    stratHud.update(S().front, S().campaign, selectedChit, stratPaused, speedIdx);
    S().stratView.clampPan(view.w, view.h); // absorbs orientation changes; a no-op at zoomMul 1
    S().stratView.stagedCell = pendingEngagement ? pendingEngagement.cell : -1;
    S().stratView.draw(ctx, S().front, selectedChit, stratPaused, SPEEDS[speedIdx], view.w, view.h);
    if (touchHold) drawHoldRing(ctx, touchHold, now);
  } else {
    if (!paused && !held) {
      // Catch-up guard. dtReal is capped at 250ms, which is up to 7 sim steps
      // in one frame — on a phone that already missed its budget that
      // guarantees it misses the next one worse, and the UI locks. Let the
      // sim run slow instead: frameSteps caps the count and drops the debt.
      // Battle speed multiplies the steps and touches nothing else. A hold
      // (above) is wall time with no steps at all, whatever the speed.
      const f = frameSteps(acc, dtReal, battleSpeed, MOBILE, DT_MS);
      for (let i = 0; i < f.steps; i++) {
        commander.update(sim);
        if (aiControl) blueCommander?.update(sim);
        sim.step();
      }
      acc = f.acc;
    } else {
      acc = 0;
    }
    // The one call that makes the sun move (N3): the render side is fully
    // reactive — light.ts quantizes, and every sun-keyed cache queues its own
    // rebakes off the step. Near-free when the step hasn't changed.
    setSun(sim.clockMin);
    const cw = view.w;
    const chh = view.h;
    const shots = sim.takeEvents();
    const melee = sim.takeMeleeEvents();
    const booms = sim.takeBooms();
    // Drained beside the booms and never THROUGH them: a breach is a map
    // mutation the renderer has to notice (stale chunks, stale enclosure runs,
    // stale wall bands), where a boom is only ever a thing that was watched.
    const breaches = sim.takeBreaches();
    // fxNow, not now: an effect stamped with wall time would keep ageing while
    // the battle is stopped, and would be born already half-expired on resume.
    renderer.addEvents(shots, fxNow);
    renderer.addMeleeEvents(melee, fxNow);
    renderer.addBooms(booms, fxNow);
    if (dtReal <= HOLD_LATE_MS && now - heldAt > HOLD_COOLDOWN_MS && renderer.holdWorthy(booms, cam)) {
      holdUntil = now + HOLD_MS;
      heldAt = now;
    }
    renderer.addBreaches(breaches, fxNow);
    // Grenade throws, when the sim reports them. takeGrenades() is the sim
    // lane's and is not on this branch's Sim yet: until it lands this is an
    // empty list every frame, and the day it lands the throws draw.
    renderer.addGrenades((sim as { takeGrenades?: () => GrenadeThrow[] }).takeGrenades?.() ?? [], fxNow);
    renderer.addPlanes(sim.takePlanes(), fxNow);
    audio.addShots(shots, cam, cw, chh);
    audio.addMelee(melee, cam, cw, chh);
    audio.addBooms(booms, cam, cw, chh);
    audio.addBreaches(breaches, cam, cw, chh);
    // The bed: engines for the live hulls the player can see, the far rumble
    // off the firing just counted. Quiet under pause.
    hullsHeard.length = 0;
    for (const v of sim.vehicles) if (v.alive && sim.vehicleVisibleTo('blue', v)) hullsHeard.push(v);
    audio.ambience(hullsHeard, cam, cw, chh, paused);
    // fog of war: enemy unit events only ping where a friendly can see. An
    // event that happened to a man is filtered by the man — a point test would
    // announce a concealed German the renderer refuses to draw. The two kinds
    // that anchor to no single soldier fall back to the point.
    const unitEvents = sim
      .takeUnitEvents()
      .filter((e) => (e.id !== undefined ? sim.soldierVisibleTo('blue', sim.soldiers[e.id]) : e.side === 'blue' || sim.fowDisabled || sim.sideSeesPoint('blue', e.x, e.y)));
    pings.add(unitEvents, sim.tick, teamPulses(sim));
    highlights.observe(sim);
    highlights.add(unitEvents, sim);
    renderer.addUnitEvents(unitEvents, fxNow);
    barks.observe(sim, fxNow);
    barks.addUnitEvents(unitEvents, sim, fxNow);
    audio.addUnitEvents(unitEvents);

    const pick = mouse.onCanvas && !targetMode ? pickAt(sim, cam, mouse.x, mouse.y, view.w, view.h) : null;
    const shot = computeShot(sim, getPrimary(), selectedVehicle, pick);
    const hover = mouse.onCanvas ? cam.screenToWorld(mouse.x, mouse.y, view.w, view.h) : null;
    // With the floor menu open the pointer is on the menu, not the map, so the
    // preview holds the target the menu was opened on.
    const cursor = floorMenu ? { x: floorMenu.wx, y: floorMenu.wy } : hover && { x: hover[0], y: hover[1] };
    const primary = getPrimary();

    // Formation drag state for overlays
    let formationDrag: { ax: number; ay: number; facing: number; width: number } | null = null;
    if (rmbDown && rmbAnchor) {
      const [cx, cy] = cam.screenToWorld(mouse.x, mouse.y, view.w, view.h);
      const wdx = cx - rmbAnchor.wx;
      const wdy = cy - rmbAnchor.wy;
      const len = Math.hypot(wdx, wdy);
      if (len >= 2) {
        formationDrag = { ax: rmbAnchor.wx, ay: rmbAnchor.wy, facing: Math.atan2(wdy, wdx), width: Math.max(3, Math.min(60, len)) };
      }
    }

    // Deployment: the first unpause commits and begins the battle.
    if (deployPhase && !paused) {
      deployPhase = false;
      deployMsg = '';
      tutorial?.notify('deploy-commit');
      noteSelection();
    }
    renderer.draw(ctx, cam, selectedSquads, fxNow, floorFocus);
    // Under a result card only the battlefield is drawn: no words, chips or rings over it.
    if (!debriefShown) barks.draw(ctx, cam, sim, fxNow, view.w, view.h);
    if (deployPhase) {
      const zone = deployZone();
      const [zx0, zy0] = cam.worldToScreen(zone.x0, 0, view.w, view.h);
      const [zx1, zy1] = cam.worldToScreen(zone.x1, sim.map.h, view.w, view.h);
      ctx.fillStyle = 'rgba(90, 140, 90, 0.12)';
      ctx.fillRect(zx0, zy0, zx1 - zx0, zy1 - zy0);
      ctx.strokeStyle = 'rgba(150, 200, 150, 0.5)';
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(zx0, zy0, zx1 - zx0, zy1 - zy0);
      ctx.setLineDash([]);
      // Centred on the CLEAR viewport, not the canvas. The roster panel owns
      // the left ~270px and a one-time coachmark can own the top-right corner,
      // so a banner centred on the canvas reads clipped at both ends — the same
      // measured-inset rule the boot framing follows.
      const inset = viewportInset();
      const by = inset.top > 0 ? inset.top + 6 : 40;
      const showMsg = deployMsg !== '' && performance.now() < deployMsgUntil;
      const bubble = document.querySelector('.coach')?.getBoundingClientRect();
      const right = bubble && bubble.height > 0 && bubble.top < by + 46 ? bubble.left - 8 : view.w;
      const text = MOBILE
        ? 'DEPLOYMENT · hold to place · Play to begin'
        : 'DEPLOYMENT · right-click to place squads · Play to begin';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      // A phone cannot hold the sentence on one line — wrap at word breaks
      // instead of clipping at the screen edges.
      const avail = right - inset.left - 20;
      const lines: string[] = [];
      let acc = '';
      for (const word of text.split(' ')) {
        const cand = acc === '' ? word : `${acc} ${word}`;
        if (acc !== '' && ctx.measureText(cand).width > avail - 20) {
          lines.push(acc);
          acc = word;
        } else acc = cand;
      }
      if (acc !== '') lines.push(acc);
      const bh = lines.length * 18 + (showMsg ? 28 : 12);
      const bw = Math.min(avail, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20);
      const bx = (inset.left + right) / 2;
      ctx.fillStyle = 'rgba(20, 18, 12, 0.85)';
      ctx.fillRect(bx - bw / 2, by, bw, bh);
      ctx.fillStyle = '#e8dcc4';
      lines.forEach((l, i) => ctx.fillText(l, bx, by + 19 + i * 18));
      if (showMsg) {
        ctx.fillStyle = '#d8a878';
        ctx.fillText(deployMsg, bx, by + 19 + lines.length * 18);
      }
    }
    const stage = stageRect();
    const taken = tutorial?.occupied() ?? [];
    if (!debriefShown) drawOverlays(ctx, cam, sim, {
      shot,
      selectedSquad: primary,
      selectedTeam,
      selectedSquads,
      selectRect: boxRect,
      formationDrag,
      targetMode,
      armedOrder,
      squadForce: addMode,
      cursor,
      orderFloor: floorMenu ? floorMenu.level : null,
      floorFocus,
      deploy: deployPhase ? { ...deployZone(), bearing: deployBearing() } : null,
      clear: stage,
      avoid: taken,
    }, pings);
    // The battle opens on the player's men: the pointer says which way the enemy
    // is. A defender needs that from the first screen, deployment and its step
    // included, so a tutorial step silences it only in the drill (every drill
    // step rings the one thing to look at) or where it would sit on the step.
    const foe = sim.winner || (drill && tutorial?.isShowing) ? null : enemyPointer(sim, stage, (x, y) => cam.worldToScreen(x, y, view.w, view.h));
    foeShown = foe && !taken.some((r) => foe.x > r.left - POINTER_REACH_PX && foe.x < r.right + POINTER_REACH_PX && foe.y > r.top - 16 && foe.y < r.bottom + 16) ? foe : null;
    if (foeShown) drawEnemyPointer(ctx, foeShown);
    if (drill) pollDrill(drill);
    const ring = tutorial?.ring();
    if (ring) drawMarkRing(ctx, ring, now);
    if (touchHold) drawHoldRing(ctx, touchHold, now);
    // One thing talks at a time: a tutorial step on screen outranks the hover card.
    tooltip.update(sim, tutorial?.isShowing ? null : pick, shot, mouse.x, mouse.y, pick?.kind === 'terrain' && (primary >= 0 || selectedVehicle >= 0), MOBILE ? touchHold !== null && now - touchHold.t0 > DETAIL_HOLD_MS : mouse.alt);
    const km = loadKeymap(localStorage);
    // A player who has given no order for a minute of battle is told the goal
    // and where the enemy is. Sim time, so a pause neither starts nor ends it.
    const quiet = !deployPhase && !sim.winner && !aiControl && (sim.tick - lastOrderTick) * DT >= QUIET_PROMPT_S;
    hud.update(sim, { selectedSquad: primary, selectedSquads, selectedTeam, selectedVehicle, paused, aiControl, targetMode, armedOrder, title: battleTitle, keymap: km, prompt: quiet && !tutorial?.isShowing ? quietPrompt(sim) : null, glow: tutorial?.step?.chip ?? null, noSupport: drill !== null, speed: battleSpeed, deploy: deployPhase, floorFocus, boxMode, addMode });
    // A new battle re-indexes sim.soldiers, so an id held across one closes the panel.
    if (inspectedSoldier >= 0 && !sim.soldiers[inspectedSoldier]) inspectedSoldier = -1;
    healthPanel.update(sim, inspectedSoldier);

    // The boot framing has to measure the battle HUD, which does not exist
    // until the update above has run once. Re-frame on that first frame —
    // before then, viewportInset() reads the collapsed strategic-mode DOM and
    // the roster panel silently fails to inset the view.
    if (needsBootFrame) {
      needsBootFrame = false;
      const b = bootCamera(sim, view.w, view.h);
      cam.x = b.x;
      cam.y = b.y;
      cam.scale = b.scale;
      zoomGoal = 0;
      // Same frame, same reason: the deploy bubble points at the battle HUD's
      // pause control, which the update above has only just built.
      if (deployPhase) tutorial?.notify('deploy-start');
      if (drill) tutorial?.notify('drill-start');
    }

    if (sim.winner && winnerAt < 0) {
      winnerAt = now;
      tutorial?.notify('battle-won');
    }
    if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) {
      if (drill) showDrillEnd();
      else showDebrief();
    }
  }
  requestAnimationFrame(frame);
}
// Boot: a campaign-defining URL param (?camp=N) bypasses the menu
// synchronously, so the harness scripts see a live session at module-eval end;
// ?menu=1 forces the menu even then. Bare boot lands on the menu — the save,
// if any, sits behind Continue instead of auto-loading.
const menuForced = new URLSearchParams(location.search).get('menu') === '1';
if (urlDrill !== null && !campPinned) {
  startDrill(Number.isFinite(Number(urlDrill)) && urlDrill !== '' ? Number(urlDrill) : campSeed());
} else if (campPinned && !menuForced) {
  startCampaign(null);
} else {
  mainMenu.setSaveProbe(probeSave());
  mainMenu.open();
}
requestAnimationFrame(frame);
