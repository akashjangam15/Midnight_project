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
        // First, check what network the wallet is currently on
        let walletNetwork = 'unknown';
        try {
          const config = await wallet.api.getConfiguration();
          walletNetwork = config?.networkId ?? 'not returned';
          console.log('[useMidnight] connect: wallet current network from getConfiguration():', walletNetwork);
        } catch (configErr) {
          console.log('[useMidnight] connect: could not read wallet config via getConfiguration()');
        }
        
        // Also check if wallet has a network property directly
        if ((wallet.api as any).network) {
          walletNetwork = (wallet.api as any).network;
          console.log('[useMidnight] connect: wallet network from api.network:', walletNetwork);
        }
        
        // Case-insensitive network comparison
        const walletNetworkLower = walletNetwork?.toLowerCase();
        const requestedNetworkLower = networkId.toLowerCase();
        
        if (walletNetworkLower && walletNetworkLower !== requestedNetworkLower) {
          console.log(`[useMidnight] connect: network mismatch detected - wallet on "${walletNetwork}", dApp wants "${networkId}"`);
          setStatus('error');
          setError(`Network mismatch: Lace is on "${walletNetwork}" but this dApp needs "${networkId}". Please switch Lace to ${networkId} network.`);
          return;
        }
        
        // Networks match (case-insensitive) - proceed with connect using lowercase networkId
        console.log(`[useMidnight] connect: networks match (case-insensitive), proceeding with "${networkId}"`);
        
        if (apiRef.current) {
          console.log('[useMidnight] connect: clearing previous connection');
          apiRef.current = null;
        }
        
        console.log(`[useMidnight] connect: calling wallet.connect("${networkId}")...`);
        console.log('[useMidnight] connect: wallet object:', JSON.stringify({
          name: wallet.api.name,
          apiVersion: wallet.api.apiVersion,
          rdns: wallet.api.rdns
        }));
        
        const api = await wallet.api.connect(networkId);
        console.log('[useMidnight] connect: wallet connected, hinting usage...');
        
        await api.hintUsage(HINTED_METHODS);
        
        console.log('[useMidnight] connect: reading wallet snapshot...');
        const next = await readWalletSnapshot(api);
        
        apiRef.current = api;
        setWalletName(wallet.api.name);
        setSnapshot(next);
        setStatus('connected');
        console.log('[useMidnight] connect: successful!', { address: next.unshieldedAddress, network: next.configuration?.networkId });
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
