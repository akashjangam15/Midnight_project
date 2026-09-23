import { useState } from 'react';

export interface CircuitCallProps {
  /** Circuit name, shown on the button. */
  name: string;
  /** Optional one-line explanation shown under the heading. */
  description?: string;
  /** Runs the circuit and resolves with the value to display. */
  onCall?: () => Promise<unknown>;
  /** When set, the button is disabled and this text explains why. */
  disabledReason?: string;
}

/**
 * A single circuit call: a button, plus the result (or error) it produced.
 *
 * Deliberately presentation-only — it knows nothing about the contract, the
 * wallet, or how the call is made. The caller supplies `onCall`, so the same
 * component renders a local in-browser execution or a real on-chain call.
 */
export function CircuitCall({ name, description, onCall, disabledReason }: CircuitCallProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = !onCall || Boolean(disabledReason);

  async function handleClick() {
    if (!onCall) return;
    setPending(true);
    setError(null);
    try {
      setResult(await onCall());
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="circuit">
      <header className="circuit__header">
        <h3 className="circuit__name">{name}()</h3>
        {description && <p className="circuit__description">{description}</p>}
      </header>

      <button type="button" className="button" onClick={handleClick} disabled={disabled || pending}>
        {pending ? 'Calling…' : `Call ${name}()`}
      </button>

      {disabled && disabledReason && <p className="note">{disabledReason}</p>}

      {error && <pre className="result result--error">{error}</pre>}

      {!error && result != null && (
        <pre className="result">{JSON.stringify(result, null, 2)}</pre>
      )}
    </section>
  );
}
