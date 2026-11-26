import {
  Group,
  Mesh,
  PlaneGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  MeshBasicMaterial,
  InstancedMesh,
  ConeGeometry,
  TorusGeometry,
  CircleGeometry,
  CylinderGeometry,
  BoxGeometry,
  IcosahedronGeometry,
  Points,
  PointsMaterial,
  CanvasTexture,
  BufferGeometry,
  Color,
  Object3D,
  MathUtils,
  DoubleSide,
  Matrix4,
} from 'three';
import { glowBlend } from './diorama';

/**
 * Procedural low-poly worlds for the first-person flight scenes.
 *
 * Every world is a `Def` (terrain height function, colors, props, sky, fog, speed) fed to one shared
 * `TileWorld`. Three identical terrain tiles leapfrog toward the camera. Every pattern is periodic in z
 * with the world's period L, so the tiles join seamlessly and the world is endless. The camera autopilots
 * along a meandering centerline (x = A * sin(2*pi*z / L)); the gates (rings) mark that line.
 * Props are InstancedMesh so a whole tile is only a handful of draw calls.
 */

export type WorldId = 'valley' | 'snow' | 'mountains' | 'beach' | 'farms';

export interface World {
  readonly id: WorldId;
  readonly group: Group;
  readonly L: number; // tile length / period
  readonly A: number; // meander amplitude of the flight line
  readonly camY: number; // camera height
  readonly speed: number; // cruise speed, units/s
  readonly fogNear: number;
  readonly fogFar: number;
  setAccent(c: Color): void;
  /** s = distance flown, camX = camera x, t = time, dt = frame time, v = current speed (units/s). */
  update(s: number, camX: number, t: number, dt: number, v: number): void;
}

type HeightFn = (x: number, z: number) => number;

interface Ctx {
  def: Def;
  K: number;
  cx: (z: number) => number;
  slope: (z: number) => number;
  ringMat: MeshBasicMaterial;
  tiles: Group[];
  /** per-frame animation hooks (water, snowfall, windmill blades) */
  ticks: Array<(t: number, dt: number, camX: number, v: number) => void>;
}

interface Def {
  id: WorldId;
  L: number;
  A: number;
  camY: number;
  speed: number;
  fogNear: number;
  fogFar: number;
  W: number; // tile width (x)
  segX: number;
  segZ: number;
  flat?: boolean; // per-face colors (crisp facets) instead of per-vertex gradients
  ringR?: number;
  height: HeightFn;
  color: (x: number, z: number, h: number, out: Color) => void;
  decorate?: (tile: Group, ctx: Ctx) => void; // per-tile props / water / clouds
  extras?: (g: Group, ctx: Ctx) => void; // once per world (snowfall)
  sun?: { color: number; radius: number; pos: [number, number, number] };
}

// ------------------------------------------------------------------ helpers
const TAU = Math.PI * 2;
const clamp = MathUtils.clamp;

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash(a: number, b: number) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const c1 = new Color();
const c2 = new Color();
/** Piecewise color ramp: stops are [t, hex] sorted by t. */
function ramp(stops: Array<[number, number]>, t: number, out: Color) {
  if (t <= stops[0][0]) return out.setHex(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, h0] = stops[i - 1];
      const [t1, h1] = stops[i];
      return out.copy(c1.setHex(h0)).lerp(c2.setHex(h1), (t - t0) / (t1 - t0));
    }
  }
  return out.setHex(stops[stops.length - 1][1]);
}

interface Spec {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  ry: number;
}

/** Build an InstancedMesh from placement specs. `tint` fills per-instance colors. */
function instanced(
  parent: Group,
  geo: BufferGeometry,
  mat: MeshStandardMaterial,
  specs: Spec[],
  tint?: (i: number, c: Color) => void,
) {
  const mesh = new InstancedMesh(geo, mat, specs.length);
  const o = new Object3D();
  const col = new Color();
  specs.forEach((s, i) => {
    o.position.set(s.x, s.y, s.z);
    o.scale.set(s.sx, s.sy, s.sz);
    o.rotation.set(0, s.ry, 0);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
    if (tint) {
      tint(i, col);
      mesh.setColorAt(i, col);
    }
  });
  parent.add(mesh);
  return mesh;
}

const flatMat = (extra: object = {}) => new MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0, ...extra });

// ------------------------------------------------------- shared polish helpers
// The beach works because it has a clear warm sun against cool water, real motion, and distinct layers.
// These helpers give the other worlds the same ingredients.

/**
 * A flat animated water sheet at height `level`. It spans the whole tile but only shows where the terrain dips
 * below it, so lakes and ponds appear wherever the height function carves a basin. Vertex colors come from the
 * depth below the surface; the waves are periodic in z, so tiles still join.
 */
