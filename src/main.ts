import { cellXY } from './strategic/sector';
import { advanceDays, fillReplacements, newCampaign, squadMembers, type Campaign } from './campaign/campaign';
import { AudioEngine } from './render/audio';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { StrategicView, TERRAIN_LABELS } from './render/strategic';
import type { RedCommander } from './sim/ai';
import { WEAPONS } from './sim/data';
import type { OrderKind, TeamOrder } from './sim/orders';
import { DT, fanOffsets, SQUAD_FAN, type Side, type Sim, type Soldier } from './sim/sim';
import { applyEngagementOutcome, makeStrategicBattle, newFront, resolveCoarse, syncStrengths } from './strategic/bridge';
import { StrategicCommander, RED_DEFENDER, BLUE_ATTACKER } from './strategic/command';
import { operationStatus, REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY, type Chit, type Engagement, type Front } from './strategic/front';
import { loadGame, saveGame } from './strategic/save';
import { makeDefaultSector } from './strategic/sector';
import { emplacementOf, Hud, infantrySquads, type HudState } from './ui/hud';
import { StratHud } from './ui/strat-hud';
import { drawOverlays, EventPings } from './ui/overlays';
import { computeShot, pickAt, Tooltip } from './ui/tooltip';
import { actionForEvent, formatBinding, loadKeymap, type Keymap } from './ui/keymap';
import { PauseMenu } from './ui/menu';
import { coach } from './ui/coach';
import './ui/ui.css';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d')!;
const resize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
};
resize();
window.addEventListener('resize', resize);

const debriefEl = document.createElement('div');
debriefEl.id = 'debrief';
document.body.appendChild(debriefEl);

let campaign: Campaign;
let front: Front;
const loaded = loadGame();
if (loaded) {
  campaign = loaded.campaign;
  front = loaded.front;
} else {
  campaign = newCampaign(Date.now() % 100000);
  front = newFront(campaign, makeDefaultSector());
  saveGame(campaign, front);
}

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

let mode: 'strategic' | 'battle' = 'strategic';
let stratView = new StrategicView(front.sector);
let selectedChit = -1;
const SPEEDS = [1, 10, 60]; // strategic minutes per real second
let speedIdx = 1;
let stratPaused = true;
let stratAcc = 0;
let prevDay = front.day;
let pendingEngagement: Engagement | null = null;
let opEnded = false;

// battle state
let sim: Sim;
let commander: RedCommander;
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
let selectedVehicle = -1;
let lastTeamId = -1; // most recently selected team, survives a later vehicle selection (Mount reads this)
let armedOrder: OrderKind | null = null; // order kind armed via ⇧1-7 / order bar, issued by right-click
let targetMode: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke' = '';
let winnerAt = -1; // ms timestamp when winner appeared
let debriefShown = false;
const mouse = { x: 0, y: 0, onCanvas: false };
const pings = new EventPings();

function selectSquad(id: number): void {
  selectedSquads = id < 0 ? [] : [id];
  selectedTeam = -1;
  selectedVehicle = -1;
  if (renderer) renderer.selectedVehicle = -1;
  armedOrder = null;
  if (id >= 0) lastTeamId = sim.squads[id].teamIds[0];
  if (id >= 0 && mode === 'battle') {
    const t = document.getElementById('squads');
    if (t) coach.maybeShow('first-squad-select', t, 'Select a squad, then right-click to move. Shift+1-8 arms an order.');
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
    const t = btn ?? document.getElementById('squads');
    if (t) coach.maybeShow('first-order-arm', t, 'Order armed — right-click to issue. Shift+right-click queues a waypoint.');
  }
}

function selectVehicle(id: number): void {
  selectedVehicle = id;
  selectedSquads = [];
  selectedTeam = -1;
  if (renderer) renderer.selectedVehicle = id;
}

