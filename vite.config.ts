import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves this site from /Portfolio/, not from the domain root.
  // A relative base ('./') makes every asset URL in the built HTML relative,
  // so it works under any sub-path (and also if you add a custom domain later).
  base: './',
});