function addWater(
  tile: Group,
  ctx: Ctx,
  o: { level: number; shade: (x: number, z: number, depth: number, out: Color) => void; opacity?: number; amp?: number },
) {
  const def = ctx.def;
  const K = ctx.K;
  const geo = new PlaneGeometry(def.W, def.L, 56, 36);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const px: number[] = [];
  const pz: number[] = [];
  const c = new Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    px.push(x);
    pz.push(z);
    o.shade(x, z, o.level - def.height(x, z), c);
    cols.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new Float32BufferAttribute(cols, 3));
  tile.add(
    new Mesh(
      geo,
      new MeshStandardMaterial({ vertexColors: true, flatShading: true, transparent: true, opacity: o.opacity ?? 0.85, roughness: 0.55, metalness: 0.05 }),
    ),
  );
  const amp = o.amp ?? 0.09;
  ctx.ticks.push((t) => {
    for (let i = 0; i < p.count; i++) {
      p.setY(i, o.level + amp * Math.sin(pz[i] * K * 10 + t * 1.3 + px[i] * 0.2) + amp * 0.65 * Math.sin(pz[i] * K * 17 - t * 1.1 + px[i] * 0.35));
    }
    p.needsUpdate = true;
  });
}

let haloTex: CanvasTexture | null = null;
/** Radial falloff used for the glow around each sun (white in the middle, transparent at the rim). */
function haloTexture() {
  if (!haloTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    haloTex = new CanvasTexture(c);
  }
  return haloTex;
}

/** Stars on a far dome that follows the camera and twinkles a little. Hidden by terrain via the depth test. */
function addStars(g: Group, ctx: Ctx, count: number, seed: number) {
  const r = rng(seed);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = r() * TAU;
    const y = 0.06 + r() * 0.94; // elevation (sine), upper hemisphere only
    const k = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(a) * k * 500;
    pos[i * 3 + 1] = y * 500;
    pos[i * 3 + 2] = Math.sin(a) * k * 500;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const m = new PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false, depthWrite: false });
  const pts = new Points(geo, m);
  pts.frustumCulled = false;
  g.add(pts);
  ctx.ticks.push((t, _dt, camX) => {
    pts.position.x = camX;
    m.opacity = 0.75 + 0.12 * Math.sin(t * 1.7);
  });
}

/** Aurora: three soft curtains of additive color hanging in the sky, swaying and rippling. */
function addAurora(g: Group, ctx: Ctx) {
  const curtains = [
    { y0: 105, h: 62, z: -300, a: 0x3dffb0, b: 0x2a9dff, phase: 0 },
    { y0: 130, h: 52, z: -345, a: 0x8a5bff, b: 0x3dffb0, phase: 2.1 },
    { y0: 92, h: 46, z: -270, a: 0x59ffd0, b: 0x7a6bff, phase: 4.2 },
  ];
  const W = 340;
  const meshes = curtains.map((cu) => {
    const geo = new PlaneGeometry(W, cu.h, 64, 10);
    const p = geo.attributes.position;
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < p.count; i++) {
      bx.push(p.getX(i));
      by.push(p.getY(i) + cu.h / 2); // 0 at the bottom edge .. h at the top
    }
    geo.setAttribute('color', new Float32BufferAttribute(new Float32Array(p.count * 3), 3));
    const mesh = new Mesh(geo, glowBlend(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, fog: false })));
    mesh.position.set(0, cu.y0, cu.z);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    g.add(mesh);
    return { cu, mesh, geo, p, bx, by, colA: new Color(cu.a), colB: new Color(cu.b), c: new Color() };
  });
  ctx.ticks.push((t, _dt, camX) => {
    for (const m of meshes) {
      const { cu, p, bx, by, colA, colB, c } = m;
      const col = m.geo.attributes.color;
      for (let i = 0; i < p.count; i++) {
        const ty = by[i] / cu.h; // 0 bottom .. 1 top
        const x = bx[i] + Math.sin(by[i] * 0.07 + t * 0.35 + cu.phase) * 12 * ty;
        const z = Math.sin(bx[i] * 0.025 + t * 0.25 + cu.phase * 1.3) * 28;
        p.setXYZ(i, x, by[i] - cu.h / 2 + Math.sin(bx[i] * 0.05 + t * 0.5 + cu.phase) * 3, z);
        // bright at the bottom edge, fading to black (= invisible, since it is additive) at the top, with bands that travel
        const band = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(bx[i] * 0.05 + t * 0.6 + cu.phase));
        c.copy(colA).lerp(colB, ty).multiplyScalar(band * Math.pow(1 - ty, 1.3) * 0.9);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      p.needsUpdate = true;
      col.needsUpdate = true;
      m.mesh.position.x = camX;
    }
  });
}

