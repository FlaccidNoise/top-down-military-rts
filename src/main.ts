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
import { makeCampaignBattle } from './sim/scenario';
import { DT, type Sim } from './sim/sim';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d')!;
const resize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
};
resize();
window.addEventListener('resize', resize);

const overlay = document.createElement('div');
overlay.style.cssText =
  'position:fixed;inset:0;display:none;background:rgba(10,12,10,0.92);color:#e8e4d8;' +
  'font:14px monospace;overflow:auto;padding:40px;z-index:10;';
document.body.appendChild(overlay);

let campaign: Campaign = loadCampaign() ?? newCampaign(Date.now() % 100000);
let sim: Sim;
let commander: RedCommander;
let renderer: Renderer;
const cam = new Camera(60, 60);

let paused = true;
let selectedSquad = -1;
let barrageMode = false;
let winnerAt = -1; // ms timestamp when winner appeared
let debriefShown = false;

function startBattle(): void {
  const battle = makeCampaignBattle(campaign, campaign.day * 7919 + campaign.battleIndex);
  sim = battle.sim;
  commander = battle.commander;
  renderer = new Renderer(sim);
  renderer.hudTitle = `Day ${campaign.day}: ${battle.name}`;
  cam.x = campaign.battleIndex === 0 ? 60 : 100;
  cam.y = 60;
  cam.scale = 8;
  paused = true;
  selectedSquad = -1;
  barrageMode = false;
  winnerAt = -1;
  debriefShown = false;
  overlay.style.display = 'none';
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
          const scars = cs.bodyDamage.some((d, i) => d > 0 && cs.status === 'fit') ? ' [permanent injury]' : '';
          const st = cs.status === 'kia' ? 'KIA' : cs.status === 'recovering' ? `recovering (${cs.recoveryDays}d)` : 'fit';
          return `<tr><td>${cs.name}</td><td>${cs.weapon}</td><td>${cs.battles}</td><td>${st}${scars}</td></tr>`;
        })
        .join('');
      return `<h3>${sq.name}</h3><table border="0" cellpadding="4"><tr><th align="left">Name</th><th align="left">Weapon</th><th align="left">Battles</th><th align="left">Status</th></tr>${men}</table>`;
    })
    .join('');

  const wins = campaign.log.filter((r) => r.won).length;
  overlay.innerHTML = `
    <h1>${record.won ? 'VICTORY' : 'DEFEAT'} — ${record.kia.length} KIA, ${record.wounded.length} wounded</h1>
    <p>${record.kia.length > 0 ? 'Fallen: ' + record.kia.join(', ') : 'No one died today.'}</p>
    <p>${replacements > 0 ? replacements + ' green replacements arrive — strangers, for now.' : ''}</p>
    ${rows}
    ${
      operationOver
        ? `<h2>Operation complete: ${wins}/${BATTLES_PER_OPERATION} battles won.</h2>
           <button id="next" style="font:16px monospace;padding:8px 16px;">New operation (fresh campaign)</button>`
        : `<h2>Next: battle ${campaign.battleIndex + 1} of ${BATTLES_PER_OPERATION}, day ${campaign.day}</h2>
           <button id="next" style="font:16px monospace;padding:8px 16px;">Move out</button>`
    }`;
  overlay.style.display = 'block';
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
canvas.addEventListener('mousemove', (e) => {
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
    if (barrageMode) {
      if (sim.callBarrage('blue', wx, wy)) {
        barrageMode = false;
        renderer.barrageMode = false;
        renderer.markBarrage(wx, wy, performance.now());
      }
    } else {
      let best = -1;
      let bestD = 15 / cam.scale;
      for (const s of sim.soldiers) {
        if (!s.alive || s.side !== 'blue') continue;
        const d = Math.hypot(s.x - wx, s.y - wy);
        if (d < bestD) {
          bestD = d;
          best = s.squadId;
        }
      }
      selectedSquad = best;
    }
  }
  dragStart = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (selectedSquad >= 0 && !barrageMode) {
    const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
    sim.orderMove(selectedSquad, wx, wy);
  }
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
  if (e.code === 'KeyB' && sim.barragesLeft.blue > 0) {
    barrageMode = !barrageMode;
    renderer.barrageMode = barrageMode;
  }
  if (e.code === 'Escape') {
    selectedSquad = -1;
    barrageMode = false;
    renderer.barrageMode = false;
  }
});

// debug/automation handle
(window as unknown as { __game: object }).__game = {
  get sim() {
    return sim;
  },
  cam,
  setPaused: (p: boolean) => (paused = p),
  selectSquad: (i: number) => (selectedSquad = i),
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
  renderer.draw(ctx, cam, selectedSquad, paused, now);
  if (sim.winner && winnerAt < 0) winnerAt = now;
  if (winnerAt >= 0 && !debriefShown && now - winnerAt > 4000) showDebrief();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
