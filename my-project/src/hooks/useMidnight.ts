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

// Network IDs are case-sensitive in the DApp connector API
// Midnight networks: 'undeployed', 'preview', 'preprod' (all lowercase)
// Normalize to lowercase to handle case variations from wallets
export const DEFAULT_NETWORK_ID = import.meta.env.VITE_NETWORK_ID?.trim().toLowerCase() || 'undeployed';

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
  if (typeof window === 'undefined') {
    console.log('[useMidnight] detectWallets: window is undefined (SSR)');
    return [];
  }
  const injected = (window as any).midnight;
  if (!injected) {
    console.log('[useMidnight] detectWallets: window.midnight not found - is Lace installed?');
    return [];
  }
  console.log(`[useMidnight] detectWallets: found ${Object.keys(injected).length} wallet(s):`, Object.keys(injected));
  return Object.entries(injected).map(([id, api]) => ({ id, api: api as InitialAPI }));
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
      console.log(`[useMidnight] connect: attempting to connect wallet ${id} to network ${networkId}`);
      
      const wallets = detectWallets();
      const wallet = wallets.find((w) => w.id === id);
      
      if (!wallet) {
        console.error('[useMidnight] connect: wallet not found:', id);
        setStatus('error');
        setError('That wallet is no longer available. Rescan and try again.');
        return;
      }
      
      setStatus('connecting');
      setError(null);

      try {
        // Per the connector spec, the InitialAPI exposes only rdns/name/icon/
        // apiVersion + connect(networkId). There is NO way to query the
        // wallet's active network before connecting — getConfiguration()
        // exists only on the ConnectedAPI. The wallet itself enforces the
        // network: connect() rejects (InvalidRequest) on mismatch, which the
        // catch below maps to a user-facing hint.
        if (apiRef.current) {
          console.log('[useMidnight] connect: clearing previous connection');
          apiRef.current = null;
        }

        console.log(`[useMidnight] connect: calling wallet.connect("${networkId}")...`);
        const api = await wallet.api.connect(networkId);

        // hintUsage is part of the ConnectedAPI type, but some wallet builds
        // (observed with Lace) ship without it. It is a courtesy signal — the
        // wallet may use it to pre-grant permissions — so a missing or
        // rejecting implementation must never fail the connection.
        if (typeof api.hintUsage === 'function') {
          try {
            await api.hintUsage(HINTED_METHODS);
            console.log('[useMidnight] connect: usage hints accepted');
          } catch (hintErr) {
            console.log('[useMidnight] connect: hintUsage rejected (non-fatal):', describeError(hintErr));
          }
        } else {
          console.log('[useMidnight] connect: wallet does not implement hintUsage — skipping');
        }

        console.log('[useMidnight] connect: reading wallet snapshot...');
        const next = await readWalletSnapshot(api);

        // Post-connect sanity: now getConfiguration() is legal. connect()
        // should have already rejected on a wrong network, so treat a
        // mismatch here as an anomaly rather than a user error.
        const connectedNetwork = next.configuration?.networkId;
        if (connectedNetwork && connectedNetwork.toLowerCase() !== networkId.toLowerCase()) {
          console.error(
            `[useMidnight] connect: post-connect network mismatch — wallet reports "${connectedNetwork}", dApp wants "${networkId}"`,
          );
          setStatus('error');
          setError(
            `Wallet reports network "${connectedNetwork}" but this dApp needs "${networkId}". Switch Lace to ${networkId} and reconnect.`,
          );
          return;
        }

        apiRef.current = api;
        setWalletName(wallet.api.name);
        setSnapshot(next);
        setStatus('connected');
        console.log('[useMidnight] connect: successful!', { address: next.unshieldedAddress, network: connectedNetwork });
      } catch (err) {
        console.error('[useMidnight] connect: failed!', err);
        
        const errStr = err instanceof Error ? err.message : String(err);
        
        if (errStr.includes('InvalidRequest') || errStr.includes('network') || errStr.includes('mismatch')) {
          setStatus('error');
          setError(`Network mismatch (InvalidRequest). Lace needs to be on the "${networkId}" network. Please switch networks in Lace.`);
        } else if (errStr.includes('feature-flags') || errStr.includes('shutdown') || errStr.includes('can no longer be used')) {
          setStatus('error');
          setError('Connection interrupted. Please refresh the page and try again.');
        } else {
          setStatus('error');
          setError(describeError(err));
        }
        
        apiRef.current = null;
        setWalletName(null);
        setSnapshot(null);
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

  const clearError = useCallback(() => setError(null), []);

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
    clearError,
  };
}
