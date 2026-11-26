import gsap from 'gsap';
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  HemisphereLight,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  BoxGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  SphereGeometry,
  CircleGeometry,
  Color,
  Vector3,
  Quaternion,
  Euler,
  MathUtils,
  DoubleSide,
  Fog,
} from 'three';
import type { SceneKind } from './scenes';
import { Workshop } from './workshop';
import { ChargingStation } from './station';
import type { Diorama } from './diorama';
import { createWorld } from './worlds';
import type { World, WorldId } from './worlds';

/**
 * Foreground 3D layer: transparent canvas, locked 3/4 camera.
 * Owns the camp character, the stool and the drone, and the camp<->flight handoff.
 * Later scene kinds (station / workshop / fpv) get their own rigs next to these.
 */

const flat = (color: number, emissive = 0x000000, ei = 0) =>
  new MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0.05, emissive, emissiveIntensity: ei });

function box(w: number, h: number, d: number, mat: MeshStandardMaterial | MeshBasicMaterial, x = 0, y = 0, z = 0) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// ---------------------------------------------------------------- character
function buildStool() {
  const g = new Group();
  const seat = new Mesh(new CylinderGeometry(0.3, 0.3, 0.05, 6), flat(0x4f8f68));
  seat.position.y = 0.52;
  g.add(seat);
  const legMat = flat(0x8a93a3);
  const legs: [number, number][] = [[0.2, 0.2], [-0.2, 0.2], [0.2, -0.2], [-0.2, -0.2]];
  for (const [lx, lz] of legs) {
    const leg = box(0.05, 0.54, 0.05, legMat, lx * 1.1, 0.26, lz * 1.1);
    // top leans toward the center, feet splay outward
    leg.rotation.z = lx * 0.35;
    leg.rotation.x = -lz * 0.35;
    g.add(leg);
  }
  return g;
}

interface Character {
  group: Group;
  breathe: Group;
  head: Group;
  /** Left then right arm: shoulder pivot + forearm pivot (so a scene can re-pose them). */
  arms: { shoulder: Group; fore: Group }[];
  radio: Group; // the FPV controller (hidden in the workshop)
  shadow: Mesh; // contact shadow
}

