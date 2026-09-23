import type { DetectedWallet, MidnightStatus, WalletSnapshot } from '../hooks/useMidnight';

export interface WalletConnectProps {
  wallets: DetectedWallet[];
  status: MidnightStatus;
  error: string | null;
  networkId: string;
  walletName: string | null;
  snapshot: WalletSnapshot | null;
  onConnect: (walletId: string) => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onRescan: () => void;
}

function short(value: string, lead = 12, tail = 8): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * Wallet connect / disconnect UI.
 *
 * Wallet-supplied `name` and `icon` are untrusted input: the name is rendered
 * as text (never HTML) and the icon inside an `<img>` tag, per the connector
 * spec's XSS guidance.
 */
export function WalletConnect({
  wallets,
  status,
  error,
  networkId,
  walletName,
  snapshot,
  onConnect,
  onDisconnect,
  onRefresh,
  onRescan,
}: WalletConnectProps) {
  const connected = status === 'connected';

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Wallet</h2>
        <span className={`badge badge--${status}`}>{status}</span>
      </header>

      <p className="note">
        Target network: <code>{networkId}</code>
      </p>

      {!connected && wallets.length === 0 && (
        <div className="empty">
          <p>No Midnight wallet detected.</p>
          <p>
            Install a Midnight-compatible browser wallet (for example Lace), then reload. The wallet
            injects itself at <code>window.midnight</code>.
          </p>
          <button type="button" className="button button--ghost" onClick={onRescan}>
            Rescan
          </button>
        </div>
      )}

      {!connected && wallets.length > 0 && (
        <ul className="wallet-list">
          {wallets.map((wallet) => (
            <li key={wallet.id} className="wallet">
              <img className="wallet__icon" src={wallet.api.icon} alt="" width={28} height={28} />
              <div className="wallet__meta">
                <span className="wallet__name">{wallet.api.name}</span>
                <span className="wallet__sub">
                  {wallet.api.rdns} · api {wallet.api.apiVersion}
                </span>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => onConnect(wallet.id)}
                disabled={status === 'connecting'}
              >
                {status === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {connected && snapshot && (
        <div className="wallet-connected">
          <div className="row">
            <span className="row__label">Wallet</span>
            <span className="row__value">{walletName ?? 'connected'}</span>
          </div>
          <div className="row">
            <span className="row__label">Wallet network</span>
            <span className="row__value">{snapshot.configuration?.networkId ?? '—'}</span>
          </div>
          <div className="row">
            <span className="row__label">Unshielded address</span>
            <span className="row__value mono" title={snapshot.unshieldedAddress ?? undefined}>
              {snapshot.unshieldedAddress ? short(snapshot.unshieldedAddress) : '—'}
            </span>
          </div>
          <div className="row">
            <span className="row__label">tNIGHT</span>
            <span className="row__value">
              {snapshot.unshieldedBalances
                ? Object.entries(snapshot.unshieldedBalances)
                    .map(([token, amount]) => `${amount.toLocaleString()} (${short(token, 8, 6)})`)
                    .join(', ')
                : '—'}
            </span>
          </div>
          <div className="row">
            <span className="row__label">DUST</span>
            <span className="row__value">
              {snapshot.dustBalance ? snapshot.dustBalance.balance.toLocaleString() : '—'}
            </span>
          </div>

          <div className="actions">
            <button type="button" className="button button--ghost" onClick={onRefresh}>
              Refresh
            </button>
            <button type="button" className="button button--danger" onClick={onDisconnect}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
