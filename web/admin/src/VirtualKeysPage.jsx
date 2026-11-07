import { useCallback, useEffect, useState } from 'react';
import { disableKey, enableKey, fetchKeys, rotateKey } from './api.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { SecretKey } from './SecretKey.jsx';

const SEED_KEYS = new Set([
  'prism-sk-search-1a2b3c',
  'prism-sk-research-4d5e6f',
  'prism-sk-free-7g8h9i',
  'prism-sk-budget-demo-0j1k2l',
]);

function isSeedKey(virtualKey) {
  return SEED_KEYS.has(virtualKey);
}

export function VirtualKeysPage() {
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchKeys();
      setKeys(data.keys || []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runKeyAction(id, action, confirmText) {
    if (confirmText) {
      const ok = await confirm(confirmText, {
        title: 'Please confirm',
        confirmLabel: 'Yes',
      });
      if (!ok) {
        return;
      }
    }
    setBusyKeyId(id);
    setError('');
    setNotice('');
    try {
      const result = await action(id);
      if (result?.key?.rotated) {
        setNotice(
          `Rotated key #${id}. New secret: ${result.key.virtual_key}. Old secret no longer works.`,
        );
      } else if (result?.key?.status === 'disabled') {
        setNotice(`Key #${id} disabled.`);
      } else if (result?.key?.status === 'active') {
        setNotice(`Key #${id} enabled.`);
      }
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <>
      {confirmDialog}
      <div className="toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}

      <p className="muted-hint" style={{ marginBottom: '0.85rem' }}>
        Keys are created when you create a user. Every key has an owner for
        usage tracking. Pack seeds are API-only and protected.
      </p>

      <div className="grid">
        <section>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Status</th>
                  <th>User</th>
                  <th>Team</th>
                  <th>Budget</th>
                  <th>RPM</th>
                  <th>Allowlist</th>
                  <th>Cache</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const seed = isSeedKey(k.virtual_key);
                  const busy = busyKeyId === k.id;
                  return (
                    <tr key={k.id || k.virtual_key}>
                      <td>
                        <SecretKey value={k.virtual_key} />
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            k.status === 'active' ? 'ok' : 'bad'
                          }`}
                        >
                          {k.status || 'active'}
                        </span>
                        {seed ? <span className="seed-tag">seed</span> : null}
                      </td>
                      <td>{k.user_name || k.username || '—'}</td>
                      <td>{k.team}</td>
                      <td className="mono">${k.monthly_budget_usd}</td>
                      <td className="mono">{k.rpm_limit}</td>
                      <td className="mono">
                        {(k.model_allowlist || []).join(', ')}
                      </td>
                      <td>{k.cache_enabled ? 'on' : 'off'}</td>
                      <td>
                        <div className="row-actions">
                          {seed ? (
                            <span className="muted-hint">Protected</span>
                          ) : k.status === 'disabled' ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                runKeyAction(k.id, enableKey, null)
                              }
                            >
                              Enable
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="ghost"
                                disabled={busy}
                                onClick={() =>
                                  runKeyAction(
                                    k.id,
                                    disableKey,
                                    `Disable ${k.virtual_key}? /v1 calls with this secret will fail.`,
                                  )
                                }
                              >
                                Disable
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  runKeyAction(
                                    k.id,
                                    rotateKey,
                                    `Rotate ${k.virtual_key}? The old secret stops working immediately.`,
                                  )
                                }
                              >
                                Rotate
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
