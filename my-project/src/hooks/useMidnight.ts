/**
 * Midnight.js / DApp Connector hook.
 *
 * A Midnight wallet (e.g. Lace) injects an `InitialAPI` per wallet under the
 * global `window.midnight` object, keyed by a UUID. `connect(networkId)`
 * returns the `ConnectedAPI`, which is the only thing a dApp may use to read
 * balances/addresses, request proving, balance, and submit transactions. The
 * hook never touches keys directly — signing and coin selection stay in the
 * wallet.
 *
 * Types come from `@midnight-ntwrk/dapp-connector-api`, which also augments
 * `Window` with the `midnight` property, so `window.midnight` is typed here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  APIError,
  Configuration,
  ConnectedAPI,
  InitialAPI,
  WalletConnectedAPI,
} from '@midnight-ntwrk/dapp-connector-api';

export type MidnightStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** A wallet extension instance found under `window.midnight`. */
export interface DetectedWallet {
  /** The UUID the wallet installed itself under. */
  id: string;
  api: InitialAPI;
}

/** Everything read from the connected wallet in one pass, best-effort. */
export interface WalletSnapshot {
  configuration: Configuration | null;
  unshieldedAddress: string | null;
  shieldedAddress: string | null;
  shieldedCoinPublicKey: string | null;
  shieldedEncryptionPublicKey: string | null;
  dustAddress: string | null;
  unshieldedBalances: Record<string, bigint> | null;
  dustBalance: { cap: bigint; balance: bigint } | null;
}

export const DEFAULT_NETWORK_ID = import.meta.env.VITE_NETWORK_ID?.trim() || 'undeployed';

/** The contract the UI is pointed at, when one has been deployed. */
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS?.trim() || null;

// Default local devnet proof server — used only for display/reference.
export const PROOF_SERVER_URL = import.meta.env.VITE_PROOF_SERVER_URL?.trim() || 'http://127.0.0.1:6300';

// Ask the wallet up front which methods this dApp will use. Wallets may prompt
// for consent here, so calling it once before the first read avoids surprises.
const HINTED_METHODS: Array<keyof WalletConnectedAPI> = [
  'getConfiguration',
  'getUnshieldedAddress',
  'getShieldedAddresses',
  'getDustAddress',
  'getUnshieldedBalances',
  'getDustBalance',
  'balanceUnsealedTransaction',
  'submitTransaction',
];

function detectWallets(): DetectedWallet[] {
  const injected = typeof window === 'undefined' ? undefined : window.midnight;
  if (!injected) return [];
  return Object.entries(injected).map(([id, api]) => ({ id, api }));
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object' && (error as APIError).type === 'DAppConnectorAPIError') {
    const apiError = error as APIError;
    return `${apiError.reason} (${apiError.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

// A wallet may reject individual methods by permission; a missing balance or
// address should not sink the whole snapshot.
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function readWalletSnapshot(api: ConnectedAPI): Promise<WalletSnapshot> {
  const [configuration, unshielded, shielded, dustAddress, unshieldedBalances, dustBalance] =
    await Promise.all([
      attempt(() => api.getConfiguration()),
      attempt(() => api.getUnshieldedAddress()),
      attempt(() => api.getShieldedAddresses()),
      attempt(() => api.getDustAddress()),
      attempt(() => api.getUnshieldedBalances()),
      attempt(() => api.getDustBalance()),
    ]);

  return {
    configuration,
    unshieldedAddress: unshielded?.unshieldedAddress ?? null,
    shieldedAddress: shielded?.shieldedAddress ?? null,
    shieldedCoinPublicKey: shielded?.shieldedCoinPublicKey ?? null,
    shieldedEncryptionPublicKey: shielded?.shieldedEncryptionPublicKey ?? null,
    dustAddress: dustAddress?.dustAddress ?? null,
    unshieldedBalances,
    dustBalance,
  };
}

export function useMidnight(networkId: string = DEFAULT_NETWORK_ID) {
  const [wallets, setWallets] = useState<DetectedWallet[]>(() => detectWallets());
  const [status, setStatus] = useState<MidnightStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const apiRef = useRef<ConnectedAPI | null>(null);

  const rescan = useCallback(() => setWallets(detectWallets()), []);

  // Wallet extensions inject window.midnight after the page loads, so poll
  // briefly instead of reading once and giving up.
  useEffect(() => {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const found = detectWallets();
      if (found.length > 0) {
        setWallets(found);
        window.clearInterval(timer);
      } else if (attempts >= 20) {
        window.clearInterval(timer);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const connect = useCallback(
    async (id: string) => {
      const wallet = detectWallets().find((w) => w.id === id);
      if (!wallet) {
        setStatus('error');
        setError('That wallet is no longer available. Rescan and try again.');
        return;
      }
      setStatus('connecting');
      setError(null);
      try {
        const api = await wallet.api.connect(networkId);
        await api.hintUsage(HINTED_METHODS);
        const next = await readWalletSnapshot(api);
        apiRef.current = api;
        setWalletName(wallet.api.name);
        setSnapshot(next);
        setStatus('connected');
      } catch (err) {
        apiRef.current = null;
        setWalletName(null);
        setSnapshot(null);
        setStatus('error');
        setError(describeError(err));
      }
    },
    [networkId],
  );

  const disconnect = useCallback(() => {
    // The connector has no explicit disconnect; dropping the reference is the
    // dApp-side equivalent.
    apiRef.current = null;
    setWalletName(null);
    setSnapshot(null);
    setStatus('idle');
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    setSnapshot(await readWalletSnapshot(api));
  }, []);

  return {
    wallets,
    status,
    error,
    networkId,
    walletName,
    snapshot,
    connectedApi: apiRef.current,
    connect,
    disconnect,
    refresh,
    rescan,
  };
}
