import { cellXY } from './strategic/sector';
import { advanceDays, fillReplacements, newCampaign, squadMembers, type BattleRecord, type Campaign } from './campaign/campaign';
import { AudioEngine } from './render/audio';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { setSun } from './render/light';
import { StrategicView, TERRAIN_LABELS } from './render/strategic';
import { bootCamera as bootCameraFor, capInset, FRAME_M_DESKTOP, FRAME_M_MOBILE, type Inset } from './render/framing';
import { MOBILE, view, viewSize } from './render/view';
import type { RedCommander } from './sim/ai';
import { WEAPONS } from './sim/data';
import { MOVE_FAMILY, type OrderKind, type TeamOrder } from './sim/orders';
import { DT, fanOffsets, SQUAD_FAN, type Side, type Sim, type Soldier } from './sim/sim';
import { applyEngagementOutcome, makeStrategicBattle, newFront, resolveCoarse, syncStrengths, trivialMismatchWinner } from './strategic/bridge';
import { StrategicCommander, RED_DEFENDER, BLUE_ATTACKER } from './strategic/command';
import { operationStatus, REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY, type Chit, type Engagement, type Front } from './strategic/front';
import { loadGame, saveGame } from './strategic/save';
import { makeDefaultSector } from './strategic/sector';
import { emplacementOf, Hud, infantrySquads, type HudState } from './ui/hud';
import { StratHud } from './ui/strat-hud';
import { drawOverlays, EventPings } from './ui/overlays';
import { computeShot, pickAt, Tooltip } from './ui/tooltip';
import { HealthPanel } from './ui/health-panel';
import { actionForEvent, loadKeymap, type Keymap } from './ui/keymap';
import { PauseMenu } from './ui/menu';
import { coach } from './ui/coach';
import { showFloorMenu } from './ui/floormenu';
import { MainMenu, type SaveProbe } from './ui/mainmenu';
import { ManualScreen } from './ui/manual';
import { Tutorial } from './ui/tutorial';
import { TheaterView } from './render/theater-view';
import { TheaterHud } from './ui/theater-hud';
import { CustomizeScreen } from './ui/customize';
import { DEFAULT_PRESET, presetSpec } from './campaign/presets';
import { SPEC_TAG, specStream, type CampaignConfig, type TheaterConfig } from './campaign/spec';
import { makeTheater, TheaterGenError } from './strategic/theatergen';
import { DispositionError, makeDisposition } from './strategic/theatergen/disposition';
import { makeWarGoals, warStatus, type WarGoals } from './strategic/goals';
import { DEPLOY_ATK_DEPTH, DEPLOY_DEF_LINE, DEPLOY_DEF_DEFAULT } from './strategic/deploy';
import { ContactIntel, OmniscientIntel, type IntelView } from './strategic/intel';
import { Commander2, RED_V2 } from './strategic/planner';
import { addForce, type CoarseBattle, type FrontV2, type MoveReject } from './strategic/theater/force';
import { orderMove } from './strategic/theater/step';
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
  '<h2>TURN THE PHONE</h2>' +
  '<p>The battlefield is 320 m wide. In portrait you see about a third of the frontage a company needs to manoeuvre across.</p>' +
  '<button id="rotate-anyway">Play in portrait anyway</button>';
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
let commander: RedCommander;
let blueCommander: RedCommander | undefined;
let aiControl = false;
let renderer: Renderer;
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
let debriefShown = false;
let needsBootFrame = false; // re-run bootCamera once the battle HUD is laid out
const mouse = { x: 0, y: 0, onCanvas: false };
const pings = new EventPings();
// Touch-only sticky modes. A phone has no shift key and no second mouse
// button, so the two modifiers the desktop path reads off the keyboard become
// latched chips in the touch bar. Both stay false on desktop, where the
// keyboard still supplies them per-event.
let boxMode = false;
let addMode = false;
/** shift-equivalent: the real key on desktop, the latched ADD chip on touch. */
const additiveWith = (shift: boolean): boolean => shift || addMode;

