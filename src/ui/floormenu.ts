import type { Sim } from '../sim/sim';

let activeMenu: HTMLDivElement | null = null;
let activeMouseListener: ((e: MouseEvent) => void) | null = null;
let activeKeyListener: ((e: KeyboardEvent) => void) | null = null;
let activeClose: (() => void) | null = null;

function closeMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  // Fires exactly once per opened menu, whichever way it goes away — the order
  // preview is pinned to the menu's target while it is up and has to be let go.
  if (activeClose) {
    const done = activeClose;
    activeClose = null;
    done();
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

export interface FloorMenuHandlers {
  pick(level: number): void;
  /** Row under the pointer, or null on leave — drives the order preview's target floor. */
  hover?(level: number | null): void;
  /** Dismissed without a pick (click-away, Escape) — and after a pick. */
  close?(): void;
}

export function showFloorMenu(
  parent: HTMLElement,
  sim: Sim,
  wx: number,
  wy: number,
  clientX: number,
  clientY: number,
  handlers: FloorMenuHandlers,
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
        handlers.pick(i);
        closeMenu();
      });
      // Hovering a row previews THAT floor: the dots move upstairs before the
      // order is committed, which is the only moment the player can still
      // change their mind.
      row.addEventListener('pointerenter', () => handlers.hover?.(i));
      row.addEventListener('pointerleave', () => handlers.hover?.(null));
    }
    el.appendChild(row);
  }

  parent.appendChild(el);
  // Clamp into the viewport once it has a measured size. A four-storey menu is
  // ~190 px of 44 px touch rows, and the press that opens it on a phone is
  // usually low on the screen — unclamped, Ground ends up under the touch bar
  // with no way to reach it.
  const bar = document.getElementById('touchbar');
  const bottom = innerHeight - (bar?.getBoundingClientRect().height ?? 0) - 6;
  el.style.left = `${Math.max(6, Math.min(clientX, innerWidth - el.offsetWidth - 6))}px`;
  el.style.top = `${Math.max(6, Math.min(clientY, bottom - el.offsetHeight))}px`;
  activeMenu = el;
  activeClose = () => handlers.close?.();

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
