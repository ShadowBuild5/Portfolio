import {
  Group,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  TubeGeometry,
  CatmullRomCurve3,
  MeshBasicMaterial,
  PointLight,
  Points,
  PointsMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  CanvasTexture,
  Vector3,
} from 'three';
import type { Object3D } from 'three';
import { box, cyl, mat, canvasTex, bakeStatic, glowBlend } from './diorama';
import type { Diorama, DioramaCam } from './diorama';

/**
 * The battery charging station: nothing but LiPo packs on charge. Two 4S and two 6S packs sit on a fireproof
 * mat on a table, each wired to a quad-channel charger by an XT60 power lead and a balance lead (5-pin for 4S,
 * 7-pin for 6S). The charger's screen shows live cell count / voltage / charge per channel; amber glow = charging,
 * green = full. No character, no drone. Local coordinates: the camera sits at negative z looking +z, so world +x
 * is screen-left.
 */

interface PackDef {
  cells: 4 | 6;
  color: number;
  css: string;
  mah: number;
  base: number; // starting charge %
  rate: number; // how fast it charges
  full?: boolean;
}

const PACKS: PackDef[] = [
  { cells: 4, color: 0x2b6fd6, css: '#2b6fd6', mah: 1500, base: 58, rate: 1.4 },
  { cells: 6, color: 0xd23b5a, css: '#d23b5a', mah: 1300, base: 34, rate: 1.1 },
  { cells: 4, color: 0xe6862b, css: '#e6862b', mah: 1800, base: 100, rate: 0, full: true },
  { cells: 6, color: 0x2fb36e, css: '#2fb36e', mah: 1100, base: 12, rate: 1.7 },
];

const BALANCE_COLORS = [0x15161b, 0xd23b3b, 0xf2f2f2, 0xe0b030, 0x2fb36e, 0x3b6bd2, 0x7b4fe0];
const AMBER = 0xffb14a;
const GREEN = 0x59ffa0;

const TY = 0.88; // table top height
const level = (p: PackDef, t: number) => (p.full ? 100 : Math.min(99.9, p.base + ((t * p.rate) % (100 - p.base))));

export class ChargingStation implements Diorama {
  readonly group = new Group();
  mergedCount = 0;

  /** Camera behind the table, high and slightly to one side; aims toward -x so the table lands left of the cards. */
  readonly cam: DioramaCam = { pos: [0.9, 2.55, -2.8], look: [-0.9, 0.85, 1.3], fov: 50, posGain: [0.4, 0.2], lookGain: [0.3, 0.12] };
  /** Phone framing (untested): table in the upper part, cards below. */
  readonly camPortrait: DioramaCam = { pos: [0.9, 2.7, -3.8], look: [0.3, 0.4, 1.2], fov: 66, posGain: [0.3, 0.2], lookGain: [0.2, 0.1] };

  private glows: { m: MeshBasicMaterial; pack: PackDef; phase: number }[] = [];
  private leds: { m: MeshBasicMaterial; pack: PackDef; phase: number }[] = [];
  private screen: { g: CanvasRenderingContext2D; tex: CanvasTexture; w: number; h: number };
  private lastDraw = -1;
  private ambLight: PointLight;
  private motes: { pos: Float32Array; geo: BufferGeometry; n: number; src: number[] };

