// Bounded sprite cache shared by the unit bakes: an insertion-order LRU over
// baked canvases. The keyspace multiplies fast (side × weapon × pose × frame ×
// variant × band) and a band-48 dude canvas is ~117 KB, so an unbounded Map is
// a leak with a nice name. Eviction is byte-budgeted, never count-budgeted:
// one band-48 entry is worth sixty-four band-6 ones.

export class SpriteCache {
  private map = new Map<string, HTMLCanvasElement>();
  private bytes = 0;

  constructor(private budget: number) {}

  get(key: string): HTMLCanvasElement | undefined {
    const c = this.map.get(key);
    if (!c) return undefined;
    this.map.delete(key); // reinsert at the tail — Map iterates in insertion order, so the head is the LRU
    this.map.set(key, c);
    return c;
  }

  set(key: string, c: HTMLCanvasElement): void {
    this.map.set(key, c);
    this.bytes += c.width * c.height * 4;
    while (this.bytes > this.budget && this.map.size > 1) {
      const oldest: string = this.map.keys().next().value!;
      this.bytes -= this.map.get(oldest)!.width * this.map.get(oldest)!.height * 4;
      this.map.delete(oldest);
    }
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.map.size, bytes: this.bytes };
  }
}
