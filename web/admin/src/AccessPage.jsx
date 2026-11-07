import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPlan,
  createTeam,
  createUser,
  deleteRecord,
  disableKey,
  enableKey,
  fetchModels,
  fetchPlans,
  fetchTeams,
  fetchUsers,
  rotateKey,
  updatePlan,
  updateTeam,
  updateUser,
} from './api.js';
import { useConfirm } from './ConfirmDialog.jsx';
import { SecretKey } from './SecretKey.jsx';

const SEED_KEYS = new Set([
  'prism-sk-search-1a2b3c',
  'prism-sk-research-4d5e6f',
  'prism-sk-free-7g8h9i',
  'prism-sk-budget-demo-0j1k2l',
]);

const ACCESS_MODE_LABELS = {
  api: 'API only',
  chat: 'Chat only',
  both: 'Both',
};

const GUARDRAIL_MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'flag', label: 'Flag (log only)' },
  { value: 'block', label: 'Block' },
  { value: 'redact', label: 'Redact' },
];

const emptyPlan = {
  name: '',
  monthly_budget_usd: '50',
  rpm_limit: '60',
  tpm_limit: '100000',
  token_cap: '',
  cache_enabled: false,
  cache_similarity: '0.92',
  guardrail_injection: 'block',
  guardrail_pii: 'flag',
  model_allowlist: ['fast'],
  verification_enabled: false,
  verify_models: [],
};

const emptyTeam = { name: '', plan_id: '' };
const emptyUser = {
  name: '',
  username: '',
  password: '',
  team: '',
  access_mode: 'both',
};

/** Checker models are every allowed model except `auto` (a router, not a checker). */
function checkerModels(allowlist) {
  return (allowlist || []).filter((model) => model !== 'auto');
}

function planPayload(form) {
  const verificationEnabled = Boolean(form.verification_enabled);
  return {
    name: form.name,
    monthly_budget_usd: Number(form.monthly_budget_usd),
    rpm_limit: Number(form.rpm_limit),
    tpm_limit: form.tpm_limit === '' ? null : Number(form.tpm_limit),
    token_cap: form.token_cap === '' ? null : Number(form.token_cap),
    cache_enabled: Boolean(form.cache_enabled),
    cache_similarity: Number(form.cache_similarity),
    guardrail_injection: form.guardrail_injection,
    guardrail_pii: form.guardrail_pii,
    model_allowlist: form.model_allowlist,
    verify_models: verificationEnabled ? form.verify_models || [] : [],
  };
}

function planFromRecord(plan) {
  return {
    name: plan.name,
    monthly_budget_usd: String(plan.monthly_budget_usd),
    rpm_limit: String(plan.rpm_limit),
    tpm_limit: plan.tpm_limit == null ? '' : String(plan.tpm_limit),
    token_cap: plan.token_cap == null ? '' : String(plan.token_cap),
    cache_enabled: Boolean(plan.cache_enabled),
    cache_similarity: String(plan.cache_similarity ?? 0.92),
    guardrail_injection: plan.guardrail_injection || 'block',
    guardrail_pii: plan.guardrail_pii || 'flag',
    model_allowlist: [...(plan.model_allowlist || [])],
    verify_models: [...(plan.verify_models || [])].filter((model) =>
      (plan.model_allowlist || []).includes(model),
    ),
    verification_enabled: (plan.verify_models || []).length > 0,
  };
}

function Notices({ error, notice }) {
  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}
    </>
  );
}

function DetailField({ label, children }) {
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <div className="detail-value">{children}</div>
    </div>
  );
}

