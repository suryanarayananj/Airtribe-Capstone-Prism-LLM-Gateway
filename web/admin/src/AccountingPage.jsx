import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchUsage } from './api.js';

const tooltipStyle = {
  background: '#ffffff',
  border: '1px solid #E8EDEB',
  borderRadius: 8,
  color: '#001E2B',
};

function money(value) {
  return Number(value || 0).toFixed(6);
}

function currentYearMonth() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}`;
}

export function AccountingPage() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(currentYearMonth);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setUsage(await fetchUsage());
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const months = useMemo(() => {
    const set = new Set();
    for (const row of usage?.monthly || []) {
      if (row.month) {
        set.add(row.month);
      }
    }
    for (const row of usage?.by_provider || []) {
      if (row.month) {
        set.add(row.month);
      }
    }
    const list = [...set].sort().reverse();
    const current = currentYearMonth();
    if (!list.includes(current)) {
      list.unshift(current);
    }
    return list;
  }, [usage]);

  useEffect(() => {
    if (!months.length) {
      return;
    }
    if (!months.includes(selectedMonth)) {
      setSelectedMonth(months[0]);
    }
  }, [months, selectedMonth]);

  const providers = useMemo(
    () =>
      (usage?.by_provider || []).filter((row) => row.month === selectedMonth),
    [usage, selectedMonth],
  );

  const thisMonthProviders = useMemo(
    () =>
      (usage?.by_provider || []).filter(
        (row) => row.month === currentYearMonth(),
      ),
    [usage],
  );

  const thisMonth = usage?.this_month_cost_usd;

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
          <div className="label">Cost this month (USD)</div>
          <div className="value mono">{usage ? money(thisMonth) : '—'}</div>
        </div>
      </div>

      <div className="grid two" style={{ marginBottom: '1.25rem' }}>
        <section>
          <div className="section-head">
            <h2>Cost by provider</h2>
            <label className="month-picker">
              <span className="hint">Month</span>
              <select
                value={selectedMonth}
                onChange={(event) => setSelectedMonth(event.target.value)}
              >
                {months.map((month) => (
                  <option key={month} value={month}>
                    {month}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Requests</th>
                <th>Tokens</th>
                <th>Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 ? (
                <tr>
                  <td colSpan={4}>No billed traffic for this month</td>
                </tr>
              ) : (
                providers.map((row) => (
                  <tr key={`${row.month}-${row.provider}`}>
                    <td className="mono">{row.provider}</td>
                    <td className="mono">{row.requests}</td>
                    <td className="mono">{row.tokens}</td>
                    <td className="mono">{money(row.cost_usd)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section>
          <h2>Provider cost</h2>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={thisMonthProviders}>
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
                <Bar dataKey="cost_usd" fill="#00684A" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </>
  );
}
