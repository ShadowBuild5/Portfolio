import {
  Group,
  Mesh,
  BoxGeometry,
  ConeGeometry,
  SphereGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  PointLight,
  Points,
  PointsMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  Vector3,
  DoubleSide,
} from 'three';
import type { Object3D } from 'three';
import { box, cyl, mat, canvasTex, bakeStatic } from './diorama';
import type { Diorama, DioramaCam } from './diorama';
/**
 * The soldering workshop: a diorama seen from behind the character's shoulder.
 * Local coordinates: the character sits at the origin facing +z; the bench is ahead of him; the
 * camera (see Stage3D) sits behind him at negative z. Everything is primitives + a few canvas textures.
 */

/** The parts of the shared character model the workshop needs to re-pose. */
export interface ShopCharacter {
  group: Group;
  breathe: Group;
  head: Group;
  arms: { shoulder: Group; fore: Group }[];
  radio: Group;
  shadow: Mesh;
}

export class Workshop implements Diorama {
  readonly group = new Group();
  private ch: ShopCharacter;
  private glow: Mesh;
  private tipLight: PointLight;
  private smoke: { pos: Float32Array; geo: BufferGeometry; n: number };
  private tip = new Vector3();
  private armBase = [0, 0];
  /** How many static meshes were folded into the single baked mesh (for ?debug stats). */
  mergedCount = 0;

  readonly cam: DioramaCam = { pos: [1.3, 2.9, -3.4], look: [-1.4, 1.25, 1.2], fov: 54, posGain: [0.5, 0.25], lookGain: [0.35, 0.15] };
  readonly camPortrait: DioramaCam = { pos: [0.8, 3.0, -3.9], look: [0.2, 0.55, 1.2], fov: 66, posGain: [0.3, 0.2], lookGain: [0.2, 0.1] };

