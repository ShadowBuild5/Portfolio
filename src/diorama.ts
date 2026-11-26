import {
  Group,
  Mesh,
  BoxGeometry,
  CylinderGeometry,
  MeshStandardMaterial,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  CustomBlending,
  AddEquation,
  SrcAlphaFactor,
  OneFactor,
  ZeroFactor,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Shared pieces for the "diorama" scenes (workshop, charging station): small handcrafted 3D sets seen from a
 * fixed camera. A diorama is a Group + an update(t, dt) + a camera framing; Stage3D drives the camera.
 */

/** Camera framing. Parallax: the mouse (-1..1) moves the camera/target by `gain` units. */
export interface DioramaCam {
  pos: [number, number, number];
  look: [number, number, number];
  fov: number; // vertical, degrees
  posGain: [number, number]; // [x, y] camera movement per unit of mouse offset
  lookGain: [number, number]; // [x, y] look-target movement per unit of mouse offset
}

export interface Diorama {
  readonly group: Group;
  readonly cam: DioramaCam;
  /** Optional framing for tall, narrow screens. */
  readonly camPortrait?: DioramaCam;
  /** For ?debug stats: how many static meshes were folded into one. */
  mergedCount?: number;
  update(t: number, dt: number): void;
}

// ---------------------------------------------------------------- builders
const mats = new Map<number, MeshStandardMaterial>();
export const mat = (c: number) => {
  let m = mats.get(c);
  if (!m) {
    m = new MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9, metalness: 0 });
    mats.set(c, m);
  }
  return m;
};

// Meshes made by box() / cyl() are flagged `merge`: bakeStatic() folds the static ones into a single mesh
// (one draw call instead of dozens), which matters a lot on slow devices.
export function box(p: Group, w: number, h: number, d: number, c: number, x: number, y: number, z: number) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat(c));
  m.position.set(x, y, z);
  m.userData.merge = true;
  p.add(m);
  return m;
}

export function cyl(p: Group, rt: number, rb: number, h: number, c: number, x: number, y: number, z: number, seg = 8) {
  const m = new Mesh(new CylinderGeometry(rt, rb, h, seg), mat(c));
  m.position.set(x, y, z);
  m.userData.merge = true;
  p.add(m);
  return m;
}

/**
 * Additive glow that works on our TRANSPARENT WebGL canvas. three's stock AdditiveBlending also writes alpha,
 * so a dark-but-additive pixel (e.g. the dim top of an aurora curtain) becomes an opaque near-black pixel once
 * the browser composites the canvas over the page. This blend adds color (scaled by the source alpha) and leaves
 * the alpha channel alone, so the page shows through and the glow is truly additive.
 */
export function glowBlend<T extends Material>(m: T): T {
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = OneFactor;
  m.blendEquationAlpha = AddEquation;
  m.blendSrcAlpha = ZeroFactor;
  m.blendDstAlpha = OneFactor;
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  return new CanvasTexture(c);
}

/**
 * Merge every flagged static mesh under `root` into one vertex-colored mesh. `isLive(mesh)` lets the caller
 * keep animated parts separate. Mirrored meshes (negative determinant) are skipped: merging would flip their
 * winding. Returns how many meshes were merged.
 */
export function bakeStatic(root: Group, isLive: (o: Object3D) => boolean): number {
  root.updateMatrixWorld(true);
  const geos: BufferGeometry[] = [];
  const doomed: Mesh[] = [];
  const c = new Color();
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !o.userData.merge || isLive(o)) return;
    if (o.matrixWorld.determinant() < 0) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    c.copy((o.material as MeshStandardMaterial).color);
    const count = geo.attributes.position.count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) col.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    geos.push(geo);
    doomed.push(o);
  });
  const merged = mergeGeometries(geos, false);
  for (const m of doomed) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  if (merged) root.add(new Mesh(merged, new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 })));
  return doomed.length;
}
