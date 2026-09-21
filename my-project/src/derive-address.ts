// Derive the wallet's bech32 address locally from the persisted seed.
// Pure key derivation — no network sync required.
//
// IMPORTANT: do NOT import '@midnight-ntwrk/wallet-sdk' (the barrel) here.
// It re-exports packages that pull in `effect`, whose ESM entry never
// finishes loading in this environment (the process hangs forever).
// We import the narrow subpaths we need instead:
//   - HDWallet / Roles  -> '@midnight-ntwrk/wallet-sdk-hd'      (loads fast)
//   - createKeystore    -> the unshielded-wallet KeyStore module (loads fast;
//                          only depends on address-format + ledger-v8). It is
//                          not reachable by subpath because the package's
//                          "exports" map hides it, so we import the file by URL.
import * as fs from 'node:fs';
import { Buffer } from 'buffer';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import type { NetworkId } from './network';

const { createKeystore } = (await import(
  new URL(
    '../node_modules/@midnight-ntwrk/wallet-sdk-unshielded-wallet/dist/KeyStore.js',
    import.meta.url,
  ).href
)) as typeof import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');

const stateFile = '.midnight-state.json';
const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
  activeNetwork: string;
  wallets: Record<string, { seed: string } | undefined>;
};

const network = state.activeNetwork;
const entry = state.wallets[network];
if (!entry?.seed) {
  console.error(`No wallet found for network "${network}" in ${stateFile}`);
  process.exit(1);
}

setNetworkId(network as NetworkId);

// Mirror deriveKeys() in wallet.ts exactly — same account, same roles.
const hdWallet = HDWallet.fromSeed(Buffer.from(entry.seed, 'hex'));
if (hdWallet.type !== 'seedOk') {
  console.error('Invalid seed');
  process.exit(1);
}
const result = hdWallet.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
  .deriveKeysAt(0);
if (result.type !== 'keysDerived') {
  console.error('Key derivation failed');
  process.exit(1);
}

const keystore = createKeystore(result.keys[Roles.NightExternal], network as NetworkId);
console.log(keystore.getBech32Address().toString());
process.exit(0);