function buildCharacter(): Character {
  const group = new Group();
  group.add(buildStool());

  // Light palette on purpose: scene backgrounds are all dark, so the character must contrast with every one of them.
  const hoodie = flat(0xd6d1c4);
  const hoodieDark = flat(0x9a9588);
  const trim = flat(0xfca311, 0xfca311, 0.25);
  const pants = flat(0x5d6b8c);
  const shoe = flat(0x1a1b22);
  const skin = flat(0xd9a583);
  const hair = flat(0x5a3b2c);
  const gear = flat(0x0d0e13);

  // ---- legs: slim, seated (thighs forward, shins down)
  for (const sx of [-0.1, 0.1]) {
    group.add(box(0.12, 0.12, 0.44, pants, sx, 0.6, 0.2));
    group.add(box(0.1, 0.44, 0.1, pants, sx, 0.34, 0.41));
    group.add(box(0.11, 0.08, 0.25, shoe, sx, 0.04, 0.47));
    group.add(box(0.115, 0.03, 0.26, trim, sx, 0.085, 0.47)); // sole accent
  }

  // ---- upper body breathes as one unit (origin at hip)
  const breathe = new Group();
  breathe.position.set(0, 0.62, 0);
  breathe.rotation.x = 0.14; // lean forward, focused
  group.add(breathe);

  // torso: elliptical, tapered to the waist
  const torso = new Mesh(new CylinderGeometry(0.21, 0.16, 0.5, 8), hoodie);
  torso.scale.z = 0.62;
  torso.position.y = 0.26;
  breathe.add(torso);
  const shoulders = box(0.4, 0.1, 0.2, hoodie, 0, 0.5, 0);
  breathe.add(shoulders);
  const hem = new Mesh(new CylinderGeometry(0.165, 0.165, 0.04, 8), trim);
  hem.scale.z = 0.62;
  hem.position.y = 0.02;
  breathe.add(hem);
  const collar = new Mesh(new CylinderGeometry(0.13, 0.17, 0.09, 8), hoodieDark);
  collar.position.y = 0.56;
  breathe.add(collar);
  breathe.add(box(0.06, 0.1, 0.06, skin, 0, 0.62, 0)); // neck

  // ---- arms bent up to hold the radio
  const arms: { shoulder: Group; fore: Group }[] = [];
  for (const sx of [-1, 1]) {
    const shoulder = new Group();
    shoulder.position.set(sx * 0.2, 0.5, 0);
    shoulder.rotation.x = -0.5;
    shoulder.add(box(0.085, 0.28, 0.085, hoodie, 0, -0.14, 0));
    const fore = new Group();
    fore.position.set(0, -0.28, 0);
    fore.rotation.x = -1.2;
    fore.add(box(0.075, 0.27, 0.075, hoodie, 0, -0.135, 0));
    fore.add(box(0.08, 0.06, 0.08, trim, 0, -0.26, 0)); // cuff
    fore.add(box(0.075, 0.08, 0.08, skin, 0, -0.31, 0)); // hand
    shoulder.add(fore);
    breathe.add(shoulder);
    arms.push({ shoulder, fore });
  }

  // FPV radio controller held at chest height (hands land at ~y .29, z .40 in this frame)
  const radio = new Group();
  radio.position.set(0, 0.3, 0.4);
  radio.add(box(0.34, 0.05, 0.12, gear));
  radio.add(box(0.09, 0.05, 0.09, gear, -0.1, 0.04, -0.02));
  radio.add(box(0.09, 0.05, 0.09, gear, 0.1, 0.04, -0.02));
  radio.add(box(0.014, 0.08, 0.014, trim, -0.1, 0.08, -0.02)); // gimbal sticks
  radio.add(box(0.014, 0.08, 0.014, trim, 0.1, 0.08, -0.02));
  const radioAnt = box(0.012, 0.22, 0.012, gear, 0.12, 0.14, -0.06);
  radioAnt.rotation.z = -0.25;
  radio.add(radioAnt);
  breathe.add(radio);

  // ---- head: skin, hair, FPV goggles
  const head = new Group();
  head.position.set(0, 0.8, 0.02);
  breathe.add(head);
  head.add(new Mesh(new IcosahedronGeometry(0.165, 1), skin));
  const hairCap = new Mesh(new SphereGeometry(0.178, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  hairCap.position.set(0, 0.01, -0.015);
  hairCap.rotation.x = -0.15;
  head.add(hairCap);
  head.add(box(0.035, 0.07, 0.05, skin, -0.165, -0.01, 0)); // ears
  head.add(box(0.035, 0.07, 0.05, skin, 0.165, -0.01, 0));

  // goggles: strap around the head + front shell + glowing lenses + antennas
  const strap = new Mesh(new CylinderGeometry(0.178, 0.178, 0.055, 10, 1, true), gear);
  strap.position.y = 0.025;
  (strap.material as MeshStandardMaterial).side = DoubleSide;
  head.add(strap);
  head.add(box(0.31, 0.115, 0.1, gear, 0, 0.025, 0.155)); // shell
  head.add(box(0.31, 0.012, 0.102, trim, 0, 0.088, 0.155)); // top accent edge
  head.add(box(0.27, 0.07, 0.012, flat(0x2a3140), 0, 0.025, 0.208)); // dark, non-glowing visor
  for (const sx of [-1, 1]) {
    const ant = new Mesh(new CylinderGeometry(0.006, 0.006, 0.22, 4), gear);
    ant.position.set(sx * 0.135, 0.16, 0.12);
    ant.rotation.z = -sx * 0.25;
    ant.rotation.x = -0.25;
    head.add(ant);
    head.add(box(0.016, 0.016, 0.016, trim, sx * 0.135 + sx * 0.03, 0.27, 0.095)); // antenna tips
  }

  // contact shadow
  const shadow = new Mesh(new CircleGeometry(0.75, 20), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.01, 0.2);
  group.add(shadow);

  return { group, breathe, head, arms, radio, shadow };
}

// -------------------------------------------------------------------- drone
const BASE_FOV = 32;
/** FPV cameras are wide-angle. */
const FPV_FOV = 78;

/** Overall drone size (was 1.15, which read as too big next to the character). */
const DRONE_SCALE = 0.62;

interface Drone {
  group: Group;
  props: Mesh[];
  leds: MeshBasicMaterial[];
}

function buildDrone(): Drone {
  const group = new Group();
  // Light body + orange shell: the scene backgrounds are all dark, so a dark drone disappears.
  const body = flat(0xe8ebf2);
  const shell = flat(0xfca311, 0xfca311, 0.2);
  group.add(box(0.5, 0.12, 0.5, body));
  group.add(box(0.3, 0.08, 0.3, shell, 0, 0.09, 0));
  group.add(new Mesh(new SphereGeometry(0.07, 6, 4), flat(0x0a0a0d)).translateZ(0.28).translateY(-0.02)); // camera

  const leds = [new MeshBasicMaterial({ color: 0xfca311 }), new MeshBasicMaterial({ color: 0xfca311 })];
  const ledF = new Mesh(new BoxGeometry(0.12, 0.03, 0.03), leds[0]);
  ledF.position.set(0, 0.0, 0.26);
  const ledB = new Mesh(new BoxGeometry(0.12, 0.03, 0.03), leds[1]);
  ledB.position.set(0, 0.0, -0.26);
  group.add(ledF, ledB);

  const props: Mesh[] = [];
  const motor = flat(0x14151a);
  const blade = flat(0xc9ced8);
  const ghost = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: DoubleSide });
  const reach = 0.46;
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const ax = sx * reach;
    const az = sz * reach;
    const arm = box(0.62, 0.045, 0.06, body, ax / 2, 0, az / 2);
    arm.rotation.y = Math.atan2(-az, ax);
    arm.scale.x = Math.hypot(ax, az) / 0.62 * 1.0;
    arm.position.set(ax / 2, 0, az / 2);
    group.add(arm);
    group.add(new Mesh(new CylinderGeometry(0.06, 0.06, 0.08, 6), motor).translateX(ax).translateZ(az).translateY(0.04));
    const prop = box(0.34, 0.014, 0.06, blade, 0, 0, 0);
    prop.position.set(ax, 0.1, az);
    group.add(prop);
    props.push(prop);
    const disc = new Mesh(new CircleGeometry(0.19, 14), ghost);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(ax, 0.1, az);
    group.add(disc);
  }
  group.scale.setScalar(DRONE_SCALE);
  return { group, props, leds };
}