/** Puffy white clouds that drift slowly toward the viewer (much slower than the ground, so they read as far away). */
function addPuffyClouds(g: Group, ctx: Ctx, seed: number) {
  const r = rng(seed);
  const parts: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }[] = [];
  for (let c = 0; c < 22; c++) {
    const bx = (r() - 0.5) * 420;
    const by = 50 + r() * 30;
    const bz = -40 - r() * 300;
    const n = 3 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      parts.push({ x: bx + (k - 1) * 9 + (r() - 0.5) * 4, y: by + (r() - 0.5) * 3, z: bz + (r() - 0.5) * 6, sx: 9 + r() * 6, sy: 5 + r() * 3, sz: 8 + r() * 5, ry: r() * 6 });
    }
  }
  const mesh = new InstancedMesh(
    new IcosahedronGeometry(1, 1),
    new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, flatShading: true, roughness: 1 }),
    parts.length,
  );
  mesh.frustumCulled = false;
  g.add(mesh);
  const o = new Object3D();
  const write = (camX: number) => {
    parts.forEach((p, i) => {
      o.position.set(camX + p.x, p.y, p.z);
      o.scale.set(p.sx, p.sy, p.sz);
      o.rotation.set(0, p.ry, 0);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  write(0);
  ctx.ticks.push((_t, dt, camX, v) => {
    for (const p of parts) {
      p.z += v * 0.1 * dt;
      if (p.z > -10) p.z -= 330;
    }
    write(camX);
  });
}

/** A flock of birds crossing the sky; two instanced wing meshes, flapping. */
function addBirds(g: Group, ctx: Ctx, count: number, seed: number) {
  const r = rng(seed);
  const wl = new BoxGeometry(1.3, 0.05, 0.42);
  wl.translate(-0.65, 0, 0);
  const wr = new BoxGeometry(1.3, 0.05, 0.42);
  wr.translate(0.65, 0, 0);
  const mat = new MeshStandardMaterial({ color: 0x2b2f3a, flatShading: true, roughness: 1 });
  const left = new InstancedMesh(wl, mat, count);
  const right = new InstancedMesh(wr, mat, count);
  left.frustumCulled = false;
  right.frustumCulled = false;
  g.add(left, right);
  const birds = Array.from({ length: count }, () => ({ x: (r() - 0.5) * 46, y: 9 + r() * 12, z: -20 - r() * 130, ph: r() * 6, sp: 0.25 + r() * 0.2, size: 1.1 + r() * 0.8 }));
  const bird = new Object3D();
  const wing = new Object3D();
  const m = new Matrix4();
  ctx.ticks.push((t, dt, camX, v) => {
    birds.forEach((b, i) => {
      b.z += v * b.sp * dt;
      b.x += Math.sin(t * 0.5 + b.ph) * 0.8 * dt;
      if (b.z > 14) {
        b.z = -150 - r() * 40;
        b.x = (r() - 0.5) * 46;
      }
      bird.position.set(camX + b.x, b.y + Math.sin(t * 1.3 + b.ph) * 0.6, b.z);
      bird.scale.setScalar(b.size);
      bird.updateMatrix();
      const ang = Math.sin(t * 7 + b.ph) * 0.6;
      wing.rotation.set(0, 0, ang);
      wing.updateMatrix();
      left.setMatrixAt(i, m.multiplyMatrices(bird.matrix, wing.matrix));
      wing.rotation.set(0, 0, -ang);
      wing.updateMatrix();
      right.setMatrixAt(i, m.multiplyMatrices(bird.matrix, wing.matrix));
    });
    left.instanceMatrix.needsUpdate = true;
    right.instanceMatrix.needsUpdate = true;
  });
}

// -------------------------------------------------------------------- valley
function valleyDef(): Def {
  const L = 160;
  const A = 7;
  const K = TAU / L;
  const cx = (z: number) => A * Math.sin(K * z);
  const LAKE = -2.6; // water level: the valley floor never dips below -1.8, so only the carved basins flood
  // two lakes per period, centered on the flight line, so the autopilot crosses over them
  const basin = (x: number, z: number) => Math.pow(Math.max(0, Math.sin(z * K * 2 - 0.4)), 2) * (1 - smooth(6, 26, Math.abs(x - cx(z))));
  const height: HeightFn = (x, z) => {
    const n = Math.sin(z * K * 3 + x * 0.07) * 0.5 + Math.sin(z * K * 5 - x * 0.11 + 1.3) * 0.3 + Math.sin(z * K * 9 + x * 0.2) * 0.2;
    const dx = Math.abs(x - cx(z));
    const c = smooth(9, 60, dx);
    return c * (16 + 12 * n) * (0.5 + dx / 90) + n * 1.4 * (1 - c * 0.7) - 0.4 - 3.8 * basin(x, z);
  };
  return {
    id: 'valley',
    L,
    A,
    camY: 3.5,
    speed: 24,
    fogNear: 35,
    fogFar: 170,
    W: 300,
    segX: 64,
    segZ: 40,
    height,
    color: (_x, _z, h, out) => {
      ramp([[0, 0x2d2152], [0.55, 0x7a4a9e], [1, 0xffb0c8]], clamp(h / 24, 0, 1), out);
    },
    decorate: (tile, ctx) => {
      const r = rng(99);
      const specs: Spec[] = [];
      for (let i = 0; i < 120; i++) {
        const z = (r() - 0.5) * L;
        const side = r() < 0.5 ? -1 : 1;
        const x = cx(z) + side * (9 + r() * 42);
        const s = 0.55 + r() * 0.8;
        const ry = r() * 6;
        const h = height(x, z);
        if (h < LAKE - 0.2) continue; // would be underwater
        specs.push({ x, y: h + 1.5 * s * 1.5, z, sx: s, sy: s * 1.5, sz: s, ry });
      }
      const rc = rng(5);
      instanced(tile, new ConeGeometry(1, 3, 5), flatMat(), specs, (_i, c) => c.setHSL(0.66 + rc() * 0.1, 0.45, 0.1 + rc() * 0.07));

      // dusk lakes: pink in the shallows, deep violet in the middle, pale foam at the edge
      addWater(tile, ctx, {
        level: LAKE,
        opacity: 0.88,
        shade: (_x, _z, depth, out) => {
          ramp([[0, 0xe58fc8], [1.2, 0x8a52b8], [4, 0x23184f]], depth, out);
          if (depth < 0.4) out.lerp(c1.setHex(0xffe3f0), 0.5 * (1 - Math.max(depth, 0) / 0.4));
        },
      });
    },
    extras: (g, ctx) => addStars(g, ctx, 320, 21),
    sun: { color: 0xffa8c4, radius: 30, pos: [55, 52, -330] },
  };
}

// ---------------------------------------------------------------------- snow
function snowDef(): Def {
  const L = 200;
  const A = 6;
  const K = TAU / L;
  const cx = (z: number) => A * Math.sin(K * z);
  const height: HeightFn = (x, z) => {
    const n = Math.sin(z * K * 2 + x * 0.05) * 0.5 + Math.sin(z * K * 4 - x * 0.09 + 1) * 0.3 + Math.sin(z * K * 7 + x * 0.15 + 2) * 0.2;
    const dx = Math.abs(x - cx(z));
    const c = smooth(12, 85, dx);
    return n * 2.4 + c * (16 + 12 * n) - 0.5;
  };
  const ROCK = new Color(0x56667f);
  return {
    id: 'snow',
    L,
    A,
    camY: 5,
    speed: 20,
    fogNear: 40,
    fogFar: 190,
    W: 320,
    segX: 64,
    segZ: 44,
    ringR: 2.7,
    height,
    color: (x, z, h, out) => {
      ramp([[0, 0xbfd4ee], [1, 0xffffff]], clamp(h / 22, 0, 1), out);
      const s = Math.abs(height(x + 2, z) - h) + Math.abs(height(x, z + 2) - h);
      if (s > 3) out.lerp(ROCK, clamp((s - 3) / 4, 0, 0.75)); // exposed rock on the steep bits
    },
    decorate: (tile) => {
      const r = rng(31);
      const trees: Spec[] = [];
      const caps: Spec[] = [];
      for (let i = 0; i < 220; i++) {
        const z = (r() - 0.5) * L;
        const side = r() < 0.5 ? -1 : 1;
        const x = cx(z) + side * (7 + r() * 70);
        const s = 0.7 + r() * 0.9;
        const sy = s * 1.7;
        const h = height(x, z);
        const ry = r() * 6;
        trees.push({ x, y: h + 1.6 * sy, z, sx: s, sy, sz: s, ry });
        caps.push({ x, y: h + 2.65 * sy, z, sx: s, sy, sz: s, ry });
      }
      const rc = rng(8);
      instanced(tile, new ConeGeometry(1, 3.2, 6), flatMat(), trees, (_i, c) => c.setHSL(0.45 + rc() * 0.06, 0.4, 0.14 + rc() * 0.06));
      instanced(tile, new ConeGeometry(0.62, 1.1, 6), flatMat(), caps, (_i, c) => c.setHex(0xf4f9ff));
    },
    extras: (g, ctx) => {
      // snowfall: points in a box around the camera; falls, drifts, and streams toward the viewer with the flight
      const N = 1400;
      const pos = new Float32Array(N * 3);
      const r = rng(77);
      for (let i = 0; i < N; i++) {
        pos[i * 3] = (r() - 0.5) * 100;
        pos[i * 3 + 1] = r() * 38;
        pos[i * 3 + 2] = -100 + r() * 94; // never closer than 6 units: near flakes would be huge
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      // soft round flakes (a plain Points sprite is a hard square)
      const dot = document.createElement('canvas');
      dot.width = dot.height = 32;
      const dg = dot.getContext('2d')!;
      const grad = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.75)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      dg.fillStyle = grad;
      dg.fillRect(0, 0, 32, 32);
      const pts = new Points(
        geo,
        new PointsMaterial({ map: new CanvasTexture(dot), color: 0xffffff, size: 0.5, transparent: true, depthWrite: false }),
      );
      pts.frustumCulled = false;
      g.add(pts);
      ctx.ticks.push((t, dt, camX, v) => {
        for (let i = 0; i < N; i++) {
          const k = i * 3;
          pos[k + 1] -= (2.2 + (i % 7) * 0.25) * dt;
          pos[k] += Math.sin(t * 0.7 + i) * 0.6 * dt;
          pos[k + 2] += v * dt;
          if (pos[k + 1] < 0) pos[k + 1] += 38;
          if (pos[k + 2] > -6) pos[k + 2] -= 94;
        }
        geo.attributes.position.needsUpdate = true;
        pts.position.x = camX;
      });

      addAurora(g, ctx);
      addStars(g, ctx, 380, 11);
    },
    sun: { color: 0xfff0cf, radius: 16, pos: [-70, 34, -330] },
  };
}

// ----------------------------------------------------------------- mountains
function mountainsDef(): Def {
  const L = 240;
  const A = 9;
  const K = TAU / L;
  const cx = (z: number) => A * Math.sin(K * z);
  const height: HeightFn = (x, z) => {
    const r1 = 1 - Math.abs(Math.sin(z * K * 3 + x * 0.045 + 0.7));
    const r2 = 1 - Math.abs(Math.sin(z * K * 5 - x * 0.07));
    const r3 = 1 - Math.abs(Math.sin(z * K * 8 + x * 0.12 + 2));
    const ridge = r1 * 0.55 + r2 * 0.3 + r3 * 0.15;
    const pk = ridge * ridge;
    const dx = Math.abs(x - cx(z));
    const c = smooth(15, 95, dx);
    return -10 + c * (80 * pk + 22) + (1 - c) * pk * 14; // cloud sea is y = 0; peaks poke above it
  };
  return {
    id: 'mountains',
    L,
    A,
    camY: 17,
    speed: 42,
    fogNear: 60,
    fogFar: 260,
    W: 420,
    segX: 70,
    segZ: 50,
    ringR: 3.6,
    height,
    color: (_x, _z, h, out) => {
      // golden hour: deep violet shadows, warm rock, glowing alpenglow on the high slopes, white-hot summits
      ramp([[0, 0x2d1f3d], [0.3, 0x6e4458], [0.58, 0xd49470], [0.85, 0xffdcc0], [1, 0xfff6f0]], clamp((h + 10) / 95, 0, 1), out);
    },
    decorate: (tile, ctx) => {
      // the cloud sea: a rumpled plane at y = 0 whose swells roll and drift. Periodic in z, so tiles still join;
      // the geometry is shared by all three tiles, so it is animated once per frame.
      const geo = new PlaneGeometry(ctx.def.W, ctx.def.L, 44, 30);
      geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position;
      const px: number[] = [];
      const pz: number[] = [];
      for (let i = 0; i < p.count; i++) {
        px.push(p.getX(i));
        pz.push(p.getZ(i));
      }
      const col = new Float32BufferAttribute(new Float32Array(p.count * 3), 3);
      geo.setAttribute('color', col);
      const lo = new Color(0xf2a283);
      const hi = new Color(0xfff2e2);
      const c = new Color();
      const roll = (t: number) => {
        for (let i = 0; i < p.count; i++) {
          const y = 1.1 * Math.sin(pz[i] * K * 9 + px[i] * 0.08 + t * 0.22) + 0.8 * Math.sin(pz[i] * K * 15 - px[i] * 0.13 + 1 - t * 0.17);
          p.setY(i, y);
          c.copy(lo).lerp(hi, clamp((y + 1.9) / 3.8, 0, 1)); // crests catch the light
          col.setXYZ(i, c.r, c.g, c.b);
        }
        p.needsUpdate = true;
        col.needsUpdate = true;
      };
      roll(0);
      tile.add(new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, transparent: true, opacity: 0.96 })));
      ctx.ticks.push((t) => roll(t));

      // a thin brighter haze sheet between the peaks and the camera: parallax depth
      const hz = new PlaneGeometry(ctx.def.W, ctx.def.L, 26, 18);
      hz.rotateX(-Math.PI / 2);
      const hp = hz.attributes.position;
      const hx: number[] = [];
      const hzz: number[] = [];
      for (let i = 0; i < hp.count; i++) {
        hx.push(hp.getX(i));
        hzz.push(hp.getZ(i));
      }
      tile.add(new Mesh(hz, new MeshBasicMaterial({ color: 0xffd8c0, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide })));
      ctx.ticks.push((t) => {
        for (let i = 0; i < hp.count; i++) hp.setY(i, 10 + 1.6 * Math.sin(hzz[i] * K * 6 + hx[i] * 0.05 - t * 0.12));
        hp.needsUpdate = true;
      });
    },
    sun: { color: 0xffd08a, radius: 60, pos: [-85, 42, -400] },
  };
}

