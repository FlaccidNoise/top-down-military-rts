// The one place that knows the difference between CSS pixels and device
// pixels. Everything downstream — camera, picking, HUD insets, overlay
// geometry — works in CSS px; the DPR lives only in the canvas backing store
// and the base transform set in main.ts.
export const view = { w: 0, h: 0, dpr: 1 };

// Clamp the backing store twice: by ratio (2× is the point of diminishing
// returns for this art) and by total area. A 3× 390×844 phone is 2.96 Mpx of
// fill per frame before a single drawImage lands, so the area cap — not the
// ratio cap — is what keeps the frame budget on mobile.
export function viewSize(
  cssW: number,
  cssH: number,
  rawDpr: number,
  maxDpr = 2,
  maxPx = 2_600_000,
): { w: number; h: number; dpr: number } {
  const area = Math.max(1, cssW * cssH);
  let dpr = Math.max(1, Math.min(rawDpr, maxDpr));
  dpr = Math.max(1, Math.min(dpr, Math.sqrt(maxPx / area)));
  return { w: cssW, h: cssH, dpr };
}

// How many device pixels a hard-surface bake (vehicle, emplacement) gets per
// CSS pixel. The men always bake at view.dpr; a hull canvas is five times a
// man's, and a phone's memory is the one place that is not worth it, so on a
// phone hulls stay on CSS pixels.
export function hullDpr(): number {
  return MOBILE ? 1 : view.dpr;
}

// Touch-first device, decided once at boot: a coarse primary pointer that
// cannot hover. A touchscreen laptop reports fine/hover and stays on the
// desktop path, which is the point — MOBILE gates layout, not capability.
export const MOBILE =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
