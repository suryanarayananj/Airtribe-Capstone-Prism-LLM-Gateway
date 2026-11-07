import { useState } from 'react';
import { AdminPage } from './AdminPage.jsx';
import { PlanPage, TeamPage, UserPage } from './AccessPage.jsx';
import { CachePage } from './CachePage.jsx';
import { AccountingPage } from './AccountingPage.jsx';
import { ProvidersPage } from './ProvidersPage.jsx';
import { RequestsPage } from './RequestsPage.jsx';
import { VirtualKeysPage } from './VirtualKeysPage.jsx';

const NAV = [
  { id: 'overview', label: 'Overview', group: null },
  { id: 'requests', label: 'Requests', group: null },
  { id: 'cache', label: 'Cache', group: null },
  { id: 'providers', label: 'Providers', group: null },
  { id: 'accounting', label: 'Accounting', group: null },
  { id: 'team', label: 'Team', group: 'Access' },
  { id: 'user', label: 'User', group: 'Access' },
  { id: 'plan', label: 'Plan', group: 'Access' },
  { id: 'keys', label: 'Virtual Keys', group: 'Access' },
];

const TITLES = {
  overview: ['Overview', 'Usage, spend, and live gateway health'],
  requests: ['Requests', 'Every request the gateway logged'],
  cache: ['Cache', 'Stored replies and each time one was served again'],
  providers: [
    'Providers',
    'Alias → provider map for online OpenRouter and offline mocks',
  ],
  accounting: [
    'Accounting',
    'This month’s spend, cost by provider by month, and this month’s provider cost',
  ],
  team: ['Team', 'A team uses one plan. Each member still has a separate meter.'],
  user: ['User', 'Chat sign-in. Creating a user copies that team’s plan onto their own key.'],
  plan: ['Plan', 'Shared rules for budget, rate limit, models, and cache.'],
  keys: [
    'Virtual Keys',
    'List and lifecycle (disable / enable / rotate). Create keys via User.',
  ],
};

export function App() {
  const [tab, setTab] = useState('overview');
  const [title, subtitle] = TITLES[tab];
  const ungrouped = NAV.filter((item) => !item.group);
  const groups = [...new Set(NAV.filter((item) => item.group).map((item) => item.group))];

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img
            className="brand-mark"
            src="/brand/logo.png?v=4"
            alt=""
            width="28"
            height="28"
          />
          <span className="brand-text">
            <span className="brand-name">Prism</span>
            <span className="brand-tag">Admin</span>
          </span>
        </div>
        <div className="side-scroll">
          <nav className="side-nav" aria-label="Main">
            {ungrouped.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? 'nav-item active' : 'nav-item'}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {groups.map((group) => (
            <div key={group}>
              <div className="nav-label">{group}</div>
              <nav className="side-nav" aria-label={group}>
                {NAV.filter((item) => item.group === group).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      tab === item.id ? 'nav-item nested active' : 'nav-item nested'
                    }
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
          ))}
        </div>
        <div className="side-footer">
          <div className="account-row">
            <div className="account" title="Admin" aria-hidden="true">
              A
            </div>
            <div className="account-meta">
              <strong>Admin</strong>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <main className="content">
          <h1>{title}</h1>
          <p className="sub">{subtitle}</p>
          {tab === 'requests' ? (
            <RequestsPage />
          ) : tab === 'cache' ? (
            <CachePage />
          ) : tab === 'providers' ? (
            <ProvidersPage />
          ) : tab === 'accounting' ? (
            <AccountingPage />
          ) : tab === 'team' ? (
            <TeamPage />
          ) : tab === 'user' ? (
            <UserPage />
          ) : tab === 'plan' ? (
            <PlanPage />
          ) : tab === 'keys' ? (
            <VirtualKeysPage />
          ) : (
            <AdminPage />
          )}
        </main>
      </div>
    </div>
  );
}