// --------------------------------------------------------------------- beach
function beachDef(): Def {
  const L = 180;
  const A = 8;
  const K = TAU / L;
  const cx = (z: number) => A * Math.sin(K * z);
  const shore = (z: number) => cx(z) - 14; // land to the left, sea to the right; the flight line runs just off the shore
  const height: HeightFn = (x, z) => {
    const d = shore(z) - x; // > 0 on land
    const n = Math.sin(z * K * 3 + x * 0.06) * 0.5 + Math.sin(z * K * 6 - x * 0.1 + 1) * 0.3 + Math.sin(z * K * 10 + x * 0.2) * 0.2;
    if (d > 0) return 0.25 + d * 0.035 + n * 1.6 * smooth(8, 50, d) + smooth(55, 140, d) * (20 + 14 * n);
    return 0.25 + d * 0.16; // sea floor slopes away from the shoreline
  };
  return {
    id: 'beach',
    L,
    A,
    camY: 6,
    speed: 26,
    fogNear: 45,
    fogFar: 200,
    W: 340,
    segX: 64,
    segZ: 40,
    height,
    color: (x, z, h, out) => {
      const d = shore(z) - x;
      if (d <= 0) {
        ramp([[0, 0x74d6c8], [10, 0x2a9fb0], [40, 0x0e5a78]], -d, out); // sea floor, seen through the water
      } else {
        ramp([[0, 0xc9ad78], [6, 0xecd39a], [40, 0xf3deb0]], d, out);
        out.lerp(c1.setHex(0x5f8f4a), smooth(50, 90, d)); // vegetation inland
        if (h > 10) out.lerp(c1.setHex(0x3f6a3a), clamp((h - 10) / 25, 0, 0.7));
      }
    },
    decorate: (tile, ctx) => {
      // animated water: periodic in z, so tiles still join; the geometry is shared by all three tiles
      const geo = new PlaneGeometry(ctx.def.W, ctx.def.L, 44, 30);
      geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position;
      const cols = new Float32Array(p.count * 3);
      const c = new Color();
      for (let i = 0; i < p.count; i++) {
        const ds = p.getX(i) - shore(p.getZ(i)); // > 0 over the sea
        ramp([[0, 0x62d4c9], [12, 0x1fa3ae], [50, 0x0d5575]], ds, c);
        if (ds < 2.5) c.lerp(c1.setHex(0xffffff), 0.5 * (1 - Math.max(ds, 0) / 2.5));
        cols.set([c.r, c.g, c.b], i * 3);
      }
      geo.setAttribute('color', new Float32BufferAttribute(cols, 3));
      tile.add(
        new Mesh(
          geo,
          new MeshStandardMaterial({ vertexColors: true, flatShading: true, transparent: true, opacity: 0.85, roughness: 0.65, metalness: 0.05 }),
        ),
      );
      const px: number[] = [];
      const pz: number[] = [];
      for (let i = 0; i < p.count; i++) {
        px.push(p.getX(i));
        pz.push(p.getZ(i));
      }
      ctx.ticks.push((t) => {
        for (let i = 0; i < p.count; i++) {
          p.setY(i, 0.14 * Math.sin(pz[i] * K * 10 + t * 1.3 + px[i] * 0.2) + 0.09 * Math.sin(pz[i] * K * 17 - t * 1.1 + px[i] * 0.35));
        }
        p.needsUpdate = true;
      });

      // palms on the land side
      const r = rng(61);
      const trunks: Spec[] = [];
      const fronds: Spec[] = [];
      for (let i = 0; i < 70; i++) {
        const z = (r() - 0.5) * L;
        const x = shore(z) - (5 + r() * 40);
        const h = height(x, z);
        const sy = 5 + r() * 4;
        const wide = 2.6 + r();
        const ry = r() * 6;
        trunks.push({ x, y: h + sy / 2, z, sx: 1, sy, sz: 1, ry });
        fronds.push({ x, y: h + sy + 0.2, z, sx: wide, sy: 0.7, sz: wide, ry });
      }
      instanced(tile, new CylinderGeometry(0.18, 0.3, 1, 5), flatMat(), trunks, (_i, col) => col.setHex(0x7a5a3a));
      const rg = rng(2);
      instanced(tile, new ConeGeometry(1, 1, 6), flatMat(), fronds, (_i, col) => col.setHSL(0.33, 0.55, 0.28 + rg() * 0.1));
    },
    sun: { color: 0xffb066, radius: 38, pos: [70, 20, -340] },
  };
}

