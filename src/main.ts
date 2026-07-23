import { advanceDays, fillReplacements, newCampaign, squadMembers, type Campaign } from './campaign/campaign';
import { AudioEngine } from './render/audio';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { StrategicView, TERRAIN_LABELS } from './render/strategic';
import type { RedCommander } from './sim/ai';
import { WEAPONS } from './sim/data';
import type { OrderKind, TeamOrder } from './sim/orders';
import { DT, type Sim, type Soldier } from './sim/sim';
import { applyEngagementOutcome, makeStrategicBattle, newFront, syncStrengths } from './strategic/bridge';
import { operationStatus, REINFORCE_CYCLE_DAYS, REINFORCE_PER_COMPANY, type Engagement, type Front } from './strategic/front';
import { loadGame, saveGame } from './strategic/save';
import { makeDefaultSector } from './strategic/sector';
import { emplacementOf, Hud, infantrySquads } from './ui/hud';
import { drawOverlays, EventPings } from './ui/overlays';
import { computeShot, pickAt, Tooltip } from './ui/tooltip';
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

// debug: ?camp=N pins the campaign seed and disables saving (screenshot
// harness reproducibility — a pinned campaign must never clobber a real save)
const urlCamp = new URLSearchParams(location.search).get('camp');
const campPinned = urlCamp !== null && Number.isFinite(Number(urlCamp));

let campaign: Campaign;
let front: Front;
const save = () => {
  if (!campPinned) saveGame(campaign, front);
};
const loaded = campPinned ? null : loadGame();
if (loaded) {
  campaign = loaded.campaign;
  front = loaded.front;
} else {
  campaign = newCampaign(campPinned ? Number(urlCamp) : Date.now() % 100000);
  front = newFront(campaign, makeDefaultSector());
  save();
}

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
let selectedSquad = -1;
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
  selectedSquad = id;
  selectedTeam = -1;
  selectedVehicle = -1;
  renderer.selectedVehicle = -1;
  armedOrder = null;
  if (id >= 0) lastTeamId = sim.squads[id].teamIds[0];
}

