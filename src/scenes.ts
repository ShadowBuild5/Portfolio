import { profile, skills, projects, experience, wip, charging } from './content';
import type { WorldId } from './worlds';

/**
 * Data-driven scene list. Add a scene = add an entry here.
 * `kind` picks the 3D rig: 'camp' = the hero diorama, 'fpv' = first-person flight over a procedural `world`.
 * Reserved for later: 'station', 'workshop'.
 */
export type SceneKind = 'camp' | 'flight' | 'station' | 'workshop' | 'fpv';

export interface SceneDef {
  id: string; // used for #hash deep links
  label: string; // sidebar tooltip
  kind: SceneKind;
  /** For kind 'fpv': which procedural world to fly over. */
  world?: WorldId;
  bg: string; // solid scene color (also the sidebar swatch, and the fog color of flight worlds)
  ascii: string; // accent: ASCII tint, HUD color, gates, key light
  layout: 'right' | 'center' | 'fpv';
  /** Build the scene's DOM. May return a cleanup function (timers, listeners) called when the scene unmounts. */
  render: (root: HTMLElement, ctx: SceneCtx) => void | (() => void);
}

/** What a scene can ask the app to do. */
export interface SceneCtx {
  goTo: (id: string) => void;
}

interface MenuItem {
  label: string;
  sub?: string;
  go?: string; // scene id; absent = not built yet
}

const FPV_MENU: MenuItem[] = [
  { label: 'PROJECTS', sub: 'things I built', go: 'projects' },
  { label: 'ABOUT / SKILLS', sub: 'who, what', go: 'about' },
  { label: 'EXPERIENCE', sub: 'where I worked', go: 'fields' },
  { label: 'CONTACT', sub: 'say hi', go: 'contact' },
  { label: 'WORKSHOP', sub: 'work in progress', go: 'workshop' },
  { label: 'CHARGING STATION', sub: 'batteries on charge', go: 'station' },
];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

interface ShellOpts {
  place: string; // shown in the HUD, e.g. SNOWFIELD
  alt: number; // base altitude readout (m)
  hub?: boolean; // the FPV hub: crosshair + menu, no content card
}

/**
 * Goggle-style HUD shared by every flight scene. Returns the container to put the scene's content card in
 * (centered over the flight, scrollable if tall) and a cleanup that stops the telemetry timer.
 */
function fpvShell(root: HTMLElement, opts: ShellOpts): { content: HTMLElement; cleanup: () => void } {
  root.classList.add('fpv');
  const row = (parent: HTMLElement, cls: string, text = '') => {
    const d = el('div', cls, text);
    parent.append(d);
    return d;
  };

  root.append(el('div', 'fpv-vignette'), el('div', 'fpv-scan'));
  if (opts.hub) root.append(el('div', 'fpv-cross'));

  // OSD readouts (dummy telemetry, animated below)
  const tl = el('div', 'osd osd-tl');
  const bat = row(tl, 'osd-row');
  row(tl, 'osd-row dim', 'CELLS 4S');
  const tr = el('div', 'osd osd-tr');
  const rssi = row(tr, 'osd-row');
  const clock = row(tr, 'osd-row');
  row(tr, 'osd-row dim', `LOC ${opts.place}`);
  const bl = el('div', 'osd osd-bl');
  const alt = row(bl, 'osd-row');
  const spd = row(bl, 'osd-row');
  const br = el('div', 'osd osd-br');
  row(br, 'osd-row', 'ARMED');
  row(br, 'osd-row dim', 'MODE: ANGLE');
  root.append(tl, tr, bl, br);

  const wrap = el('div', 'fpv-content');
  const content = el('div', 'fpv-scroll');
  wrap.append(content);
  if (!opts.hub) root.append(wrap);

  const t0 = performance.now();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    const volts = Math.max(14.2, 16.8 - t * 0.004);
    const bars = Math.max(1, Math.round(((volts - 14.2) / (16.8 - 14.2)) * 8));
    bat.textContent = `BAT [${'|'.repeat(bars)}${' '.repeat(8 - bars)}] ${volts.toFixed(1)}V`;
    rssi.textContent = `RSSI ||||  ${Math.round(96 + Math.sin(t * 0.9) * 2)}%`;
    clock.textContent = `TIME ${pad(Math.floor(t / 60))}:${pad(Math.floor(t % 60))}`;
    alt.textContent = `ALT ${(opts.alt + Math.sin(t * 0.7) * 3).toFixed(1)}M`;
    spd.textContent = `SPD ${Math.round(62 + Math.sin(t * 0.5) * 9)}KM/H`;
  };
  tick();
  const timer = window.setInterval(tick, 200);

  return { content, cleanup: () => window.clearInterval(timer) };
}