// --------------------------------------------------------------------- farms
function farmsDef(): Def {
  const L = 160;
  const A = 5;
  const K = TAU / L;
  const cx = (z: number) => A * Math.sin(K * z);
  const POND = -2.4; // water level: the fields never dip below -1.7, so only the carved ponds flood
  // two ponds per period, a little off the road on opposite sides
  const ponds: Array<[number, number]> = [
    [cx(-42) + 24, -42],
    [cx(40) - 28, 40],
  ];
  const pondDepth = (x: number, z: number) => {
    let d = 0;
    for (const [px, pz] of ponds) d += 5 * Math.exp(-((x - px) ** 2 + (z - pz) ** 2) / (13 * 13));
    return d;
  };
  const height: HeightFn = (x, z) => {
    const n = Math.sin(z * K * 2 + x * 0.03) * 0.6 + Math.sin(z * K * 5 - x * 0.05) * 0.4;
    const dx = Math.abs(x - cx(z));
    const c = smooth(35, 115, dx);
    return n * 1.4 + c * (10 + 8 * n) - 0.3 - pondDepth(x, z);
  };
  const CELL_X = 22;
  const CELL_Z = 20; // L / CELL_Z = 8 cells, so the patchwork is periodic in z
  const FIELD = [0x5f9a45, 0x78b04f, 0x4d8a3d, 0x9bc46a, 0xd9b94e, 0xe3c765, 0x8a6a45, 0x7a5a3a];
  return {
    id: 'farms',
    L,
    A,
    camY: 9,
    speed: 22,
    fogNear: 50,
    fogFar: 210,
    W: 320,
    segX: 72,
    segZ: 44,
    flat: true,
    ringR: 2.9,
    height,
    color: (x, z, h, out) => {
      if (Math.abs(x - cx(z)) < 3.2) return void out.setHex(0xc9b48a); // the dirt road along the flight line
      if (h < -1.9) return void out.setHex(0xb9a67a); // pond bed, seen through the water
      if (h > 7) return void out.setHex(0x2f5f3a); // forested hills
      const ix = Math.floor((x + 200) / CELL_X);
      const iz = (((Math.floor((z + L / 2) / CELL_Z) % 8) + 8) % 8);
      out.setHex(FIELD[Math.floor(hash(ix, iz) * FIELD.length)]);
      out.multiplyScalar(0.92 + hash(Math.floor(x * 0.5), Math.floor(z * 0.5)) * 0.16); // per-facet variation
    },
    decorate: (tile, ctx) => {
      const r = rng(13);
      const crowns: Spec[] = [];
      const trunks: Spec[] = [];
      for (let i = 0; i < 140; i++) {
        const z = (r() - 0.5) * L;
        const x = (r() - 0.5) * 280;
        if (Math.abs(x - cx(z)) < 6) continue; // keep the road clear
        const s = 1.2 + r() * 1.2;
        const h = height(x, z);
        if (h < POND + 0.2) continue; // would be in a pond
        crowns.push({ x, y: h + s * 1.1 + s * 1.2, z, sx: s, sy: s * 1.15, sz: s, ry: r() * 6 });
        trunks.push({ x, y: h + s * 0.6, z, sx: 1, sy: s * 1.2, sz: 1, ry: 0 });
      }
      const rc = rng(3);
      instanced(tile, new IcosahedronGeometry(1, 0), flatMat(), crowns, (_i, c) => c.setHSL(0.29 + rc() * 0.05, 0.45, 0.2 + rc() * 0.1));
      instanced(tile, new CylinderGeometry(0.2, 0.28, 1, 5), flatMat(), trunks, (_i, c) => c.setHex(0x6a4a2e));

      // barns: box walls + a four-sided roof
      const walls: Spec[] = [];
      const roofs: Spec[] = [];
      const rb = rng(21);
      for (let i = 0; i < 10; i++) {
        const z = (rb() - 0.5) * L;
        const side = rb() < 0.5 ? -1 : 1;
        const x = cx(z) + side * (14 + rb() * 46);
        const h = height(x, z);
        const ry = rb() < 0.5 ? 0 : Math.PI / 2;
        if (h < POND + 0.6) continue; // no barns in the pond
        walls.push({ x, y: h + 2, z, sx: 6, sy: 4, sz: 8, ry });
        roofs.push({ x, y: h + 5.5, z, sx: 4.67, sy: 3, sz: 6.1, ry });
      }
      const roofGeo = new ConeGeometry(1, 1, 4);
      roofGeo.rotateY(Math.PI / 4);
      const rw = rng(4);
      instanced(tile, new BoxGeometry(1, 1, 1), flatMat(), walls, (_i, c) => c.setHSL(0.02 + rw() * 0.02, 0.55, 0.32));
      instanced(tile, roofGeo, flatMat(), roofs, (_i, c) => c.setHex(0x4a3b36));

      // one windmill per tile; the blades turn
      const wz = -30;
      const wx = cx(wz) + 26;
      const wh = height(wx, wz);
      const mill = new Group();
      const tower = new Mesh(new CylinderGeometry(0.9, 1.7, 13, 6), flatMat({ color: 0xe8dcc4 }));
      tower.position.set(wx, wh + 6.5, wz);
      const cap = new Mesh(new ConeGeometry(1.4, 2.2, 6), flatMat({ color: 0x8a3b2c }));
      cap.position.set(wx, wh + 14, wz);
      const blades = new Group();
      blades.name = 'blades';
      blades.position.set(wx, wh + 11, wz + 1.7);
      const bladeMat = flatMat({ color: 0xf2ead6 });
      for (let i = 0; i < 4; i++) {
        const b = new Mesh(new BoxGeometry(0.5, 5, 0.12), bladeMat);
        const arm = new Group();
        arm.rotation.z = (i * Math.PI) / 2;
        b.position.y = 2.7;
        arm.add(b);
        blades.add(arm);
      }
      mill.add(tower, cap, blades);
      tile.add(mill);
      ctx.ticks.push((t) => {
        for (const tl of ctx.tiles) {
          const bl = tl.getObjectByName('blades');
          if (bl) bl.rotation.z = t * 0.9;
        }
      });

      // ponds that catch the sky
      addWater(tile, ctx, {
        level: POND,
        opacity: 0.86,
        shade: (_x, _z, depth, out) => {
          ramp([[0, 0xa9e6f5], [2, 0x4ba8d6], [5, 0x1b6a9e]], depth, out);
          if (depth < 0.4) out.lerp(c1.setHex(0xffffff), 0.45 * (1 - Math.max(depth, 0) / 0.4));
        },
      });
    },
    extras: (g, ctx) => {
      addPuffyClouds(g, ctx, 41); // drifting clouds
      addBirds(g, ctx, 11, 7); // a flock crossing the sky
    },
    sun: { color: 0xfff0b0, radius: 26, pos: [-70, 55, -330] },
  };
}

