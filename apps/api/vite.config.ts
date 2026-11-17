import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vite';

// The workspace packages ship TypeScript, so the build bundles them into one file with SWC for
// the decorator metadata Nest needs. Everything from node_modules stays external.
const testkitStub = fileURLToPath(
  new URL('./src/module-registry/testkit-stub.ts', import.meta.url),
);

export default defineConfig({
  // The testkit is test-only, so the production bundle gets a stub instead of its server code.
  resolve: {
    alias: [{ find: /^@briefroom\/module-testkit\/(server|manifest)$/, replacement: testkitStub }],
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
  ssr: { noExternal: [/^@briefroom\//] },
  build: {
    ssr: true,
    outDir: 'dist',
    target: 'node24',
    minify: false,
    sourcemap: true,
    // admin-cli.js is what `briefroom reset-password` runs inside the container.
    rollupOptions: {
      input: { main: 'src/main.ts', 'admin-cli': 'src/admin-cli.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
});
