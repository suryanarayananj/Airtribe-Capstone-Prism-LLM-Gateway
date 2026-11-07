const ADMIN_TOKEN =
  import.meta.env.VITE_ADMIN_TOKEN || 'prism-admin-demo';

async function adminGet(path) {
  const res = await fetch(path, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export function fetchUsage(keyOrOpts, maybeOpts) {
  const opts =
    keyOrOpts && typeof keyOrOpts === 'object'
      ? keyOrOpts
      : { key: keyOrOpts, ...(maybeOpts || {}) };
  const params = new URLSearchParams();
  if (opts.key) {
    params.set('key', opts.key);
  }
  if (opts.from) {
    params.set('from', opts.from);
  }
  if (opts.to) {
    params.set('to', opts.to);
  }
  const q = params.toString();
  return adminGet(`/admin/usage${q ? `?${q}` : ''}`);
}

export function fetchLogs(limit = 40) {
  return adminGet(`/admin/logs?limit=${limit}`);
}

export function fetchCacheEntries(limit = 200) {
  return adminGet(`/admin/cache/entries?limit=${limit}`);
}

export function fetchCacheHits(limit = 200) {
  return adminGet(`/admin/cache/hits?limit=${limit}`);
}

export function fetchCacheStats() {
  return adminGet('/admin/cache/stats');
}

export function fetchProviderHealth() {
  return adminGet('/admin/providers/health');
}

export function fetchProviderCatalog() {
  return adminGet('/admin/providers/catalog');
}

export function fetchObservability(key) {
  const q = key ? `?key=${encodeURIComponent(key)}` : '';
  return adminGet(`/admin/observability${q}`);
}

export function fetchKeys() {
  return adminGet('/admin/keys');
}

export function createKey(body) {
  return adminSend('/admin/keys', 'POST', body);
}

export function disableKey(id) {
  return adminSend(`/admin/keys/${id}/disable`, 'POST', {});
}

export function enableKey(id) {
  return adminSend(`/admin/keys/${id}/enable`, 'POST', {});
}

export function rotateKey(id) {
  return adminSend(`/admin/keys/${id}/rotate`, 'POST', {});
}

async function adminSend(path, method, body) {
  const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    throw new Error(json?.error?.message || `${res.status}: ${text}`);
  }
  return json;
}

export function deleteRecord(table, id) {
  return adminSend(`/admin/records/${table}/${id}`, 'DELETE');
}

export function clearTable(table) {
  return adminSend(`/admin/records/${table}`, 'DELETE');
}

export function fetchTeams() {
  return adminGet('/admin/teams');
}

export function fetchUsers() {
  return adminGet('/admin/users');
}

export function fetchModels() {
  return adminGet('/admin/models');
}

export function fetchPlans() {
  return adminGet('/admin/plans');
}

export function createPlan(body) {
  return adminSend('/admin/plans', 'POST', body);
}

export function updatePlan(id, body) {
  return adminSend(`/admin/plans/${id}`, 'PATCH', body);
}

export function createTeam(body) {
  return adminSend('/admin/teams', 'POST', body);
}

export function updateTeam(id, body) {
  return adminSend(`/admin/teams/${id}`, 'PATCH', body);
}

export function createUser(body) {
  return adminSend('/admin/users', 'POST', body);
}

export function updateUser(id, body) {
  return adminSend(`/admin/users/${id}`, 'PATCH', body);
}
