import { useCallback, useEffect, useState } from 'react';
import {
  clearTable,
  deleteRecord,
  fetchCacheEntries,
  fetchCacheHits,
  fetchCacheStats,
} from './api.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { SecretKey } from './SecretKey.jsx';

function when(value) {
  if (!value) {
    return '—';
  }
  return String(value).replace('T', ' ').slice(0, 19);
}

function score(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return '—';
  }
  return Number(value).toFixed(3);
}

export function CachePage() {
  const [stats, setStats] = useState(null);
  const [entries, setEntries] = useState([]);
  const [hits, setHits] = useState([]);
  const [entriesTotal, setEntriesTotal] = useState(0);
  const [hitsTotal, setHitsTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('entries');
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, e, h] = await Promise.all([
        fetchCacheStats(),
        fetchCacheEntries(200),
        fetchCacheHits(200),
      ]);
      setStats(s);
      setEntries(e.entries || []);
      setHits(h.hits || []);
      setEntriesTotal(Number(e.total ?? e.entries?.length ?? 0));
      setHitsTotal(Number(h.total ?? h.hits?.length ?? 0));
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function remove(table, id, message) {
    const ok = await confirm(message, {
      title: 'Delete?',
      confirmLabel: 'Yes, delete',
    });
    if (!ok) {
      return;
    }
    setError('');
    try {
      if (id == null) {
        await clearTable(table);
      } else {
        await deleteRecord(table, id);
      }
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
      </div>
      {error ? <p className="error">{error}</p> : null}

      <div className="stats" style={{ marginBottom: '1.25rem' }}>
        <div className="stat">
          <div className="label">Stored entries</div>
          <div className="value">{stats?.entries ?? entries.length}</div>
        </div>
        <div className="stat">
          <div className="label">Recorded hits</div>
          <div className="value">{hits.length}</div>
        </div>
        <div className="stat">
          <div className="label">Hit rate (all)</div>
          <div className="value">
            {stats
              ? `${(Number(stats.lifetime_hit_rate || 0) * 100).toFixed(1)}%`
              : '—'}
          </div>
        </div>
      </div>

      <section>
        <div className="section-head">
          <div className="metric-toggle" role="group" aria-label="Cache table">
            <button
              type="button"
              className={view === 'entries' ? 'active' : ''}
              onClick={() => setView('entries')}
            >
              Stored entries
            </button>
            <button
              type="button"
              className={view === 'hits' ? 'active' : ''}
              onClick={() => setView('hits')}
            >
              Cache hits
            </button>
          </div>
          <div className="section-head-actions">
            {view === 'entries' ? (
              <>
                <span className="hint">
                  Showing {entries.length} of {entriesTotal} entries
                </span>
                <button
                  type="button"
                  className="danger"
                  disabled={!entries.length}
                  onClick={() =>
                    remove(
                      'cache_entries',
                      null,
                      'Delete every stored cache entry and its hits? This cannot be undone.',
                    )
                  }
                >
                  Delete all entries
                </button>
              </>
            ) : (
              <>
                <span className="hint">
                  Showing {hits.length} of {hitsTotal} hits
                </span>
                <button
                  type="button"
                  className="danger"
                  disabled={!hits.length}
                  onClick={() =>
                    remove(
                      'cache_hits',
                      null,
                      'Delete every recorded cache hit? This cannot be undone.',
                    )
                  }
                >
                  Delete all hits
                </button>
              </>
            )}
          </div>
        </div>

        {view === 'entries' ? (
          entries.length === 0 ? (
            <p className="hint">No stored cache entries yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Id</th>
                    <th>When</th>
                    <th>Key</th>
                    <th>Model</th>
                    <th>Hits</th>
                    <th>Vector</th>
                    <th>Prompt</th>
                    <th>Saved reply</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((row) => (
                    <tr key={row.id}>
                      <td className="mono">{row.id}</td>
                      <td className="mono">{when(row.created_at)}</td>
                      <td>
                        <SecretKey value={row.virtual_key} />
                      </td>
                      <td className="mono">{row.model}</td>
                      <td className="mono">{row.hit_count}</td>
                      <td className="mono">
                        {row.embedding_dims ? `${row.embedding_dims} dims` : '—'}
                      </td>
                      <td>
                        {row.prompt_text ||
                          (row.prompt_hash
                            ? `hash ${String(row.prompt_hash).slice(0, 12)}…`
                            : '—')}
                      </td>
                      <td>{row.reply_preview || '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() =>
                            remove(
                              'cache_entries',
                              row.id,
                              `Delete stored cache entry #${row.id}?`,
                            )
                          }
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : hits.length === 0 ? (
          <p className="hint">No cache hits recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Entry</th>
                  <th>Key</th>
                  <th>Model</th>
                  <th>Score</th>
                  <th>Prompt</th>
                  <th>Request</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {hits.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{when(row.created_at)}</td>
                    <td className="mono">{row.cache_entry_id}</td>
                    <td>
                      <SecretKey value={row.virtual_key} />
                    </td>
                    <td className="mono">{row.model}</td>
                    <td className="mono">{score(row.score)}</td>
                    <td>{row.prompt_text || '—'}</td>
                    <td className="mono">{row.request_id}</td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          remove(
                            'cache_hits',
                            row.id,
                            `Delete cache hit #${row.id}?`,
                          )
                        }
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
