import swc from 'unplugin-swc';
import { defineConfig } from 'vite';

// The workspace packages ship TypeScript, so the build bundles them into one file with SWC for
// the decorator metadata Nest needs. Everything from node_modules stays external.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  ssr: { noExternal: [/^@briefroom\//] },
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    target: 'node24',
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: 'main.js' } },
  },
});
