(function () {
  'use strict';

  // Electron exposes the same interface through preload.js. In a normal browser
  // the Go backend supplies it over HTTP, so the existing renderer can stay the
  // single frontend for both surfaces.
  if (window.tally) return;
  // Preserve the existing file:// preview (which intentionally uses demo data).
  // A file-based client can opt into the backend explicitly by setting the URL.
  if (window.location.protocol === 'file:' && !window.TALLY_BACKEND_URL) return;
  const base = String(window.TALLY_BACKEND_URL || (window.location.protocol === 'file:' ? 'http://127.0.0.1:43821' : window.location.origin)).replace(/\/+$/, '');
  // The backend injects its per-process API token into the index.html it serves.
  const tokenMeta = document.querySelector('meta[name="tally-token"]');
  const token = String(window.TALLY_BACKEND_TOKEN || (tokenMeta && tokenMeta.content) || '');

  async function request(path, options) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-tally-token': token, ...(options && options.headers) },
    });
    if (!response.ok) throw new Error(`backend ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  // Session answers come back with their status so a 409 conflict can name the
  // session already running.
  async function focusRequest(path, options) {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-tally-token': token },
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 200 || response.status === 201) return { ok: true, session: body.session ?? null };
    if (response.status === 409) return { ok: false, status: 409, session: body.session || null };
    return { ok: false, status: 400, error: (body && body.error) || `backend ${response.status}` };
  }

  window.tally = {
    snapshot: () => request('/api/v1/snapshot'),
    range: (days) => request(`/api/v1/range?days=${encodeURIComponent(days)}`),
    updateSettings: (patch) => request('/api/v1/settings', { method: 'PATCH', body: JSON.stringify(patch || {}) }),
    startFocus: (input) => focusRequest('/api/v1/focus/session', {
      method: 'POST',
      body: JSON.stringify({ ...(input || {}), source: 'screen-time' }),
    }),
    endFocus: () => focusRequest('/api/v1/focus/session?source=screen-time', { method: 'DELETE' }),
    focusCatalog: (days) => request(`/api/v1/focus/catalog?days=${encodeURIComponent(days)}`),
    clearData: () => request('/api/v1/clear', { method: 'POST', body: '{}' }),
    openDataFolder: async () => false,
    rescanBrowsers: () => request('/api/v1/browsers'),
    requestAccessibility: async () => false,
    installUpdate: async () => false,
    checkForUpdates: () => request('/api/v1/snapshot').then((snapshot) => snapshot.system.update),
    onChanged: (callback) => {
      const timer = setInterval(() => {
        if (!document.hidden) callback({ at: Date.now() });
      }, 10000);
      return () => clearInterval(timer);
    },
  };
})();