function ModelMenu({ models, selected, onToggle }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const summary =
    selected.length === 0
      ? 'Select models'
      : selected.length <= 2
        ? selected.join(', ')
        : `${selected.length} selected`;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="model-menu" ref={rootRef}>
      <button
        type="button"
        className={open ? 'model-menu-trigger open' : 'model-menu-trigger'}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-menu-summary">{summary}</span>
        <span className="model-menu-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="model-menu-panel" role="listbox" aria-multiselectable="true">
          {models.map((model) => {
            const checked = selected.includes(model);
            return (
              <label
                key={model}
                className={checked ? 'model-menu-option checked' : 'model-menu-option'}
              >
                <span className="model-picker-name">{model}</span>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(model)}
                />
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function PlanPage() {
  const [plans, setPlans] = useState([]);
  const [models, setModels] = useState([]);
  const [view, setView] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyPlan);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    const [planData, modelData] = await Promise.all([fetchPlans(), fetchModels()]);
    setPlans(planData.plans || []);
    setModels(modelData.models || []);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(err.message || String(err)));
  }, [refresh]);

  const selected = plans.find((plan) => plan.id === selectedId) || null;

  async function run(action, okMessage) {
    setError('');
    setNotice('');
    try {
      const result = await action();
      await refresh();
      if (okMessage) {
        setNotice(okMessage);
      }
      return result;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    }
  }

  function openList() {
    setView('list');
    setSelectedId(null);
    setForm(emptyPlan);
    setError('');
  }

  function openDetail(plan) {
    setSelectedId(plan.id);
    setView('detail');
    setError('');
    setNotice('');
  }

  function openCreate() {
    setSelectedId(null);
    setForm(emptyPlan);
    setView('create');
    setError('');
    setNotice('');
  }

  function openEdit() {
    if (!selected) {
      return;
    }
    setForm(planFromRecord(selected));
    setView('edit');
    setError('');
    setNotice('');
  }

  function toggleModel(model) {
    setForm((prev) => {
      const has = prev.model_allowlist.includes(model);
      const model_allowlist = has
        ? prev.model_allowlist.filter((item) => item !== model)
        : [...prev.model_allowlist, model];
      return {
        ...prev,
        model_allowlist,
        verify_models: prev.verification_enabled
          ? checkerModels(model_allowlist)
          : [],
      };
    });
  }

  if (view === 'list') {
    return (
      <>
        {confirmDialog}
        <Notices error={error} notice={notice} />
        <div className="list-toolbar">
          <button type="button" onClick={openCreate}>
            Create new
          </button>
        </div>
        <section>
          <div className="table-wrap">
            <table className="clickable-table">
              <thead>
                <tr>
                  <th className="row-num">#</th>
                  <th>Name</th>
                  <th>Budget</th>
                  <th>RPM</th>
                  <th>Models</th>
                  <th>Cache</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan, index) => (
                  <tr key={plan.id} onClick={() => openDetail(plan)}>
                    <td className="row-num mono">{index + 1}</td>
                    <td>{plan.name}</td>
                    <td className="mono">${plan.monthly_budget_usd}</td>
                    <td className="mono">{plan.rpm_limit}</td>
                    <td className="mono">
                      {(plan.model_allowlist || []).join(', ')}
                    </td>
                    <td>{plan.cache_enabled ? 'on' : 'off'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="list-count">
            {plans.length} plan{plans.length === 1 ? '' : 's'}
          </p>
        </section>
      </>
    );
  }

  if (view === 'detail' && selected) {
    return (
      <>
        {confirmDialog}
        <Notices error={error} notice={notice} />
        <div className="list-toolbar">
          <button type="button" className="ghost" onClick={openList}>
            Back to plans
          </button>
          <div className="form-actions">
            <button type="button" onClick={openEdit}>
              Edit
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                const ok = await confirm(
                  `Delete plan “${selected.name}”? Teams using it must be reassigned first.`,
                  { title: 'Delete plan?', confirmLabel: 'Yes, delete' },
                );
                if (!ok) {
                  return;
                }
                await run(async () => {
                  await deleteRecord('plans', selected.id);
                  openList();
                }, 'Plan deleted');
              }}
            >
              Delete
            </button>
          </div>
        </div>
        <section>
          <h2>{selected.name}</h2>
          <div className="detail-grid">
            <DetailField label="Monthly budget">
              ${selected.monthly_budget_usd}
            </DetailField>
            <DetailField label="Requests / minute">{selected.rpm_limit}</DetailField>
            <DetailField label="Tokens / minute">
              {selected.tpm_limit ?? '—'}
            </DetailField>
            <DetailField label="Token cap">
              {selected.token_cap ?? '—'}
            </DetailField>
            <DetailField label="Models">
              <span className="mono">
                {(selected.model_allowlist || []).join(', ') || '—'}
              </span>
            </DetailField>
            <DetailField label="Verification">
              {(selected.verify_models || []).length
                ? 'on — any other allowed model'
                : 'off'}
            </DetailField>
            <DetailField label="Semantic cache">
              {selected.cache_enabled ? 'on' : 'off'}
            </DetailField>
            <DetailField label="Cache similarity">
              {selected.cache_similarity ?? '—'}
            </DetailField>
            <DetailField label="Injection policy">
              {selected.guardrail_injection || 'block'}
            </DetailField>
            <DetailField label="PII policy">
              {selected.guardrail_pii || 'flag'}
            </DetailField>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {confirmDialog}
      <Notices error={error} notice={notice} />
      <div className="list-toolbar">
        <button
          type="button"
          className="ghost"
          onClick={() => (view === 'edit' && selected ? setView('detail') : openList())}
        >
          {view === 'edit' ? 'Back to details' : 'Back to plans'}
        </button>
      </div>
      <section>
        <h2>{view === 'edit' ? selected?.name || 'Plan' : 'Create plan'}</h2>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const payload = planPayload(form);
            run(async () => {
              if (view === 'edit' && selectedId) {
                await updatePlan(selectedId, payload);
                setView('detail');
              } else {
                const created = await createPlan(payload);
                setSelectedId(created.id);
                setView('detail');
              }
            }, view === 'edit' ? `Plan “${payload.name}” updated` : `Plan “${payload.name}” created`);
          }}
        >
          <label>
            Plan name
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </label>
          <label>
            Monthly budget USD
            <input
              type="number"
              min="0"
              step="any"
              value={form.monthly_budget_usd}
              onChange={(event) =>
                setForm({ ...form, monthly_budget_usd: event.target.value })
              }
              required
            />
          </label>
          <label>
            Requests / minute
            <input
              type="number"
              min="1"
              step="1"
              value={form.rpm_limit}
              onChange={(event) =>
                setForm({ ...form, rpm_limit: event.target.value })
              }
              required
            />
          </label>
          <label>
            Tokens / minute
            <input
              type="number"
              min="1"
              step="1"
              value={form.tpm_limit}
              onChange={(event) =>
                setForm({ ...form, tpm_limit: event.target.value })
              }
            />
          </label>
          <label>
            Token cap
            <input
              type="number"
              min="1"
              step="1"
              value={form.token_cap}
              placeholder="optional"
              onChange={(event) =>
                setForm({ ...form, token_cap: event.target.value })
              }
            />
          </label>
          <label className="model-menu-field">
            Models
            <ModelMenu
              models={models}
              selected={form.model_allowlist}
              onToggle={toggleModel}
            />
          </label>
          <label className="inline">
            Verification
            <input
              type="checkbox"
              checked={Boolean(form.verification_enabled)}
              onChange={(event) => {
                const enabled = event.target.checked;
                setForm({
                  ...form,
                  verification_enabled: enabled,
                  verify_models: enabled
                    ? checkerModels(form.model_allowlist)
                    : [],
                });
              }}
            />
          </label>
          {form.verification_enabled ? (
            <p className="hint">
              Chat can check an answer with any other allowed model. `auto` is
              not used as a checker.
            </p>
          ) : null}
          <label className="inline">
            Semantic cache on
            <input
              type="checkbox"
              checked={form.cache_enabled}
              onChange={(event) =>
                setForm({ ...form, cache_enabled: event.target.checked })
              }
            />
          </label>
          <label>
            Cache similarity
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={form.cache_similarity}
              onChange={(event) =>
                setForm({ ...form, cache_similarity: event.target.value })
              }
            />
          </label>
          <label>
            Injection policy
            <select
              value={form.guardrail_injection}
              onChange={(event) =>
                setForm({ ...form, guardrail_injection: event.target.value })
              }
            >
              {GUARDRAIL_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            PII policy
            <select
              value={form.guardrail_pii}
              onChange={(event) =>
                setForm({ ...form, guardrail_pii: event.target.value })
              }
            >
              {GUARDRAIL_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit">Save</button>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                view === 'edit' && selected ? setView('detail') : openList()
              }
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

export function TeamPage() {
  const [plans, setPlans] = useState([]);
  const [teams, setTeams] = useState([]);
  const [view, setView] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyTeam);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    const [planData, teamData] = await Promise.all([fetchPlans(), fetchTeams()]);
    setPlans(planData.plans || []);
    setTeams(teamData.teams || []);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(err.message || String(err)));
  }, [refresh]);

  const selected = teams.find((team) => team.id === selectedId) || null;

  async function run(action, okMessage) {
    setError('');
    setNotice('');
    try {
      const result = await action();
      await refresh();
      if (okMessage) {
        setNotice(okMessage);
      }
      return result;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    }
  }

  function openList() {
    setView('list');
    setSelectedId(null);
    setForm(emptyTeam);
    setError('');
  }

  function openDetail(team) {
    setSelectedId(team.id);
    setView('detail');
    setError('');
    setNotice('');
  }

  function openCreate() {
    setSelectedId(null);
    setForm(emptyTeam);
    setView('create');
    setError('');
    setNotice('');
  }

  function openEdit() {
    if (!selected) {
      return;
    }
    setForm({
      name: selected.name,
      plan_id: selected.plan_id ? String(selected.plan_id) : '',
    });
    setView('edit');
    setError('');
    setNotice('');
  }

  if (view === 'list') {
    return (
      <>
        {confirmDialog}
        <Notices error={error} notice={notice} />
        <div className="list-toolbar">
          <button type="button" onClick={openCreate}>
            Create new
          </button>
        </div>
        <section>
          <div className="table-wrap">
            <table className="clickable-table">
              <thead>
                <tr>
                  <th className="row-num">#</th>
                  <th>Team</th>
                  <th>Plan</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((team, index) => (
                  <tr key={team.id} onClick={() => openDetail(team)}>
                    <td className="row-num mono">{index + 1}</td>
                    <td>{team.name}</td>
                    <td>{team.plan_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="list-count">
            {teams.length} team{teams.length === 1 ? '' : 's'}
          </p>
        </section>
      </>
    );
  }

  if (view === 'detail' && selected) {
    return (
      <>
        {confirmDialog}
        <Notices error={error} notice={notice} />
        <div className="list-toolbar">
          <button type="button" className="ghost" onClick={openList}>
            Back to teams
          </button>
          <div className="form-actions">
            <button type="button" onClick={openEdit}>
              Edit
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                const ok = await confirm(
                  `Delete team “${selected.name}”? Users on this team must be moved first.`,
                  { title: 'Delete team?', confirmLabel: 'Yes, delete' },
                );
                if (!ok) {
                  return;
                }
                await run(async () => {
                  await deleteRecord('teams', selected.id);
                  openList();
                }, 'Team deleted');
              }}
            >
              Delete
            </button>
          </div>
        </div>
        <section>
          <h2>{selected.name}</h2>
          <div className="detail-grid">
            <DetailField label="Team name">{selected.name}</DetailField>
            <DetailField label="Plan">{selected.plan_name || '—'}</DetailField>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {confirmDialog}
      <Notices error={error} notice={notice} />
      <div className="list-toolbar">
        <button
          type="button"
          className="ghost"
          onClick={() => (view === 'edit' && selected ? setView('detail') : openList())}
        >
          {view === 'edit' ? 'Back to details' : 'Back to teams'}
        </button>
      </div>
      <section>
        <h2>{view === 'edit' ? selected?.name || 'Team' : 'Create team'}</h2>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const payload = {
              name: form.name,
              plan_id: Number(form.plan_id),
            };
            run(async () => {
              if (view === 'edit' && selectedId) {
                await updateTeam(selectedId, payload);
                setView('detail');
              } else {
                const created = await createTeam(payload);
                setSelectedId(created.id);
                setView('detail');
              }
            }, view === 'edit'
              ? `Team “${payload.name}” updated`
              : `Team “${payload.name}” created`);
          }}
        >
          <label>
            Team name
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </label>
          <label>
            Plan
            <select
              value={form.plan_id}
              onChange={(event) =>
                setForm({ ...form, plan_id: event.target.value })
              }
              required
            >
              <option value="">Choose a plan</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit">Save</button>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                view === 'edit' && selected ? setView('detail') : openList()
              }
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