// ------------------------------------------------------------------- stage
export class Stage3D {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(BASE_FOV, 1, 0.1, 600);
  private key: DirectionalLight;
  private character = buildCharacter();
  private drone = buildDrone();
  private t = 0;
  private orbit = 0;
  private warp = 0;
  private portrait = false;
  /** 1 = camp composition (character visible, drone orbits), 0 = flight (drone hovers). */
  campBlend = 1;
  /** Direction of the current camp transition: -1 leaving the camp scene, +1 arriving at it. */
  campDir = 1;
  private warpPhase: 0 | 1 = 0;
  private camDir = new Vector3(0, 0, -1);
  private targetAccent = new Color('#fca311');
  private accent = new Color('#fca311');

  // ---- camera rigs. 'main' = locked 3/4 camera (hero); 'fpv' = first-person drone camera over a world;
  // 'diorama' = a small handcrafted set (soldering workshop, charging station) seen from its own fixed camera.
  private rig: 'main' | 'fpv' | 'diorama' = 'main';
  private dioramas = new Map<string, Diorama>(); // built lazily on first visit
  private diorama: Diorama | null = null; // the active one
  private worlds = new Map<WorldId, World>(); // built lazily on first visit
  private world: World | null = null; // the active flight world
  private fpvS = 0; // distance flown
  private fogColor = new Color('#2a1840');
  private look = { x: 0, y: 0 }; // smoothed pointer position (-1..1) driving the FPV head movement

  // anchors (world space), recomputed on resize
  private campBase = new Vector3();
  private hoverAnchor = new Vector3();
  private charScale = 1;

  // ---- pointer-follow: orbit by default, chase the cursor while it is active, relax back when idle
  private pointer = { x: 0, y: 0, lastMove: -99, hold: -99 };
  private follow = 0; // 0 = rest behavior (orbit / hover), 1 = fully chasing the pointer
  private dronePos = new Vector3();
  private droneVel = new Vector3();
  private droneInit = false;
  private static readonly ACTIVE_FOR = 1.8; // seconds of mouse movement that count as "active"
  private static readonly CLICK_HOLD = 3.5; // seconds the drone stays at a clicked point

