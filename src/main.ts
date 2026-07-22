import {
  advanceDays,
  applyBattleResults,
  BATTLES_PER_OPERATION,
  DAYS_BETWEEN_BATTLES,
  fillReplacements,
  loadCampaign,
  newCampaign,
  saveCampaign,
  type Campaign,
} from './campaign/campaign';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import type { RedCommander } from './sim/ai';
import { WEAPONS } from './sim/data';
import { makeCampaignBattle } from './sim/scenario';
import { DT, type Sim } from './sim/sim';
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

let campaign: Campaign = loadCampaign() ?? newCampaign(Date.now() % 100000);
let sim: Sim;
let commander: RedCommander;
let renderer: Renderer;
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
  togglePause: () => (paused = !paused),
});
const tooltip = new Tooltip(hud.root);

function startBattle(): void {
  const seed = urlSeed !== null ? Number(urlSeed) : campaign.day * 7919 + campaign.battleIndex;
  const battle = makeCampaignBattle(campaign, seed);
  sim = battle.sim;
  commander = battle.commander;
  renderer = new Renderer(sim);
  battleTitle = `Day ${campaign.day}: ${battle.name}`;
  cam.x = battle.camStart.x;
  cam.y = battle.camStart.y;
  cam.scale = 8;
  paused = true;
  selectedSquad = -1;
  selectedVehicle = -1;
  setTargetMode('');
  winnerAt = -1;
  debriefShown = false;
  debriefEl.style.display = 'none';
}

function showDebrief(): void {
  debriefShown = true;
  const won = sim.winner === 'blue';
  const record = applyBattleResults(campaign, sim, won);
  advanceDays(campaign, DAYS_BETWEEN_BATTLES);
  const replacements = fillReplacements(campaign, campaign.day * 31 + 7);
  saveCampaign(campaign);

  const operationOver = campaign.battleIndex >= BATTLES_PER_OPERATION;
  const rows = campaign.squads
    .map((sq) => {
      const men = sq.members
        .map((pid) => campaign.soldiers[pid])
        .map((cs) => {
          const scars = cs.bodyDamage.some((d) => d > 0) && cs.status === 'fit' ? ' <span class="scar">permanent injury</span>' : '';
          const st = cs.status === 'kia' ? 'KIA' : cs.status === 'recovering' ? `recovering (${cs.recoveryDays}d)` : 'fit';
          const cls = cs.status === 'kia' ? ' class="kia"' : cs.status === 'recovering' ? ' class="rec"' : '';
          return `<tr${cls}><td>${cs.name}</td><td>${WEAPONS[cs.weapon].name}</td><td>${cs.battles}</td><td>${st}${scars}</td></tr>`;
        })
        .join('');
      return `<h3>${sq.name}</h3><table><tr><th>NAME</th><th>WEAPON</th><th>BATTLES</th><th>STATUS</th></tr>${men}</table>`;
    })
    .join('');

  const wins = campaign.log.filter((r) => r.won).length;
  debriefEl.innerHTML = `<div class="db">
    <h1 class="${record.won ? 'win' : 'loss'}">${record.won ? 'VICTORY' : 'DEFEAT'}</h1>
    <p class="sub">${record.kia.length} KIA · ${record.wounded.length} wounded</p>
    <p class="fallen">${record.kia.length > 0 ? 'Fallen: ' + record.kia.join(', ') : 'No one died today.'}</p>
    ${replacements > 0 ? `<p class="repl">${replacements} green replacements arrive — strangers, for now.</p>` : ''}
    ${rows}
    ${
      operationOver
        ? `<h2>Operation complete: ${wins}/${BATTLES_PER_OPERATION} battles won.</h2>
           <button id="next">New operation (fresh campaign)</button>`
        : `<h2>Next: battle ${campaign.battleIndex + 1} of ${BATTLES_PER_OPERATION}, day ${campaign.day}</h2>
           <button id="next">Move out</button>`
    }</div>`;
  debriefEl.style.display = 'block';
  document.getElementById('next')!.onclick = () => {
    if (operationOver) {
      campaign = newCampaign(Date.now() % 100000);
      saveCampaign(campaign);
    }
    startBattle();
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
  if (dragStart && e.buttons & 1) {
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
  if (targetMode !== '') return;
  const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
  if (selectedVehicle >= 0) sim.orderVehicleMove(selectedVehicle, wx, wy);
  else if (selectedSquad >= 0) sim.orderMove(selectedSquad, wx, wy);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.zoom(Math.pow(1.1, -e.deltaY / 100), e.clientX, e.clientY, canvas.width, canvas.height);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
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
  cam,
  setPaused: (p: boolean) => (paused = p),
  selectSquad: (i: number) => selectSquad(i),
  getCampaign: () => campaign,
  showDebrief,
};

startBattle();

let last = performance.now();
let acc = 0;
const DT_MS = DT * 1000;

function frame(now: number): void {
  acc += Math.min(now - last, 250);
  last = now;
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
  pings.watch(sim);

  const pick = mouse.onCanvas && !targetMode ? pickAt(sim, cam, mouse.x, mouse.y, canvas.width, canvas.height) : null;
  const shot = computeShot(sim, selectedSquad, selectedVehicle, pick);

  renderer.draw(ctx, cam, selectedSquad, now);
  drawOverlays(ctx, cam, sim, { pick, shot, selectedSquad, targetMode }, pings);
  tooltip.update(sim, pick, shot, mouse.x, mouse.y, pick?.kind === 'terrain' && (selectedSquad >= 0 || selectedVehicle >= 0));
  hud.update(sim, { selectedSquad, selectedVehicle, paused, targetMode, title: battleTitle });

  if (sim.winner && winnerAt < 0) winnerAt = now;
  if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
