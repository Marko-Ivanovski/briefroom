import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vite';

// The workspace packages ship TypeScript, so the build bundles them into one file with SWC for
// the decorator metadata Nest needs. Everything from node_modules stays external.
const testkitStub = fileURLToPath(
  new URL('../api/src/module-registry/testkit-stub.ts', import.meta.url),
);

export default defineConfig({
  // The testkit is test-only, so the production bundle gets a stub instead of its server code.
  resolve: {
    alias: [{ find: /^@briefroom\/module-testkit\/(server|manifest)$/, replacement: testkitStub }],
  },
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