  constructor(canvas: HTMLCanvasElement, private reduceMotion: boolean) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);

    this.camera.position.set(3.4, 2.1, 8.6);
    this.camera.lookAt(0, 1.0, 0);

    this.scene.add(new HemisphereLight(0xbfd4ff, 0x2a2c40, 1.5));
    this.key = new DirectionalLight(0xfca311, 1.5);
    this.key.position.set(3, 5, 4);
    this.scene.add(this.key);
    const rim = new DirectionalLight(0x8fb2ff, 2.4);
    rim.position.set(-4, 3, -4);
    this.scene.add(rim);

    // Camera sits right-of-center, so "facing screen-right in 3/4 view" needs a big yaw (~100deg past the camera axis).
    this.character.group.rotation.y = 1.75;
    this.scene.add(this.character.group, this.drone.group);

    // Reduced motion freezes the orbit, so park the drone on the character's left (away from the intro text).
    if (reduceMotion) this.orbit = Math.PI * 0.85;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __stage?: Stage3D }).__stage = this;

    if (!reduceMotion) {
      const setPoint = (e: PointerEvent) => {
        this.pointer.x = Math.max(-0.95, Math.min(0.95, (e.clientX / window.innerWidth) * 2 - 1));
        this.pointer.y = Math.max(-0.95, Math.min(0.95, -((e.clientY / window.innerHeight) * 2 - 1)));
      };
      window.addEventListener('pointermove', (e) => {
        setPoint(e);
        this.pointer.lastMove = this.t;
      }, { passive: true });
      window.addEventListener('pointerdown', (e) => {
        // Clicks on real controls (arrows, sidebar, links) shouldn't also send the drone there.
        if (e.target instanceof Element && e.target.closest('button, a')) return;
        setPoint(e);
        this.pointer.lastMove = this.t;
        this.pointer.hold = this.t + Stage3D.CLICK_HOLD;
      }, { passive: true });
      document.addEventListener('mouseleave', () => {
        this.pointer.lastMove = -99;
        this.pointer.hold = -99;
      });
    }
  }

  /** Renderer stats of the last frame; reachable as window.__stage.stats when the page is opened with ?debug. */
  get stats() {
    const r = this.renderer.info.render;
    return { rig: this.rig, drawCalls: r.calls, triangles: r.triangles, dioramaMerged: this.diorama?.mergedCount ?? 0 };
  }

  /** Project a normalized-device point onto the world plane z = 0. */
  private ndcToWorld(nx: number, ny: number): Vector3 {
    const near = new Vector3(nx, ny, -1).unproject(this.camera);
    const far = new Vector3(nx, ny, 1).unproject(this.camera);
    const dir = far.sub(near).normalize();
    const k = -near.z / dir.z;
    return near.add(dir.multiplyScalar(k));
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.portrait = w / h < 0.9;
    this.camera.updateProjectionMatrix();
    // Anchors are projected through the locked 3/4 camera, so only recompute them while that rig is active
    // (setRig('main') recomputes them when we come back).
    if (this.rig === 'main') this.layout();
  }

  private layout() {
    this.camera.updateMatrixWorld(true);
    if (this.portrait) {
      this.campBase.copy(this.ndcToWorld(0.02, 0.1));
      this.hoverAnchor.copy(this.ndcToWorld(-0.55, 0.6));
      this.charScale = 0.75;
    } else {
      // Rule of thirds: character in the left third, feet low-ish.
      // Lower-left power point of the rule of thirds (NDC thirds sit at +-0.33): body centered near it, feet below.
      this.campBase.copy(this.ndcToWorld(-0.36, -0.62));
      this.hoverAnchor.copy(this.ndcToWorld(-0.62, -0.62));
      this.charScale = 1.4;
    }
    this.character.group.scale.setScalar(this.charScale);
  }

  setAccent(css: string) {
    this.targetAccent.set(css);
  }

  /** Scene background color: the FPV valley fades into it with fog so the horizon blends seamlessly. */
  setBg(css: string) {
    this.fogColor.set(css);
    if (this.scene.fog) this.scene.fog.color.copy(this.fogColor);
  }

  private getWorld(id: WorldId): World {
    let w = this.worlds.get(id);
    if (!w) {
      w = createWorld(id); // first visit: build it now (keeps startup light)
      this.worlds.set(id, w);
      this.scene.add(w.group);
    }
    return w;
  }

  /**
   * Switch camera rig / flight world. Called while the warp is at peak intensity so the cut is hidden.
   * kind 'fpv' = first-person drone camera over `worldId`; anything else = the locked 3/4 camera.
   */
  setRig(kind: SceneKind, worldId: WorldId = 'valley') {
    const next: 'main' | 'fpv' | 'diorama' = kind === 'fpv' ? 'fpv' : kind === 'workshop' || kind === 'station' ? 'diorama' : 'main';

    if (next === 'diorama') {
      // may switch between two dioramas without a rig change, so this happens before the early return below
      const d = this.getDiorama(kind);
      if (this.diorama && this.diorama !== d) this.diorama.group.visible = false;
      this.diorama = d;
      d.group.visible = true;
    }
    if (next === 'fpv') {
      const w = this.getWorld(worldId);
      if (this.world && this.world !== w) this.world.group.visible = false;
      this.world = w;
      w.group.visible = true;
      this.fpvAccentSync();
      if (this.scene.fog) {
        this.scene.fog.color.copy(this.fogColor);
        (this.scene.fog as Fog).near = w.fogNear;
        (this.scene.fog as Fog).far = w.fogFar;
      }
    }
    if (next === this.rig) return;

    const prev = this.rig;
    this.rig = next;
    this.drone.group.visible = next === 'main';
    if (prev === 'fpv' && this.world) this.world.group.visible = false;
    if (prev === 'diorama' && this.diorama) this.diorama.group.visible = false;

    if (next === 'fpv') {
      const w = this.world!;
      this.scene.fog = new Fog(this.fogColor.clone(), w.fogNear, w.fogFar);
      this.camera.rotation.order = 'YXZ';
    } else if (next === 'diorama') {
      this.scene.fog = null;
      this.camera.rotation.order = 'XYZ';
    } else {
      this.scene.fog = null;
      this.camera.rotation.order = 'XYZ';
      this.camera.position.set(3.4, 2.1, 8.6);
      this.camera.lookAt(0, 1.0, 0);
      this.camera.fov = BASE_FOV;
      this.camera.updateProjectionMatrix();
      this.layout();
    }
  }

  private fpvAccentSync() {
    this.world?.setAccent(this.accent);
  }

  private getDiorama(kind: SceneKind): Diorama {
    const key = kind === 'station' ? 'station' : 'workshop';
    let d = this.dioramas.get(key);
    if (!d) {
      d = key === 'station' ? new ChargingStation() : new Workshop(buildCharacter()); // first visit: build it now
      this.dioramas.set(key, d);
      this.scene.add(d.group);
    }
    return d;
  }

  /**
   * Diorama camera: a fixed framing defined by the diorama itself, drifting a little with the mouse.
   * (Dioramas are seen from behind looking +z, where world +x is screen-LEFT; each one aims its camera so the
   * subject lands left of the content cards. Parallax gains use the matching sign.)
   */
  private updateDiorama(dt: number) {
    const d = this.diorama;
    if (!d) return;
    const tx = this.reduceMotion ? 0 : this.pointer.x;
    const ty = this.reduceMotion ? 0 : this.pointer.y;
    const k = 1 - Math.exp(-dt * 3.5);
    this.look.x += (tx - this.look.x) * k;
    this.look.y += (ty - this.look.y) * k;

    d.update(this.t, dt);
    const c = this.portrait && d.camPortrait ? d.camPortrait : d.cam;
    this.camera.position.set(c.pos[0] - this.look.x * c.posGain[0], c.pos[1] + this.look.y * c.posGain[1], c.pos[2]);
    this.camera.lookAt(c.look[0] - this.look.x * c.lookGain[0], c.look[1] + this.look.y * c.lookGain[1], c.look[2]);

    const fov = c.fov + 24 * this.warp;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** FPV camera: autopilot along the world's centerline + a little head movement toward the mouse. */
  private updateFpv(dt: number) {
    const world = this.world;
    if (!world) return;
    const w = this.warp;
    const v = world.speed * (1 + w * 7); // accelerate through the warp
    this.fpvS += v * dt;
    const ph = (2 * Math.PI * this.fpvS) / world.L;
    const camX = -world.A * Math.sin(ph);
    const slope = world.A * ((2 * Math.PI) / world.L) * Math.cos(ph); // d(centerline)/dz, + = path bends left
    const heading = Math.atan(slope);

    // pointer -> head. Smoothed so it feels like a gimbal, not a cursor.
    const tx = this.reduceMotion ? 0 : this.pointer.x;
    const ty = this.reduceMotion ? 0 : this.pointer.y;
    const k = 1 - Math.exp(-dt * 3.5);
    this.look.x += (tx - this.look.x) * k;
    this.look.y += (ty - this.look.y) * k;

    const t = this.t;
    this.camera.position.set(camX + this.look.x * 0.8, world.camY + this.look.y * 0.35 + Math.sin(t * 1.7) * 0.1, 0);
    this.camera.rotation.set(
      this.look.y * 0.14 + Math.sin(t * 1.1) * 0.008, // pitch: mouse up = look up
      heading * 0.9 - this.look.x * 0.24, // yaw: follow the valley + look toward the mouse
      heading * 0.6 - this.look.x * 0.08 + Math.sin(t * 0.8) * 0.012, // roll: bank gently into the turn
    );

    const fov = FPV_FOV + 24 * w;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    world.setAccent(this.accent);
    world.update(this.fpvS, camX, this.t, dt, v);
  }

  /**
   * Warp 0..1 from the transition timeline. `phase` 0 = old scene flying out past the camera,
   * 1 = new scene arriving from the vanishing point.
   */
  setWarp(w: number, phase: 0 | 1 = 0) {
    this.warp = w;
    this.warpPhase = phase;
  }

  // ---- warp flight helpers. Both translate PARALLEL to the view axis, so perspective pushes every object
  // radially outward from the vanishing point: things on the left drift left, things on the right drift right.
  private depthOf(p: Vector3) {
    return p.clone().sub(this.camera.position).dot(this.camDir);
  }
  /** `p` after flying fraction u (0..1) toward and past the camera (u=1: safely behind it). */
  private passBy(p: Vector3, u: number) {
    return p.clone().addScaledVector(this.camDir, -u * (this.depthOf(p) + 3));
  }
  /** `p` pushed u (0..1) of the way back to the horizon, shrinking toward the vanishing point. */
  private fromFar(p: Vector3, u: number) {
    return p.clone().addScaledVector(this.camDir, u * 120);
  }

  setKind(kind: SceneKind, duration: number, instant = false) {
    const target = kind === 'camp' ? 1 : 0;
    this.campDir = target === 1 ? 1 : -1;
    if (instant || duration <= 0.02) {
      gsap.killTweensOf(this, 'campBlend');
      this.campBlend = target;
      return;
    }
    gsap.to(this, { campBlend: target, duration, ease: 'power2.inOut', overwrite: 'auto' });
  }

  update(dt: number) {
    this.t += dt;
    const k = this.campBlend;

    // accent follows the scene tint (key light + LEDs)
    this.accent.lerp(this.targetAccent, 1 - Math.pow(0.001, dt));
    this.key.color.copy(this.accent);
    for (const l of this.drone.leds) l.color.copy(this.accent);

    if (this.rig === 'fpv') {
      this.character.group.visible = false;
      this.updateFpv(dt);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.rig === 'diorama') {
      this.character.group.visible = false;
      this.updateDiorama(dt);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.camera.getWorldDirection(this.camDir);

    // ---- character: flies out toward the viewer when leaving camp (first half of the transition), and
    // arrives from the vanishing point when returning (second half). Hidden while the swap happens at k = 0.5.
    const ch = this.character;
    ch.group.visible = k > 0.5;
    let charPos = this.campBase;
    if (k < 0.999) {
      if (this.campDir < 0) {
        const x = MathUtils.clamp((1 - k) * 2, 0, 1);
        charPos = this.passBy(this.campBase, x * x);
      } else {
        const s = MathUtils.clamp(k * 2 - 1, 0, 1);
        charPos = this.fromFar(this.campBase, (1 - s) * (1 - s));
      }
    }
    ch.group.position.copy(charPos);
    const br = Math.sin(this.t * 1.6) * 0.012;
    ch.breathe.scale.y = 1 + br;
    ch.breathe.rotation.x = 0.12 + Math.sin(this.t * 1.6) * 0.01;
    ch.head.rotation.y = Math.sin(this.t * 0.5) * 0.12;
    ch.head.rotation.x = Math.sin(this.t * 0.7 + 1) * 0.04;

    // ---- drone
    if (!this.reduceMotion) this.orbit += dt * 0.75;
    const a = this.orbit;
    const center = new Vector3(this.campBase.x, this.campBase.y + 0.85 * this.charScale, this.campBase.z);
    // Orbit radius is deliberately NOT scaled with the character: it must stay inside the left half.
    const rx = this.portrait ? 1.5 : 1.9;
    const rz = this.portrait ? 1.2 : 1.5;

    const orbitPos = new Vector3(
      center.x + Math.cos(a) * rx,
      center.y + 0.35 + Math.sin(a * 2) * 0.18,
      center.z + Math.sin(a) * rz,
    );
    const vx = -Math.sin(a) * rx;
    const vz = Math.cos(a) * rz;
    const orbitQ = new Quaternion().setFromEuler(new Euler(0.14, Math.atan2(vx, vz), -0.22, 'YXZ'));

    const hoverPos = new Vector3(
      this.hoverAnchor.x,
      this.hoverAnchor.y + Math.sin(this.t * 1.3) * 0.08,
      this.hoverAnchor.z,
    );
    const hoverQ = new Quaternion().setFromEuler(
      new Euler(0.1 + Math.sin(this.t * 0.9) * 0.02, 0.7 + Math.sin(this.t * 0.4) * 0.12, Math.sin(this.t * 1.1) * 0.03, 'YXZ'),
    );

    const restPos = new Vector3().lerpVectors(hoverPos, orbitPos, k);
    const restQ = hoverQ.clone().slerp(orbitQ, k);

    // ---- pointer follow: blend factor eases in fast, relaxes back slower
    const active = this.t - this.pointer.lastMove < Stage3D.ACTIVE_FOR || this.t < this.pointer.hold;
    this.follow += ((active ? 1 : 0) - this.follow) * (1 - Math.exp(-dt * (active ? 4 : 1.8)));
    const f = this.follow * this.follow * (3 - 2 * this.follow); // smoothstep
    const target = this.ndcToWorld(this.pointer.x, this.pointer.y);
    target.z += 0.6; // a bit in front of the character plane
    target.y += Math.sin(this.t * 2.1) * 0.06;
    const desired = restPos.clone().lerp(target, f);

    if (!this.droneInit) {
      this.dronePos.copy(desired);
      this.droneInit = true;
    }
    const before = this.dronePos.clone();
    this.dronePos.lerp(desired, 1 - Math.exp(-dt * 5.5)); // chase with a little lag so it feels flown, not snapped
    if (dt > 1e-4) {
      const v = this.dronePos.clone().sub(before).divideScalar(dt);
      this.droneVel.lerp(v, 1 - Math.exp(-dt * 8));
    }
    const speed = this.droneVel.length();
    const followQ = new Quaternion().setFromEuler(
      new Euler(
        0.1 + MathUtils.clamp(speed * 0.05, 0, 0.35), // nose down while moving
        0.7 + MathUtils.clamp(-this.droneVel.x * 0.03, -0.5, 0.5),
        MathUtils.clamp(-this.droneVel.x * 0.09, -0.5, 0.5), // bank into the turn
        'YXZ',
      ),
    );

    const d = this.drone.group;
    d.position.copy(this.dronePos);
    d.quaternion.copy(restQ).slerp(followQ, f);

    // ---- warp: unlike the character / tree / text (which rush toward the viewer), the drone flies INTO the
    // warp: it dives to the vanishing point, then emerges back out of the tunnel into the new scene.
    // `w` carries the slow -> fast -> slow ease from the timeline.
    const w = this.warp;
    d.scale.setScalar(DRONE_SCALE); // perspective does the scaling
    if (w > 0.001) {
      const e = w * w * (3 - 2 * w);
      d.position.copy(this.fromFar(d.position, e)); // same path both ways: in on exit, out on arrival
      const flown = d.quaternion.clone();
      // exit: nose into the tunnel (away from the viewer); arrival: nose toward the viewer as it flies back out
      const heading = this.warpPhase === 0 ? 1 : -1;
      d.lookAt(d.position.clone().addScaledVector(this.camDir, 10 * heading));
      d.quaternion.copy(flown).slerp(d.quaternion, Math.min(1, w * 2));
    }

    // FOV kick: widen with warp intensity for the feeling of acceleration
    const fov = BASE_FOV + 24 * w;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    const spin = 38 * dt;
    this.drone.props.forEach((p, i) => (p.rotation.y += i % 2 ? -spin : spin));

    this.renderer.render(this.scene, this.camera);
  }
}