function setTargetMode(m: '' | 'barrage' | 'air' | 'wheel' | 'empfire' | 'empsmoke'): void {
  targetMode = m;
  canvas.style.cursor = m ? 'crosshair' : '';
}

const urlSeed = new URLSearchParams(location.search).get('seed'); // debug: ?seed=N pins the map
if (urlSeed !== null && !Number.isFinite(Number(urlSeed))) console.warn(`?seed=${urlSeed} is not a number; ignoring`);
const fowOff = new URLSearchParams(location.search).get('fow') === '0'; // debug: ?fow=0 disables fog of war (render-only; never touches sim outcomes)
const hud = new Hud({
  selectSquad,
  selectVehicle,
  panToSoldier: (id) => {
    const s = sim.soldiers[id];
    cam.x = s.x;
    cam.y = s.y;
  },
  callBarrage: () => {
    if (sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  },
  callAirstrike: () => {
    if (sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
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
});
const stratHud = new StratHud();
const tooltip = new Tooltip(hud.root);
let pauseBeforeMenu: boolean | null = null;
const menu = new PauseMenu({
  onResume: () => {
    if (pauseBeforeMenu === null) return;
    if (mode === 'strategic') stratPaused = pauseBeforeMenu;
    else paused = pauseBeforeMenu;
    pauseBeforeMenu = null;
  },
  onKeymapChanged: (km: Keymap) => { hud.setKeymap(km); }
});
menu.setKeymap(loadKeymap(localStorage));

function showContactModal(e: Engagement): void {
  const attacker = front.chits.find((c) => c.id === e.attackerId)!;
  const defender = front.chits.find((c) => c.id === e.defenderId)!;
  const cell = front.sector.cells[e.cell];
  const terrain = TERRAIN_LABELS[cell.terrain].toLowerCase();
  const forceCol = (c: Chit): string => {
    const cls = c.side === 'blue' ? 'us' : 'ge';
    let str = `~${c.strength} men`;
    let comp = 'enemy — composition unknown';
    if (c.companyIndex >= 0) {
      const squads = campaign.companies[c.companyIndex].squads.map((si) => campaign.squads[si]);
      const fit = squads.flatMap(squadMembers).map((pid) => campaign.soldiers[pid]).filter((s) => s.status !== 'kia');
      const tally = new Map<string, number>();
      for (const s of fit) tally.set(s.weapon, (tally.get(s.weapon) ?? 0) + 1);
      const weapons = [...tally].map(([w, n]) => `${n} ${WEAPONS[w as keyof typeof WEAPONS].name}`).join(' · ');
      str = `${c.strength} men`;
      comp = `${squads.length} squads · ${fit.length} fit<br>${weapons}`;
    }
    return `<div class="fc-col ${cls}"><h4>${c.name}</h4><p class="fc-str">${str}</p><p class="fc-comp">${comp}</p></div>`;
  };
  const objectives = front.sector.cells.filter((c) => c.objective);
  const held = objectives.filter((c) => c.owner === 'blue').length;
  const stakes = cell.objective
    ? `Objective — ${held}/${objectives.length} held toward victory`
    : 'Front cell — losing shifts the front line';
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1>CONTACT</h1>
    <p class="sub">${attacker.name} has met ${defender.name}.</p>
    <div class="fc">${forceCol(attacker)}<div class="fc-vs">VS</div>${forceCol(defender)}</div>
    <p class="intel">Terrain: <b>${terrain}</b>${cell.objective ? ' <span class="obj">— objective</span>' : ''}</p>
    <p class="stakes">Stakes: ${stakes}</p>
    </div></div>
    <div class="db-actions">
      <button id="fight" class="primary">Attack</button>
      <button id="standdown">Stand down</button>
    </div>`;
  debriefEl.style.display = 'flex';
  {
    const fight = document.getElementById('fight');
    coach.maybeShow('first-engagement', fight ?? debriefEl, 'Staging — review the force comparison, then Attack or Stand down.');
  }
  document.getElementById('fight')!.onclick = () => startEngagementBattle(e);
  document.getElementById('standdown')!.onclick = () => {
    debriefEl.style.display = 'none';
    pendingEngagement = null;
  };
}

// Boot framing: fit the whole map when the viewport allows ≥3 px/m (the
// threshold ui.md already treats as "whole map fits" for the strategic map
// zoom-out); otherwise frame ~120m across around the blue spawn centroid so
// the view isn't half dead space off the map edge.
function bootCamera(s: Sim, cw: number, ch: number): { x: number; y: number; scale: number } {
  const fit = Math.min(cw / s.map.w, ch / s.map.h);
  if (fit >= 3) return { x: s.map.w / 2, y: s.map.h / 2, scale: fit };
  const blue = s.soldiers.filter((sd) => sd.side === 'blue');
  const cx = blue.length ? blue.reduce((a, sd) => a + sd.x, 0) / blue.length : s.map.w / 2;
  const cy = blue.length ? blue.reduce((a, sd) => a + sd.y, 0) / blue.length : s.map.h / 2;
  return { x: cx, y: cy, scale: Math.min(48, Math.max(2, cw / 120)) };
}

function startEngagementBattle(e: Engagement): void {
  pendingEngagement = e;
  const seed = urlSeed !== null && Number.isFinite(Number(urlSeed)) ? Number(urlSeed) : front.clockMin * 7919 + e.cell;
  const battle = makeStrategicBattle(campaign, front, e, seed);
  sim = battle.sim;
  sim.fowDisabled = fowOff;
  commander = battle.commander;
  battleCompany = battle.companyIndex;
  renderer = new Renderer(sim);
  battleTitle = `Day ${front.day} ${front.hhmm} — ${battle.name}`;
  const boot = bootCamera(sim, canvas.width, canvas.height);
  cam.x = boot.x;
  cam.y = boot.y;
  cam.scale = boot.scale;
  mode = 'battle';
  paused = true;
  selectedSquads = [];
  selectedVehicle = -1;
  setTargetMode('');
  winnerAt = -1;
  debriefShown = false;
  debriefEl.style.display = 'none';
  boxRect = null;
  pings.reset();
  tooltip.clear();
}

function showDebrief(): void {
  debriefShown = true;
  const e = pendingEngagement;
  if (!e) throw new Error('showDebrief: pendingEngagement is null — startEngagementBattle must set it');
  const blueAttacked = front.chits.find((ch) => ch.id === e.attackerId)!.side === 'blue';
  const out = applyEngagementOutcome(campaign, front, e, sim);
  pendingEngagement = null;
  saveGame(campaign, front);

  const deployedPids = new Set(sim.soldiers.filter((s) => s.side === 'blue').map((s) => s.pid));
  const rows = campaign.companies[battleCompany].squads
    .map((si) => campaign.squads[si])
    .map((sq) => {
      const men = squadMembers(sq)
        .map((pid) => campaign.soldiers[pid])
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

  const groundLine = out.cellTaken
    ? blueAttacked ? 'The ground is ours.' : 'The position is lost.'
    : blueAttacked ? 'The attack failed; the line is unchanged.' : 'The line held.';
  const enemyLosses = out.redLosses > 0 ? `~${out.redLosses} enemy losses` : 'no enemy losses';
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1 class="${out.record.won ? 'win' : 'loss'}">${out.record.won ? 'VICTORY' : 'DEFEAT'}</h1>
    <p class="sub">${out.record.kia.length} KIA · ${out.record.wounded.length} wounded · ${enemyLosses}</p>
    <p class="fallen">${out.record.kia.length > 0 ? 'Fallen: ' + out.record.kia.join(', ') : 'No one died today.'}</p>
    <p class="sub">${groundLine}</p>
    ${rows}
    </div></div>
    <div class="db-actions"><button id="next" class="primary">Return to the front</button></div>`;
  debriefEl.style.display = 'flex';
  document.getElementById('next')!.onclick = () => {
    debriefEl.style.display = 'none';
    mode = 'strategic';
    stratPaused = !(aiSides.has('red') && aiSides.has('blue'));
    tooltip.clear();
  };
}

function freshCampaign(): void {
  campaign = newCampaign(Date.now() % 100000);
  front = newFront(campaign, makeDefaultSector());
  stratView = new StrategicView(front.sector);
  selectedChit = -1;
  pendingEngagement = null;
  opEnded = false;
  prevDay = front.day;
  stratPaused = true;
  saveGame(campaign, front);
  buildCommanders();
}

function showOperationEnd(status: 'won' | 'lost'): void {
  opEnded = true;
  const kia = Object.values(campaign.soldiers).filter((s) => s.status === 'kia').length;
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1 class="${status === 'won' ? 'win' : 'loss'}">OPERATION ${status === 'won' ? 'ACCOMPLISHED' : 'FAILED'}</h1>
    <p class="sub">${campaign.log.length} battles fought over ${front.day} days · ${kia} men killed.</p>
    </div></div>
    <div class="db-actions"><button id="next" class="primary">New operation</button></div>`;
  debriefEl.style.display = 'flex';
  document.getElementById('next')!.onclick = () => {
    debriefEl.style.display = 'none';
    freshCampaign();
  };
}

let dragStart: { x: number; y: number } | null = null;
let dragged = false;
let boxRect: { x: number; y: number; w: number; h: number } | null = null;
let rmbDown = false;
let rmbAnchor: { sx: number; sy: number; wx: number; wy: number } | null = null;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    dragStart = { x: e.clientX, y: e.clientY };
    dragged = false;
    boxRect = null;
  }
  if (e.button === 2) {
    rmbDown = true;
    const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
    rmbAnchor = { sx: e.clientX, sy: e.clientY, wx, wy };
  }
});
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.onCanvas = e.target === canvas;
  if (mode !== 'battle') return;
  if (dragStart && e.buttons & 1) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (dragged || Math.hypot(dx, dy) > 5) {
      if (!dragged) { dragged = true; boxRect = null; }
      // Box select
      const x0 = dragStart.x;
      const y0 = dragStart.y;
      const x1 = e.clientX;
      const y1 = e.clientY;
      boxRect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
  }
});
canvas.addEventListener('mouseleave', () => {
  // window 'mousemove' only updates mouse.onCanvas on movement, so a cursor
  // that exits the canvas and stops (e.g. leaves the browser window) would
  // otherwise leave the tooltip frozen on stale content forever.
  mouse.onCanvas = false;
});
canvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  
  if (mode === 'strategic') {
    const cell = stratView.cellAtScreen(e.clientX, e.clientY, canvas.width, canvas.height);
    const chit = cell >= 0 ? front.chitAt(cell, 'blue') : undefined;
    selectedChit = chit ? chit.id : -1;
    if (chit) {
      const t = document.getElementById('strat-hud');
      if (t) coach.maybeShow('first-strat-chit', t, 'Chit selected — right-click a cell to move. ✕ on a waypoint cancels it.');
    }
    dragStart = null;
    boxRect = null;
    return;
  }
  
  if (boxRect && dragged) {
    // Box-select completion
    const [wx0, wy0] = cam.screenToWorld(boxRect.x, boxRect.y, canvas.width, canvas.height);
    const [wx1, wy1] = cam.screenToWorld(boxRect.x + boxRect.w, boxRect.y + boxRect.h, canvas.width, canvas.height);
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
    if (e.shiftKey) {
      for (const id of found) { if (!selectedSquads.includes(id)) selectedSquads.push(id); }
    } else {
      selectedSquads = found;
    }
    selectedTeam = -1;
    dragStart = null;
    boxRect = null;
    return;
  }
  
  if (!dragged) {
    const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
    if (targetMode === 'barrage') {
      if (sim.callBarrage('blue', wx, wy)) {
        setTargetMode('');
        renderer.markBarrage(wx, wy);
      }
    } else if (targetMode === 'air') {
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
          if (e.shiftKey) toggleSquadSelection(empSquad);
          else selectSquad(empSquad);
        } else {
          let best: Soldier | null = null;
          let bestD = 15 / cam.scale;
          for (const s of sim.soldiers) {
            if (!s.alive || s.side !== 'blue' || s.inVehicle >= 0) continue;
            const d = Math.hypot(s.x - wx, s.y - wy);
            if (d < bestD) {
              bestD = d;
              best = s;
            }
          }
          if (best && best.squadId === getPrimary() && selectedSquads.length === 1) {
            selectedTeam = best.teamId;
            lastTeamId = best.teamId;
          } else if (best) {
            if (e.shiftKey) toggleSquadSelection(best.squadId);
            else selectSquad(best.squadId);
          } else if (!e.shiftKey) {
            selectSquad(-1);
          }
        }
      }
    }
  }
  dragStart = null;
  boxRect = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode === 'strategic') {
    if (selectedChit >= 0) {
      const cell = stratView.cellAtScreen(e.clientX, e.clientY, canvas.width, canvas.height);
      if (cell >= 0 && !front.orderMove(selectedChit, cell) && front.sector.cells[cell].terrain === 'river')
        stratView.flash("Can't hold open water — ford across to the far bank");
    }
    return;
  }
  // Right-click in battle: handling moved to mouseup on button 2 via a
  // separate listener below.
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 2) return;
  if (!rmbDown || !rmbAnchor) { rmbDown = false; rmbAnchor = null; return; }
  rmbDown = false;
  
  if (mode === 'strategic') {
    rmbAnchor = null;
    return;
  }
  if (targetMode !== '') { rmbAnchor = null; return; }
  
  const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
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
  
  // Move-family kinds that support formation orders
  const MOVE_FAMILY: OrderKind[] = ['move', 'fast', 'sneak', 'assault', 'defend', 'ambush'];
  const useArmed = armedOrder && MOVE_FAMILY.includes(armedOrder);
  const kind: OrderKind = useArmed ? armedOrder! : 'move';
  
  if (len < 2) {
    // Plain right-click (short drag): legacy behavior with squad fan
    const offs = fanOffsets(K, SQUAD_FAN);
    const primary = getPrimary();
    for (let i = 0; i < K; i++) {
      const id = selectedSquads[i];
      const order: TeamOrder = { kind, x: wx, y: wy + offs[i] };
      if (useArmed || e.shiftKey) {
        sim.orderSquad(id, order);
      } else if (selectedTeam >= 0 && id === primary) {
        sim.orderTeam(selectedTeam, order);
      } else {
        sim.orderSquad(id, order);
      }
    }
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
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (mode !== 'battle') return;
  if (e.ctrlKey || e.shiftKey) {
    cam.zoom(Math.pow(1.1, -e.deltaY / 100), e.clientX, e.clientY, canvas.width, canvas.height);
  } else {
    cam.x -= e.deltaX / cam.scale;
    cam.y -= e.deltaY / cam.scale;
  }
});
window.addEventListener('keydown', (e) => {
  if (menu.isOpen) {
    // rebind capture handles keys first (capture phase); menu/cancel closes
    const action = actionForEvent(e, loadKeymap(localStorage));
    if (action === 'menu' || action === 'cancel') { e.preventDefault(); menu.close(); }
    return;
  }
  
  const km = loadKeymap(localStorage);
  const action = actionForEvent(e, km);
  if (!action) return;
  
  e.preventDefault();
  
  // Global actions
  if (action === 'pause') {
    if (mode === 'strategic') stratPaused = !stratPaused;
    else paused = !paused;
    return;
  }
  if (action === 'mute') { audio.toggleMute(); return; }
  if (action === 'menu' || action === 'cancel') {
    let consumed = false;
    if (mode === 'strategic') {
      if (selectedChit >= 0) { selectedChit = -1; consumed = true; }
    } else {
      if (targetMode) { setTargetMode(''); consumed = true; }
      else if (armedOrder) { armedOrder = null; consumed = true; }
      else if (selectedTeam >= 0) { selectedTeam = -1; consumed = true; }
      else if (selectedSquads.length > 0) { selectSquad(-1); consumed = true; }
    }
    if (!consumed) {
      pauseBeforeMenu = mode === 'strategic' ? stratPaused : paused;
      if (mode === 'strategic') stratPaused = true;
      else paused = true;
      menu.setKeymap(km);
      menu.open();
    }
    return;
  }
  
  if (mode === 'strategic') {
    if (action === 'speed1') speedIdx = 0;
    if (action === 'speed2') speedIdx = 1;
    if (action === 'speed3') speedIdx = 2;
    return;
  }
  
  // Battle mode
  if (action === 'barrage' && sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  if (action === 'airstrike' && sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
  
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

// debug/automation handle
(window as unknown as { __game: object }).__game = {
  get sim() {
    return sim;
  },
  get front() {
    return front;
  },
  commanders,
  cam,
  audio,
  setPaused: (p: boolean) => {
    stratPaused = p;
    paused = p;
  },
  selectSquad: (i: number) => selectSquad(i),
  selectVehicle: (i: number) => selectVehicle(i),
  getCampaign: () => campaign,
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
  hud.root.style.display = mode === 'battle' ? '' : 'none';
  stratHud.root.style.display = mode === 'strategic' ? '' : 'none';
  if (mode === 'strategic') {
    hud.updateIdle('strategic', selectedChit >= 0 || stratPaused);
    stratHud.update(front, campaign, selectedChit, stratPaused);
    if (!stratPaused && !pendingEngagement && !opEnded) {
      stratAcc += (dtReal / 1000) * SPEEDS[speedIdx];
      while (stratAcc >= 1 && !pendingEngagement) {
        stratAcc -= 1;
        for (const cmd of commanders) cmd.evaluate(front);
        const e = front.step();
        if (front.day > prevDay) {
          advanceDays(campaign, front.day - prevDay);
          if (front.day % REINFORCE_CYCLE_DAYS === 0) {
            const arrived = fillReplacements(campaign, front.day * 31 + 7, REINFORCE_PER_COMPANY);
            if (arrived > 0) stratView.flash(`+${arrived} replacements arrived`);
          }
          syncStrengths(campaign, front);
          prevDay = front.day;
          saveGame(campaign, front);
        }
        if (e) {
          const attacker = front.chits.find((c) => c.id === e.attackerId)!;
          const defender = front.chits.find((c) => c.id === e.defenderId)!;
          const attackerIsAI = aiSides.has(attacker.side);
          const defenderIsAI = aiSides.has(defender.side);
          
          if (attackerIsAI && defenderIsAI) {
            const result = resolveCoarse(campaign, front, e);
            stratView.flash(`${attacker.name} vs ${defender.name}: ${result.record.won ? 'attacker wins' : 'defender holds'}`);
            saveGame(campaign, front);
          } else if (attackerIsAI && !defenderIsAI) {
            pendingEngagement = e;
            stratPaused = true;
            startEngagementBattle(e);
          } else {
            pendingEngagement = e;
            stratPaused = true;
            showContactModal(e);
          }
        }
      }
      const status = operationStatus(front);
      if (status !== 'ongoing') showOperationEnd(status);
    }
    stratHud.update(front, campaign, selectedChit, stratPaused);
    stratView.stagedCell = pendingEngagement ? pendingEngagement.cell : -1;
    stratView.draw(ctx, front, selectedChit, stratPaused, SPEEDS[speedIdx], canvas.width, canvas.height);
  } else {
    acc += dtReal;
    if (!paused) {
      while (acc >= DT_MS) {
        commander.update(sim);
        sim.step();
        acc -= DT_MS;
      }
    } else {
      acc = 0;
    }
    const cw = canvas.width;
    const chh = canvas.height;
    const shots = sim.takeEvents();
    const melee = sim.takeMeleeEvents();
    const booms = sim.takeBooms();
    renderer.addEvents(shots, now);
    renderer.addMeleeEvents(melee, now);
    renderer.addBooms(booms, now);
    renderer.addPlanes(sim.takePlanes(), now);
    audio.addShots(shots, cam, cw, chh);
    audio.addMelee(melee, cam, cw, chh);
    audio.addBooms(booms, cam, cw, chh);
    // fog of war: enemy unit events only ping where a friendly can see
    const unitEvents = sim.takeUnitEvents().filter((e) => e.side === 'blue' || sim.fowDisabled || sim.sideSeesPoint('blue', e.x, e.y));
    pings.add(unitEvents, sim.tick);
    audio.addUnitEvents(unitEvents);

    const pick = mouse.onCanvas && !targetMode ? pickAt(sim, cam, mouse.x, mouse.y, canvas.width, canvas.height) : null;
    const shot = computeShot(sim, getPrimary(), selectedVehicle, pick);
    const cursor = mouse.onCanvas ? cam.screenToWorld(mouse.x, mouse.y, canvas.width, canvas.height) : null;
    const primary = getPrimary();
    const primarySquad = sim.squads[primary];
    const focusTeams = primary < 0 ? [] : selectedTeam >= 0 ? [selectedTeam] : primarySquad?.teamIds ?? [];

    // Formation drag state for overlays
    let formationDrag: { ax: number; ay: number; facing: number; width: number } | null = null;
    if (rmbDown && rmbAnchor) {
      const [cx, cy] = cam.screenToWorld(mouse.x, mouse.y, canvas.width, canvas.height);
      const wdx = cx - rmbAnchor.wx;
      const wdy = cy - rmbAnchor.wy;
      const len = Math.hypot(wdx, wdy);
      if (len >= 2) {
        formationDrag = { ax: rmbAnchor.wx, ay: rmbAnchor.wy, facing: Math.atan2(wdy, wdx), width: Math.max(3, Math.min(60, len)) };
      }
    }

    renderer.draw(ctx, cam, selectedSquads, now);
    drawOverlays(ctx, cam, sim, {
      pick, shot,
      selectedSquad: primary,
      selectedSquads,
      selectRect: boxRect,
      formationDrag,
      targetMode,
      focusTeams,
      armedOrder,
      cursor: cursor && { x: cursor[0], y: cursor[1] }
    }, pings);
    tooltip.update(sim, pick, shot, mouse.x, mouse.y, pick?.kind === 'terrain' && (primary >= 0 || selectedVehicle >= 0));
    const km = loadKeymap(localStorage);
    let objective: HudState['objective'] = null;
    if (pendingEngagement) {
      const attacker = front.chits.find((c) => c.id === pendingEngagement!.attackerId);
      const defender = front.chits.find((c) => c.id === pendingEngagement!.defenderId);
      if (attacker && defender) {
        const cell = front.sector.cells[pendingEngagement!.cell];
        const xy = cellXY(front.sector, pendingEngagement!.cell);
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
    hud.update(sim, { selectedSquad: primary, selectedSquads, selectedTeam, selectedVehicle, paused, targetMode, armedOrder, title: battleTitle, keymap: km, objective });
    hud.updateIdle('battle', targetMode !== '' || selectedSquads.length > 0 || selectedVehicle >= 0 || selectedTeam >= 0 || paused);

    if (sim.winner && winnerAt < 0) winnerAt = now;
    if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
