import { WarpFx } from './warp';

/**
 * Procedural ASCII parallax. Each depth layer is rendered ONCE into an offscreen
 * canvas strip (seamlessly tileable), then scrolled by translation. No DOM text
 * nodes, so drift is nearly free. The strips are plain canvases, so they can later
 * be uploaded as THREE.CanvasTexture without changing this module.
 */

interface LayerSpec {
  depth: number; // 0 = far, 1 = near
  speed: number; // px/sec at warp = 0
  font: number; // px
  base: number; // ridge baseline as fraction of height
  amp: number; // ridge amplitude as fraction of height
  alpha: number;
}

const LAYERS: LayerSpec[] = [
  { depth: 0.0, speed: 6, font: 9, base: 0.55, amp: 0.2, alpha: 0.28 },
  { depth: 0.35, speed: 14, font: 12, base: 0.66, amp: 0.16, alpha: 0.4 },
  { depth: 0.7, speed: 30, font: 16, base: 0.78, amp: 0.12, alpha: 0.5 },
  { depth: 1.0, speed: 60, font: 22, base: 0.92, amp: 0.07, alpha: 0.6 },
];

/** Background ASCII hills/mountains (the parallax layers). Off by request; flip to true to bring them back. */
const SHOW_HILLS = false;

const GLYPHS = ['.', ':', '^', '/', '\\', '#'];

// Deterministic PRNG so layers are stable between rebuilds.
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Strip {
  canvas: HTMLCanvasElement;
  spec: LayerSpec;
  offset: number;
}

// ---- hero tree ------------------------------------------------------------
interface TreeSprite {
  canvas: HTMLCanvasElement;
  rows: number;
  fontDev: number; // row height in device px (integer so row slices are exact)
  cx: number; // trunk center, CSS px
  baseY: number; // ground line, CSS px
}

const hexToRgb = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// Leaf ramp: darker/sparser glyphs in shadow, denser in light.
const LEAF_RAMP = ['.', ':', '+', '*', '#', '@'];
const LEAF_ALPHA = [0.32, 0.45, 0.6, 0.74, 0.88, 1];
// Canopy lumps: [centerCol, centerRow, radiusCols, radiusRows]. Cells are ~0.6 wide x 1 tall, so rx is larger than ry.
const LUMPS: number[][] = [
  [32, 10, 17, 8],
  [18, 14, 11, 6],
  [46, 13, 12, 6],
  [24, 5, 10, 5],
  [41, 5, 10, 5],
  [11, 19, 8, 4],
  [53, 18, 8, 4],
  [32, 17, 10, 5],
  [27, 22, 6, 3],
  [40, 22, 5, 3],
];

