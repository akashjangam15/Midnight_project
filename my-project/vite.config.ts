import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// The dApp frontend shares src/ with the Node-side CLI scripts (cli.ts, deploy.ts,
// ...). Vite only bundles what src/main.tsx imports, so those scripts stay out of
// the web build entirely — no exclusion rules needed.
//
// wasm() is required: @midnight-ntwrk/onchain-runtime-v3 (pulled in by
// compact-runtime, which the compiled counter contract imports) loads its
// midnight_onchain_runtime_wasm_bg.wasm with the standardized wasm-ESM import
// syntax, which Vite's dev server does not support natively. Without the
// plugin the module initializes with `wasm` undefined and the app fails
// during import with
//   Uncaught TypeError: Cannot read properties of undefined
//   (reading '__wbindgen_export_2')
// leaving #root — and the whole page — empty.
//
// nodePolyfills() is required by the on-chain path: levelPrivateStateProvider
// → level → abstract-level extends Node's EventEmitter (the `events`
// builtin), which does not exist in browsers. Without the polyfill the dep
// optimizes to "Module events has been externalized" and module init throws
//   Uncaught TypeError: Class extends value undefined is not a constructor
export default defineConfig({
  plugins: [react(), wasm(), nodePolyfills({ include: ['events', 'buffer'] })],
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
    // wasm-ESM imports require top-level-await support in the output format.
    target: 'esnext',
  },
});
