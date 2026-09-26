// Copies zkConfig assets from managed/counter/ into public/counter-keys/
// so the browser dApp can fetch them over HTTP (the browser has no
// filesystem, so NodeZkConfigProvider cannot be used there).
//
// Layout mirrors the on-disk layout, which BrowserZkConfigProvider
// (src/onchain.ts) fetches:
//   public/counter-keys/zkir/{circuit}.bzkir
//   public/counter-keys/keys/{circuit}.{prover,verifier}
import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'managed', 'counter');
const dest = join(root, 'public', 'counter-keys');

if (!existsSync(join(src, 'zkir'))) {
  console.error('managed/counter/zkir not found — run `npm run compile` first.');
  process.exit(1);
}

mkdirSync(join(dest, 'zkir'), { recursive: true });
mkdirSync(join(dest, 'keys'), { recursive: true });

cpSync(join(src, 'zkir'), join(dest, 'zkir'), { recursive: true });
cpSync(join(src, 'keys'), join(dest, 'keys'), { recursive: true });

const count = (dir) =>
  readdirSync(join(dest, dir)).filter((f) => statSync(join(dest, dir, f)).isFile()).length;

console.log(`synced: ${count('zkir')} zkIR(s), ${count('keys')} key file(s) → public/counter-keys/`);
