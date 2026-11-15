import { defineConfig } from 'vite';

// One self-contained file, so `npm i -g` needs no node_modules beside it.
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: 'src/index.ts',
    outDir: 'bin',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'briefroom.js', banner: '#!/usr/bin/env node' },
    },
  },
});
