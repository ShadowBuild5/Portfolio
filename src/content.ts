// Dummy payload. Replace freely; nothing else in the app hardcodes copy.

export const profile = {
  name: 'Shadow Blackie',
  alias: 'Lord Shadow', // hidden under the post-it in the hero; revealed on click
  role: 'Software Developer',
  tagline: 'I build things that run quietly and fail loudly.',
  email: 'hello@example.com',
  links: [
    { label: 'GitHub', href: 'https://github.com/' },
    { label: 'LinkedIn', href: 'https://linkedin.com/' },
  ],
};

export const skills = ['TypeScript', 'Node.js', 'Python', 'PostgreSQL', 'Docker', 'WebGL'];

export interface Charge {
  title: string;
  blurb: string;
  pack: '4S' | '6S'; // matches the battery pack of the same color on the charging-station table
  color: string; // that pack's color
  level: number; // 0-100
}

// Dummy "things I'm currently charging up on" (learning), shown in the Charging Station scene.
export const charging: Charge[] = [
  { title: 'Rust', blurb: 'Placeholder: systems programming, one borrow-checker fight at a time.', pack: '4S', color: '#2b6fd6', level: 58 },
  { title: 'Embedded / ESP32', blurb: 'Placeholder: tiny boards, big ideas.', pack: '6S', color: '#d23b5a', level: 34 },
  { title: 'System design', blurb: 'Placeholder: fully charged.', pack: '4S', color: '#e6862b', level: 100 },
  { title: 'GLSL shaders', blurb: 'Placeholder: making pixels do tricks.', pack: '6S', color: '#2fb36e', level: 12 },
];

export interface Wip {
  title: string;
  blurb: string;
  status: string;
  progress: number; // 0-100
}

// Dummy work-in-progress projects, shown on the Workshop bench.
export const wip: Wip[] = [
  { title: 'Project Delta', blurb: 'Placeholder: a flight-controller breakout board.', status: 'soldering', progress: 62 },
  { title: 'Project Echo', blurb: 'Placeholder: a tiny telemetry dashboard.', status: 'prototyping', progress: 35 },
  { title: 'Project Foxtrot', blurb: 'Placeholder: a battery pack with a smart charger.', status: 'planning', progress: 12 },
];

export interface Job {
  role: string;
  org: string;
  years: string;
  blurb: string;
}

// Dummy experience, shown in the Fields scene.
export const experience: Job[] = [
  { role: 'Senior Software Developer', org: 'Placeholder Labs', years: '2023 - now', blurb: 'Placeholder: led a small team shipping a realtime product.' },
  { role: 'Software Developer', org: 'Example Systems', years: '2020 - 2023', blurb: 'Placeholder: built APIs, tooling and a lot of dashboards.' },
  { role: 'Junior Developer', org: 'Sample Studio', years: '2018 - 2020', blurb: 'Placeholder: learned everything the hard way.' },
];

export interface Project {
  title: string;
  blurb: string;
  tags: string[];
}

export const projects: Project[] = [
  { title: 'Project Alpha', blurb: 'Placeholder: a realtime dashboard for something important.', tags: ['TS', 'WebSocket'] },
  { title: 'Project Beta', blurb: 'Placeholder: a CLI that saves an hour a day.', tags: ['Node', 'CLI'] },
  { title: 'Project Gamma', blurb: 'Placeholder: a tiny game engine experiment.', tags: ['WebGL', 'Math'] },
];
