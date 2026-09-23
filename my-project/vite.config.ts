import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dApp frontend shares src/ with the Node-side CLI scripts (cli.ts, deploy.ts,
// ...). Vite only bundles what src/main.tsx imports, so those scripts stay out of
// the web build entirely — no exclusion rules needed.
export default defineConfig({
  plugins: [react()],
  server: {
    // The wallet extension injects window.midnight for the page's origin, so the
    // dev server must keep a stable port.
    port: 5173,
    strictPort: true,
  },
  build: {
    // Web output lands in dist/ (gitignored). `npm run build` uses tsc --noEmit,
    // so there is no emit collision.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