function selectSquad(id: number): void {
  selectedSquads = id < 0 ? [] : [id];
  selectedTeam = -1;
  selectedVehicle = -1;
  if (renderer) renderer.selectedVehicle = -1;
  armedOrder = null;
  if (id >= 0) lastTeamId = sim.squads[id].teamIds[0];
  if (id >= 0 && mode === 'battle') {
    const t = document.getElementById(MOBILE ? 'touchbar' : 'squads');
    if (t)
      coach.maybeShow(
        MOBILE ? 'touch-order' : 'first-squad-select',
        t,
        MOBILE
          ? 'Squad selected — press and hold the ground to send them. Tap an order chip first to change how.'
          : 'Select a squad, then right-click to move. Shift+1-8 arms an order.',
      );
  }
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
}

/** Arm an order kind (toggle) and fire first-order-arm coachmark once. */
function doArmOrder(kind: OrderKind): void {
  armedOrder = armedOrder === kind ? null : kind;
  if (armedOrder) {
    const btn = document.querySelector(`[data-order="${armedOrder}"]`) as HTMLElement | null;
    const t = btn ?? document.getElementById(MOBILE ? 'touchbar' : 'squads');
    if (t)
      coach.maybeShow(
        'first-order-arm',
        t,
        MOBILE ? 'Order armed — press and hold the ground to issue it.' : 'Order armed — right-click to issue.',
      );
  }
}

function selectVehicle(id: number): void {
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
  selectSquad,
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
    if (mode === 'strategic') stratPaused = !stratPaused;
    else paused = !paused;
  },
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
  },
  cancel: () => { escapeLadder(); },
  cycleFloor: () => { cycleFloorFocus(); },
  openMenu: () => { openPauseMenu(); },
});
// Two stacked fixed bottom layers (touch bar + roster sheet) have to agree on
// one height, and the bar's own height changes when the order-chip row comes
// and goes. Publish the measured value rather than hard-coding it twice.
const touchbarEl = document.getElementById('touchbar');
if (touchbarEl && typeof ResizeObserver === 'function') {
  const publishBarHeight = (): void =>
    document.documentElement.style.setProperty('--touchbar-h', `${Math.round(touchbarEl.getBoundingClientRect().height)}px`);
  new ResizeObserver(publishBarHeight).observe(touchbarEl);
  publishBarHeight();
}
const stratHud = new StratHud({
  togglePause: () => { stratPaused = !stratPaused; },
  setSpeed: (i) => { speedIdx = i; },
});
const theaterHud = new TheaterHud({
  togglePause: () => { stratPaused = !stratPaused; tutorial?.notify('speed-changed'); },
  setSpeed: (i) => { speedIdx = i; tutorial?.notify('speed-changed'); },
  openMenu: () => { openPauseMenu(); },
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
});
menu.setKeymap(loadKeymap(localStorage));

/**
 * The one door to the pause menu. The battle ⚙, the theater ⚙ and Esc with
 * nothing left to cancel all come through here, and each stops the clock it
 * found running — the theater's, or the battle's.
 */
function openPauseMenu(): void {
  if (menu.isOpen) { menu.close(); return; }
  pauseBeforeMenu = mode === 'strategic' ? stratPaused : paused;
  if (mode === 'strategic') stratPaused = true;
  else paused = true;
  menu.setKeymap(loadKeymap(localStorage));
  menu.open();
}

