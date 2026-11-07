import { useCallback, useEffect, useState } from 'react';
import { fetchProviderCatalog } from './api.js';

function chainLabel(aliasRow) {
  if (!aliasRow) {
    return '—';
  }
  if (aliasRow.kind === 'router') {
    return 'Chooses fast or smart from the prompt';
  }
  const parts = [aliasRow.primary, ...(aliasRow.fallbacks || [])].filter(Boolean);
  return parts.join(' → ');
}

function openRouterForSlot(catalog, slot) {
  const row = (catalog?.slots || []).find((item) => item.slot === slot);
  return row?.openrouter_model_id || '—';
}

function OnlineChain({ catalog, alias }) {
  const row = (catalog?.aliases || []).find((item) => item.alias === alias);
  if (!row || row.kind === 'router') {
    return (
      <tr>
        <td className="mono">{alias}</td>
        <td colSpan={3}>{chainLabel(row)}</td>
      </tr>
    );
  }
  const steps = [row.primary, ...(row.fallbacks || [])].filter(Boolean);
  return (
    <tr>
      <td className="mono">{alias}</td>
      <td className="mono">{steps.join(' → ')}</td>
      <td className="mono">
        {steps.map((slot) => openRouterForSlot(catalog, slot)).join(' → ')}
      </td>
      <td className="mono">
        {steps
          .map((slot) => {
            const found = (catalog?.slots || []).find((item) => item.slot === slot);
            return found?.provider || slot.split('-')[0];
          })
          .join(' → ')}
      </td>
    </tr>
  );
}

function MockChain({ catalog, alias }) {
  const row = (catalog?.aliases || []).find((item) => item.alias === alias);
  if (!row || row.kind === 'router') {
    return (
      <tr>
        <td className="mono">{alias}</td>
        <td colSpan={2}>{chainLabel(row)}</td>
      </tr>
    );
  }
  const steps = [row.primary, ...(row.fallbacks || [])].filter(Boolean);
  return (
    <tr>
      <td className="mono">{alias}</td>
      <td className="mono">{steps.join(' → ')}</td>
      <td className="mono">
        {steps
          .map((slot) => {
            const found = (catalog?.slots || []).find((item) => item.slot === slot);
            return found?.provider || slot.split('-')[0];
          })
          .join(' → ')}
      </td>
    </tr>
  );
}

export function ProvidersPage() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setCatalog(await fetchProviderCatalog());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <>
      <div className="toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}

      <div className="grid" style={{ marginBottom: '1.25rem' }}>
        <section>
          <h2>Online</h2>
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Slot chain</th>
                <th>Real models</th>
                <th>Providers</th>
              </tr>
            </thead>
            <tbody>
              <OnlineChain catalog={catalog} alias="fast" />
              <OnlineChain catalog={catalog} alias="smart" />
              <OnlineChain catalog={catalog} alias="auto" />
            </tbody>
          </table>
        </section>
      </div>

      <div className="grid">
        <section>
          <h2>Offline</h2>
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Slot chain</th>
                <th>Providers</th>
              </tr>
            </thead>
            <tbody>
              <MockChain catalog={catalog} alias="fast" />
              <MockChain catalog={catalog} alias="smart" />
              <MockChain catalog={catalog} alias="auto" />
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