function selectVehicle(id: number): void {
  selectedVehicle = id;
  selectedSquad = -1;
  selectedTeam = -1;
  renderer.selectedVehicle = id;
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
    armedOrder = armedOrder === kind ? null : kind;
  },
  deployEmplacement: () => {
    const e = emplacementOf(sim, selectedSquad);
    if (e) sim.orderDeploy(e.id);
  },
  packEmplacement: () => {
    const e = emplacementOf(sim, selectedSquad);
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
const tooltip = new Tooltip(hud.root);

function showContactModal(e: Engagement): void {
  const attacker = front.chits.find((c) => c.id === e.attackerId)!;
  const defender = front.chits.find((c) => c.id === e.defenderId)!;
  const cell = front.sector.cells[e.cell];
  const terrain = TERRAIN_LABELS[cell.terrain].toLowerCase();
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1>CONTACT</h1>
    <p class="sub">${attacker.name} (${attacker.strength} men) has met ${defender.name} (~${defender.strength} men).</p>
    <p class="intel">Terrain: <b>${terrain}</b>${cell.objective ? ' <span class="obj">— objective</span>' : ''}</p>
    </div></div>
    <div class="db-actions">
      <button id="fight" class="primary">Attack</button>
      <button id="standdown">Stand down</button>
    </div>`;
  debriefEl.style.display = 'flex';
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
  selectedSquad = -1;
  selectedVehicle = -1;
  setTargetMode('');
  winnerAt = -1;
  debriefShown = false;
  debriefEl.style.display = 'none';
  pings.reset();
  tooltip.clear();
}

function showDebrief(): void {
  debriefShown = true;
  const e = pendingEngagement;
  if (!e) throw new Error('showDebrief: pendingEngagement is null — startEngagementBattle must set it');
  const out = applyEngagementOutcome(campaign, front, e, sim);
  pendingEngagement = null;
  save();

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

  const enemyLosses = out.redLosses > 0 ? `~${out.redLosses} enemy losses` : 'no enemy losses';
  debriefEl.innerHTML = `<div class="db-scroll"><div class="db">
    <h1 class="${out.record.won ? 'win' : 'loss'}">${out.record.won ? 'VICTORY' : 'DEFEAT'}</h1>
    <p class="sub">${out.record.kia.length} KIA · ${out.record.wounded.length} wounded · ${enemyLosses}</p>
    <p class="fallen">${out.record.kia.length > 0 ? 'Fallen: ' + out.record.kia.join(', ') : 'No one died today.'}</p>
    <p class="sub">${out.cellTaken ? 'The ground is ours.' : 'The attack failed; the line is unchanged.'}</p>
    ${rows}
    </div></div>
    <div class="db-actions"><button id="next" class="primary">Return to the front</button></div>`;
  debriefEl.style.display = 'flex';
  document.getElementById('next')!.onclick = () => {
    debriefEl.style.display = 'none';
    mode = 'strategic';
    stratPaused = true;
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
  save();
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

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    dragStart = { x: e.clientX, y: e.clientY };
    dragged = false;
  }
});
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.onCanvas = e.target === canvas;
  if (mode === 'battle' && dragStart && e.buttons & 1) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (dragged || Math.hypot(dx, dy) > 5) {
      dragged = true;
      cam.x -= dx / cam.scale;
      cam.y -= dy / cam.scale;
      dragStart = { x: e.clientX, y: e.clientY };
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
    dragStart = null;
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
      const e = emplacementOf(sim, selectedSquad);
      if (e) sim.orderWheel(e.id, wx, wy);
      setTargetMode('');
    } else if (targetMode === 'empfire') {
      const e = emplacementOf(sim, selectedSquad);
      if (e) sim.orderFire(e.id, wx, wy);
      setTargetMode('');
    } else if (targetMode === 'empsmoke') {
      const e = emplacementOf(sim, selectedSquad);
      if (e) sim.orderSmoke(e.id, wx, wy);
      setTargetMode('');
    } else {
      // vehicles first, then emplacement glyphs, then soldiers (narrowing team on a second click)
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
          selectSquad(empSquad);
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
          if (best && best.squadId === selectedSquad) {
            selectedTeam = best.teamId;
            lastTeamId = best.teamId;
          } else if (best) {
            selectSquad(best.squadId);
          } else {
            selectSquad(-1);
          }
        }
      }
    }
  }
  dragStart = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode === 'strategic') {
    if (selectedChit >= 0) {
      const cell = stratView.cellAtScreen(e.clientX, e.clientY, canvas.width, canvas.height);
      if (cell >= 0) front.orderMove(selectedChit, cell);
    }
    return;
  }
  if (targetMode !== '') return;
  const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
  if (selectedVehicle >= 0) sim.orderVehicleMove(selectedVehicle, wx, wy);
  else if (selectedSquad >= 0) {
    if (armedOrder) {
      const order: TeamOrder = { kind: armedOrder, x: wx, y: wy };
      if (selectedTeam >= 0) sim.orderTeam(selectedTeam, order);
      else sim.orderSquad(selectedSquad, order);
      armedOrder = null;
    } else if (e.shiftKey) {
      sim.queueMove(selectedSquad, wx, wy);
    } else if (selectedTeam >= 0) {
      sim.orderTeam(selectedTeam, { kind: 'move', x: wx, y: wy });
    } else {
      sim.orderSquad(selectedSquad, { kind: 'move', x: wx, y: wy });
    }
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (mode === 'battle') cam.zoom(Math.pow(1.1, -e.deltaY / 100), e.clientX, e.clientY, canvas.width, canvas.height);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (mode === 'strategic') stratPaused = !stratPaused;
    else paused = !paused;
  }
  if (e.code === 'KeyM') audio.toggleMute();
  if (mode === 'strategic') {
    if (e.code === 'Digit1') speedIdx = 0;
    if (e.code === 'Digit2') speedIdx = 1;
    if (e.code === 'Digit3') speedIdx = 2;
    if (e.code === 'Escape') selectedChit = -1;
    return;
  }
  if (e.code === 'KeyB' && sim.barragesLeft.blue > 0) setTargetMode(targetMode === 'barrage' ? '' : 'barrage');
  if (e.code === 'KeyA' && sim.airstrikesLeft.blue > 0) setTargetMode(targetMode === 'air' ? '' : 'air');
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5)) - 1;
    if (e.shiftKey) {
      // Order-kind hotbar: plain digits already own squad selection (below),
      // so order kinds live on shift+digit — see Task 13 commit message.
      if (n >= 0 && n < ORDER_KINDS.length) armedOrder = armedOrder === ORDER_KINDS[n] ? null : ORDER_KINDS[n];
    } else {
      const list = infantrySquads(sim);
      if (n >= 0 && n < list.length) selectSquad(list[n].id);
    }
  }
  if (e.code === 'Escape') {
    if (selectedTeam >= 0) selectedTeam = -1;
    else selectSquad(-1);
    armedOrder = null;
    setTargetMode('');
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
  if (mode === 'strategic') {
    if (!stratPaused && !pendingEngagement && !opEnded) {
      stratAcc += (dtReal / 1000) * SPEEDS[speedIdx];
      while (stratAcc >= 1 && !pendingEngagement) {
        stratAcc -= 1;
        const e = front.step();
        if (front.day > prevDay) {
          advanceDays(campaign, front.day - prevDay);
          if (front.day % REINFORCE_CYCLE_DAYS === 0) {
            const arrived = fillReplacements(campaign, front.day * 31 + 7, REINFORCE_PER_COMPANY);
            if (arrived > 0) stratView.flash(`+${arrived} replacements arrived`);
          }
          syncStrengths(campaign, front);
          prevDay = front.day;
          save();
        }
        if (e) {
          pendingEngagement = e;
          stratPaused = true;
          showContactModal(e);
        }
      }
      const status = operationStatus(front);
      if (status !== 'ongoing') showOperationEnd(status);
    }
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
    const shot = computeShot(sim, selectedSquad, selectedVehicle, pick);
    const cursor = mouse.onCanvas ? cam.screenToWorld(mouse.x, mouse.y, canvas.width, canvas.height) : null;
    const focusTeams = selectedSquad < 0 ? [] : selectedTeam >= 0 ? [selectedTeam] : sim.squads[selectedSquad].teamIds;

    renderer.draw(ctx, cam, selectedSquad, now);
    drawOverlays(ctx, cam, sim, { pick, shot, selectedSquad, targetMode, focusTeams, armedOrder, cursor: cursor && { x: cursor[0], y: cursor[1] } }, pings);
    tooltip.update(sim, pick, shot, mouse.x, mouse.y, pick?.kind === 'terrain' && (selectedSquad >= 0 || selectedVehicle >= 0));
    hud.update(sim, { selectedSquad, selectedTeam, selectedVehicle, paused, targetMode, armedOrder, title: battleTitle });

    if (sim.winner && winnerAt < 0) winnerAt = now;
    if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