// The tutorial driver teaches over the live game. It does not exist at all on
// the pinned art path: ?camp= must render byte-identical frames forever.
const tutorial = campPinned
  ? null
  : new Tutorial(coach, MOBILE, (chapterId) => manual.open(chapterId), typeof localStorage !== 'undefined' ? localStorage : undefined);

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
  onNewOperation: () => {
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
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
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
    </div>`;
  debriefEl.style.display = 'flex';
  {
    const fight = document.getElementById('fight');
    coach.maybeShow('first-engagement', fight ?? debriefEl, 'Staging — review the force comparison, then Attack or Stand down.');
  }
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
  // battle HUD is still in the DOM but collapsed, and a hidden #hint would
  // otherwise read as an 800px bottom inset and collapse the viewport to
  // nothing. Only elements that actually occupy space may inset the view.
  const box = (id: string) => {
    const r = document.getElementById(id)?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? r : null;
  };
  const squads = box('squads');
  const strip = box('obj-strip');
  // Both bottom-edge layers, whichever exists: #hint on desktop, #touchbar on
  // a phone. They are mutually exclusive today, but taking the max means the
  // camera never frames blue behind whichever one is actually on screen.
  const bottoms = ['hint', 'touchbar'].map((id) => box(id)).filter((r) => r !== null);
  return {
    left: squads ? squads.right : 0,
    top: strip ? strip.bottom : 0,
    bottom: bottoms.length ? Math.max(...bottoms.map((r) => view.h - r.top)) : 0,
  };
}

// bootCameraFor scales off the clear region's WIDTH, which is the right axis
// on a portrait phone and the wrong one the moment it turns: 844x390 landscape
// solves 70m across 844px at 12 px/m, and 70m of ground 22m tall showed 24 of
// 138 men. FRAME_M_MOBILE is really "meters across the short axis" — in
// portrait that is already the width (so this returns it unchanged), in
// landscape it is the clear height, so convert.
const MOBILE_CAP_FRAC = 0.35;
function mobileFrameM(cw: number, ch: number, raw: Inset): number {
  const vw = Math.max(1, cw - capInset(raw.left, cw, MOBILE_CAP_FRAC));
  const vh = Math.max(1, ch - capInset(raw.top, ch, MOBILE_CAP_FRAC) - capInset(raw.bottom, ch, MOBILE_CAP_FRAC));
  return vh < vw ? (FRAME_M_MOBILE * vw) / vh : FRAME_M_MOBILE;
}

function bootCamera(s: Sim, cw: number, ch: number): { x: number; y: number; scale: number } {
  const raw = viewportInset();
  return bootCameraFor(s.map, s.soldiers.filter((sd) => sd.side === 'blue'), cw, ch, raw, {
    frameM: MOBILE ? mobileFrameM(cw, ch, raw) : FRAME_M_DESKTOP,
    // Desktop insets are borders and must keep insetting at every window
    // width; only the phone's full-width sheets are drawers worth ignoring.
    capFrac: MOBILE ? MOBILE_CAP_FRAC : undefined,
    maxScale: cam.maxScale,
    minScale: 2,
  });
}

function bootBattle(staged: { sim: Sim; commander: RedCommander; blueCommander: RedCommander; companyIndex: number }, title: string): void {
  sim = staged.sim;
  sim.fowDisabled = fowOff;
  commander = staged.commander;
  blueCommander = staged.blueCommander;
  aiControl = false;
  battleCompany = staged.companyIndex;
  renderer = new Renderer(sim);
  renderer.hazeOn = !hazeOff;
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
  tooltip.clear();
}

function startEngagementBattle(e: Engagement): void {
  pendingEngagement = e;
  const seed = urlSeed !== null && Number.isFinite(Number(urlSeed)) ? Number(urlSeed) : S().front.clockMin * 7919 + e.cell;
  const battle = makeStrategicBattle(S().campaign, S().front, e, seed);
  bootBattle(battle, `Day ${S().front.day} ${S().front.hhmm} — ${battle.name}`);
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

// Reposition the selected squads around (wx, wy): deterministic compact fan,
// every man through nudgeSpawn (no rng), zone- and bounds-checked. Guns and
// mounted men refuse — emplacements deploy where they stand.
function deployPlace(wx: number, wy: number): void {
  const zone = deployZone();
  if (wx < zone.x0 || wx > zone.x1) {
    deployFlash(`Outside your deployment zone (x ${zone.x0}–${Math.round(zone.x1)})`);
    return;
  }
  const K = selectedSquads.length;
  if (K === 0) {
    deployFlash('Select a squad first — tap it, then right-click the ground');
    return;
  }
  const offs = fanOffsets(K, SQUAD_FAN);
  selectedSquads.forEach((id, qi) => {
    const squad = sim.squads[id];
    if (!squad) return;
    if (emplacementOf(sim, id)) {
      deployFlash(`${squad.name}: guns deploy where they stand`);
      return;
    }
    const ax = wx;
    const ay = wy + offs[qi];
    let i = 0;
    for (const sid of squad.soldierIds) {
      const s = sim.soldiers[sid];
      if (!s.alive || s.inVehicle >= 0) continue;
      const gx = ax + ((i % 4) - 1.5) * 2;
      const gy = ay + Math.floor(i / 4) * 2 - 2;
      const p = sim.nudgeSpawn(
        Math.max(zone.x0 + 0.5, Math.min(zone.x1 - 0.5, gx)),
        Math.max(1, Math.min(sim.map.h - 2, gy)),
      );
      s.x = p.x;
      s.y = p.y;
      s.level = 0;
      s.path = null;
      i++;
    }
  });
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
      const arrived = fillReplacements(S().campaign, v2.front.day * 31 + 7, REINFORCE_PER_COMPANY);
      if (arrived > 0) v2.view.flash(`+${arrived} replacements arrived`);
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

function showContactModalV2(c: Contact): void {
  const v2 = S().v2!;
  const atk = v2.front.forces.find((f) => f.id === c.attackerId)!;
  const def = v2.front.forces.find((f) => f.id === c.defenderId)!;
  const playerAttacks = atk.side === 'blue';
  const trivial =
    atk.strength > 0 && def.strength > 0 &&
    (atk.strength >= def.strength * TRIVIAL_RATIO || def.strength >= atk.strength * TRIVIAL_RATIO);
  const siteName = c.site.kind === 'node' ? v2.front.theater.nodes[c.site.nodeId].name : 'the road';
  // Odds in plain words: the man reading this should not have to divide.
  const own = playerAttacks ? atk : def;
  const foe = playerAttacks ? def : atk;
  const ratio = Math.max(own.strength, foe.strength) / Math.max(1, Math.min(own.strength, foe.strength));
  const rtxt = ratio < 2 ? ratio.toFixed(1) : Math.round(ratio).toString();
  const odds =
    ratio < 1.1 ? 'Even match.' : own.strength > foe.strength ? `You outnumber them ${rtxt}:1.` : `They outnumber you ${rtxt}:1.`;
  const oddsLine = trivial ? `${odds} Auto-resolve is available at ${TRIVIAL_RATIO}:1.` : odds;
  const col = (f: typeof atk): string =>
    `<div class="fc-col ${f.side === 'blue' ? 'us' : 'ge'}"><h4>${f.name}</h4><p class="fc-str">${f.strength} men</p></div>`;
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1>CONTACT</h1>
    <p class="sub">${atk.name} has met ${def.name} at ${siteName}.</p>
    <div class="fc">${col(atk)}<div class="fc-vs">VS</div>${col(def)}</div>
    <p class="fc-odds">${oddsLine}</p>
    ${playerAttacks ? '' : '<p class="fc-odds fc-forced">They chose this fight. A defender cannot stand down.</p>'}
    </div></div>
    <div class="db-actions">
      <button id="fight" class="primary">${playerAttacks ? 'Attack' : 'Defend'}</button>
      ${trivial ? '<button id="autoresolve">Auto-resolve</button>' : ''}
      ${playerAttacks ? '<button id="standdown">Stand down</button>' : ''}
    </div>`;
  debriefEl.style.display = 'flex';
  document.getElementById('fight')!.onclick = () => {
    debriefEl.style.display = 'none';
    tutorial?.notify('contact-closed');
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
      debriefEl.style.display = 'none';
      v2.pending = null;
      tutorial?.notify('contact-closed');
      save();
    };
  }
  if (playerAttacks) {
    document.getElementById('standdown')!.onclick = () => {
      debriefEl.style.display = 'none';
      // Breaking contact is a MOVE, not a wish: a force left halted inside
      // CONTACT_M re-contacts every minute and the modal never stops. The
      // §3.6 retreat parks it beyond threat range; trapped = hold (a
      // voluntary order never annihilates its own force).
      retreatForce(v2.front, atk, null, { trapped: 'stay' });
      v2.pending = null;
      save();
      tutorial?.notify('contact-closed');
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

function renderDebrief(record: BattleRecord, redLosses: number, groundLine: string, onNext: () => void): void {
  const enemyLosses = redLosses > 0 ? `~${redLosses} enemy losses` : 'no enemy losses';
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1 class="${record.won ? 'win' : 'loss'}">${record.won ? 'VICTORY' : 'DEFEAT'}</h1>
    <p class="sub">${record.kia.length} KIA · ${record.wounded.length} wounded · ${enemyLosses}</p>
    <p class="fallen">${record.kia.length > 0 ? 'Fallen: ' + record.kia.join(', ') : 'No one died today.'}</p>
    <p class="sub">${groundLine}</p>
    ${debriefRows()}
    </div></div>
    <div class="db-actions"><button id="next" class="primary">Return to the front</button></div>`;
  debriefEl.style.display = 'flex';
  document.getElementById('next')!.onclick = onNext;
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
        red: new Commander2('red', RED_V2, goals, camp.warDays, { nightTempo: camp.nightTempo }),
        // OQ6 (A): identical fog and detection — red reads ghosts when the
        // campaign runs contacts, exactly as the player's map does.
        redIntel: camp.recon === 'contacts' ? new ContactIntel(front, 'red') : new OmniscientIntel(front, 'red'),
        view: Object.assign(new TheaterView(front.theater), { supplyOn: camp.supply, recon: camp.recon }),
        battle: null,
        pending: null,
        selectedForce: -1,
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
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1 class="${status === 'won' ? 'win' : 'loss'}">OPERATION ${status === 'won' ? 'ACCOMPLISHED' : 'FAILED'}</h1>
    <p class="sub">${S().campaign.log.length} battles fought over ${day} days · ${kia} men killed.</p>
    </div></div>
    <div class="db-actions"><button id="next" class="primary">New operation</button><button id="same">Same theater again</button></div>`;
  debriefEl.style.display = 'flex';
  document.getElementById('next')!.onclick = () => {
    debriefEl.style.display = 'none';
    mode = 'menu';
    mainMenu.setSaveProbe(probeSave());
    mainMenu.open();
  };
  document.getElementById('same')!.onclick = () => {
    debriefEl.style.display = 'none';
    const v2 = S().v2;
    if (v2) startCampaignV2({ kind: 'fresh', seed: v2.seed });
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
}

function tapSelect(sx: number, sy: number, additive: boolean): void {
  const [wx, wy] = cam.screenToWorld(sx, sy, view.w, view.h);
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

// The plain right-click: every selected squad, fanned on the y axis, narrowed
// to one team only where commitOrder's rule says so. The floor menu issues
// through here too (with `l` set), so "which units move" is one rule shared by
// both paths — and the same one previewMoveSpots mirrors.
function issueShortClick(wx: number, wy: number, squadForce: boolean, l?: number): void {
  const K = selectedSquads.length;
  const useArmed = armedOrder !== null && MOVE_FAMILY.includes(armedOrder);
  const kind: OrderKind = useArmed ? armedOrder! : 'move';
  const offs = fanOffsets(K, SQUAD_FAN);
  const primary = getPrimary();
  for (let i = 0; i < K; i++) {
    const id = selectedSquads[i];
    const order: TeamOrder = { kind, x: wx, y: wy + offs[i], l };
    if (useArmed || squadForce) {
      sim.orderSquad(id, order);
    } else if (selectedTeam >= 0 && id === primary) {
      sim.orderTeam(selectedTeam, order);
    } else {
      sim.orderSquad(id, order);
    }
  }
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
    sim.orderVehicleMove(selectedVehicle, wx, wy);
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
    for (let i = 0; i < K; i++) {
      const id = selectedSquads[i];
      const ax = rmbAnchor.wx + cos * offs[i];
      const ay = rmbAnchor.wy + sin * offs[i];
      const order: TeamOrder = { kind, x: ax, y: ay, facing, width: seg };
      sim.orderSquad(id, order);
    }
    if (useArmed) armedOrder = null;
  }

  rmbAnchor = null;
}

function stratTapSelect(sx: number, sy: number): void {
  const v2 = S().v2;
  if (v2) {
    v2.selectedForce = v2.view.forceAtScreen(v2.front, 'blue', sx, sy, view.w, view.h);
    if (v2.selectedForce >= 0) tutorial?.notify('force-selected');
    return;
  }
  const cell = S().stratView.cellAtScreen(sx, sy, view.w, view.h);
  const chit = cell >= 0 ? S().front.chitAt(cell, 'blue') : undefined;
  selectedChit = chit ? chit.id : -1;
  if (chit) {
    const t = document.getElementById('strat-hud');
    if (t) coach.maybeShow('first-strat-chit', t, 'Chit selected — right-click a cell to move. ✕ on a waypoint cancels it.');
  }
}

function stratOrderMove(sx: number, sy: number): void {
  const v2 = S().v2;
  if (v2) {
    if (v2.selectedForce < 0) return;
    const n = v2.view.nodeAtScreen(sx, sy, view.w, view.h);
    if (n < 0) return;
    const r = orderMove(v2.front, v2.selectedForce, n, { nightTempo: v2.campaignCfg.nightTempo });
    if (!r.ok) v2.view.flash(MOVE_REJECT_TEXT[r.reason]);
    else {
      v2.view.flash(`${v2.front.forces.find((f) => f.id === v2.selectedForce)!.name} moving — ETA ${Math.round(r.etaMin / 60)}h${Math.round(r.etaMin % 60)}m`);
      tutorial?.notify('move-ordered');
    }
    return;
  }
  if (selectedChit < 0) return;
  const cell = S().stratView.cellAtScreen(sx, sy, view.w, view.h);
  if (cell >= 0 && !S().front.orderMove(selectedChit, cell) && S().front.sector.cells[cell].terrain === 'river')
    S().stratView.flash("Can't hold open water — ford across to the far bank");
}

/** Esc's cancel ladder: targetMode → inspect → armedOrder → team → selection. */
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
  return false;
}

canvas.addEventListener('mousedown', (e) => {
  if (mode === 'menu') return;
  if (e.button === 0) beginBox(e.clientX, e.clientY);
  if (e.button === 2) beginOrderAnchor(e.clientX, e.clientY);
});
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.onCanvas = e.target === canvas;
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
    stratTapSelect(e.clientX, e.clientY);
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
  holdStart: () => {},
  holdMove: () => {},
  holdEnd: (x, y) => stratOrderMove(x, y),
  holdCancel: () => {},
  pinch: (factor, mx, my, dmx, dmy) => {
    const cam2 = stratCam();
    const before = cam2.zoomMul;
    cam2.zoomMul = Math.max(STRAT_ZOOM[0], Math.min(STRAT_ZOOM[1] * (S().v2 ? 2 : 1), before * factor));
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
  if (mode !== 'battle') return;
  // scroll = zoom (trackpad two-finger scroll, pinch, and mouse wheel alike);
  // ~1.003^px: a trackpad flick ramps fast, a mouse notch (dy≈100) ≈1.35×
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  cam.zoom(Math.pow(1.003, -dy), e.clientX, e.clientY, view.w, view.h);
});

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
    if (mode === 'strategic') { stratPaused = !stratPaused; tutorial?.notify('speed-changed'); }
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
    if (action.startsWith('speed')) tutorial?.notify('speed-changed');
    return;
  }
  
  // Battle mode
  if (action === 'aiControl') { aiControl = !aiControl; if (aiControl) { armedOrder = null; setTargetMode(''); } return; }
  if (action === 'barrage' && !aiControl && sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  if (action === 'airstrike' && !aiControl && sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
  
  if (action.startsWith('squad')) {
    const n = Number(action.slice(5)) - 1;
    const list = infantrySquads(sim);
    if (n >= 0 && n < list.length) selectSquad(list[n].id);
  }
  
  if (action.startsWith('order')) {
    const n = Number(action.slice(5)) - 1;
    if (n >= 0 && n < ORDER_KINDS.length) doArmOrder(ORDER_KINDS[n]);
  }
});

