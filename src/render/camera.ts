export class Camera {
  x: number; // world center, meters
  y: number;
  scale = 8; // px per meter

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  worldToScreen(wx: number, wy: number, cw: number, ch: number): [number, number] {
    return [(wx - this.x) * this.scale + cw / 2, (wy - this.y) * this.scale + ch / 2];
  }

  screenToWorld(sx: number, sy: number, cw: number, ch: number): [number, number] {
    return [(sx - cw / 2) / this.scale + this.x, (sy - ch / 2) / this.scale + this.y];
  }

  zoom(factor: number, sx: number, sy: number, cw: number, ch: number): void {
    const [wx, wy] = this.screenToWorld(sx, sy, cw, ch);
    this.scale = Math.min(48, Math.max(2, this.scale * factor));
    // keep the world point under the cursor fixed
    this.x = wx - (sx - cw / 2) / this.scale;
    this.y = wy - (sy - ch / 2) / this.scale;
  }
}
