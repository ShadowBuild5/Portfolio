/**
 * Warp-jump speed lines, drawn with ASCII glyphs on the 2D background canvas.
 *
 * One-point perspective: every streak is a short run of '-', '=' or '~' glyphs travelling outward
 * from a central vanishing point, rotated to follow its ray. Rays above the horizon tilt upward
 * toward the screen edge, rays below tilt downward, and the horizon ray itself stays perfectly
 * flat. Glyph size, streak length and speed all grow with distance from the vanishing point
 * (u^1.8) so the field accelerates like real perspective, and everything scales with `k` (0..1).
 */

interface Ray {
  cos: number;
  sin: number;
  sp: number; // relative speed
  glyph: string;
  light: boolean; // light (white-ish) vs accent-colored streak
  u: number[]; // progress 0..1 of each dash along the ray
}

const FONT_STEPS = [8, 11, 14, 18, 23, 29, 36];
const GLYPHS = ['-', '=', '~', '-'];

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class WarpFx {
  private rays: Ray[] = [];
  private col = [255, 255, 255];
  private light = [255, 255, 255];

  constructor(count = 88) {
    const r = lcg(7);
    for (let i = 0; i < count; i++) {
      // Even spread of angles with jitter; i=0 and i=count/2 are exactly horizontal (the flat horizon rays).
      const exact = i === 0 || i === count / 2;
      const a = (i / count) * Math.PI * 2 + (exact ? 0 : (r() - 0.5) * 0.06);
      this.rays.push({
        cos: Math.cos(a),
        sin: exact ? 0 : Math.sin(a),
        sp: 0.55 + r() * 0.9,
        glyph: GLYPHS[Math.floor(r() * GLYPHS.length)],
        light: r() < 0.45,
        u: [r(), r(), r()],
      });
    }
  }

  /** Draw into device-pixel space. `k` = warp intensity 0..1, `target` = scene accent rgb. */
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number, dt: number, k: number, target: number[]) {
    if (k < 0.01) return;
    const rate = 1 - Math.exp(-dt * 10);
    for (let i = 0; i < 3; i++) this.col[i] += (target[i] - this.col[i]) * rate;
    for (let i = 0; i < 3; i++) this.light[i] = this.col[i] + (255 - this.col[i]) * 0.6;
    const accent = `rgb(${this.col[0] | 0},${this.col[1] | 0},${this.col[2] | 0})`;
    const white = `rgb(${this.light[0] | 0},${this.light[1] | 0},${this.light[2] | 0})`;

    const cx = W * 0.5;
    const cy = H * 0.5;
    const rmax = Math.hypot(cx, cy) * 1.1;

    ctx.save();

    // tunnel glow at the vanishing point
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rmax * 0.6);
    g.addColorStop(0, `rgba(${this.light[0] | 0},${this.light[1] | 0},${this.light[2] | 0},${0.3 * k})`);
    g.addColorStop(0.35, `rgba(${this.col[0] | 0},${this.col[1] | 0},${this.col[2] | 0},${0.14 * k})`);
    g.addColorStop(1, `rgba(${this.col[0] | 0},${this.col[1] | 0},${this.col[2] | 0},0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.textBaseline = 'middle';
    const speedMul = 0.25 + 2.7 * k;

    // straight horizon line
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${12 * dpr}px "Courier New", monospace`;
    ctx.fillStyle = white;
    ctx.globalAlpha = 0.5 * k;
    const cols = Math.ceil(W / (12 * dpr * 0.6));
    ctx.fillText('-'.repeat(cols), 0, cy);

    let lastStep = -1;
    for (const ray of this.rays) {
      ctx.fillStyle = ray.light ? white : accent;
      for (let j = 0; j < 3; j++) {
        let u = ray.u[j] + dt * ray.sp * speedMul;
        if (u >= 1) u -= 1;
        ray.u[j] = u;

        const step = Math.min(FONT_STEPS.length - 1, Math.floor(u * FONT_STEPS.length));
        const px = FONT_STEPS[step] * dpr;
        if (step !== lastStep) {
          ctx.font = `${px}px "Courier New", monospace`;
          lastStep = step;
        }
        const r = u ** 1.8 * rmax;
        const n = 2 + Math.floor(u * 14 * k);
        ctx.setTransform(ray.cos, ray.sin, -ray.sin, ray.cos, cx + ray.cos * r, cy + ray.sin * r);
        ctx.globalAlpha = k * (0.15 + 0.85 * u);
        ctx.fillText(ray.glyph.repeat(n), 0, 0);
      }
    }

    ctx.restore();
  }
}