// ------------------------------------------------------------- world builder
function buildTile(def: Def, ctx: Ctx): Group {
  const tile = new Group();

  let geo: BufferGeometry = new PlaneGeometry(def.W, def.L, def.segX, def.segZ);
  geo.rotateX(-Math.PI / 2);
  const p0 = geo.attributes.position;
  for (let i = 0; i < p0.count; i++) p0.setY(i, def.height(p0.getX(i), p0.getZ(i)));
  if (def.flat) geo = geo.toNonIndexed();

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  if (def.flat) {
    for (let i = 0; i < pos.count; i += 3) {
      const mx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const my = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const mz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      def.color(mx, mz, my, c);
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      def.color(pos.getX(i), pos.getZ(i), pos.getY(i), c);
      colors.set([c.r, c.g, c.b], i * 3);
    }
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  tile.add(new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 })));

  def.decorate?.(tile, ctx);

  // gates along the flight line
  for (let k = 0; k < 4; k++) {
    const z = -def.L / 2 + (def.L * (k + 0.5)) / 4;
    const ring = new Mesh(new TorusGeometry(def.ringR ?? 2.4, 0.13, 6, 28), ctx.ringMat);
    ring.position.set(ctx.cx(z), def.camY + 0.1, z);
    ring.rotation.y = Math.atan(ctx.slope(z));
    ring.name = 'ring';
    tile.add(ring);
  }
  return tile;
}

