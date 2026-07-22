import { advanceDays, fillReplacements, newCampaign, type Campaign } from './campaign/campaign';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { StrategicView, TERRAIN_LABELS } from './render/strategic';
import type { RedCommander } from './sim/ai';
import { WEAPONS } from './sim/data';
import { DT, type Sim } from './sim/sim';
import { applyEngagementOutcome, makeStrategicBattle, newFront, syncStrengths } from './strategic/bridge';
import { operationStatus, type Engagement, type Front } from './strategic/front';
import { loadGame, saveGame } from './strategic/save';
import { makeDefaultSector } from './strategic/sector';
import { Hud, infantrySquads } from './ui/hud';
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
let paused = true;
let selectedSquad = -1;
let selectedVehicle = -1;
let targetMode: '' | 'barrage' | 'air' = '';
let winnerAt = -1; // ms timestamp when winner appeared
let debriefShown = false;
const mouse = { x: 0, y: 0, onCanvas: false };
const pings = new EventPings();

function selectSquad(id: number): void {
  selectedSquad = id;
  selectedVehicle = -1;
  renderer.selectedVehicle = -1;
}

function selectVehicle(id: number): void {
  selectedVehicle = id;
  selectedSquad = -1;
  renderer.selectedVehicle = id;
}

function setTargetMode(m: '' | 'barrage' | 'air'): void {
  targetMode = m;
  canvas.style.cursor = m ? 'crosshair' : '';
}

const urlSeed = new URLSearchParams(location.search).get('seed'); // debug: ?seed=N pins the map
if (urlSeed !== null && !Number.isFinite(Number(urlSeed))) console.warn(`?seed=${urlSeed} is not a number; using 0`);

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
});
const tooltip = new Tooltip(hud.root);

function showContactModal(e: Engagement): void {
  const attacker = front.chits.find((c) => c.id === e.attackerId)!;
  const defender = front.chits.find((c) => c.id === e.defenderId)!;
  const cell = front.sector.cells[e.cell];
  const terrain = TERRAIN_LABELS[cell.terrain].toLowerCase();
  debriefEl.innerHTML = `<div class="db">
    <h1>CONTACT</h1>
    <p class="sub">${attacker.name} (${attacker.strength} men) has met ${defender.name} (~${defender.strength} men).</p>
    <p class="intel">Terrain: <b>${terrain}</b>${cell.objective ? ' <span class="obj">— objective</span>' : ''}</p>
    <div class="db-actions">
      <button id="fight" class="primary">Attack</button>
      <button id="standdown">Stand down</button>
    </div></div>`;
  debriefEl.style.display = 'block';
  document.getElementById('fight')!.onclick = () => startEngagementBattle(e);
  document.getElementById('standdown')!.onclick = () => {
    debriefEl.style.display = 'none';
    pendingEngagement = null;
  };
}

function startEngagementBattle(e: Engagement): void {
  const seed = urlSeed !== null ? Number(urlSeed) : front.clockMin * 7919 + e.cell;
  const battle = makeStrategicBattle(campaign, front, e, seed);
  sim = battle.sim;
  commander = battle.commander;
  battleCompany = battle.companyIndex;
  renderer = new Renderer(sim);
  battleTitle = `Day ${front.day} ${front.hhmm} — ${battle.name}`;
  const first = sim.soldiers.find((s) => s.side === 'blue');
  cam.x = first ? first.x + 12 : 60;
  cam.y = first ? first.y : 60;
  cam.scale = 8;
  mode = 'battle';
  paused = true;
  selectedSquad = -1;
  selectedVehicle = -1;
  setTargetMode('');
  winnerAt = -1;
  debriefShown = false;
  debriefEl.style.display = 'none';
  pings.reset();
}