  constructor(ch: ShopCharacter) {
    this.ch = ch;
    const g = this.group;

    // ------------------------------------------------------------ character, re-posed to work
    g.add(ch.group);
    ch.radio.visible = false;
    ch.breathe.rotation.x = 0.28; // leaning over the work
    ch.head.rotation.x = 0.32; // looking down at the board
    const [left, right] = ch.arms;
    left.shoulder.rotation.x = -1.0;
    left.fore.rotation.x = -0.45;
    right.shoulder.rotation.x = -1.05; // soldering arm
    right.fore.rotation.x = -0.35;
    this.armBase = [left.shoulder.rotation.x, right.shoulder.rotation.x];

    // soldering iron strapped to the right forearm: handle, shaft, tip
    const handle = cyl(new Group(), 0.024, 0.02, 0.24, 0x2b2b30, 0, -0.4, 0);
    const ring = cyl(new Group(), 0.027, 0.027, 0.03, 0xff8a1f, 0, -0.3, 0);
    const shaft = cyl(new Group(), 0.008, 0.008, 0.14, 0xc4c8d2, 0, -0.59, 0, 6);
    const tipCone = new Mesh(new ConeGeometry(0.011, 0.045, 6), mat(0xe2e4ea));
    tipCone.position.set(0, -0.69, 0);
    tipCone.rotation.x = Math.PI;
    right.fore.add(handle, ring, shaft, tipCone);

    // where does the tip end up? (the bench and the PCB are built around it)
    g.updateMatrixWorld(true);
    right.fore.localToWorld(this.tip.set(0, -0.715, 0));
    const benchY = Math.max(0.82, this.tip.y - 0.045);

    // ------------------------------------------------------------ room
    box(g, 16, 0.2, 12, 0x3a2c20, 0, -0.1, 1); // floor
    box(g, 16, 6.5, 0.3, 0x4b3b2d, 0, 3.1, 3.7); // back wall
    box(g, 0.3, 6.5, 12, 0x43352a, -4.6, 3.1, 1); // left wall (just peeks in at the edge)
    box(g, 0.3, 6.5, 12, 0x43352a, 5.6, 3.1, 1);
    // wall slats for texture
    for (let i = 0; i < 6; i++) box(g, 16, 0.04, 0.02, 0x3a2d22, 0, 0.7 + i * 1.0, 3.53);

    // pegboard with tools
    box(g, 5.2, 2.0, 0.08, 0x7a6040, -0.5, 2.1, 3.5);
    const hang = new Group();
    hang.position.set(0, -0.25, 3.44);
    g.add(hang);
    box(hang, 0.05, 0.5, 0.03, 0x6a4a2c, -2.5, 2.5, 0); // hammer
    box(hang, 0.22, 0.1, 0.05, 0x9aa0ad, -2.5, 2.8, 0);
    box(hang, 0.04, 0.42, 0.03, 0xb02a2a, -1.9, 2.5, 0); // pliers
    box(hang, 0.04, 0.42, 0.03, 0xb02a2a, -1.82, 2.5, 0);
    box(hang, 0.04, 0.3, 0.03, 0x9aa0ad, -1.86, 2.72, 0);
    box(hang, 0.07, 0.2, 0.04, 0xe0b030, -1.3, 2.4, 0); // screwdriver
    box(hang, 0.015, 0.28, 0.02, 0xc4c8d2, -1.3, 2.18, 0);
    box(hang, 0.09, 0.62, 0.03, 0x9aa0ad, -0.7, 2.5, 0); // wrench
    box(hang, 0.5, 0.06, 0.02, 0xd8c08a, 0.1, 2.05, 0); // ruler
    for (let i = 0; i < 3; i++) cyl(hang, 0.16, 0.16, 0.12, [0xd23b3b, 0x3b6bd2, 0x3bb36b][i], 0.7 + i * 0.5, 2.6, 0, 12).rotation.x = Math.PI / 2; // wire spools

    // sign + hazard tape
    const sign = new Mesh(
      new PlaneGeometry(2.8, 0.7),
      new MeshBasicMaterial({
        map: canvasTex(512, 128, (c) => {
          c.fillStyle = '#6b4f33';
          c.fillRect(0, 0, 512, 128);
          c.strokeStyle = 'rgba(0,0,0,0.3)';
          for (let y = 32; y < 128; y += 32) {
            c.beginPath();
            c.moveTo(0, y);
            c.lineTo(512, y);
            c.stroke();
          }
          c.fillStyle = '#ffd27a';
          c.font = 'bold 54px "Segoe Print","Ink Free","Comic Sans MS",cursive';
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText("WORKSHOP", 256, 66);
        }),
        color: 0xd8d8d8,
      }),
    );
    sign.position.set(-0.5, 3.7, 3.5);
    sign.rotation.y = Math.PI; // face -z, toward the camera
    g.add(sign);
    const hazard = new Mesh(
      new PlaneGeometry(5.2, 0.22),
      new MeshBasicMaterial({
        map: canvasTex(512, 32, (c) => {
          c.fillStyle = '#ffcc00';
          c.fillRect(0, 0, 512, 32);
          c.fillStyle = '#141414';
          for (let x = -32; x < 544; x += 48) {
            c.beginPath();
            c.moveTo(x, 32);
            c.lineTo(x + 24, 32);
            c.lineTo(x + 56, 0);
            c.lineTo(x + 32, 0);
            c.closePath();
            c.fill();
          }
        }),
        color: 0xd0d0d0,
      }),
    );
    hazard.position.set(-0.5, 3.25, 3.5);
    hazard.rotation.y = Math.PI;
    g.add(hazard);

    // shelves (right) with bins, spools and a spare drone frame
    for (const sy of [1.7, 2.5]) box(g, 2.2, 0.07, 0.6, 0x7a5c3a, 3.4, sy, 3.2);
    [0x3a6ea5, 0xa53a3a, 0x3aa56e, 0xc79a2b, 0x7a4aa5].forEach((c, i) => box(g, 0.34, 0.26 + (i % 2) * 0.1, 0.4, c, 2.6 + i * 0.4, 1.87 + (i % 2) * 0.05, 3.15));
    for (let i = 0; i < 3; i++) cyl(g, 0.15, 0.15, 0.18, [0xd23b3b, 0x3bb36b, 0xe0b030][i], 2.75 + i * 0.45, 2.68, 3.15, 12);
    const spare = new Group();
    spare.position.set(4.3, 2.62, 3.15);
    box(spare, 0.28, 0.07, 0.28, 0x22252e, 0, 0, 0);
    for (const rz of [Math.PI / 4, -Math.PI / 4]) box(spare, 0.7, 0.035, 0.06, 0x22252e, 0, 0, 0).rotation.y = rz;
    g.add(spare);

    // crates on the floor, left
    box(g, 0.9, 0.7, 0.9, 0x7a5c3a, -3.2, 0.35, 2.4);
    box(g, 0.8, 0.6, 0.8, 0x6a4f32, -3.15, 1.0, 2.35);
    box(g, 0.9, 0.5, 0.9, 0x6a4f32, -2.3, 0.25, 2.8);

    // ------------------------------------------------------------ bench
    const bz = 1.45;
    box(g, 4.6, 0.08, 1.7, 0x8a6a46, 0.4, benchY - 0.04, bz); // top
    box(g, 4.6, 0.12, 0.05, 0x6f5336, 0.4, benchY - 0.14, bz - 0.83); // front apron
    for (const lx of [-1.8, 2.6]) for (const lz of [bz - 0.75, bz + 0.75]) box(g, 0.12, benchY - 0.08, 0.12, 0x6f5336, lx, (benchY - 0.08) / 2, lz);
    box(g, 4.4, 0.05, 1.4, 0x6f5336, 0.4, 0.3, bz); // lower shelf

    // PCB under the iron tip: board, chip, pads, caps
    const pcb = new Group();
    pcb.position.set(this.tip.x - 0.02, benchY + 0.02, this.tip.z + 0.06);
    g.add(pcb);
    box(pcb, 0.7, 0.04, 0.5, 0x1f7a4d, 0, 0, 0);
    box(pcb, 0.14, 0.035, 0.14, 0x15161b, -0.17, 0.035, 0.05);
    box(pcb, 0.09, 0.03, 0.09, 0x15161b, 0.18, 0.033, -0.1);
    for (let i = 0; i < 6; i++) box(pcb, 0.03, 0.012, 0.03, 0xe0b04a, -0.05 + i * 0.045, 0.026, -0.14);
    cyl(pcb, 0.025, 0.025, 0.05, 0x3b6bd2, 0.2, 0.04, 0.12, 8);
    cyl(pcb, 0.025, 0.025, 0.05, 0xd23b3b, 0.12, 0.04, 0.17, 8);

    // solder spool, iron stand, multimeter, parts tray
    cyl(g, 0.11, 0.11, 0.13, 0xc9ccd6, this.tip.x + 0.75, benchY + 0.065, this.tip.z - 0.1, 14);
    box(g, 0.16, 0.05, 0.2, 0x2b2b30, this.tip.x - 0.62, benchY + 0.025, this.tip.z + 0.1);
    cyl(g, 0.012, 0.012, 0.14, 0xc4c8d2, this.tip.x - 0.62, benchY + 0.12, this.tip.z + 0.1, 5);
    const meter = new Group();
    meter.position.set(this.tip.x - 1.4, benchY + 0.07, this.tip.z + 0.3);
    meter.rotation.y = 0.25;
    g.add(meter);
    box(meter, 0.3, 0.13, 0.5, 0xe0b030, 0, 0, 0);
    const screen = new Mesh(new BoxGeometry(0.2, 0.012, 0.12), new MeshBasicMaterial({ color: 0x4fe38a })); // lit display
    screen.position.set(0, 0.07, 0.12);
    meter.add(screen);
    cyl(meter, 0.05, 0.05, 0.015, 0x2b2b30, 0, 0.07, -0.08, 10);
    // parts tray (a grid of tiny bins)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) box(g, 0.13, 0.08, 0.13, [0x5a6b82, 0x6b7f9a][(i + j) % 2], this.tip.x + 1.55 + j * 0.15, benchY + 0.04, this.tip.z + 0.45 + i * 0.15);

    // the half-built drone on the bench
    const drone = new Group();
    drone.position.set(this.tip.x + 1.15, benchY + 0.07, this.tip.z + 0.2);
    drone.rotation.y = -0.4;
    g.add(drone);
    box(drone, 0.3, 0.08, 0.3, 0x22252e, 0, 0, 0);
    box(drone, 0.2, 0.05, 0.2, 0xfca311, 0, 0.06, 0);
    for (const rz of [Math.PI / 4, -Math.PI / 4]) box(drone, 0.85, 0.04, 0.07, 0x22252e, 0, 0, 0).rotation.y = rz;
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) cyl(drone, 0.06, 0.06, 0.07, 0x8a8e9b, sx * 0.3, 0.05, sz * 0.3, 8);
    for (let i = 0; i < 3; i++) box(drone, 0.4, 0.012, 0.05, 0xcfd3dc, -0.25 + i * 0.12, -0.03, 0.55 + i * 0.1).rotation.y = i * 0.7; // props lying nearby

