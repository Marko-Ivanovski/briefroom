import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_ORIGIN = 'http://localhost:4300';

export default defineConfig(({ mode }) => ({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  // The e2e build always includes the testkit. Any other build includes it only when
  // VITE_BRIEFROOM_TESTKIT=1 is set, so a release bundle carries no testkit code.
  define:
    mode === 'e2e' ? { 'import.meta.env.VITE_BRIEFROOM_TESTKIT': JSON.stringify('1') } : undefined,
  server: {
    port: 5173,
    proxy: {
      '/api': API_ORIGIN,
      '/mcp': API_ORIGIN,
    },
  },
}));