function showDebrief(): void {
  debriefShown = true;
  const e = pendingEngagement!;
  const out = applyEngagementOutcome(campaign, front, e, sim);
  pendingEngagement = null;
  saveGame(campaign, front);

  const deployedPids = new Set(sim.soldiers.filter((s) => s.side === 'blue').map((s) => s.pid));
  const rows = campaign.companies[battleCompany].squads
    .map((si) => campaign.squads[si])
    .map((sq) => {
      const men = sq.members
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
  debriefEl.innerHTML = `<div class="db">
    <h1 class="${out.record.won ? 'win' : 'loss'}">${out.record.won ? 'VICTORY' : 'DEFEAT'}</h1>
    <p class="sub">${out.record.kia.length} KIA · ${out.record.wounded.length} wounded · ${enemyLosses}</p>
    <p class="fallen">${out.record.kia.length > 0 ? 'Fallen: ' + out.record.kia.join(', ') : 'No one died today.'}</p>
    <p class="sub">${out.cellTaken ? 'The ground is ours.' : 'The attack failed; the line is unchanged.'}</p>
    ${rows}
    <div class="db-actions"><button id="next" class="primary">Return to the front</button></div></div>`;
  debriefEl.style.display = 'block';
  document.getElementById('next')!.onclick = () => {
    debriefEl.style.display = 'none';
    mode = 'strategic';
    stratPaused = true;
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
}

function showOperationEnd(status: 'won' | 'lost'): void {
  opEnded = true;
  const kia = Object.values(campaign.soldiers).filter((s) => s.status === 'kia').length;
  debriefEl.innerHTML = `<div class="db">
    <h1 class="${status === 'won' ? 'win' : 'loss'}">OPERATION ${status === 'won' ? 'ACCOMPLISHED' : 'FAILED'}</h1>
    <p class="sub">${campaign.log.length} battles fought over ${front.day} days · ${kia} men killed.</p>
    <div class="db-actions"><button id="next" class="primary">New operation</button></div></div>`;
  debriefEl.style.display = 'block';
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
    } else {
      // vehicles first, then squads
      let vehicle = -1;
      for (const v of sim.vehicles) {
        if (v.alive && v.side === 'blue' && Math.hypot(v.x - wx, v.y - wy) < 3.5) vehicle = v.id;
      }
      if (vehicle >= 0) {
        selectVehicle(vehicle);
      } else {
        let best = -1;
        let bestD = 15 / cam.scale;
        for (const s of sim.soldiers) {
          if (!s.alive || s.side !== 'blue' || s.inVehicle >= 0) continue;
          const d = Math.hypot(s.x - wx, s.y - wy);
          if (d < bestD) {
            bestD = d;
            best = s.squadId;
          }
        }
        selectSquad(best);
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
    if (e.shiftKey) sim.queueMove(selectedSquad, wx, wy);
    else sim.orderMove(selectedSquad, wx, wy);
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
    const list = infantrySquads(sim);
    if (n >= 0 && n < list.length) selectSquad(list[n].id);
  }
  if (e.code === 'Escape') {
    selectSquad(-1);
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
  setPaused: (p: boolean) => {
    stratPaused = p;
    paused = p;
  },
  selectSquad: (i: number) => selectSquad(i),
  getCampaign: () => campaign,
  startEngagementBattle,
  showDebrief,
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
          fillReplacements(campaign, front.day * 31 + 7);
          syncStrengths(campaign, front);
          prevDay = front.day;
          saveGame(campaign, front);
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
    renderer.addEvents(sim.takeEvents(), now);
    renderer.addBooms(sim.takeBooms(), now);
    renderer.addPlanes(sim.takePlanes(), now);
    pings.add(sim.takeUnitEvents(), sim.tick);

    const pick = mouse.onCanvas && !targetMode ? pickAt(sim, cam, mouse.x, mouse.y, canvas.width, canvas.height) : null;
    const shot = computeShot(sim, selectedSquad, selectedVehicle, pick);

    renderer.draw(ctx, cam, selectedSquad, now);
    drawOverlays(ctx, cam, sim, { pick, shot, selectedSquad, targetMode }, pings);
    tooltip.update(sim, pick, shot, mouse.x, mouse.y, pick?.kind === 'terrain' && (selectedSquad >= 0 || selectedVehicle >= 0));
    hud.update(sim, { selectedSquad, selectedVehicle, paused, targetMode, title: battleTitle });

    if (sim.winner && winnerAt < 0) winnerAt = now;
    if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
