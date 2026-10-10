// Update a HUD region in place.
//
// The HUD used to rebuild its panels with innerHTML several times a second. A
// mouse press that spanned a rebuild put its mouseup on a NEW element, the
// browser found no common target for the press, and no click fired: 3 of 20
// human-length clicks landed on a running battle (jtbug #784). Hover, focus and
// a long-press timer holding a button died the same way.
//
// patchChildren keeps the callers' string templates and stops replacing nodes:
// elements are built once and afterwards only their text, classes and
// attributes are written, and only where they differ.

const KEYS = ['data-squad', 'data-vehicle', 'data-soldier', 'data-order', 'data-ctx', 'data-tb'];

function keyOf(n: Node): string {
  if (n.nodeType !== 1) return '';
  const e = n as Element;
  for (const k of KEYS) {
    const v = e.getAttribute(k);
    if (v !== null) return `${k}=${v}`;
  }
  return '';
}

function same(a: Node, b: Node): boolean {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
}

function sync(live: Node, want: Node): void {
  if (live.nodeType !== 1) {
    if (live.nodeValue !== want.nodeValue) live.nodeValue = want.nodeValue;
    return;
  }
  const a = live as Element;
  const b = want as Element;
  for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name);
  morph(a, b);
}

function morph(live: Node, want: Node): void {
  let a = live.firstChild;
  let b = want.firstChild;
  while (b) {
    const next = b.nextSibling;
    if (a && same(a, b)) {
      sync(a, b);
      a = a.nextSibling;
    } else {
      // A keyed element that moved (a squad left the list above it) is found
      // further down and brought up, so it keeps its identity too.
      const key = keyOf(b);
      let hit: Node | null = null;
      if (key) for (let s = a?.nextSibling ?? null; s; s = s.nextSibling) if (same(s, b)) { hit = s; break; }
      if (hit) {
        live.insertBefore(hit, a);
        sync(hit, b);
      } else {
        live.insertBefore(b, a);
      }
    }
    b = next;
  }
  while (a) {
    const next = a.nextSibling;
    live.removeChild(a);
    a = next;
  }
}

/** Make `parent`'s children match `html`, reusing every element already there. */
export function patchChildren(parent: Element, html: string): void {
  const want = document.createElement('template');
  want.innerHTML = html;
  morph(parent, want.content);
}