function projectCards(): HTMLElement {
  const grid = el('div', 'grid');
  projects.forEach((p) => {
    const c = el('article', 'card');
    c.append(el('h3', '', p.title), el('p', '', p.blurb));
    const t = el('div', 'tags');
    p.tags.forEach((x) => t.append(el('span', 'tag', x)));
    c.append(t);
    grid.append(c);
  });
  return grid;
}

export const scenes: SceneDef[] = [
  {
    id: 'hero',
    label: 'Hello',
    kind: 'camp',
    bg: '#14213d',
    ascii: '#fca311',
    layout: 'right',
    render(root) {
      // The name is a post-it stuck on a cardboard box. Peel it (click) to reveal the alias written on the cardboard.
      const h1 = el('h1', 'name-heading');
      const tag = el('button', 'name-tag');
      tag.type = 'button';
      const board = el('span', 'tag-board');
      board.append(el('span', 'tag-hidden', profile.alias));
      const note = el('span', 'tag-note');
      note.append(el('span', 'tag-text', profile.name));
      tag.append(board, note);

      const label = (revealed: boolean) =>
        revealed ? `${profile.alias}. Click to stick the note back on.` : `${profile.name}. Click the note to reveal a hidden name.`;
      tag.setAttribute('aria-pressed', 'false');
      tag.setAttribute('aria-label', label(false));
      tag.addEventListener('click', () => {
        const on = tag.getAttribute('aria-pressed') !== 'true';
        tag.setAttribute('aria-pressed', String(on));
        tag.setAttribute('aria-label', label(on));
      });
      h1.append(tag);

      root.append(el('p', 'eyebrow', 'Hello, I am'), h1, el('p', 'role', profile.role), el('p', 'lead', profile.tagline));
    },
  },
  {
    // The hub: valley flight + OSD menu to everything else.
    id: 'fpv',
    label: 'Fly',
    kind: 'fpv',
    world: 'valley',
    bg: '#2a1840',
    ascii: '#ff8fab',
    layout: 'fpv',
    render(root, ctx) {
      const { cleanup } = fpvShell(root, { place: 'VALLEY', alt: 12, hub: true });
      root.append(el('div', 'osd osd-hint', `MOVE MOUSE TO LOOK AROUND  //  PRESS 1-${FPV_MENU.length}`));

      const menu = el('nav', 'osd-menu');
      menu.setAttribute('aria-label', 'Main menu');
      menu.append(el('div', 'osd-title', '- MAIN MENU -'));
      FPV_MENU.forEach((it, i) => {
        const b = el('button', 'osd-item');
        b.type = 'button';
        b.append(el('span', 'osd-key', String(i + 1)), el('span', 'osd-label', it.label));
        if (it.sub) b.append(el('span', 'osd-sub', it.sub));
        if (it.go) {
          const target = it.go;
          b.addEventListener('click', () => ctx.goTo(target));
        } else {
          b.classList.add('soon');
          b.setAttribute('aria-disabled', 'true');
        }
        menu.append(b);
      });
      root.append(menu);

      const onKey = (e: KeyboardEvent) => {
        const n = Number(e.key);
        const it = FPV_MENU[n - 1];
        if (it?.go) ctx.goTo(it.go);
      };
      window.addEventListener('keydown', onKey);

      return () => {
        cleanup();
        window.removeEventListener('keydown', onKey);
      };
    },
  },
  {
    id: 'about',
    label: 'About',
    kind: 'fpv',
    world: 'snow',
    bg: '#27466e',
    ascii: '#ffd27a',
    layout: 'fpv',
    render(root) {
      const { content, cleanup } = fpvShell(root, { place: 'SNOWFIELD', alt: 24 });
      const card = el('div', 'card');
      card.append(
        el('h2', '', 'About & Skills'),
        el('p', '', 'Placeholder bio. Software developer who likes small, sharp tools and over-engineered side projects.'),
      );
      const tags = el('div', 'tags');
      skills.forEach((s) => tags.append(el('span', 'tag', s)));
      card.append(tags);
      content.append(card);
      return cleanup;
    },
  },
  {
    id: 'projects',
    label: 'Projects',
    kind: 'fpv',
    world: 'mountains',
    bg: '#b4603f',
    ascii: '#ffe2b8',
    layout: 'fpv',
    render(root) {
      const { content, cleanup } = fpvShell(root, { place: 'HIGH PEAKS', alt: 180 });
      content.append(el('h2', '', 'Projects'), projectCards());
      return cleanup;
    },
  },
  {
    // Projects still on the bench: the character, seen from behind, is soldering one of them.
    id: 'workshop',
    label: 'Workshop',
    kind: 'workshop',
    bg: '#2a1f17',
    ascii: '#ffb347',
    layout: 'right',
    render(root) {
      root.append(el('div', 'hazard'), el('p', 'eyebrow', 'Under construction'), el('h2', '', 'Workshop'));
      const stack = el('div', 'stack');
      const fills: Array<[HTMLElement, number]> = [];
      wip.forEach((p) => {
        const c = el('article', 'card wip-card');
        const bar = el('div', 'wip-bar');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(p.progress));
        bar.setAttribute('aria-label', `${p.title} progress`);
        const fill = el('div', 'wip-fill');
        bar.append(fill);
        fills.push([fill, p.progress]);
        const meta = el('div', 'wip-row');
        meta.append(el('span', 'wip-status', `STATUS // ${p.status.toUpperCase()}`), el('span', 'wip-pct', `${p.progress}%`));
        c.append(el('h3', '', p.title), el('p', '', p.blurb), meta, bar);
        stack.append(c);
      });
      root.append(stack);
      // fill the progress bars once the card has been laid out, so the CSS transition plays
      requestAnimationFrame(() => requestAnimationFrame(() => fills.forEach(([f, v]) => (f.style.width = `${v}%`))));
    },
  },
  {
    // Nothing but 4S / 6S LiPo packs on a table, on charge. The cards are what I'm currently "charging up" on.
    id: 'station',
    label: 'Charging Station',
    kind: 'station',
    bg: '#10242c',
    ascii: '#6dffb0',
    layout: 'right',
    render(root) {
      root.append(el('p', 'eyebrow', 'Recharging'), el('h2', '', 'Charging Station'));
      const stack = el('div', 'stack');
      const fills: Array<{ cells: HTMLElement[]; on: number; live: boolean }> = [];
      charging.forEach((c) => {
        const card = el('article', 'card charge-card');
        card.style.setProperty('--pack', c.color);
        const head = el('div', 'charge-head');
        head.append(el('h3', '', c.title), el('span', 'pack-tag', c.pack));
        const meta = el('div', 'wip-row');
        meta.append(el('span', 'wip-status', c.level >= 100 ? 'STATUS // FULL' : 'STATUS // CHARGING'), el('span', 'wip-pct', `${c.level}%`));
        const batt = el('div', 'batt');
        batt.setAttribute('role', 'progressbar');
        batt.setAttribute('aria-valuemin', '0');
        batt.setAttribute('aria-valuemax', '100');
        batt.setAttribute('aria-valuenow', String(c.level));
        batt.setAttribute('aria-label', `${c.title} charge`);
        const cells: HTMLElement[] = [];
        for (let i = 0; i < 10; i++) {
          const cell = el('span', 'cell');
          batt.append(cell);
          cells.push(cell);
        }
        fills.push({ cells, on: Math.round(c.level / 10), live: c.level < 100 });
        card.append(head, el('p', '', c.blurb), meta, batt);
        stack.append(card);
      });
      root.append(stack);
      // fill the cells one after another once laid out, with the last one pulsing while it is still charging
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          fills.forEach((f) =>
            f.cells.forEach((cell, i) => {
              if (i >= f.on) return;
              cell.style.transitionDelay = `${i * 70}ms`;
              cell.classList.add('on');
              if (f.live && i === f.on - 1) cell.classList.add('live');
            }),
          ),
        ),
      );
    },
  },
  {
    id: 'fields',
    label: 'Experience',
    kind: 'fpv',
    world: 'farms',
    bg: '#5f9ab5',
    ascii: '#fff0b8',
    layout: 'fpv',
    render(root) {
      const { content, cleanup } = fpvShell(root, { place: 'FARMLAND', alt: 14 });
      content.append(el('h2', '', 'Experience'));
      const grid = el('div', 'grid');
      experience.forEach((j) => {
        const c = el('article', 'card');
        c.append(el('h3', '', j.role), el('p', 'job-meta', `${j.org}  •  ${j.years}`), el('p', '', j.blurb));
        grid.append(c);
      });
      content.append(grid);
      return cleanup;
    },
  },
  {
    id: 'contact',
    label: 'Contact',
    kind: 'fpv',
    world: 'beach',
    bg: '#1b5f78',
    ascii: '#ffd166',
    layout: 'fpv',
    render(root) {
      const { content, cleanup } = fpvShell(root, { place: 'COASTLINE', alt: 9 });
      const card = el('div', 'card');
      card.append(el('h2', '', 'Contact'), el('p', '', 'Say hi. I read everything.'));
      const a = el('a', 'btn', profile.email);
      a.href = `mailto:${profile.email}`;
      card.append(a);
      const links = el('div', 'tags');
      profile.links.forEach((l) => {
        const x = el('a', 'tag', l.label);
        x.href = l.href;
        x.target = '_blank';
        x.rel = 'noopener noreferrer';
        links.append(x);
      });
      card.append(links);
      content.append(card);
      return cleanup;
    },
  },
];
