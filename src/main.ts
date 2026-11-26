import gsap from 'gsap';
import './style.css';
import { scenes } from './scenes';
import { AsciiParallax } from './ascii';
import { Stage3D } from './stage3d';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Transition length: 0.8s base x 2 (tuned by feel). Override for tuning with ?slowmo=N (e.g. ?slowmo=6 to inspect the warp).
const DEFAULT_SLOWMO = 2;
const slowmo = Math.max(0.25, Number(new URLSearchParams(location.search).get('slowmo')) || DEFAULT_SLOWMO);
const TRANSITION = reduceMotion ? 0.01 : 0.8 * slowmo; // seconds, committed + eased

const stage = document.getElementById('stage')!;
const sidebar = document.getElementById('sidebar')!;
const prevBtn = document.getElementById('prev') as HTMLButtonElement;
const nextBtn = document.getElementById('next') as HTMLButtonElement;
const bgCanvas = document.getElementById('bg') as HTMLCanvasElement;

const fgCanvas = document.getElementById('fg') as HTMLCanvasElement;

const ascii = new AsciiParallax(bgCanvas);
const stage3d = new Stage3D(fgCanvas, reduceMotion);

// ---- state machine -------------------------------------------------------
let index = indexFromHash();
let locked = false;
const visited = new Set<number>([index]);
let lastTransitionEnd = 0;

function indexFromHash(): number {
  const id = location.hash.replace('#', '');
  const i = scenes.findIndex((s) => s.id === id);
  return i >= 0 ? i : 0;
}

/** Scenes can ask the app to navigate (e.g. the FPV menu). */
function goToId(id: string) {
  const i = scenes.findIndex((s) => s.id === id);
  if (i >= 0) goTo(i);
}

let disposeScene: (() => void) | null = null;

function mountScene(i: number) {
  const s = scenes[i];
  disposeScene?.(); // timers / key listeners of the scene we are leaving
  disposeScene = null;
  stage.replaceChildren();
  stage.dataset.layout = s.layout;
  stage.dataset.scene = s.id;
  const inner = document.createElement('section');
  inner.className = 'scene';
  const cleanup = s.render(inner, { goTo: goToId });
  if (typeof cleanup === 'function') disposeScene = cleanup;
  stage.append(inner);
  ascii.setColor(s.ascii);
  stage3d.setAccent(s.ascii);
  stage3d.setBg(s.bg);
  document.documentElement.style.setProperty('--scene-bg', s.bg);
  document.documentElement.style.setProperty('--scene-accent', s.ascii);
  prevBtn.disabled = i === 0;
  nextBtn.disabled = i === scenes.length - 1;
  renderSidebar();
}

function goTo(target: number) {
  if (locked || target === index || target < 0 || target >= scenes.length) return;
  locked = true;
  const to = scenes[target];
  visited.add(target);

  const state = { w: 0 };
  let phase: 0 | 1 = 0; // 0 = old scene flying out toward the viewer, 1 = new scene arriving from the distance
  stage3d.setKind(to.kind, TRANSITION);
  const setWarp = () => {
    ascii.warp = state.w;
    stage3d.setWarp(state.w, phase);
  };
  const tl = gsap.timeline({
    onComplete: () => {
      index = target;
      locked = false;
      lastTransitionEnd = performance.now();
      history.replaceState(null, '', `#${scenes[index].id}`);
    },
  });
  // Everything flies TOWARD the viewer. Scaling about screen center sends content on the left to the left and
  // content on the right to the right, exactly like the 3D layer's parallel-to-view-axis motion.
  tl.to(stage, { opacity: 0, scale: 1.8, duration: TRANSITION * 0.45, ease: 'power3.in' }, 0)
    .to(state, { w: 1, duration: TRANSITION * 0.5, ease: 'power2.in', onUpdate: setWarp }, 0)
    .to(document.body, { backgroundColor: to.bg, duration: TRANSITION, ease: 'power2.inOut' }, 0)
    .add(() => {
      index = target;
      phase = 1;
      mountScene(target);
      stage3d.setRig(to.kind, to.world); // camera rig / flight world swap happens at warp peak, hidden by the streaks
      gsap.set(stage, { x: 0, scale: 0.55 }); // new content starts far away...
    }, TRANSITION * 0.5)
    .to(stage, { opacity: 1, scale: 1, duration: TRANSITION * 0.5, ease: 'power3.out' }, TRANSITION * 0.5) // ...and flies in
    .to(state, { w: 0, duration: TRANSITION * 0.5, ease: 'power2.out', onUpdate: setWarp }, TRANSITION * 0.5);
}

const next = () => goTo(index + 1);
const prev = () => goTo(index - 1);

// ---- sidebar: color-absorbing history ------------------------------------
function renderSidebar() {
  sidebar.replaceChildren();
  scenes.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = s.label;
    b.setAttribute('aria-label', `Go to ${s.label}`);
    if (visited.has(i)) b.style.background = s.bg;
    if (i === index) b.classList.add('current');
    if (!visited.has(i)) b.classList.add('unvisited');
    b.addEventListener('click', () => goTo(i));
    sidebar.append(b);
  });
}

// ---- input ----------------------------------------------------------------
prevBtn.addEventListener('click', prev);
nextBtn.addEventListener('click', next);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) next();
  else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) prev();
});

// Wheel = threshold trigger only. Trackpad inertia is swallowed by a cooldown.
let wheelAcc = 0;
let wheelTimer: number | undefined;
window.addEventListener(
  'wheel',
  (e) => {
    if (locked || performance.now() - lastTransitionEnd < 450) {
      wheelAcc = 0;
      return;
    }
    // Let tall scene content scroll natively if it can.
    const sc = (stage.querySelector('.fpv-scroll') ?? stage.firstElementChild) as HTMLElement | null;
    if (sc && sc.scrollHeight > sc.clientHeight + 2) {
      const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      const atStart = sc.scrollTop <= 0;
      if ((e.deltaY > 0 && !atEnd) || (e.deltaY < 0 && !atStart)) return;
    }
    wheelAcc += e.deltaY;
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => (wheelAcc = 0), 160);
    if (Math.abs(wheelAcc) > 60) {
      const d = wheelAcc > 0 ? 1 : -1;
      wheelAcc = 0;
      goTo(index + d);
    }
  },
  { passive: true },
);

// Touch swipe
let touchY = 0;
let touchX = 0;
window.addEventListener('touchstart', (e) => {
  touchY = e.touches[0].clientY;
  touchX = e.touches[0].clientX;
}, { passive: true });
window.addEventListener('touchend', (e) => {
  const dy = touchY - e.changedTouches[0].clientY;
  const dx = touchX - e.changedTouches[0].clientX;
  const major = Math.abs(dy) > Math.abs(dx) ? dy : dx;
  if (Math.abs(major) > 60) goTo(index + (major > 0 ? 1 : -1));
}, { passive: true });

window.addEventListener('hashchange', () => {
  const i = indexFromHash();
  if (i !== index) goTo(i);
});

// ---- boot + render loop ---------------------------------------------------
document.body.style.backgroundColor = scenes[index].bg;
mountScene(index);
stage3d.setKind(scenes[index].kind, 0, true);
stage3d.setRig(scenes[index].kind, scenes[index].world);

let last = performance.now();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ascii.camp = stage3d.campBlend;
  ascii.campDir = stage3d.campDir;
  ascii.update(dt, reduceMotion);
  stage3d.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
