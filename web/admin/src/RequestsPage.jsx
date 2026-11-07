import { useCallback, useEffect, useState } from 'react';
import { clearTable, deleteRecord, fetchLogs } from './api.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { SecretKey } from './SecretKey.jsx';

function when(value) {
  if (!value) {
    return '—';
  }
  return String(value).replace('T', ' ').slice(0, 19);
}

/** What `auto` resolved to (fast/smart), from stored route_reason. */
function routedAlias(row) {
  if (row?.requested_model !== 'auto') {
    return '—';
  }
  const reason = String(row.route_reason || '');
  if (/\bescalated_to_smart\b/i.test(reason)) {
    return 'smart';
  }
  const match = reason.match(/\b(fast|smart)\s*\(/i);
  return match ? match[1].toLowerCase() : '—';
}

export function RequestsPage() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchLogs(500);
      setLogs(data.logs || []);
      setTotal(Number(data.total || data.logs?.length || 0));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function removeOne(id) {
    const ok = await confirm(`Delete request log #${id}?`, {
      title: 'Delete?',
      confirmLabel: 'Yes, delete',
    });
    if (!ok) {
      return;
    }
    setError('');
    try {
      await deleteRecord('request_logs', id);
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function removeAll() {
    const ok = await confirm(
      'Delete every request log? This cannot be undone.',
      { title: 'Delete all?', confirmLabel: 'Yes, delete' },
    );
    if (!ok) {
      return;
    }
    setError('');
    try {
      await clearTable('request_logs');
      await refresh();
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  return (
    <>
      {confirmDialog}
      <div className="toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="danger"
          disabled={loading || total === 0}
          onClick={removeAll}
        >
          Delete all
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <section>
        <div className="section-head">
          <h2>Requests</h2>
          <span className="hint">
            Showing {logs.length} of {total} requests
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Key</th>
                <th>Asked</th>
                <th>Routed</th>
                <th>Served</th>
                <th>Cache</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>ms</th>
                <th>Reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{when(row.created_at)}</td>
                  <td>
                    <span
                      className={`badge ${
                        row.status === 'ok' || row.status === 'cache_hit'
                          ? 'ok'
                          : 'bad'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td>
                    <SecretKey value={row.virtual_key} />
                  </td>
                  <td className="mono">{row.requested_model || '—'}</td>
                  <td className="mono">{routedAlias(row)}</td>
                  <td className="mono">
                    {row.resolved_provider
                      ? `${row.resolved_provider}/${row.resolved_model || ''}`
                      : row.resolved_model || '—'}
                  </td>
                  <td className="mono">{row.cache || '—'}</td>
                  <td className="mono">
                    {Number(row.prompt_tokens || 0) +
                      Number(row.completion_tokens || 0)}
                  </td>
                  <td className="mono">{Number(row.cost_usd || 0).toFixed(6)}</td>
                  <td className="mono">{row.latency_ms ?? '—'}</td>
                  <td className="mono">{row.route_reason || row.error_type || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => removeOne(row.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
