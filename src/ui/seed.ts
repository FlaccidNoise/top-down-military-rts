// The seed boundary. rollSeed below is the one entropy source outside
// src/render — the player pressing [Roll] is the only place a campaign may
// start from something the seed does not name. tests/determinism-boundary
// pins that: exactly one call here, zero under src/sim, src/strategic
// and src/campaign.

// Text hashes FNV-1a; digits parse as the uint32 they name, so re-entering the
// normalized number the UI displays reproduces the campaign it came from.
export function parseSeed(text: string): number {
  const t = text.trim();
  if (/^[0-9]+$/.test(t)) return Number(t) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rollSeed(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0;
}