    // desk lamp with a warm light
    const lamp = new Group();
    lamp.position.set(this.tip.x + 2.5, benchY, this.tip.z + 0.65); // left end of the bench (screen-left)
    lamp.scale.set(-0.7, 0.7, 0.7); // mirrored so the arm leans in toward the work; a bit smaller than first built
    g.add(lamp);
    cyl(lamp, 0.16, 0.18, 0.05, 0x2b2b30, 0, 0.025, 0, 12);
    box(lamp, 0.04, 0.85, 0.04, 0x3a3a42, 0, 0.45, 0).rotation.z = -0.35;
    box(lamp, 0.04, 0.75, 0.04, 0x3a3a42, 0.28, 1.1, 0).rotation.z = 0.7;
    const shade = new Mesh(new ConeGeometry(0.2, 0.28, 10, 1, true), new MeshStandardMaterial({ color: 0xfca311, flatShading: true, side: DoubleSide, emissive: 0xffa040, emissiveIntensity: 0.5 }));
    shade.position.set(0.55, 1.35, 0);
    shade.rotation.z = -0.5;
    lamp.add(shade);
    const bulb = new Mesh(new SphereGeometry(0.06, 8, 6), new MeshBasicMaterial({ color: 0xffe3a8 }));
    bulb.position.set(0.52, 1.28, 0);
    lamp.add(bulb);
    const lampLight = new PointLight(0xffc27a, 14, 9, 1.6);
    lampLight.position.set(0.5, 1.2, 0.1);
    lamp.add(lampLight);