export class AsciiParallax {
  private strips: Strip[] = [];
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private color = '#ffffff';
  /** 0 = calm drift. >0 stretches speed (used by the warp placeholder). */
  warp = 0;
  /** Global dim for the UI-legibility rule (muted behind cards). */
  mute = 0.6;
  /** 1 = hero/camp composition (still hills + swaying tree), 0 = flight (drifting parallax). */
  camp = 1;
  /** -1 = leaving the camp scene, +1 = arriving at it (mirrors Stage3D.campDir). */
  campDir = 1;
  private time = 0;
  private tree: TreeSprite | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setColor(c: string) {
    if (c === this.color) return;
    this.color = c;
    this.build();
  }

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.build();
  }

  private build() {
    if (!SHOW_HILLS) {
      this.strips = [];
      this.buildTree();
      return;
    }
    this.strips = LAYERS.map((spec, i) => {
      const prev = this.strips[i];
      const c = document.createElement('canvas');
      // Strip is at least 2x screen so one tile always covers the viewport.
      const width = Math.ceil(Math.max(this.w, 1200) * 1.5);
      c.width = width * this.dpr;
      c.height = this.h * this.dpr;
      this.paintStrip(c, spec, i, width);
      return { canvas: c, spec, offset: prev ? prev.offset : 0 };
    });
    this.buildTree();
  }

  /** Procedurally build the hero tree once into an offscreen canvas (one row = one animatable slice). */
  private buildTree() {
    const portrait = this.w / this.h < 0.9;
    const baseY = (portrait ? 0.43 : 0.79) * this.h;
    const cx = (portrait ? 0.5 : 0.25) * this.w; // trunk just left of the character so it stays visible
    const cols = 64;
    const rows = 44;
    const font = Math.max(8, Math.min(this.h / 58, this.w / 42, baseY / 46, 17));
    const fontDev = Math.round(font * this.dpr);
    const cwDev = fontDev * 0.6;

    const accent = hexToRgb(this.color);
    const light = mix(accent, [255, 255, 255], 0.4);
    const trunkC = mix(accent, [205, 150, 100], 0.6);
    const trunkL = mix(trunkC, [255, 255, 255], 0.35);
    // class -> fill style: 1..6 leaf ramp, 7 trunk shade, 8 trunk lit, 9 branch
    const style: string[] = ['', ...LEAF_RAMP.map((_, i) => rgba(i >= 4 ? light : accent, LEAF_ALPHA[i])), rgba(trunkC, 0.8), rgba(trunkL, 1), rgba(trunkC, 0.85)];

    const ch: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
    const cl: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
    const rnd = mulberry32(4242);
    const trunkX = (r: number) => 32 + Math.sin((rows - 1 - r) * 0.1) * 2;

    // trunk: tapered, curved, bark texture, flared roots
    for (let r = rows - 1; r >= 16; r--) {
      const rb = rows - 1 - r;
      const half = Math.max(3.2, 7 - rb * 0.16) / 2;
      const x = trunkX(r);
      const l = Math.round(x - half);
      const rt = Math.round(x + half);
      for (let c = l; c <= rt; c++) {
        if (c === l) { ch[r][c] = '('; cl[r][c] = 7; }
        else if (c === rt) { ch[r][c] = ')'; cl[r][c] = 8; }
        else { ch[r][c] = (r + c) % 3 === 0 ? ':' : c > x ? '#' : '|'; cl[r][c] = c > x ? 8 : 7; }
      }
      if (r >= rows - 4) {
        const extra = r - (rows - 4) + 1;
        if (l - extra >= 0) { ch[r][l - extra] = '/'; cl[r][l - extra] = 7; }
        if (rt + extra < cols) { ch[r][rt + extra] = '\\'; cl[r][rt + extra] = 8; }
      }
    }

    // canopy: union of lumps, lit from the upper right, ragged edges
    for (let r = 0; r < 27; r++) {
      for (let c = 0; c < cols; c++) {
        let best = -1;
        let bl: number[] | null = null;
        for (const lp of LUMPS) {
          const d2 = ((c - lp[0]) / lp[2]) ** 2 + ((r - lp[1]) / lp[3]) ** 2;
          const h = 1 - d2;
          if (h > best) { best = h; bl = lp; }
        }
        if (best <= 0 || !bl) continue;
        if (best < 0.22 && rnd() < 0.45) continue;
        // sky holes: sparse gaps inside the canopy so it reads as leaves + branches, not a solid cloud
        if (best > 0.15 && best < 0.75 && Math.sin(c * 0.9 + r * 1.7) * Math.sin(c * 0.4 - r * 0.8) > 0.8) continue;
        if (best < 0.12) {
          ch[r][c] = "';,."[Math.floor(rnd() * 4)];
          cl[r][c] = 1;
          continue;
        }
        const shade = 0.16 + best * 0.42 + 0.22 * ((c - bl[0]) / bl[2]) - 0.26 * ((r - bl[1]) / bl[3]) + (rnd() - 0.5) * 0.34;
        const idx = Math.max(0, Math.min(5, Math.floor(shade * 6)));
        ch[r][c] = LEAF_RAMP[idx];
        cl[r][c] = idx + 1;
      }
    }

    // branches: only where the canopy hasn't already covered the cell
    const branch = (r0: number, len: number, dir: number, slope: number) => {
      for (let i = 0; i < len; i++) {
        const r = r0 - i;
        const c = Math.round(trunkX(r0) + dir * (i + 1) * slope);
        if (r < 0 || c < 0 || c >= cols || ch[r][c] !== ' ') continue;
        ch[r][c] = dir < 0 ? '\\' : '/';
        cl[r][c] = 9;
      }
    };
    branch(31, 10, -1, 1.1);
    branch(31, 10, 1, 1.1);
    branch(35, 7, -1, 1.0);
    branch(34, 8, 1, 1.0);

    const c = document.createElement('canvas');
    c.width = Math.ceil(cols * cwDev) + 2;
    c.height = rows * fontDev;
    const g = c.getContext('2d')!;
    g.font = `${fontDev}px "Courier New", monospace`;
    g.textBaseline = 'top';
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const k = cl[r][col];
        if (!k) continue;
        g.fillStyle = style[k];
        g.fillText(ch[r][col], col * cwDev, r * fontDev);
      }
    }
    this.tree = { canvas: c, rows, fontDev, cx, baseY };
  }

  /** Draw the tree row by row, shearing each row by wind * height^1.7 so the trunk bends and the canopy swings. */
  private drawTree(still: boolean) {
    const tr = this.tree;
    const k = this.camp;
    if (!tr) return;
    // Same flight as the 3D layer: leaving => grows outward from the vanishing point and fades;
    // arriving => grows in from small. Scaling about screen center sends left things left, right things right.
    let sc = 1;
    let alpha = 1;
    if (k < 0.999) {
      // Same perspective math as Stage3D (an object ~10 units from the camera flying along the view axis),
      // so the tree and the 3D character stay in step: scale = 1 / (remaining depth fraction).
      if (this.campDir < 0) {
        const x = Math.min(1, Math.max(0, (1 - k) * 2));
        sc = Math.min(4, 1 / Math.max(0.12, 1 - 1.3 * x * x));
        alpha = (1 - x) ** 1.5;
      } else {
        const s = Math.min(1, Math.max(0, k * 2 - 1));
        sc = 1 / (1 + 12 * (1 - s) * (1 - s));
        alpha = s;
      }
    }
    if (alpha < 0.01) return;
    const ctx = this.ctx;
    const t = this.time;
    const gust = Math.max(0, Math.sin(t * 0.31)) ** 3 * 0.7;
    const wind = still ? 0 : 0.35 + Math.sin(t * 0.7) * 0.45 + Math.sin(t * 1.9 + 1.3) * 0.2 + gust;
    const amp = tr.fontDev * 1.9;
    const w = tr.canvas.width;
    const x0 = tr.cx * this.dpr - w / 2;
    const y0 = tr.baseY * this.dpr - tr.rows * tr.fontDev;
    ctx.save();
    ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    ctx.scale(sc, sc);
    ctx.translate(-this.canvas.width / 2, -this.canvas.height / 2);
    ctx.globalAlpha = alpha * 0.95;
    for (let r = 0; r < tr.rows; r++) {
      const hn = (tr.rows - 1 - r) / (tr.rows - 1);
      const ripple = still ? 0 : Math.sin(t * 2.6 + r * 0.55) * tr.fontDev * 0.12 * hn;
      const off = wind * amp * hn ** 1.7 + ripple;
      const sy = r * tr.fontDev;
      ctx.drawImage(tr.canvas, 0, sy, w, tr.fontDev, x0 + off, y0 + sy, w, tr.fontDev);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private paintStrip(c: HTMLCanvasElement, spec: LayerSpec, seed: number, width: number) {
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    g.font = `${spec.font}px "Courier New", monospace`;
    g.textBaseline = 'top';
    g.fillStyle = this.color;
    const cw = spec.font * 0.6; // monospace advance
    const lh = spec.font;
    const cols = Math.floor(width / cw);
    const rows = Math.ceil(this.h / lh);
    const rnd = mulberry32(1000 + seed * 77);

    // Periodic ridge: integer number of cycles across the strip => seamless wrap.
    const p1 = 2 + seed;
    const p2 = 5 + seed * 2;
    const p3 = 11 + seed * 3;
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    const ridge = (x: number) => {
      const t = (x / cols) * Math.PI * 2;
      const v = Math.sin(t * p1 + ph[0]) * 0.55 + Math.sin(t * p2 + ph[1]) * 0.3 + Math.sin(t * p3 + ph[2]) * 0.15;
      return spec.base * rows + v * spec.amp * rows;
    };

    const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
    for (let x = 0; x < cols; x++) {
      const top = Math.floor(ridge(x));
      const slope = ridge(x + 1) - ridge(x - 1);
      for (let y = Math.max(top, 0); y < rows; y++) {
        const d = y - top;
        let ch: string;
        if (d === 0) ch = slope > 0.4 ? '\\' : slope < -0.4 ? '/' : '^';
        else if (d < 3) ch = ':';
        else ch = rnd() < 0.12 ? GLYPHS[Math.floor(rnd() * 3)] : ' ';
        grid[y][x] = ch;
      }
    }

    for (let y = 0; y < rows; y++) {
      const row = grid[y].join('');
      if (row.trim()) g.fillText(row, 0, y * lh);
    }
  }

  private warpFx = new WarpFx();

  /** ASCII speed lines for the warp jump; `this.warp` (0..1) is driven by the transition timeline. */
  private drawWarp(dt: number) {
    if (this.warp < 0.01) return;
    this.warpFx.draw(this.ctx, this.canvas.width, this.canvas.height, this.dpr, dt, this.warp, hexToRgb(this.color));
  }

  update(dt: number, still: boolean) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.time += dt;
    const mult = 1 + this.warp * 28;
    // Hero is still (the tree provides the motion); drift fades in as we leave it. Warp always wins.
    const drift = Math.max(1 - this.camp, this.warp);
    if (!SHOW_HILLS) {
      this.drawTree(still);
      this.drawWarp(dt);
      return;
    }
    let si = 0;
    for (const s of this.strips) {
      if (si++ === 2) this.drawTree(still); // behind the two nearest hill layers
      if (!still) s.offset = (s.offset + s.spec.speed * mult * drift * dt) % (s.canvas.width / this.dpr);
      ctx.globalAlpha = s.spec.alpha * this.mute;
      const tileW = s.canvas.width;
      const x = -Math.floor(s.offset * this.dpr);
      for (let tx = x; tx < this.canvas.width; tx += tileW) ctx.drawImage(s.canvas, tx, 0);
      // Warp placeholder: ghost stretched copies for a cheap streak feel.
      if (this.warp > 0.05) {
        ctx.globalAlpha = s.spec.alpha * this.mute * 0.35 * this.warp;
        for (let tx = x - 40; tx < this.canvas.width; tx += tileW) ctx.drawImage(s.canvas, tx, 0);
      }
    }
    ctx.globalAlpha = 1;
    this.drawWarp(dt);
  }
}
