import type { Sim } from '../sim/sim';

let activeMenu: HTMLDivElement | null = null;
let activeMouseListener: ((e: MouseEvent) => void) | null = null;
let activeKeyListener: ((e: KeyboardEvent) => void) | null = null;

function closeMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (activeMouseListener) {
    window.removeEventListener('mousedown', activeMouseListener, true);
    activeMouseListener = null;
  }
  if (activeKeyListener) {
    window.removeEventListener('keydown', activeKeyListener);
    activeKeyListener = null;
  }
}

export function showFloorMenu(
  parent: HTMLElement,
  sim: Sim,
  wx: number,
  wy: number,
  clientX: number,
  clientY: number,
  onPick: (level: number) => void,
): void {
  const tx = Math.floor(wx);
  const ty = Math.floor(wy);
  const stories = sim.map.storiesAt(tx, ty);
  if (stories < 2) return;

  closeMenu();

  const bid = sim.map.buildingIdAt(tx, ty);
  let hasStairs = false;
  if (bid >= 0) {
    for (let y = 0; y < sim.map.h && !hasStairs; y++) {
      for (let x = 0; x < sim.map.w && !hasStairs; x++) {
        if (sim.map.buildingIdAt(x, y) === bid && sim.map.isStair(x, y)) {
          hasStairs = true;
        }
      }
    }
  }

  const el = document.createElement('div');
  el.id = 'floormenu';
  el.className = 'panel';
  el.style.position = 'absolute';
  el.style.left = `${clientX}px`;
  el.style.top = `${clientY}px`;

  // Rows bottom-to-top: Ground at bottom, Floor N at top
  for (let i = stories - 1; i >= 0; i--) {
    const row = document.createElement('div');
    row.className = 'fm-row';
    row.textContent = i === 0 ? 'Ground' : `Floor ${i + 1}`;
    if (i > 0 && !hasStairs) {
      row.classList.add('disabled');
      row.title = 'no stairs';
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(i);
        closeMenu();
      });
    }
    el.appendChild(row);
  }

  parent.appendChild(el);
  activeMenu = el;

  activeMouseListener = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) {
      closeMenu();
    }
  };
  window.addEventListener('mousedown', activeMouseListener, true);

  activeKeyListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  };
  window.addEventListener('keydown', activeKeyListener);
}