  constructor() {
    const g = this.group;

    // ------------------------------------------------------------ room
    box(g, 16, 0.2, 12, 0x1b2229, 0, -0.1, 1); // floor
    box(g, 16, 6.5, 0.3, 0x1d2c37, 0, 3.1, 3.7); // back wall
    box(g, 0.3, 6.5, 12, 0x18242d, -5.6, 3.1, 1);
    box(g, 0.3, 6.5, 12, 0x18242d, 5.6, 3.1, 1);
    for (let i = 0; i < 5; i++) box(g, 16, 0.05, 0.02, 0x2b4256, 0, 0.9 + i * 0.9, 3.53); // wall panel lines

    // sign + lightning bolt on the wall
    const sign = new Mesh(
      new PlaneGeometry(3.4, 0.62),
      new MeshBasicMaterial({
        map: canvasTex(512, 96, (c) => {
          c.fillStyle = '#e0b030';
          c.fillRect(0, 0, 512, 96);
          c.fillStyle = '#141414';
          c.fillRect(8, 8, 496, 80);
          c.fillStyle = '#e0b030';
          c.font = 'bold 44px "Courier New", monospace';
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText('CHARGING STATION', 256, 50);
        }),
        color: 0xe0e0e0,
      }),
    );
    sign.position.set(0.3, 3.35, 3.5);
    sign.rotation.y = Math.PI;
    g.add(sign);
    const bolt = new Mesh(
      new PlaneGeometry(1.0, 1.5),
      new MeshBasicMaterial({
        transparent: true,
        map: canvasTex(128, 192, (c) => {
          const grad = c.createRadialGradient(64, 96, 10, 64, 96, 90);
          grad.addColorStop(0, 'rgba(255,220,90,0.55)');
          grad.addColorStop(1, 'rgba(255,220,90,0)');
          c.fillStyle = grad;
          c.fillRect(0, 0, 128, 192);
          c.fillStyle = '#ffd84a';
          c.beginPath();
          c.moveTo(78, 14);
          c.lineTo(34, 104);
          c.lineTo(62, 104);
          c.lineTo(46, 178);
          c.lineTo(96, 80);
          c.lineTo(66, 80);
          c.closePath();
          c.fill();
        }),
      }),
    );
    bolt.position.set(2.7, 2.1, 3.5);
    bolt.rotation.y = Math.PI;
    g.add(bolt);
    cyl(g, 0.11, 0.11, 0.5, 0xc4252b, 3.7, 0.95, 3.4, 10); // fire extinguisher
    cyl(g, 0.04, 0.05, 0.1, 0x15161b, 3.7, 1.25, 3.4, 6);
    box(g, 0.14, 0.04, 0.04, 0x15161b, 3.7, 1.28, 3.34);

    // ------------------------------------------------------------ table
    const cx = 0.3;
    const tz = 1.2;
    box(g, 3.9, 0.1, 1.9, 0x8a6a46, cx, TY - 0.05, tz); // top
    box(g, 3.9, 0.14, 0.05, 0x6f5336, cx, TY - 0.17, tz - 0.9); // front apron
    box(g, 3.9, 0.14, 0.05, 0x6f5336, cx, TY - 0.17, tz + 0.9);
    for (const lx of [cx - 1.85, cx + 1.85]) for (const lz of [tz - 0.85, tz + 0.85]) box(g, 0.12, TY - 0.1, 0.12, 0x6f5336, lx, (TY - 0.1) / 2, lz);
    box(g, 3.6, 0.05, 1.5, 0x6f5336, cx, 0.3, tz); // lower shelf

    // fireproof charging mat with a yellow border
    const mz = 0.85;
    box(g, 3.1, 0.02, 1.15, 0x6c727b, cx, TY + 0.01, mz);
    box(g, 3.1, 0.022, 0.03, 0xe0b030, cx, TY + 0.011, mz - 0.575);
    box(g, 3.1, 0.022, 0.03, 0xe0b030, cx, TY + 0.011, mz + 0.575);
    box(g, 0.03, 0.022, 1.15, 0xe0b030, cx - 1.55, TY + 0.011, mz);
    box(g, 0.03, 0.022, 1.15, 0xe0b030, cx + 1.55, TY + 0.011, mz);

    // ------------------------------------------------------------ charger (quad channel)
    const chz = 1.78;
    const chY = TY + 0.17;
    box(g, 1.95, 0.34, 0.62, 0x15181d, cx, chY, chz);
    box(g, 1.97, 0.03, 0.64, 0xfca311, cx, TY + 0.345, chz); // orange top trim
    const faceZ = chz - 0.31; // the face the camera sees
    // screen (live canvas)
    const sw = 512;
    const sh = 133;
    const sc = document.createElement('canvas');
    sc.width = sw;
    sc.height = sh;
    const tex = new CanvasTexture(sc);
    const screen = new Mesh(new PlaneGeometry(1.0, 0.26), new MeshBasicMaterial({ map: tex }));
    screen.position.set(cx + 0.45, TY + 0.2, faceZ - 0.002);
    screen.rotation.y = Math.PI;
    g.add(screen);
    this.screen = { g: sc.getContext('2d')!, tex, w: sw, h: sh };
    // knob + the four channel sockets (XT60 + balance port)
    cyl(g, 0.06, 0.06, 0.04, 0x2b2b30, cx - 0.62, chY + 0.03, faceZ - 0.01, 12).rotation.x = Math.PI / 2;
    const sockX: number[] = [];
    for (let i = 0; i < 4; i++) {
      const sx = cx + 0.78 - i * 0.32;
      sockX.push(sx);
      box(g, 0.1, 0.06, 0.05, 0x2b2b30, sx, TY + 0.075, faceZ - 0.02);
      box(g, 0.08, 0.04, 0.012, 0xe0b030, sx, TY + 0.075, faceZ - 0.05);
      box(g, 0.075, 0.03, 0.02, 0xf2f2f2, sx, TY + 0.14, faceZ - 0.02);
    }

    // ------------------------------------------------------------ packs
    const packX = [cx + 1.1, cx + 0.38, cx - 0.36, cx - 1.1];
    this.packX = packX; // (needed by the motes below, and by respawnMote during construction)
    this.packZ = mz - 0.08;
    PACKS.forEach((p, i) => {
      const four = p.cells === 4;
      const W = four ? 0.27 : 0.31;
      const H = four ? 0.16 : 0.2;
      const L = four ? 0.54 : 0.66;
      const px = packX[i];
      const pz = mz - 0.08;
      const py = TY + 0.02 + H / 2;

      // charging glow on the mat under each pack
      const glowM = new MeshBasicMaterial({ color: p.full ? GREEN : AMBER, transparent: true, opacity: 0.3, depthWrite: false });
      const glow = new Mesh(new PlaneGeometry(W + 0.16, L + 0.16), glowM);
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(px, TY + 0.023, pz);
      g.add(glow);
      this.glows.push({ m: glowM, pack: p, phase: i * 1.3 });

      // body (black shrink-wrap) + colored end band
      box(g, W, H, L, 0x17191f, px, py, pz);
      box(g, W + 0.006, H * 0.5, L * 0.12, p.color, px, py, pz - L / 2 + 0.05);

      // top label, upright when seen from the camera
      const label = new Mesh(
        new PlaneGeometry(W * 0.9, L * 0.62),
        new MeshBasicMaterial({
          color: 0xdddddd,
          map: canvasTex(192, 256, (c) => {
            c.fillStyle = p.css;
            c.fillRect(0, 0, 192, 256);
            c.fillStyle = '#ffffff';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.font = 'bold 76px "Courier New", monospace';
            c.fillText(`${p.cells}S`, 96, 70);
            c.font = 'bold 26px "Courier New", monospace';
            c.fillText(`${(p.cells * 3.7).toFixed(1)}V`, 96, 134);
            c.font = '22px "Courier New", monospace';
            c.fillText(`${p.mah}mAh`, 96, 172);
            c.fillText('LiPo 100C', 96, 204);
          }),
        }),
      );
      label.rotation.set(-Math.PI / 2, 0, Math.PI);
      label.position.set(px, py + H / 2 + 0.002, pz + 0.01);
      g.add(label);

      // XT60 connector + red/black power lead to this channel's socket
      const connZ = pz + L / 2 + 0.06;
      box(g, 0.075, 0.05, 0.09, 0xe0b030, px, py - 0.02, connZ);
      const sx = sockX[i];
      const dock = new Vector3(sx, TY + 0.075, faceZ - 0.07);
      const start = new Vector3(px, py - 0.02, connZ + 0.05);
      const mid = new Vector3((px + sx) / 2, TY + 0.08, (connZ + dock.z) / 2 - 0.05);
      this.cable([start, mid, dock], 0.02, 0x15161b);
      this.cable([start.clone().add(new Vector3(0.03, 0, 0)), mid.clone().add(new Vector3(0.03, 0, 0)), dock.clone().add(new Vector3(0.03, 0, 0))], 0.015, 0xd23b3b);

      // balance lead: a connector with (cells + 1) coloured pins, and a thin white lead up to the port
      const pins = p.cells + 1;
      const bx = px - W / 2 + 0.03;
      const bz = pz + L / 2 + 0.04;
      for (let k = 0; k < pins; k++) box(g, 0.012, 0.03, 0.03, BALANCE_COLORS[k], bx - 0.04 + k * 0.014, py + H * 0.15, bz);
      const port = new Vector3(sx, TY + 0.14, faceZ - 0.035);
      this.cable([new Vector3(bx, py + H * 0.15, bz + 0.02), new Vector3(bx + (sx - bx) * 0.5, TY + 0.2, (bz + port.z) / 2), port], 0.008, 0xf2f2f2);
    });

    // channel LEDs on the charger face
    for (let i = 0; i < 4; i++) {
      const m = new MeshBasicMaterial({ color: AMBER });
      const led = new Mesh(new BoxGeometry(0.07, 0.03, 0.012), m);
      led.position.set(cx - 0.05 - i * 0.12, chY + 0.07, faceZ - 0.008);
      g.add(led);
      this.leds.push({ m, pack: PACKS[i], phase: i * 0.9 });
    }

    // ------------------------------------------------------------ lights + motes
    const overhead = new PointLight(0xb8dcff, 18, 16, 1.5);
    overhead.position.set(cx, 4.2, 0.2);
    g.add(overhead);
    this.ambLight = new PointLight(AMBER, 6, 4.5, 2);
    this.ambLight.position.set(cx, TY + 0.5, mz);
    g.add(this.ambLight);
    const screenLight = new PointLight(GREEN, 2.5, 3, 2);
    screenLight.position.set(cx + 0.45, TY + 0.4, 1.2);
    g.add(screenLight);

    // faint energy motes rising off the packs
    const n = 44;
    const pos = new Float32Array(n * 3);
    const src: number[] = [];
    for (let i = 0; i < n; i++) {
      src.push(Math.floor(Math.random() * 4));
      this.respawnMote(pos, i, src[i], Math.random());
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    const dot = canvasTex(32, 32, (c) => {
      const grad = c.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255,225,150,1)');
      grad.addColorStop(1, 'rgba(255,200,90,0)');
      c.fillStyle = grad;
      c.fillRect(0, 0, 32, 32);
    });
    const pts = new Points(geo, glowBlend(new PointsMaterial({ map: dot, size: 0.07 })));
    pts.frustumCulled = false;
    g.add(pts);
    this.motes = { pos, geo, n, src };

    this.mergedCount = bakeStatic(g, (o: Object3D) => !!o.userData.live);
  }