// Floor-focus filter (Height E2): All → Ground → Floor 2 → … → All. The F key
// drives it on desktop and the touch bar's ⬒ chip on a phone — one function, so
// the two surfaces cannot drift.
function cycleFloorFocus(): void {
  const maxStories = sim.map.maxStories;
  if (maxStories <= 0) return;
  floorFocus = floorFocus >= maxStories - 1 ? -1 : floorFocus + 1;
}

// Plain keydown listener — migrates into keymap.ts when the controls pass lands.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (mode !== 'battle' || menu.isOpen) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
  cycleFloorFocus();
});

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
  selectSquad: (i: number) => selectSquad(i),
  selectVehicle: (i: number) => selectVehicle(i),
  getCampaign: () => S().campaign,
  getV2: () => S().v2,
  startEngagementBattle,
  showDebrief,
  setFow: (on: boolean) => {
    sim.fowDisabled = !on;
  },
};

let last = performance.now();
let acc = 0;
const DT_MS = DT * 1000;

function frame(now: number): void {
  const dtReal = Math.min(now - last, 250);
  last = now;
  if (mode === 'battle' && panHeld.size > 0 && !menu.isOpen) {
    let pdx = 0;
    let pdy = 0;
    for (const [dx, dy] of panHeld.values()) { pdx += dx; pdy += dy; }
    const mag = Math.hypot(pdx, pdy);
    if (mag > 0) {
      const step = (PAN_PX_PER_SEC / cam.scale) * (dtReal / 1000) / mag;
      cam.x += pdx * step;
      cam.y += pdy * step;
    }
  }
  hud.root.style.display = mode === 'battle' ? '' : 'none';
  stratHud.root.style.display = mode === 'strategic' && !S().v2 ? '' : 'none';
  theaterHud.root.style.display = mode === 'strategic' && S().v2 ? '' : 'none';
  if (mode === 'menu') {
    requestAnimationFrame(frame);
    return;
  }
  if (mode === 'strategic' && S().v2) {
    const v2 = S().v2!;
    hud.updateIdle('strategic', v2.selectedForce >= 0 || stratPaused);
    if (!stratPaused && !v2.pending && !opEnded) {
      stratAcc += (dtReal / 1000) * SPEEDS[speedIdx];
      while (stratAcc >= 1 && !v2.pending) {
        stratAcc -= 1;
        stepTheaterMinuteV2(v2);
        if (v2.pending) showContactModalV2(v2.pending);
      }
      const st = warStatus(v2.front, v2.goals);
      if (st.state === 'decided') showOperationEnd(st.winner === 'blue' ? 'won' : 'lost');
    }
    v2.view.clampPan(view.w, view.h);
    v2.view.draw(ctx, v2.front, v2.selectedForce, stratPaused, SPEEDS[speedIdx], view.w, view.h);
    theaterHud.update(v2.front, v2.goals, v2.selectedForce, stratPaused, speedIdx, v2.campaignCfg.supply, v2.campaignCfg.recon === 'contacts', v2.campaignCfg.nightTempo);
    if (touchHold) drawHoldRing(ctx, touchHold, now);
  } else if (mode === 'strategic') {
    hud.updateIdle('strategic', selectedChit >= 0 || stratPaused);
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
    acc += dtReal;
    if (!paused) {
      // Catch-up guard. dtReal is capped at 250ms, which is up to 7 sim steps
      // in one frame — on a phone that already missed its budget that
      // guarantees it misses the next one worse, and the UI locks. Let the
      // sim run slow instead: 3 steps, then drop the debt. Mobile-gated, so
      // desktop determinism and the perf tests are untouched.
      let steps = 0;
      const maxSteps = MOBILE ? 3 : Infinity;
      while (acc >= DT_MS && steps < maxSteps) {
        commander.update(sim);
        if (aiControl) blueCommander?.update(sim);
        sim.step();
        acc -= DT_MS;
        steps++;
      }
      if (acc >= DT_MS) acc = 0;
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
    renderer.addEvents(shots, now);
    renderer.addMeleeEvents(melee, now);
    renderer.addBooms(booms, now);
    renderer.addBreaches(breaches, now);
    renderer.addPlanes(sim.takePlanes(), now);
    audio.addShots(shots, cam, cw, chh);
    audio.addMelee(melee, cam, cw, chh);
    audio.addBooms(booms, cam, cw, chh);
    audio.addBreaches(breaches, cam, cw, chh);
    // fog of war: enemy unit events only ping where a friendly can see
    const unitEvents = sim.takeUnitEvents().filter((e) => e.side === 'blue' || sim.fowDisabled || sim.sideSeesPoint('blue', e.x, e.y));
    pings.add(unitEvents, sim.tick);
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
    }
    renderer.draw(ctx, cam, selectedSquads, now, floorFocus);
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
        ? 'DEPLOYMENT — tap a squad, press and hold to reposition inside your zone · Resume to begin'
        : 'DEPLOYMENT — select squads, right-click to reposition inside your zone · Resume to begin';
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
    drawOverlays(ctx, cam, sim, {
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
    }, pings);
    if (touchHold) drawHoldRing(ctx, touchHold, now);
    tooltip.update(sim, pick, shot, mouse.x, mouse.y, pick?.kind === 'terrain' && (primary >= 0 || selectedVehicle >= 0));
    const km = loadKeymap(localStorage);
    let objective: HudState['objective'] = null;
    if (pendingEngagement) {
      const attacker = S().front.chits.find((c) => c.id === pendingEngagement!.attackerId);
      const defender = S().front.chits.find((c) => c.id === pendingEngagement!.defenderId);
      if (attacker && defender) {
        const cell = S().front.sector.cells[pendingEngagement!.cell];
        const xy = cellXY(S().front.sector, pendingEngagement!.cell);
        const cellLabel = `${String.fromCharCode(65 + (xy.x % 26))}${xy.y + 1}`;
        objective = {
          kind: attacker.side === 'blue' ? 'attack' : 'defend',
          cellLabel,
          isObjective: cell.objective,
          attackerName: attacker.name,
          defenderName: defender.name,
          attackerStrength: attacker.strength,
          defenderStrength: defender.strength,
        };
      }
    }
    hud.update(sim, { selectedSquad: primary, selectedSquads, selectedTeam, selectedVehicle, paused, aiControl, targetMode, armedOrder, title: battleTitle, keymap: km, objective, floorFocus, boxMode, addMode });
    hud.updateIdle('battle', targetMode !== '' || selectedSquads.length > 0 || selectedVehicle >= 0 || selectedTeam >= 0 || paused);
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
      // Same frame, same reason: the touch bar the coachmark points at only
      // exists once the HUD has rendered once.
      if (MOBILE) {
        const t = document.getElementById('touchbar');
        if (t) coach.maybeShow('touch-basics', t, 'Drag to pan · pinch to zoom · press and hold to give an order');
      }
      // Same frame, same reason: the deploy bubble points at the battle HUD's
      // pause control, which the update above has only just built.
      if (deployPhase) tutorial?.notify('deploy-start');
    }

    if (sim.winner && winnerAt < 0) winnerAt = now;
    if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  }
  requestAnimationFrame(frame);
}
// Boot: a campaign-defining URL param (?camp=N) bypasses the menu
// synchronously, so the harness scripts see a live session at module-eval end;
// ?menu=1 forces the menu even then. Bare boot lands on the menu — the save,
// if any, sits behind Continue instead of auto-loading.
const menuForced = new URLSearchParams(location.search).get('menu') === '1';
if (campPinned && !menuForced) {
  startCampaign(null);
} else {
  mainMenu.setSaveProbe(probeSave());
  mainMenu.open();
}
requestAnimationFrame(frame);
