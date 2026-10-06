import { defineConfig } from 'vite';

// GitHub Pages serves the repo at /errata/. ERRATA_BASE overrides it (for example "./" for a file:// build).
// Nothing here depends on the local folder name.
export default defineConfig({
  base: process.env.ERRATA_BASE ?? '/errata/',
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
});
