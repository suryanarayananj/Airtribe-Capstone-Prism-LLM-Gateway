import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  fetchCacheStats,
  fetchObservability,
  fetchProviderHealth,
  fetchUsage,
} from './api.js';

function formatMs(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return '—';
  }
  return `${Math.round(Number(value))} ms`;
}

function formatPct(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return '—';
  }
  return `${(Number(value) * 100).toFixed(1)}%`;
}

const tooltipStyle = {
  background: '#ffffff',
  border: '1px solid #E8EDEB',
  borderRadius: 8,
  color: '#001E2B',
};

function MetricToggle({ value, onChange }) {
  return (
    <div className="metric-toggle" role="group" aria-label="Chart metric">
      <button
        type="button"
        className={value === 'tokens' ? 'active' : ''}
        onClick={() => onChange('tokens')}
      >
        Tokens
      </button>
      <button
        type="button"
        className={value === 'cost' ? 'active' : ''}
        onClick={() => onChange('cost')}
      >
        Cost
      </button>
    </div>
  );
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function AdminPage() {
  const initialMonth = currentYearMonth();
  const initialBounds = monthBounds(initialMonth);
  const [usage, setUsage] = useState(null);
  const [chartUsage, setChartUsage] = useState(null);
  const [cache, setCache] = useState(null);
  const [health, setHealth] = useState([]);
  const [observability, setObservability] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [dailyMetric, setDailyMetric] = useState('tokens');
  const [modelMetric, setModelMetric] = useState('tokens');
  const [chartMonth, setChartMonth] = useState(initialMonth);
  const [chartFrom, setChartFrom] = useState(initialBounds.from);
  const [chartTo, setChartTo] = useState(
    todayIso() < initialBounds.to ? todayIso() : initialBounds.to,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, charts, c, h, o] = await Promise.all([
        fetchUsage(),
        fetchUsage({ from: chartFrom, to: chartTo }),
        fetchCacheStats(),
        fetchProviderHealth(),
        fetchObservability(),
      ]);
      setUsage(u);
      setChartUsage(charts);
      setCache(c);
      setHealth(h.providers || []);
      setObservability(o);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [chartFrom, chartTo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const chartMonths = useMemo(() => {
    const set = new Set([currentYearMonth()]);
    for (const row of usage?.monthly || []) {
      if (row.month) {
        set.add(row.month);
      }
    }
    for (const row of usage?.daily || []) {
      if (row.day) {
        set.add(String(row.day).slice(0, 7));
      }
    }
    return [...set].sort().reverse();
  }, [usage]);

  function applyMonth(month) {
    const bounds = monthBounds(month);
    const end = todayIso() < bounds.to && month === currentYearMonth()
      ? todayIso()
      : bounds.to;
    setChartMonth(month);
    setChartFrom(bounds.from);
    setChartTo(end);
  }

  const routingChart = useMemo(() => {
    const buckets = observability?.routing?.buckets || {};
    return [
      { name: 'auto→fast', requests: buckets.auto_fast || 0 },
      { name: 'auto→smart', requests: buckets.auto_smart || 0 },
      { name: 'escalated', requests: buckets.escalated || 0 },
      { name: 'guardrail', requests: buckets.guardrail_flag || 0 },
      { name: 'other', requests: buckets.other || 0 },
      { name: 'none', requests: buckets.none || 0 },
    ];
  }, [observability]);

  const providerChart = useMemo(
    () =>
      (observability?.by_provider || []).map((row) => ({
        provider: row.provider,
        ok: row.ok,
        errors: row.errors,
        avg_ms: row.avg_latency_ms == null ? 0 : Math.round(row.avg_latency_ms),
      })),
    [observability],
  );

  return (
    <>
      <div className="toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}

      <div className="stats" style={{ marginBottom: '1.25rem' }}>
        <div className="stat">
          <div className="label">Requests</div>
          <div className="value">{usage?.requests ?? '—'}</div>
        </div>
        <div className="stat">
          <div className="label">Cost this month (USD)</div>
          <div className="value mono">
            {usage
              ? Number(usage.this_month_cost_usd ?? 0).toFixed(6)
              : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Tokens this month</div>
          <div className="value mono">
            {usage ? Number(usage.this_month_tokens ?? 0) : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Cache hit rate (all)</div>
          <div className="value">
            {cache
              ? `${(Number(cache.lifetime_hit_rate || 0) * 100).toFixed(1)}%`
              : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="label">Latency p95</div>
          <div className="value mono">
            {formatMs(observability?.latency?.p95_ms)}
          </div>
        </div>
      </div>

      <div className="chart-range" style={{ marginBottom: '0.85rem' }}>
        <label className="month-picker">
          <span className="hint">Month</span>
          <select
            value={chartMonth}
            onChange={(event) => applyMonth(event.target.value)}
          >
            {chartMonths.map((month) => (
              <option key={month} value={month}>
                {month}
              </option>
            ))}
          </select>
        </label>
        <label className="month-picker">
          <span className="hint">From</span>
          <input
            type="date"
            value={chartFrom}
            onChange={(event) => setChartFrom(event.target.value)}
          />
        </label>
        <label className="month-picker">
          <span className="hint">To</span>
          <input
            type="date"
            value={chartTo}
            onChange={(event) => setChartTo(event.target.value)}
          />
        </label>
      </div>

      <div className="grid two">
        <section>
          <div className="section-head">
            <h2>{dailyMetric === 'tokens' ? 'Daily tokens' : 'Daily cost'}</h2>
            <MetricToggle value={dailyMetric} onChange={setDailyMetric} />
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartUsage?.daily || []}>
                <CartesianGrid stroke="#E8EDEB" vertical={false} />
                <XAxis
                  dataKey="day"
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <YAxis
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar
                  dataKey={dailyMetric === 'tokens' ? 'tokens' : 'cost_usd'}
                  fill="#00684A"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <div className="section-head">
            <h2>
              {modelMetric === 'tokens' ? 'Tokens by model' : 'Cost by model'}
            </h2>
            <MetricToggle value={modelMetric} onChange={setModelMetric} />
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartUsage?.by_model || []}>
                <CartesianGrid stroke="#E8EDEB" vertical={false} />
                <XAxis
                  dataKey="model"
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <YAxis
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar
                  dataKey={modelMetric === 'tokens' ? 'tokens' : 'cost_usd'}
                  fill="#1A73A7"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="grid two" style={{ marginTop: '1.25rem' }}>
        <section>
          <h2>Provider health</h2>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Error rate</th>
              </tr>
            </thead>
            <tbody>
              {health.length === 0 ? (
                <tr>
                  <td colSpan={3}>No health samples yet</td>
                </tr>
              ) : (
                health.map((row) => (
                  <tr key={row.name}>
                    <td className="mono">{row.name}</td>
                    <td>
                      <span
                        className={`badge ${row.degraded ? 'bad' : 'ok'}`}
                      >
                        {row.degraded ? 'degraded' : 'healthy'}
                      </span>
                    </td>
                    <td className="mono">{formatPct(row.error_rate)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h2>Gateway latency</h2>
          <div className="stats" style={{ marginBottom: '0.85rem' }}>
            <div className="stat">
              <div className="label">p50</div>
              <div className="value mono">
                {formatMs(observability?.latency?.p50_ms)}
              </div>
            </div>
            <div className="stat">
              <div className="label">p95</div>
              <div className="value mono">
                {formatMs(observability?.latency?.p95_ms)}
              </div>
            </div>
            <div className="stat">
              <div className="label">p99</div>
              <div className="value mono">
                {formatMs(observability?.latency?.p99_ms)}
              </div>
            </div>
            <div className="stat">
              <div className="label">Avg</div>
              <div className="value mono">
                {formatMs(observability?.latency?.avg_ms)}
              </div>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={providerChart}>
                <CartesianGrid stroke="#E8EDEB" vertical={false} />
                <XAxis
                  dataKey="provider"
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <YAxis
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Bar dataKey="ok" stackId="a" fill="#00684A" />
                <Bar
                  dataKey="errors"
                  stackId="a"
                  fill="#B00020"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="grid two" style={{ marginTop: '1.25rem' }}>
        <section>
          <h2>Routing decisions</h2>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={routingChart}>
                <CartesianGrid stroke="#E8EDEB" vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <YAxis
                  stroke="#5C6C75"
                  tick={{ fontSize: 11, fill: '#5C6C75' }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar
                  dataKey="requests"
                  fill="#B86E00"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <h2>By team</h2>
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>Requests</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(usage?.by_team || []).map((row) => (
                <tr key={row.team}>
                  <td>{row.team}</td>
                  <td className="mono">{row.requests}</td>
                  <td className="mono">{row.tokens}</td>
                  <td className="mono">{Number(row.cost_usd).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

    </>
  );
}
