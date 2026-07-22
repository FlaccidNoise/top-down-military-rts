import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { makeScenario } from './sim/scenario';
import { DT } from './sim/sim';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d')!;
const resize = () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
};
resize();
window.addEventListener('resize', resize);

const sim = makeScenario(42);
const renderer = new Renderer(sim);
const cam = new Camera(60, 60);

// debug/automation handle
(window as unknown as { __game: object }).__game = {
  sim,
  cam,
  setPaused: (p: boolean) => (paused = p),
  selectSquad: (i: number) => (selectedSquad = i),
};

let paused = true; // start paused, Close Combat style: read the map, then go
let selectedSquad = -1;

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
    // select nearest blue squad within 15 screen px
    const [wx, wy] = cam.screenToWorld(e.clientX, e.clientY, canvas.width, canvas.height);
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
  dragStart = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (selectedSquad >= 0) {
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
  if (e.code === 'Escape') selectedSquad = -1;
});

let last = performance.now();
let acc = 0;
const DT_MS = DT * 1000;

function frame(now: number): void {
  acc += Math.min(now - last, 250);
  last = now;
  if (!paused) {
    while (acc >= DT_MS) {
      sim.step();
      acc -= DT_MS;
    }
  } else {
    acc = 0;
  }
  renderer.addEvents(sim.takeEvents(), now);
  renderer.draw(ctx, cam, selectedSquad, paused, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