    // overhead fill so the walls read, and the soldering tip light + glow
    const fill = new PointLight(0xffe0b8, 20, 16, 1.5);
    fill.position.set(0.5, 4.6, 0.5);
    g.add(fill);

    this.tipLight = new PointLight(0xff9a3c, 1.4, 2.2, 2);
    this.tipLight.position.set(this.tip.x, this.tip.y + 0.08, this.tip.z);
    g.add(this.tipLight);
    this.glow = new Mesh(new SphereGeometry(0.02, 8, 6), new MeshBasicMaterial({ color: 0xffa347 }));
    this.glow.position.copy(this.tip);
    g.add(this.glow);

    // solder smoke: soft round puffs rising from the tip
    const n = 36;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.respawn(pos, i, Math.random());
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    const dot = canvasTex(32, 32, (c) => {
      const grad = c.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(230,230,235,0.9)');
      grad.addColorStop(1, 'rgba(230,230,235,0)');
      c.fillStyle = grad;
      c.fillRect(0, 0, 32, 32);
    });
    const pts = new Points(geo, new PointsMaterial({ map: dot, size: 0.16, transparent: true, opacity: 0.45, depthWrite: false }));
    pts.frustumCulled = false;
    g.add(pts);
    this.smoke = { pos, geo, n };

    this.bake();
  }

  /** Fold the static props into one mesh. The character (and the iron on his arm) stays live. */
  private bake() {
    this.mergedCount = bakeStatic(this.group, (o: Object3D) => {
      for (let p: Object3D | null = o.parent; p; p = p.parent) if (p === this.ch.group) return true;
      return false;
    });
  }
  /** Put smoke particle i back at the tip, `age` (0..1) of the way up. */
  private respawn(pos: Float32Array, i: number, age: number) {
    pos[i * 3] = this.tip.x + (Math.random() - 0.5) * 0.05 + age * 0.08;
    pos[i * 3 + 1] = this.tip.y + 0.02 + age * 0.75;
    pos[i * 3 + 2] = this.tip.z + (Math.random() - 0.5) * 0.05;
  }

  update(t: number, dt: number) {
    const ch = this.ch;
    ch.breathe.scale.y = 1 + Math.sin(t * 1.5) * 0.01;
    ch.breathe.rotation.x = 0.28 + Math.sin(t * 1.5) * 0.008;
    ch.head.rotation.x = 0.32 + Math.sin(t * 0.9) * 0.03; // peering at the joint
    ch.head.rotation.y = Math.sin(t * 0.4) * 0.07;
    // the iron hand makes tiny dabbing motions; the other hand steadies the board
    const dab = Math.max(0, Math.sin(t * 0.9)) * Math.sin(t * 8.5);
    ch.arms[1].shoulder.rotation.x = this.armBase[1] + 0.012 * Math.sin(t * 2.2) + 0.02 * dab;
    ch.arms[0].shoulder.rotation.x = this.armBase[0] + 0.01 * Math.sin(t * 1.7 + 1);

    // glowing tip + flickering light
    const flick = 0.75 + 0.35 * Math.sin(t * 23) * Math.sin(t * 7.3) + 0.2 * dab;
    this.tipLight.intensity = 1.2 * flick;
    this.glow.scale.setScalar(0.9 + 0.35 * flick);

    // smoke
    const { pos, geo, n } = this.smoke;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      pos[k + 1] += (0.18 + (i % 5) * 0.03) * dt;
      pos[k] += Math.sin(t * 0.8 + i) * 0.03 * dt;
      if (pos[k + 1] > this.tip.y + 0.8) this.respawn(pos, i, 0);
    }
    geo.attributes.position.needsUpdate = true;
  }
}