class TileWorld implements World {
  readonly id: WorldId;
  readonly group = new Group();
  readonly L: number;
  readonly A: number;
  readonly camY: number;
  readonly speed: number;
  readonly fogNear: number;
  readonly fogFar: number;
  private ctx: Ctx;
  private tiles: Group[];
  private sun?: Mesh;
  private halo?: Mesh;
  private sunPos: [number, number, number] = [0, 0, 0];

  constructor(def: Def) {
    this.id = def.id;
    this.L = def.L;
    this.A = def.A;
    this.camY = def.camY;
    this.speed = def.speed;
    this.fogNear = def.fogNear;
    this.fogFar = def.fogFar;

    const K = TAU / def.L;
    this.ctx = {
      def,
      K,
      cx: (z) => def.A * Math.sin(K * z),
      slope: (z) => def.A * K * Math.cos(K * z),
      ringMat: new MeshBasicMaterial({ color: 0xff8fab }),
      tiles: [],
      ticks: [],
    };
    const base = buildTile(def, this.ctx);
    this.tiles = [base, base.clone(), base.clone()];
    this.ctx.tiles = this.tiles;
    this.tiles.forEach((t) => this.group.add(t));
    def.extras?.(this.group, this.ctx);

    if (def.sun) {
      this.sunPos = def.sun.pos;
      this.sun = new Mesh(new CircleGeometry(def.sun.radius, 32), new MeshBasicMaterial({ color: def.sun.color, fog: false, depthWrite: false }));
      this.group.add(this.sun);
      // soft glow around the sun: additive, so it brightens whatever sky is behind it
      this.halo = new Mesh(
        new CircleGeometry(def.sun.radius * 3.4, 40),
        glowBlend(new MeshBasicMaterial({ map: haloTexture(), color: def.sun.color, opacity: 0.55, fog: false })),
      );
      this.halo.renderOrder = -2;
      this.group.add(this.halo);
    }
    this.group.visible = false;
  }

  setAccent(c: Color) {
    this.ctx.ringMat.color.copy(c);
  }

  update(s: number, camX: number, t: number, dt: number, v: number) {
    const m = s % this.L;
    this.tiles.forEach((tile, j) => (tile.position.z = m - j * this.L));
    this.sun?.position.set(camX + this.sunPos[0], this.sunPos[1], this.sunPos[2]);
    this.halo?.position.set(camX + this.sunPos[0], this.sunPos[1], this.sunPos[2] - 1);
    for (const tick of this.ctx.ticks) tick(t, dt, camX, v);
  }
}

export function createWorld(id: WorldId): World {
  switch (id) {
    case 'snow':
      return new TileWorld(snowDef());
    case 'mountains':
      return new TileWorld(mountainsDef());
    case 'beach':
      return new TileWorld(beachDef());
    case 'farms':
      return new TileWorld(farmsDef());
    default:
      return new TileWorld(valleyDef());
  }
}