  private packX: number[] = [];
  private packZ = 0;

  /** A cable along a smooth curve. Flagged `merge` so it is baked with the rest of the static set. */
  private cable(pts: Vector3[], radius: number, color: number) {
    const m = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 16, radius, 6), mat(color));
    m.userData.merge = true;
    this.group.add(m);
  }

  private respawnMote(pos: Float32Array, i: number, pack: number, age: number) {
    const x = (this.packX[pack] ?? 0) + (Math.random() - 0.5) * 0.25;
    pos[i * 3] = x;
    pos[i * 3 + 1] = TY + 0.25 + age * 0.9;
    pos[i * 3 + 2] = this.packZ + (Math.random() - 0.5) * 0.4;
  }

  private drawScreen(t: number) {
    const { g, tex, w, h } = this.screen;
    g.fillStyle = '#06131a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1d4a58';
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
    g.font = '13px "Courier New", monospace';
    g.fillStyle = '#5f7a88';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText('QUAD CHARGER   LIPO BALANCE', 10, 13);
    PACKS.forEach((p, i) => {
      const y = 36 + i * 24;
      const lvl = level(p, t);
      const volts = p.cells * (3.3 + 0.9 * (lvl / 100));
      g.font = 'bold 15px "Courier New", monospace';
      g.fillStyle = '#e8f1f4';
      g.fillText(`CH${i + 1} ${p.cells}S ${volts.toFixed(1)}V`, 10, y);
      // bar
      g.fillStyle = '#12303a';
      g.fillRect(190, y - 8, 230, 16);
      g.fillStyle = p.css;
      g.fillRect(190, y - 8, (230 * lvl) / 100, 16);
      g.fillStyle = '#e8f1f4';
      g.textAlign = 'right';
      g.fillText(`${Math.floor(lvl)}%`, 466, y);
      g.fillStyle = p.full ? '#59ffa0' : '#ffb14a';
      g.font = 'bold 11px "Courier New", monospace';
      g.fillText(p.full ? 'FULL' : 'CHG', 504, y);
      g.textAlign = 'left';
    });
    tex.needsUpdate = true;
  }

  update(t: number, dt: number) {
    // glows under the packs and channel LEDs: amber pulse = charging, steady green = full
    for (const gl of this.glows) {
      gl.m.opacity = gl.pack.full ? 0.28 : 0.2 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2.4 + gl.phase));
    }
    for (const l of this.leds) {
      if (l.pack.full) l.m.color.setHex(GREEN);
      else l.m.color.setHex(AMBER).multiplyScalar(0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 3 + l.phase)));
    }
    this.ambLight.intensity = 5 + 1.6 * Math.sin(t * 2.2);

    // the screen only needs ~2 updates a second
    if (t - this.lastDraw > 0.5) {
      this.drawScreen(t);
      this.lastDraw = t;
    }

    const { pos, geo, n, src } = this.motes;
    for (let i = 0; i < n; i++) {
      pos[i * 3 + 1] += (0.12 + (i % 4) * 0.03) * dt;
      pos[i * 3] += Math.sin(t * 0.9 + i) * 0.02 * dt;
      if (pos[i * 3 + 1] > TY + 1.2) this.respawnMote(pos, i, src[i], 0);
    }
    geo.attributes.position.needsUpdate = true;
  }
}