export function UserPage() {
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [view, setView] = useState('list');
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(emptyUser);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, confirmDialog] = useConfirm();

  const refresh = useCallback(async () => {
    const [teamData, userData] = await Promise.all([fetchTeams(), fetchUsers()]);
    setTeams(teamData.teams || []);
    setUsers(userData.users || []);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(err.message || String(err)));
  }, [refresh]);

  const selected = users.find((user) => user.id === selectedId) || null;

  async function run(action, okMessage) {
    setError('');
    setNotice('');
    try {
      const result = await action();
      await refresh();
      if (okMessage) {
        setNotice(okMessage);
      }
      return result;
    } catch (err) {
      setError(err.message || String(err));
      return null;
    }
  }

  function openList() {
    setView('list');
    setSelectedId(null);
    setForm(emptyUser);
    setError('');
  }

  function openDetail(user) {
    setSelectedId(user.id);
    setView('detail');
    setError('');
    setNotice('');
  }

  function openCreate() {
    setSelectedId(null);
    setForm(emptyUser);
    setView('create');
    setError('');
    setNotice('');
  }

  function openEdit() {
    if (!selected) {
      return;
    }
    setForm({
      name: selected.name || '',
      username: selected.username || '',
      password: '',
      team: selected.team || '',
      access_mode: selected.access_mode || 'both',
    });
    setView('edit');
    setError('');
    setNotice('');
  }

  async function runKeyAction(action, confirmText, okMessage) {
    if (!selected?.key_id) {
      setError('This user has no virtual key');
      return;
    }
    if (SEED_KEYS.has(selected.virtual_key)) {
      setError('Pack seed keys cannot be disabled or rotated');
      return;
    }
    if (confirmText) {
      const ok = await confirm(confirmText, {
        title: 'Please confirm',
        confirmLabel: 'Yes',
      });
      if (!ok) {
        return;
      }
    }
    await run(async () => {
      const result = await action(selected.key_id);
      if (result?.key?.rotated) {
        setNotice(
          `Rotated. New secret: ${result.key.virtual_key}. Old secret no longer works.`,
        );
        return;
      }
      if (okMessage) {
        setNotice(okMessage);
      }
    });
  }

  if (view === 'list') {
    return (
      <>
        {confirmDialog}
        <Notices error={error} notice={notice} />
        <div className="list-toolbar">
          <button type="button" onClick={openCreate}>
            Create new
          </button>
        </div>
        <section>
          <div className="table-wrap">
            <table className="clickable-table">
              <thead>
                <tr>
                  <th className="row-num">#</th>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Access</th>
                  <th>Team</th>
                  <th>Plan</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user, index) => (
                  <tr key={user.id} onClick={() => openDetail(user)}>
                    <td className="row-num mono">{index + 1}</td>
                    <td>{user.name}</td>
                    <td className="mono">{user.username || '—'}</td>
                    <td>
                      {ACCESS_MODE_LABELS[user.access_mode] ||
                        user.access_mode ||
                        'Both'}
                    </td>
                    <td>{user.team}</td>
                    <td>{user.plan_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="list-count">
            {users.length} user{users.length === 1 ? '' : 's'}
          </p>
        </section>
      </>
    );
  }

  if (view === 'detail' && selected) {
    const seed = SEED_KEYS.has(selected.virtual_key);
    return (
      <>
        {confirmDialog}
        <Notices error={error} notice={notice} />
        <div className="list-toolbar">
          <button type="button" className="ghost" onClick={openList}>
            Back to users
          </button>
          <div className="form-actions">
            <button type="button" onClick={openEdit}>
              Edit
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                const ok = await confirm(
                  `Delete user “${selected.name}”? Their virtual key will be removed too.`,
                  { title: 'Delete user?', confirmLabel: 'Yes, delete' },
                );
                if (!ok) {
                  return;
                }
                await run(async () => {
                  await deleteRecord('users', selected.id);
                  openList();
                }, 'User deleted');
              }}
            >
              Delete
            </button>
          </div>
        </div>
        <section>
          <h2>{selected.name}</h2>
          <div className="detail-grid">
            <DetailField label="Display name">{selected.name}</DetailField>
            <DetailField label="Username">
              <span className="mono">{selected.username || '—'}</span>
            </DetailField>
            <DetailField label="Access">
              {ACCESS_MODE_LABELS[selected.access_mode] ||
                selected.access_mode ||
                'Both'}
            </DetailField>
            <DetailField label="Team">{selected.team || '—'}</DetailField>
            <DetailField label="Plan">{selected.plan_name || '—'}</DetailField>
          </div>
        </section>
        <section style={{ marginTop: '1.25rem' }}>
          <h2>Virtual key</h2>
          <div className="detail-grid">
            <DetailField label="Secret">
              <SecretKey value={selected.virtual_key} />
              {seed ? <span className="seed-tag">seed</span> : null}
            </DetailField>
            <DetailField label="Key status">
              <span
                className={`badge ${
                  selected.key_status === 'active' ? 'ok' : 'bad'
                }`}
              >
                {selected.key_status || '—'}
              </span>
            </DetailField>
          </div>
          {seed ? null : (
            <div className="form-actions" style={{ marginTop: '0.85rem' }}>
              {selected.key_status === 'disabled' ? (
                <button
                  type="button"
                  onClick={() =>
                    runKeyAction(enableKey, null, 'Key enabled')
                  }
                >
                  Enable key
                </button>
              ) : selected.key_id ? (
                <>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      runKeyAction(
                        disableKey,
                        `Disable ${selected.virtual_key}? API calls with this secret will fail.`,
                        'Key disabled',
                      )
                    }
                  >
                    Disable key
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      runKeyAction(
                        rotateKey,
                        `Rotate ${selected.virtual_key}? The old secret stops working immediately.`,
                      )
                    }
                  >
                    Rotate key
                  </button>
                </>
              ) : (
                <span className="muted-hint">No key on this user yet</span>
              )}
            </div>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      {confirmDialog}
      <Notices error={error} notice={notice} />
      <div className="list-toolbar">
        <button
          type="button"
          className="ghost"
          onClick={() => (view === 'edit' && selected ? setView('detail') : openList())}
        >
          {view === 'edit' ? 'Back to details' : 'Back to users'}
        </button>
      </div>
      <section>
        <h2>{view === 'edit' ? selected?.name || 'User' : 'Create user'}</h2>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const payload = { ...form };
            run(async () => {
              if (view === 'edit' && selectedId) {
                await updateUser(selectedId, payload);
                setView('detail');
              } else {
                const created = await createUser(payload);
                setSelectedId(created.id);
                setView('detail');
              }
            }, view === 'edit'
              ? `User ${payload.username} updated`
              : payload.access_mode === 'api'
                ? `User ${payload.username} created (API only — key ready for /v1)`
                : `User ${payload.username} created with key`);
          }}
        >
          <label>
            Display name
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
            />
          </label>
          <label>
            Username
            <input
              value={form.username}
              onChange={(event) =>
                setForm({ ...form, username: event.target.value })
              }
              autoComplete="off"
              required
            />
          </label>
          <label>
            Access
            <select
              value={form.access_mode}
              onChange={(event) =>
                setForm({ ...form, access_mode: event.target.value })
              }
              required
            >
              <option value="both">Both (chat + API key)</option>
              <option value="chat">Chat only</option>
              <option value="api">API only</option>
            </select>
          </label>
          <label>
            Password
            <input
              type="password"
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
              placeholder={
                view === 'edit'
                  ? 'Leave blank to keep current'
                  : form.access_mode === 'api'
                    ? 'Optional for API-only'
                    : ''
              }
              autoComplete="new-password"
              required={view === 'create' && form.access_mode !== 'api'}
            />
          </label>
          <label>
            Team
            <select
              value={form.team}
              onChange={(event) => setForm({ ...form, team: event.target.value })}
              required
            >
              <option value="">Choose a team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.name}>
                  {team.name}
                  {team.plan_name ? ` · ${team.plan_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="submit">Save</button>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                view === 'edit' && selected ? setView('detail') : openList()
              }
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
